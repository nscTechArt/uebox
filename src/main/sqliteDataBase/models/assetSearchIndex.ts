/**
 * 资产库的全文检索索引（FTS5）。
 *
 * 原来的关键词搜索是五个字段一起 `LIKE '%词%'`，外加一次跨库标签查询。两个毛病：
 *
 * 1. **没有索引可用**。`%词%` 前面带通配符，B-Tree 索引一概用不上，每搜一次
 *    就是一次全表扫描。几十万条资产时这是秒级的等待，而且随库增长线性变慢。
 * 2. **没有相关度**。命中之后按资产名字母序排，取前 100 个 —— 于是调用方看到的
 *    永远是「以 A 开头的那一百个」，不是「最像用户要的那一百个」。这才是
 *    「答得不准」的真正来源：不是搜不到，是排在第 3000 位。
 *
 * FTS5 两件事一起解决：倒排索引让命中变成对数级，bm25() 给出真正的相关度排序。
 *
 * ## 中文怎么办
 *
 * unicode61 分词器会把一整串汉字当成**一个词**：「木头椅子」是一个 token，
 * 搜「椅子」永远命中不了。这里的解法是**建索引时把汉字逐字拆开**
 * （「木 头 椅 子」），查询时把中文串拼成短语（`"椅 子"`）。
 * 不需要词典、不需要分词器插件，两个字的中文词也搜得到 ——
 * 这是 trigram 分词器做不到的（它要求查询至少 3 个字符）。
 *
 * ## 索引怎么保持新鲜
 *
 * 触发器只负责**记账**：assetData / asset_tags 一有变动，就往 assetSearchDirty
 * 里丢一个 id。真正的重建由 JS 侧批量做 —— 因为标签名在另一个数据库里，
 * SQL 触发器跨不过去，而汉字逐字拆分也不是 SQL 干得了的事。
 *
 * 这样做的关键好处是：**索引落后是可观察的**。assetSearchDirty 里还剩多少条，
 * 一查便知。没追上的时候搜索会退回 LIKE 并如实说明，而不是安静地漏掉资产。
 */

import Database from 'better-sqlite3'
import { buildFtsMatchQuery, FTS_TOKENIZER, prepareIndexText } from './ftsText'

export const FTS_TABLE = 'assetSearchIndex'
export const DIRTY_TABLE = 'assetSearchDirty'

/**
 * bm25 的列权重，顺序必须和建表时的列顺序一致。
 *
 * 名字最重要 —— 用户说「找 chair」，指的几乎总是名字里有 chair 的那个，
 * 而不是备注里顺口提过一句 chair 的那个。路径权重最低：一个目录下几百个资产
 * 会共享同一段路径，让它和名字等价的话，整个目录会一起浮上来把真正的命中挤下去。
 */
const COLUMN_WEIGHTS = {
  name: 10.0,
  tags: 6.0,
  folder: 2.5,
  type: 2.5,
  note: 2.0,
  path: 1.0
}

export const BM25_EXPR = `bm25(${FTS_TABLE}, ${Object.values(COLUMN_WEIGHTS).join(', ')})`

/**
 * 中文逐字拆分与 MATCH 表达式的构造和知识库共用，实现在 ftsText.ts。
 * 这里保留导出是因为搜索服务与测试一直从本模块取它们。
 */
export { buildFtsMatchQuery, prepareIndexText }

/**
 * 建表、建触发器。第一次创建时把已有资产全部记为待索引。
 *
 * 对已经有库的用户来说，这意味着升级后第一次打开会有一段后台补索引的时间 ——
 * 期间搜索照常可用，只是走老的 LIKE 路径（慢，但结果是全的）。
 */
export function initAssetSearchIndexModel(db: Database.Database): void {
  const existed = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(FTS_TABLE)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      name, tags, folder, type, note, path,
      ${FTS_TOKENIZER}
    );

    CREATE TABLE IF NOT EXISTS ${DIRTY_TABLE} (
      assetId INTEGER PRIMARY KEY
    );

    CREATE TRIGGER IF NOT EXISTS assetData_fts_insert AFTER INSERT ON assetData BEGIN
      INSERT OR REPLACE INTO ${DIRTY_TABLE}(assetId) VALUES (new.id);
    END;

    CREATE TRIGGER IF NOT EXISTS assetData_fts_update AFTER UPDATE ON assetData BEGIN
      INSERT OR REPLACE INTO ${DIRTY_TABLE}(assetId) VALUES (new.id);
    END;

    CREATE TRIGGER IF NOT EXISTS assetData_fts_delete AFTER DELETE ON assetData BEGIN
      INSERT OR REPLACE INTO ${DIRTY_TABLE}(assetId) VALUES (old.id);
    END;

    CREATE TRIGGER IF NOT EXISTS asset_tags_fts_insert AFTER INSERT ON asset_tags BEGIN
      INSERT OR REPLACE INTO ${DIRTY_TABLE}(assetId)
        SELECT id FROM assetData WHERE assetKey = new.assetKey;
    END;

    CREATE TRIGGER IF NOT EXISTS asset_tags_fts_delete AFTER DELETE ON asset_tags BEGIN
      INSERT OR REPLACE INTO ${DIRTY_TABLE}(assetId)
        SELECT id FROM assetData WHERE assetKey = old.assetKey;
    END;
  `)

  if (!existed) {
    markAllAssetsDirty(db)
  }
}

/** 把整个库标记为待重建索引。换 embedding 之外的口径变化、或索引怀疑坏了时用 */
export function markAllAssetsDirty(db: Database.Database): void {
  db.exec(`INSERT OR REPLACE INTO ${DIRTY_TABLE}(assetId) SELECT id FROM assetData`)
}

export interface AssetSearchIndexStatus {
  /** 已经进索引的资产条数 */
  indexed: number
  /** 还没追上的条数。0 = 索引是新鲜的 */
  pending: number
  /** 库里未删除的资产总数 */
  total: number
  ready: boolean
}

export function getAssetSearchIndexStatus(db: Database.Database): AssetSearchIndexStatus {
  const pending = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM ${DIRTY_TABLE}`).get() as { n: number }).n
  )
  const indexed = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`).get() as { n: number }).n
  )
  const total = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM assetData WHERE isDelete = 0').get() as { n: number }).n
  )
  return { indexed, pending, total, ready: pending === 0 }
}

/**
 * 一个关键词该怎么搜：走索引还是退回 LIKE。
 *
 * 单开一个函数是因为这个判断有**两个调用方**（搜索和统计），而判错的两个方向
 * 后果完全不同：该走索引没走，只是慢；索引没追上却走了，会安静地漏掉资产。
 * 让两边共用同一段判断，就不会一边对一边错。
 *
 * 返回值直接铺进 AssetSearchCriteria 用。
 */
export function resolveKeywordCriteria(
  db: Database.Database,
  query: string | undefined | null
): { keyword?: string; ftsMatch?: string; indexReady: boolean } {
  const text = (query ?? '').trim()
  if (!text || text === '*') return { indexReady: true }

  if (!isAssetSearchIndexReady(db)) return { keyword: text, indexReady: false }

  const match = buildFtsMatchQuery(text)
  // 输入里一个字母数字汉字都没有（比如全是标点）—— 没什么可搜的，退回 LIKE
  if (!match) return { keyword: text, indexReady: true }
  return { ftsMatch: match, indexReady: true }
}

/** 索引追上了才能用它搜 —— 没追上就得退回 LIKE，否则会安静地漏资产 */
export function isAssetSearchIndexReady(db: Database.Database): boolean {
  try {
    const row = db.prepare(`SELECT 1 FROM ${DIRTY_TABLE} LIMIT 1`).get()
    return !row
  } catch {
    return false
  }
}

interface DirtyRow {
  assetId: number
}

interface AssetRow {
  id: number
  assetKey: string
  assetName: string | null
  folderName: string | null
  softPath: string | null
  assetType: string | null
  classNameCn: string | null
  note: string | null
  isDelete: number
}

export interface SyncResult {
  /** 这次重建了多少条 */
  indexed: number
  /** 还剩多少条没追上 */
  pending: number
}

const DEFAULT_BUDGET = 2000

/**
 * 把待索引队列消化掉一批。
 *
 * @param publicDb 公共库连接，用来把标签 id 换成名字。不给的话索引里就没有标签文本
 *   —— 搜得到资产，搜不到「用中文标签找资产」。
 * @param budget 这一次最多处理多少条。分批是为了不把主进程卡住：
 *   几十万条的首次建索引会分成很多次，中间搜索照常可用（走 LIKE）。
 */
export function syncAssetSearchIndex(
  db: Database.Database,
  options: { publicDb?: Database.Database; budget?: number } = {}
): SyncResult {
  const budget = Math.max(1, Math.floor(options.budget ?? DEFAULT_BUDGET))

  const dirty = db
    .prepare(`SELECT assetId FROM ${DIRTY_TABLE} ORDER BY assetId LIMIT ?`)
    .all(budget) as DirtyRow[]

  if (dirty.length === 0) return { indexed: 0, pending: 0 }

  const ids = dirty.map((row) => row.assetId)
  const placeholders = ids.map(() => '?').join(',')

  const rows = db
    .prepare(
      `SELECT id, assetKey, assetName, folderName, softPath, assetType, classNameCn, note, isDelete
         FROM assetData WHERE id IN (${placeholders})`
    )
    .all(...ids) as AssetRow[]

  // 已删除（软删或真删）的不进索引 —— 索引里留着的话，搜出来的东西点开就没了
  const live = rows.filter((row) => row.isDelete === 0)
  const tagText = collectTagText(
    db,
    options.publicDb,
    live.map((row) => row.assetKey)
  )

  const deleteFts = db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`)
  const insertFts = db.prepare(
    `INSERT INTO ${FTS_TABLE} (rowid, name, tags, folder, type, note, path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const clearDirty = db.prepare(`DELETE FROM ${DIRTY_TABLE} WHERE assetId = ?`)

  const run = db.transaction(() => {
    for (const id of ids) deleteFts.run(id)
    for (const row of live) {
      insertFts.run(
        row.id,
        prepareIndexText(row.assetName),
        prepareIndexText(tagText.get(row.assetKey) ?? ''),
        prepareIndexText(row.folderName),
        prepareIndexText([row.assetType, row.classNameCn].filter(Boolean).join(' ')),
        prepareIndexText(row.note),
        prepareIndexText(row.softPath)
      )
    }
    for (const id of ids) clearDirty.run(id)
  })
  run()

  const pending = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM ${DIRTY_TABLE}`).get() as { n: number }).n
  )
  return { indexed: live.length, pending }
}

/**
 * 取这批资产的标签名文本。
 *
 * 关联在保管库、名字在公共库，跨库 JOIN 会直接报 no such table，所以分两步查。
 * 公共库读不出来时静默降级成「没有标签文本」—— 为标签把整个索引搞挂不值当。
 */
function collectTagText(
  db: Database.Database,
  publicDb: Database.Database | undefined,
  assetKeys: string[]
): Map<string, string> {
  const result = new Map<string, string>()
  if (!publicDb || assetKeys.length === 0) return result

  try {
    const placeholders = assetKeys.map(() => '?').join(',')
    const links = db
      .prepare(`SELECT assetKey, tagId FROM asset_tags WHERE assetKey IN (${placeholders})`)
      .all(...assetKeys) as Array<{ assetKey: string; tagId: number }>
    if (links.length === 0) return result

    const tagIds = [...new Set(links.map((link) => link.tagId))]
    const names = publicDb
      .prepare(`SELECT id, name FROM tags WHERE id IN (${tagIds.map(() => '?').join(',')})`)
      .all(...tagIds) as Array<{ id: number; name: string }>
    const nameById = new Map(names.map((row) => [row.id, row.name]))

    for (const link of links) {
      const name = nameById.get(link.tagId)
      if (!name) continue
      const prev = result.get(link.assetKey)
      result.set(link.assetKey, prev ? `${prev} ${name}` : name)
    }
  } catch (error) {
    console.warn('[资产索引] 取标签名失败，这一批索引里不含标签文本:', error)
  }

  return result
}
