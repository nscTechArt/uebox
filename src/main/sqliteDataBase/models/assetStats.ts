/**
 * 资产库的**聚合统计** —— 「我库里有什么」这个问题的正确答案来源。
 *
 * 为什么单开一个文件，而不是让调用方翻页去数：
 *
 * 几十万条资产的库里，「库里有什么」如果只能靠列举资产行来回答，就只有两种结局 ——
 * 要么翻几千页（不可能），要么看前 100 条然后凭它们下结论（那 100 条还是按名字
 * 字母序排的，等于「以 A 开头的一百个」）。两种都是错的，后一种还错得看不出来。
 *
 * 正确的做法是**别把行搬出数据库**：分布让 SQL 去算，回给调用方的是几十个
 * 数字。不管库里是 8 个资产还是 80 万个，这个返回值的大小几乎不变，而且每个
 * 数字都是精确的、不是抽样估的。
 *
 * 所有统计都复用 assetSearch 的筛选条件拼装（buildAssetQueryParts），所以
 * 「Trees 文件夹里有什么」「带这个标签的都是些什么类型」和「全库有什么」
 * 走的是同一条路 —— 统计既是概览，也是逐层收窄的导航。
 */

import Database from 'better-sqlite3'
import { buildAssetQueryParts, type AssetSearchCriteria } from './assetSearch'

/** 一个分布桶：某个取值下有多少个资产、占多少字节 */
export interface AssetFacetBucket {
  key: string
  count: number
  size: number
}

/**
 * 一组分布。
 *
 * `buckets` 只取前 N 个，剩下的合并进 `otherCount` / `otherKinds` ——
 * **不能直接丢掉**：丢掉的话桶里的数加起来小于总数，而调用方没有任何办法
 * 察觉这件事，只会把「前 12 类」当成「全部类别」念给用户听。
 */
export interface AssetFacet {
  buckets: AssetFacetBucket[]
  /** 没进前 N 的资产总数 */
  otherCount: number
  /** 没进前 N 的取值有多少种 */
  otherKinds: number
}

export interface AssetLibraryOverview {
  /** 符合筛选条件的资产总数 */
  total: number
  /** 这些资产占多少字节 */
  totalSize: number
  byType: AssetFacet
  byExtension: AssetFacet
  /** 按下一层文件夹分。scopePath 为空时就是顶层文件夹 */
  byFolder: AssetFacet
  byEngineVersion: AssetFacet
  byTag: AssetFacet
  /** 一个标签都没打的有多少个 */
  untaggedCount: number
  /** 收藏了多少个 */
  favoriteCount: number
  /** 最占地方的几个 */
  largest: Array<{ name: string; size: number; folder?: string }>
  /** 最早 / 最近的入库时间 */
  earliest?: string
  latest?: string
}

export interface OverviewOptions {
  /** 每组分布最多列几个取值，默认 12 */
  facetLimit?: number
  /** 「最占地方的」列几个，默认 5 */
  largestLimit?: number
  /**
   * 文件夹分布从哪一层往下切。传 '/角色' 就按 /角色 的直接子文件夹分组。
   * 空 / 不传 = 按顶层文件夹分组。
   */
  scopePath?: string
  /** 标签名解析用的公共库连接。不传就只回标签 id */
  publicDb?: Database.Database
}

/** size 和 fileSize 两个字段历史上都在用，取先有值的那个 */
const SIZE_EXPR = 'COALESCE(NULLIF(ad.size, 0), ad.fileSize, 0)'

const DEFAULT_FACET_LIMIT = 12
const DEFAULT_LARGEST_LIMIT = 5

interface RawBucket {
  key: string | null
  count: number
  size: number
}

/**
 * 把「按某个表达式分组」跑成一组分布。
 *
 * 注意这里查了 **limit + 1 之外的全部**：`otherCount` 是拿总数减出来的，
 * 所以不需要再扫一遍，也保证桶里的数 + other = total 恒等。
 */
function runFacet(
  db: Database.Database,
  criteria: AssetSearchCriteria,
  groupExpr: string,
  options: { limit: number; extraJoin?: string; total: number }
): AssetFacet {
  const { withClause, joinSql, whereSql, params } = buildAssetQueryParts(db, criteria)
  const sql = `
    ${withClause}
    SELECT ${groupExpr} AS key,
           COUNT(*) AS count,
           SUM(${SIZE_EXPR}) AS size
    FROM assetData ad
    ${joinSql}
    ${options.extraJoin ?? ''}
    ${whereSql}
    GROUP BY key
    ORDER BY count DESC
  `
  const rows = db.prepare(sql).all(...params) as RawBucket[]

  const sorted = rows.filter((r) => r.count > 0)
  const head = sorted.slice(0, options.limit)
  const tail = sorted.slice(options.limit)

  return {
    buckets: head.map((r) => ({
      key: (r.key ?? '').toString().trim() || '(未标注)',
      count: Number(r.count) || 0,
      size: Number(r.size) || 0
    })),
    otherCount: tail.reduce((sum, r) => sum + (Number(r.count) || 0), 0),
    otherKinds: tail.length
  }
}

/**
 * 文件夹分布的分组表达式：把 fullPath 在 scopePath 之后的**第一段**切出来。
 *
 * /角色/主角/贴图 在 scopePath='' 时归到「角色」，在 scopePath='/角色' 时归到「主角」。
 * 正好落在 scopePath 这一层的资产归到「(本级)」—— 它们不属于任何子文件夹，
 * 直接丢掉的话数字就对不上了。
 */
function folderGroupExpr(scopePath: string): string {
  // prefixLen：要跳过的前缀长度。scopePath='' 时跳过开头的 '/'
  const prefixLen = scopePath ? scopePath.length + 1 : 1
  return `
    CASE
      WHEN afo.fullPath IS NULL OR length(afo.fullPath) <= ${prefixLen} THEN '(本级)'
      WHEN instr(substr(afo.fullPath, ${prefixLen + 1}), '/') > 0
        THEN substr(afo.fullPath, ${prefixLen + 1}, instr(substr(afo.fullPath, ${prefixLen + 1}), '/') - 1)
      ELSE substr(afo.fullPath, ${prefixLen + 1})
    END
  `
}

/**
 * 算出一份资产库概览。
 *
 * @param db 保管库连接（assetData / asset_tags / asset_favorites 都在这里）
 * @param criteria 筛选条件，和搜索用的是同一套。不传 = 整个库
 */
export function getAssetLibraryOverview(
  db: Database.Database,
  criteria: AssetSearchCriteria = {},
  options: OverviewOptions = {}
): AssetLibraryOverview {
  const facetLimit = Math.max(1, Math.floor(options.facetLimit ?? DEFAULT_FACET_LIMIT))
  const largestLimit = Math.max(0, Math.floor(options.largestLimit ?? DEFAULT_LARGEST_LIMIT))
  const scopePath = (options.scopePath ?? '').replace(/\/+$/, '')

  // ── 总数 / 总大小 / 时间跨度：一次查询拿全 ──────────────────────────────
  const base = buildAssetQueryParts(db, criteria)
  const summary = db
    .prepare(
      `
      ${base.withClause}
      SELECT COUNT(*) AS total,
             SUM(${SIZE_EXPR}) AS totalSize,
             MIN(ad.created_at) AS earliest,
             MAX(ad.created_at) AS latest
      FROM assetData ad
      ${base.joinSql}
      ${base.whereSql}
    `
    )
    .get(...base.params) as {
    total?: number
    totalSize?: number
    earliest?: string
    latest?: string
  }

  const total = Number(summary?.total ?? 0)
  const empty: AssetFacet = { buckets: [], otherCount: 0, otherKinds: 0 }

  if (total === 0) {
    return {
      total: 0,
      totalSize: 0,
      byType: empty,
      byExtension: empty,
      byFolder: empty,
      byEngineVersion: empty,
      byTag: empty,
      untaggedCount: 0,
      favoriteCount: 0,
      largest: []
    }
  }

  const byType = runFacet(
    db,
    criteria,
    `COALESCE(NULLIF(TRIM(ad.assetType), ''), NULLIF(TRIM(ad.classNameCn), ''), '(未知类型)')`,
    { limit: facetLimit, total }
  )

  const byExtension = runFacet(
    db,
    criteria,
    `LOWER(COALESCE(NULLIF(TRIM(ad.fileExtension), ''), NULLIF(TRIM(ad.ext), ''), '(无扩展名)'))`,
    { limit: facetLimit, total }
  )

  const byEngineVersion = runFacet(
    db,
    criteria,
    `COALESCE(NULLIF(TRIM(ad.engineVersion), ''), '(未标注版本)')`,
    { limit: facetLimit, total }
  )

  // 文件夹分布要 fullPath，用独立别名 afo —— af 可能已经被文件夹筛选占用了
  const byFolder = runFacet(db, criteria, folderGroupExpr(scopePath), {
    limit: facetLimit,
    total,
    extraJoin: 'LEFT JOIN assetFolder afo ON afo.folderKey = ad.folderKey'
  })

  // ── 标签分布：关联在保管库，名字在公共库，只能分两步 ─────────────────────
  const tagParts = buildAssetQueryParts(db, criteria)
  const tagRows = db
    .prepare(
      `
      ${tagParts.withClause}
      SELECT at2.tagId AS tagId, COUNT(*) AS count, SUM(${SIZE_EXPR}) AS size
      FROM assetData ad
      ${tagParts.joinSql}
      JOIN asset_tags at2 ON at2.assetKey = ad.assetKey
      ${tagParts.whereSql}
      GROUP BY at2.tagId
      ORDER BY count DESC
    `
    )
    .all(...tagParts.params) as Array<{ tagId: number; count: number; size: number }>

  const tagHead = tagRows.slice(0, facetLimit)
  const tagTail = tagRows.slice(facetLimit)
  const tagNameById = resolveTagNames(
    options.publicDb,
    tagHead.map((r) => r.tagId)
  )
  const byTag: AssetFacet = {
    buckets: tagHead.map((r) => ({
      key: tagNameById.get(r.tagId) ?? `标签#${r.tagId}`,
      count: Number(r.count) || 0,
      size: Number(r.size) || 0
    })),
    otherCount: tagTail.reduce((sum, r) => sum + (Number(r.count) || 0), 0),
    otherKinds: tagTail.length
  }

  // ── 没打标签的 / 收藏的 ────────────────────────────────────────────────
  const untaggedParts = buildAssetQueryParts(db, criteria)
  const untaggedCount = Number(
    (
      db
        .prepare(
          `
          ${untaggedParts.withClause}
          SELECT COUNT(*) AS n
          FROM assetData ad
          ${untaggedParts.joinSql}
          ${untaggedParts.whereSql}
          ${untaggedParts.whereSql ? 'AND' : 'WHERE'}
            ad.assetKey NOT IN (SELECT DISTINCT assetKey FROM asset_tags)
        `
        )
        .get(...untaggedParts.params) as { n?: number }
    )?.n ?? 0
  )

  const favParts = buildAssetQueryParts(db, criteria)
  const favoriteCount = Number(
    (
      db
        .prepare(
          `
          ${favParts.withClause}
          SELECT COUNT(*) AS n
          FROM assetData ad
          ${favParts.joinSql}
          JOIN asset_favorites afv ON afv.assetKey = ad.assetKey
          ${favParts.whereSql}
        `
        )
        .get(...favParts.params) as { n?: number }
    )?.n ?? 0
  )

  // ── 最占地方的几个：4TB 的库里「什么在吃硬盘」是个真问题 ────────────────
  let largest: AssetLibraryOverview['largest'] = []
  if (largestLimit > 0) {
    const bigParts = buildAssetQueryParts(db, criteria)
    bigParts.params.push(largestLimit)
    largest = (
      db
        .prepare(
          `
          ${bigParts.withClause}
          SELECT ad.assetName AS name, ${SIZE_EXPR} AS size, ad.folderName AS folder
          FROM assetData ad
          ${bigParts.joinSql}
          ${bigParts.whereSql}
          ORDER BY size DESC
          LIMIT ?
        `
        )
        .all(...bigParts.params) as Array<{ name: string; size: number; folder?: string }>
    ).map((r) => ({ name: r.name, size: Number(r.size) || 0, folder: r.folder || undefined }))
  }

  return {
    total,
    totalSize: Number(summary?.totalSize ?? 0),
    byType,
    byExtension,
    byFolder,
    byEngineVersion,
    byTag,
    untaggedCount,
    favoriteCount,
    largest,
    ...(summary?.earliest ? { earliest: summary.earliest } : {}),
    ...(summary?.latest ? { latest: summary.latest } : {})
  }
}

/**
 * 标签 id 换名字。查不到就退回 `标签#id` —— 统计不该因为标签库读不出来整个失败。
 */
function resolveTagNames(
  publicDb: Database.Database | undefined,
  ids: number[]
): Map<number, string> {
  const map = new Map<number, string>()
  if (!publicDb || ids.length === 0) return map
  try {
    const rows = publicDb
      .prepare(`SELECT id, name FROM tags WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: number; name: string }>
    for (const row of rows) map.set(row.id, row.name)
  } catch (error) {
    console.warn('[资产统计] 解析标签名失败，回退成标签 id:', error)
  }
  return map
}
