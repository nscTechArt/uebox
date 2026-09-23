/**
 * 按相关度取「一个保管库里的前 N 个」—— 给跨库合并用的检索。
 *
 * ## 为什么不复用 searchAssetsByCriteria
 *
 * 那条路给界面用：它把每一条命中都回表 JOIN，再用窗口函数给**全部命中**排名次（为了 RRF），
 * 连数总数也走这一套。库小的时候无所谓；在 50 万资产的库上，一个「SM_Env」（几乎命中全库）
 * 要 3 秒，翻到深处要 5 秒多，而同样的结果只查 FTS 表取前 20 只要 37ms。
 * 慢的不是全文索引，是「先回表、后截断」。所以这里反过来：**先在 FTS 里截断，只对留下的回表。**
 *
 * ## 排序键
 *
 * (层, bm25, id)。层 = 查询词在 name/tags/folder/type 里是否全中（见 buildFtsAllTermsQuery）。
 * 全中层内用全中表达式的 bm25（只算那四列），部分层用 OR 表达式的 bm25 ——
 * 备注里的整段 AI 提示词不该左右「谁是最匹配的那个」。
 * 调用方拿各库的前 N 个按同一个键归并，就是全局的前 N 个 —— 前提是每个库给出的真是
 * 它自己的前 N 个，本文件的全部复杂度都在保证这一点。
 *
 * ## 三条路（按代价从低到高，便宜的不够才升级）
 *
 * 1. 候选：从 FTS 按排序键取前 k 个，回表核对筛选条件，不够就 k ×4。
 *    纯关键词时筛选只剩「没删除」，一轮就够。
 * 2. 类型集合子查询：按类型筛时，只扫 assetType 的覆盖索引拿到类型集合，塞进 FTS 查询
 *    （`+rowid IN (...)`）。窄类型直接走这条；宽类型先走候选，凑不够再走这条。结果和总数都精确。
 * 3. JOIN：非类型的窄筛选（文件夹、标签、时间……）候选凑不够时的兜底，代价等于原来的做法。
 *
 * 每一步的阈值来自 5k~500k 资产的实测，见各常量上的说明。
 */

import type Database from 'better-sqlite3'
import type { AssetData } from './assetData'
import { buildAssetQueryParts, type AssetSearchCriteria } from './assetSearch'
import { BM25_EXPR, DIRTY_TABLE, FTS_TABLE } from './assetSearchIndex'
import { buildFtsAllTermsQuery, buildFtsTerms, textMatchesTerm, type FtsTerm } from './ftsText'

/**
 * 待索引的行不超过这么多时，对它们单独做一遍比对，结果仍然是全的；超过就只报数量。
 *
 * 实测（强制从待索引表出发）：1 万行 4ms，2 万行 59~103ms —— 2 万附近页缓存装不下了。
 * 超过这个量说明刚导入了一个大包、索引正在追，这时明说「有 N 个还没进索引」
 * 比每次搜索都卡一下要好。
 */
export const PENDING_SCAN_LIMIT = 10000

/**
 * 带筛选时，候选最多扩到 need 的这么多倍（且不少于 CANDIDATE_FLOOR × 16），还凑不够就换路。
 *
 * 纯关键词时候选几乎全部有效，一轮就够；这个上限只在「筛选很窄」时起作用。
 */
export const CANDIDATE_MULTIPLIER = 64

/**
 * 带筛选时候选起步至少取这么多。
 *
 * 每一轮的主要成本是 FTS 给全部命中打分（宽查询在 50 万库上 ~130ms），和取多少个关系不大
 * （实测前 100 与前 2000 只差 25ms），所以起步就取宽一些、少扩几轮。
 */
export const CANDIDATE_FLOOR = 400

/**
 * 按类型筛、且这个类型的资产不超过这么多时，直接走「类型集合子查询」，结果和总数都精确。
 *
 * 类型集合只扫 assetType 的覆盖索引、不回主表：50 万资产的库上任何类型都在 36ms 以内。
 * 拿它去限定全文查询，实测 SkeletalMesh（5.7 万个）取前 100 是 47~78ms、精确计数 62ms 以内；
 * 而 StaticMesh（33 万个）这种占了大半个库的，配上宽查询要 774ms —— 那种筛选很松，
 * 候选一轮就凑够了，先走候选。
 */
export const TYPE_SET_DIRECT_LIMIT = 60000

/**
 * 非类型筛选（文件夹、标签、时间……）时总数数到这么多就停，回「至少这么多」。
 *
 * 这个上限只限制数字、不限制耗时：真实结果不到上限时照样要把全部命中核对一遍。
 * 类型筛选不走这里，用类型集合精确数。
 */
export const COUNT_CAP = 1000

export interface RankedHit {
  id: number
  /** 1 = 查询词全中（name/tags/folder/type），0 = 只中了一部分 */
  tier: 0 | 1
  /** bm25，越小越相关。还没进索引、靠 JS 比对命中的是 +Infinity，排在同层最后 */
  score: number
}

export type RankedRoute = 'candidates' | 'filter-subquery' | 'join'

export interface RankedSearchResult {
  /** 这个库按排序键的前 need 个 */
  hits: RankedHit[]
  total: number
  /** true = total 是数到上限停下的，真实数量只多不少 */
  totalIsLowerBound: boolean
  /** 待索引的行数。> 0 且 pendingSearched = false 时，结果里不含它们 */
  indexPending: number
  pendingSearched: boolean
  route: RankedRoute
}

export interface RankedSearchOptions {
  query: string
  /** 要这个库的前多少个（= 调用方的 offset + limit） */
  need: number
  /** 关键词以外的筛选条件（文件夹、类型、标签……）。不能带 keyword / ftsMatch */
  filter: AssetSearchCriteria
  /** 覆盖阈值。只给测试用：让小数据集也能走到每一条路 */
  limits?: Partial<RankedLimits>
}

export interface RankedLimits {
  pendingScanLimit: number
  candidateMultiplier: number
  candidateFloor: number
  typeSetDirectLimit: number
  countCap: number
}

/** 这个库有没有全文索引表。老库第一次打开前可能没有，调用方要退回别的路 */
export function hasAssetSearchIndex(db: Database.Database): boolean {
  try {
    return !!db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(FTS_TABLE)
  } catch {
    return false
  }
}

/** 筛选条件里除了「没删除」还有没有别的 —— 没有的话候选一轮就够，也能直接数 FTS */
function hasRealFilter(filter: AssetSearchCriteria): boolean {
  return Object.entries(filter).some(([key, value]) => {
    if (value === undefined || value === null) return false
    // 只有 showDependencies:false 是一个真筛选；其余布尔开关为 false 时等于没开
    if (value === false) return key === 'showDependencies'
    if (Array.isArray(value)) return value.length > 0
    if (key === 'favoriteStatus') return value !== 'all'
    if (key === 'folderKey') return value !== 'ALL'
    if (key === 'includeSubfolders' || key === 'userId' || key === 'vaultId') return false
    return true
  })
}

interface FilterSql {
  /** 一段能单独执行的 `SELECT ad.id ...`（可能带 WITH） */
  subquery: string
  /** subquery 自己的参数（只按类型筛时它就是类型集合，参数和 condition 那套不同） */
  subqueryParams: (string | number | null)[]
  /** 回表时接在 `FROM ... JOIN assetData ad` 后面的 JOIN 与条件 */
  withClause: string
  joinSql: string
  condition: string
  params: (string | number | null)[]
}

interface TypeSet {
  sql: string
  params: string[]
}

/**
 * 类型集合：只扫 assetType 的覆盖索引，不碰主表。
 *
 * 匹配口径和 buildAssetQueryParts 里的类型条件完全一致（整串相等，或者是逗号分隔列表里的一项），
 * 区别只在于这里**不带 isDelete** —— 带上它就得回主表，退化成全表扫描（50 万资产 0.7~7 秒）。
 * 已删除的资产不在全文索引里，最后还有一遍主键核对兜底。
 */
function buildTypeSet(db: Database.Database, types: string[]): TypeSet {
  const hasIndex = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_assetData_assetType'`)
    .get()
  const cond = types
    .map(() => '(assetType = ? OR assetType LIKE ? OR assetType LIKE ? OR assetType LIKE ?)')
    .join(' OR ')
  return {
    sql: `SELECT id FROM assetData ${hasIndex ? 'INDEXED BY idx_assetData_assetType' : ''} WHERE ${cond}`,
    params: types.flatMap((t) => [t, `${t},%`, `%, ${t},%`, `%, ${t}`])
  }
}

/**
 * @param typeSet 给了就把类型条件换成「id 在类型集合里」，其余条件照旧由 buildAssetQueryParts 生成
 */
function buildFilterSql(
  db: Database.Database,
  filter: AssetSearchCriteria,
  typeSet: TypeSet | null
): FilterSql {
  // 逐行核对（候选回表、JOIN）用原样的条件：类型按行判断就行。
  // 换成「id 在类型集合里」的话，每一批候选都要把整个类型集合物化一遍 ——
  // 50 万库上 StaticMesh 有 33 万个，一批就是几十毫秒，几批下来上秒
  const parts = buildAssetQueryParts(db, filter)
  // whereSql 永远以 WHERE 开头（至少有 isDelete 那一条）
  const condition = parts.whereSql.replace(/^\s*WHERE\s+/i, '')
  const rowLevel = {
    withClause: parts.withClause,
    joinSql: parts.joinSql,
    condition,
    params: parts.params
  }
  if (!typeSet) {
    return {
      ...rowLevel,
      subquery: `${parts.withClause} SELECT ad.id FROM assetData ad ${parts.joinSql} WHERE ${condition}`,
      subqueryParams: parts.params
    }
  }

  // 塞进 FTS 查询的子查询用类型集合：只扫覆盖索引，一次物化
  const rest = { ...filter }
  delete rest.assetTypes
  if (!hasRealFilter(rest)) {
    // 只按类型筛：子查询直接就是类型集合，不回主表判 isDelete ——
    // 已删除的不在全文索引里，待索引的另行剔除，孤儿条目的 id 也不可能出现在类型集合里
    return { ...rowLevel, subquery: typeSet.sql, subqueryParams: typeSet.params }
  }
  const restParts = buildAssetQueryParts(db, rest)
  // 类型条件接在最后，参数顺序才对得上
  const restCondition = restParts.whereSql.replace(/^\s*WHERE\s+/i, '')
  return {
    ...rowLevel,
    subquery: `${restParts.withClause} SELECT ad.id FROM assetData ad ${restParts.joinSql}
               WHERE ${restCondition} AND ad.id IN (${typeSet.sql})`,
    subqueryParams: [...restParts.params, ...typeSet.params]
  }
}

const CHUNK = 900

/** 这些 id 里哪些满足筛选条件（至少是「没删除」—— 顺带挡掉索引里的孤儿条目） */
function passingIds(db: Database.Database, sql: FilterSql, ids: number[]): Set<number> {
  const pass = new Set<number>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const rows = db
      .prepare(
        `${sql.withClause} SELECT ad.id FROM assetData ad ${sql.joinSql}
         WHERE ${sql.condition} AND ad.id IN (${chunk.map(() => '?').join(',')})`
      )
      .all(...sql.params, ...chunk) as Array<{ id: number }>
    for (const row of rows) pass.add(row.id)
  }
  return pass
}

type TierMode =
  | { kind: 'plain' }
  | { kind: 'subquery'; sql: FilterSql }
  | { kind: 'join'; sql: FilterSql }

/** 按 (bm25, rowid) 取某个 MATCH 表达式的前 k 个 */
function fetchTier(
  db: Database.Database,
  expr: string,
  k: number,
  mode: TierMode
): Array<{ id: number; s: number }> {
  if (mode.kind === 'plain') {
    return db
      .prepare(
        `SELECT rowid AS id, ${BM25_EXPR} AS s FROM ${FTS_TABLE}
         WHERE ${FTS_TABLE} MATCH ? ORDER BY s, rowid LIMIT ?`
      )
      .all(expr, k) as Array<{ id: number; s: number }>
  }
  if (mode.kind === 'subquery') {
    // `+rowid`：不让规划器拿子查询去驱动 FTS，而是 FTS 驱动、子查询只当成员判断
    return db
      .prepare(
        `SELECT rowid AS id, ${BM25_EXPR} AS s FROM ${FTS_TABLE}
         WHERE +rowid IN (${mode.sql.subquery}) AND ${FTS_TABLE} MATCH ?
         ORDER BY s, rowid LIMIT ?`
      )
      .all(...mode.sql.subqueryParams, expr, k) as Array<{ id: number; s: number }>
  }
  return db
    .prepare(
      `${mode.sql.withClause}
       SELECT ${FTS_TABLE}.rowid AS id, ${BM25_EXPR} AS s
       FROM ${FTS_TABLE} JOIN assetData ad ON ad.id = ${FTS_TABLE}.rowid ${mode.sql.joinSql}
       WHERE ${mode.sql.condition} AND ${FTS_TABLE} MATCH ?
       ORDER BY s, ${FTS_TABLE}.rowid LIMIT ?`
    )
    .all(...mode.sql.params, expr, k) as Array<{ id: number; s: number }>
}

interface CandidateRound {
  /** 按排序键排好的候选 */
  list: RankedHit[]
  /** 这一轮已经把所有命中都取出来了，再扩也不会多 */
  exhausted: boolean
}

/**
 * 两层各取前 k 个，拼成一个按 (层, bm25, id) 有序的前缀。
 *
 * 全中层被截断（取满了 k 个）时**不能**把 OR 层接上去：没取到的全中项排在所有 OR 项前面，
 * 接上去的话 OR 项会插队。这时只返回全中层，调用方不够就扩 k。
 */
function candidateRound(
  db: Database.Database,
  allExpr: string,
  orExpr: string,
  k: number,
  mode: TierMode,
  exclude: Set<number> | null
): CandidateRound {
  const full = fetchTier(db, allExpr, k, mode)
  const fullTruncated = full.length >= k
  const list: RankedHit[] = full.map((r) => ({ id: r.id, tier: 1, score: r.s }))
  let exhausted = false

  if (!fullTruncated) {
    // 全中层已经取全了；OR 层多取 full.length 个，去掉全中的之后仍有 k 个
    const fullIds = new Set(full.map((r) => r.id))
    const want = k + full.length
    const or = fetchTier(db, orExpr, want, mode)
    for (const r of or) if (!fullIds.has(r.id)) list.push({ id: r.id, tier: 0, score: r.s })
    exhausted = or.length < want
  }

  return {
    list: exclude ? list.filter((h) => !exclude.has(h.id)) : list,
    exhausted
  }
}

/** 取到有效的前 need 个，或者确认已经取完 */
function collect(
  db: Database.Database,
  allExpr: string,
  orExpr: string,
  need: number,
  mode: TierMode,
  check: FilterSql | null,
  exclude: Set<number> | null,
  maxK: number,
  startK: number = need
): { hits: RankedHit[]; complete: boolean } {
  let k = Math.max(startK, need, 1)
  for (;;) {
    const round = candidateRound(db, allExpr, orExpr, k, mode, exclude)
    const pass = check
      ? passingIds(
          db,
          check,
          round.list.map((h) => h.id)
        )
      : null
    const kept = pass ? round.list.filter((h) => pass.has(h.id)) : round.list
    if (kept.length >= need || round.exhausted) {
      return { hits: kept.slice(0, need), complete: true }
    }
    if (k >= maxK) return { hits: kept, complete: false }
    k = Math.min(k * 4, maxK)
  }
}

interface PendingRow {
  id: number
  assetName: string | null
  folderName: string | null
  softPath: string | null
  assetType: string | null
  classNameCn: string | null
  note: string | null
}

/**
 * 还没进索引的那几行，在 JS 里按和 FTS 一样的规则判命中、分层。
 *
 * 标签文本不在 assetData 上，这里不比对 —— 追平之前，靠标签才能命中的资产会暂时搜不到。
 */
function matchPendingRows(rows: PendingRow[], terms: FtsTerm[]): RankedHit[] {
  const hits: RankedHit[] = []
  for (const row of rows) {
    const type = [row.assetType, row.classNameCn].filter(Boolean).join(' ')
    const strong = [row.assetName, row.folderName, type]
    const all = [...strong, row.note, row.softPath]
    const everyStrong = terms.every((t) => strong.some((text) => textMatchesTerm(text, t)))
    const anyHit = terms.some((t) => all.some((text) => textMatchesTerm(text, t)))
    if (everyStrong) hits.push({ id: row.id, tier: 1, score: Number.POSITIVE_INFINITY })
    else if (anyHit) hits.push({ id: row.id, tier: 0, score: Number.POSITIVE_INFINITY })
  }
  return hits
}

/** 两个分数的先后。不能直接相减：待索引行都是 +Infinity，Infinity - Infinity 是 NaN，排序就不确定了 */
export function compareScores(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1
}

export function compareHits(a: RankedHit, b: RankedHit): number {
  return b.tier - a.tier || compareScores(a.score, b.score) || a.id - b.id
}

function countFts(db: Database.Database, expr: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ?`)
    .get(expr) as { n: number }
  return Number(row.n)
}

/**
 * 在一个库里按相关度取前 need 个。
 *
 * @returns null = 查询里没有能搜的字符，或者这个库还没有全文索引表 —— 调用方走老路
 */
export function rankedSearchVault(
  db: Database.Database,
  options: RankedSearchOptions
): RankedSearchResult | null {
  const terms = buildFtsTerms(options.query)
  const allExpr = buildFtsAllTermsQuery(options.query)
  if (terms.length === 0 || !allExpr || !hasAssetSearchIndex(db)) return null
  const orExpr = terms.map((t) => t.expr).join(' OR ')
  const need = Math.max(1, Math.floor(options.need))
  const limits: RankedLimits = {
    pendingScanLimit: PENDING_SCAN_LIMIT,
    candidateMultiplier: CANDIDATE_MULTIPLIER,
    candidateFloor: CANDIDATE_FLOOR,
    typeSetDirectLimit: TYPE_SET_DIRECT_LIMIT,
    countCap: COUNT_CAP,
    ...options.limits
  }

  // ── 待索引的行 ──────────────────────────────────────────────────────────
  // 它们在 FTS 里要么没有、要么是改名前的旧内容，都不能信：从 FTS 结果里剔掉，另外单独比对
  const pending = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM ${DIRTY_TABLE}`).get() as { n: number }).n
  )
  const pendingSearched = pending > 0 && pending <= limits.pendingScanLimit
  const pendingIds = pendingSearched
    ? new Set(
        (db.prepare(`SELECT assetId FROM ${DIRTY_TABLE}`).all() as Array<{ assetId: number }>).map(
          (r) => r.assetId
        )
      )
    : null

  const types = options.filter.assetTypes ?? []
  const typeSet = types.length > 0 ? buildTypeSet(db, types) : null
  const filterSql = buildFilterSql(db, options.filter, typeSet)
  const filtered = hasRealFilter(options.filter)
  const everything = Number.MAX_SAFE_INTEGER

  // 类型集合有多大：只数覆盖索引，50 万资产的库上 36ms 以内
  const typeSetSize = typeSet
    ? Number(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM (${typeSet.sql})`).get(...typeSet.params) as {
            n: number
          }
        ).n
      )
    : null

  let route: RankedRoute
  let hits: RankedHit[]
  let complete: boolean
  if (typeSetSize !== null && typeSetSize <= limits.typeSetDirectLimit) {
    // ── 窄类型：直接把类型集合塞进全文查询，一次到位 ─────────────────────────
    route = 'filter-subquery'
    ;({ hits, complete } = collect(
      db,
      allExpr,
      orExpr,
      need,
      { kind: 'subquery', sql: filterSql },
      null,
      pendingIds,
      everything
    ))
  } else {
    // ── 1. 候选 ───────────────────────────────────────────────────────────
    route = 'candidates'
    ;({ hits, complete } = collect(
      db,
      allExpr,
      orExpr,
      need,
      { kind: 'plain' },
      filterSql,
      pendingIds,
      filtered ? Math.max(need, limits.candidateFloor) * limits.candidateMultiplier : everything,
      filtered ? Math.max(need, limits.candidateFloor) : need
    ))

    // ── 2 / 3. 候选凑不够（筛选很窄）：有类型集合就用它，否则 JOIN ─────────────
    if (!complete) {
      route = typeSet ? 'filter-subquery' : 'join'
      const mode: TierMode = typeSet
        ? { kind: 'subquery', sql: filterSql }
        : { kind: 'join', sql: filterSql }
      // 筛选已经在 SQL 里了，不用再回表核对
      ;({ hits, complete } = collect(db, allExpr, orExpr, need, mode, null, pendingIds, everything))
    }
  }

  // ── 待索引行单独比对，归并进来 ────────────────────────────────────────────
  let pendingHits: RankedHit[] = []
  if (pendingIds && pendingIds.size > 0) {
    const rows = db
      .prepare(
        `SELECT ad.id, ad.assetName, ad.folderName, ad.softPath, ad.assetType, ad.classNameCn, ad.note
         FROM ${DIRTY_TABLE} d CROSS JOIN assetData ad ON ad.id = d.assetId
         WHERE ad.isDelete = 0`
      )
      .all() as PendingRow[]
    const matched = matchPendingRows(rows, terms)
    const pass = passingIds(
      db,
      filterSql,
      matched.map((h) => h.id)
    )
    pendingHits = matched.filter((h) => pass.has(h.id))
    hits = [...hits, ...pendingHits].sort(compareHits).slice(0, need)
  }

  // ── 总数 ────────────────────────────────────────────────────────────────
  let total: number
  let totalIsLowerBound = false
  if (!filtered) {
    // 纯关键词：FTS 自己数，50 万资产的库上 20ms 以内。待索引的旧条目减掉、新比对的加上
    total = countFts(db, orExpr)
    if (pendingIds && pendingIds.size > 0) {
      const stale = db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${FTS_TABLE}
           WHERE ${FTS_TABLE} MATCH ? AND rowid IN (SELECT assetId FROM ${DIRTY_TABLE})`
        )
        .get(orExpr) as { n: number }
      total = total - Number(stale.n) + pendingHits.length
    }
  } else if (complete && hits.length < need) {
    // 候选已经取完了，手上的就是全部
    total = hits.length
  } else {
    // 待索引的行在 FTS 里是旧内容，不能按它数：剔掉，再把 JS 比对出来的 pendingHits 加回去
    const notPending =
      pendingIds && pendingIds.size > 0
        ? `AND ${FTS_TABLE}.rowid NOT IN (SELECT assetId FROM ${DIRTY_TABLE})`
        : ''
    if (typeSet) {
      // 类型筛选：用类型集合精确数，50 万资产的库上最宽的 StaticMesh 也在 112ms 以内
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${FTS_TABLE}
           WHERE +rowid IN (${filterSql.subquery}) AND ${FTS_TABLE} MATCH ? ${notPending}`
        )
        .get(...filterSql.subqueryParams, orExpr) as { n: number }
      total = Number(row.n) + pendingHits.length
    } else {
      const row = db
        .prepare(
          `${filterSql.withClause}
           SELECT COUNT(*) AS n FROM (
             SELECT 1 FROM ${FTS_TABLE} JOIN assetData ad ON ad.id = ${FTS_TABLE}.rowid ${filterSql.joinSql}
             WHERE ${filterSql.condition} AND ${FTS_TABLE} MATCH ? ${notPending}
             LIMIT ${limits.countCap + 1}
           )`
        )
        .get(...filterSql.params, orExpr) as { n: number }
      // 上限管的是总数：待索引那几个也算在里面，不能封顶之后再往上加
      const n = Number(row.n) + pendingHits.length
      totalIsLowerBound = n > limits.countCap
      total = Math.min(n, limits.countCap)
    }
  }
  // 手上已经有的不可能比总数多（待索引的旧条目、孤儿条目都会让 FTS 的数偏大偏小一点）
  total = Math.max(total, hits.length)

  return {
    hits,
    total,
    totalIsLowerBound,
    indexPending: pendingSearched ? 0 : pending,
    pendingSearched,
    route
  }
}

/**
 * 语义召回的 id 里，哪些是**全文没命中**、但满足筛选条件的 —— 按传入顺序返回。
 *
 * 全文也命中的那些已经在主列表里了；这里剩下的是「只靠语义相近」的，
 * 调用方单独列出、不计入总数（它们没有任何字面依据，真机上 horse 召回的是一堆 mp3）。
 */
export function semanticOnlyIds(
  db: Database.Database,
  ids: number[],
  query: string,
  filter: AssetSearchCriteria
): number[] {
  if (ids.length === 0) return []
  const terms = buildFtsTerms(query)
  const orExpr = terms.map((t) => t.expr).join(' OR ')
  const ftsHits = new Set<number>()
  if (orExpr && hasAssetSearchIndex(db)) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const rows = db
        .prepare(
          `SELECT rowid AS id FROM ${FTS_TABLE}
           WHERE ${FTS_TABLE} MATCH ? AND rowid IN (${chunk.map(() => '?').join(',')})`
        )
        .all(orExpr, ...chunk) as Array<{ id: number }>
      for (const row of rows) ftsHits.add(row.id)
    }
  }
  const pass = passingIds(db, buildFilterSql(db, filter, null), ids)
  return ids.filter((id) => pass.has(id) && !ftsHits.has(id))
}

/**
 * 按 id 取整行，带上标签 id（和 searchAssetsByCriteria 返回的形状一致）。
 *
 * 已删除的不回：只按类型筛的那条路不回表核对，索引还没追上的软删除会从这里挡掉。
 */
export function getAssetRowsByIds(db: Database.Database, ids: number[]): AssetData[] {
  const rows: AssetData[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    rows.push(
      ...(db
        .prepare(
          `SELECT ad.*,
             (SELECT GROUP_CONCAT(at2.tagId) FROM asset_tags at2 WHERE at2.assetKey = ad.assetKey) AS tagIdList
           FROM assetData ad WHERE ad.isDelete = 0 AND ad.id IN (${chunk.map(() => '?').join(',')})`
        )
        .all(...chunk) as AssetData[])
    )
  }
  const byId = new Map(rows.map((row) => [(row as { id?: number }).id, row]))
  return ids.map((id) => byId.get(id)).filter((row): row is AssetData => !!row)
}
