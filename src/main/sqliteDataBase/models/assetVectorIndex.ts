/**
 * 资产库的语义检索索引（sqlite-vec）。
 *
 * 全文索引解决不了这个问题：用户的资产名几乎都是英文（SM_Chair_Wood、
 * T_Wood_Diffuse），而用户用中文问「有没有椅子」。字面上这两个字符串
 * 一个字都不重合，倒排索引再快也匹配不上。
 *
 * 以前的兜底是「中文没命中就随机回 20 个资产让调用方照着猜英文词」——
 * 能用，但它把认词这件事摊派给了每一次对话，而且猜不中就得再猜一轮。
 * 语义索引是把这件事一次性做掉：给每个资产算一张「资产卡」的向量
 * （名字 + 类型 + 文件夹 + 标签 + 备注），查询也算成向量，比的是意思不是字面。
 *
 * ## 为什么是可选的、默认关的
 *
 * 算向量要调 embedding 模型。几十万个资产就是几十万次调用 —— 走云端要花钱、
 * 要很久；走本地 Ollama 不花钱但要用户先装。这个代价必须由用户自己决定值不值，
 * 不能替他做主，所以做成资产库设置里的一个开关，默认关闭。
 *
 * **关掉的时候不留任何痕迹**：触发器删掉、队列清空、向量表删掉。
 * 不做「关了但还在后台悄悄记账」这种事。
 */

import Database from 'better-sqlite3'
import { ensureSqliteVecLoaded } from '../sqliteVec'

export const VECTOR_TABLE = 'asset_vectors'
export const VECTOR_DIRTY_TABLE = 'assetVectorDirty'
const DIM_KEY = 'asset_vector_dim'

/** 触发器名字集中在这里，开和关必须动同一组 */
const TRIGGERS = [
  'assetData_vec_insert',
  'assetData_vec_update',
  'assetData_vec_delete',
  'asset_tags_vec_insert',
  'asset_tags_vec_delete'
]

export interface AssetVectorStatus {
  enabled: boolean
  /** sqlite-vec 扩展在这个连接上加载成功了没有。没有的话语义搜索整个不可用 */
  available: boolean
  /** 向量维度。0 = 还没建表 */
  dimension: number
  indexed: number
  pending: number
  total: number
  ready: boolean
}

/** 向量表建表时就把维度写死了，换模型必须重建 —— 维度记在保管库元数据里 */
function readDimension(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT value FROM vault_metadata WHERE key = ?').get(DIM_KEY) as
      | { value?: string }
      | undefined
    return Number(row?.value ?? 0) || 0
  } catch {
    return 0
  }
}

function writeDimension(db: Database.Database, dimension: number): void {
  db.prepare(
    `INSERT INTO vault_metadata (key, value, type) VALUES (?, ?, 'number')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = datetime('now', 'localtime')`
  ).run(DIM_KEY, String(dimension))
}

export function isAssetVectorEnabled(db: Database.Database): boolean {
  try {
    return !!db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(VECTOR_DIRTY_TABLE)
  } catch {
    return false
  }
}

/**
 * 打开语义索引：建向量表、建队列、挂触发器，并把整个库排进队列。
 *
 * @param dimension embedding 模型的输出维度。和已有的对不上就**重建** ——
 *   维度不一致时 sqlite-vec 的插入会失败，而失败是静默的（只 warn 一句），
 *   于是索引看起来在跑、实际一条都没进去。
 */
export function enableAssetVectorIndex(
  db: Database.Database,
  dimension: number
): { ok: boolean; error?: string } {
  const dim = Math.floor(dimension)
  if (!Number.isFinite(dim) || dim <= 0) {
    return { ok: false, error: `向量维度不合法：${dimension}` }
  }

  if (!ensureSqliteVecLoaded(db)) {
    return {
      ok: false,
      error: 'sqlite-vec 扩展没能加载，这台机器上用不了语义搜索。关键词搜索不受影响。'
    }
  }

  try {
    const currentDim = readDimension(db)
    if (currentDim !== dim) {
      // 维度变了（换了 embedding 模型）：旧向量全部作废，留着只会让检索结果变成噪声
      db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`)
    }
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(embedding float[${dim}])`
    )
    writeDimension(db, dim)

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${VECTOR_DIRTY_TABLE} (assetId INTEGER PRIMARY KEY);

      CREATE TRIGGER IF NOT EXISTS assetData_vec_insert AFTER INSERT ON assetData BEGIN
        INSERT OR REPLACE INTO ${VECTOR_DIRTY_TABLE}(assetId) VALUES (new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS assetData_vec_update AFTER UPDATE ON assetData BEGIN
        INSERT OR REPLACE INTO ${VECTOR_DIRTY_TABLE}(assetId) VALUES (new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS assetData_vec_delete AFTER DELETE ON assetData BEGIN
        INSERT OR REPLACE INTO ${VECTOR_DIRTY_TABLE}(assetId) VALUES (old.id);
      END;
      CREATE TRIGGER IF NOT EXISTS asset_tags_vec_insert AFTER INSERT ON asset_tags BEGIN
        INSERT OR REPLACE INTO ${VECTOR_DIRTY_TABLE}(assetId)
          SELECT id FROM assetData WHERE assetKey = new.assetKey;
      END;
      CREATE TRIGGER IF NOT EXISTS asset_tags_vec_delete AFTER DELETE ON asset_tags BEGIN
        INSERT OR REPLACE INTO ${VECTOR_DIRTY_TABLE}(assetId)
          SELECT id FROM assetData WHERE assetKey = old.assetKey;
      END;
    `)

    // 已经有向量的不用重算 —— 只把缺的排进队列。换维度时上面刚 DROP 过，
    // 这里自然就是全量了。
    db.exec(`
      INSERT OR REPLACE INTO ${VECTOR_DIRTY_TABLE}(assetId)
      SELECT id FROM assetData
      WHERE isDelete = 0 AND id NOT IN (SELECT rowid FROM ${VECTOR_TABLE})
    `)

    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 关掉语义索引：触发器、队列、向量表全部删掉。
 *
 * 不留半吊子状态。用户关掉之后再打开就是重新建一遍 —— 多花一次钱，
 * 但换来的是「关掉就是真的关掉了」，没有后台还在偷偷记账这回事。
 */
export function disableAssetVectorIndex(db: Database.Database): void {
  try {
    for (const trigger of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
    db.exec(`DROP TABLE IF EXISTS ${VECTOR_DIRTY_TABLE}`)
    db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`)
    db.prepare('DELETE FROM vault_metadata WHERE key = ?').run(DIM_KEY)
  } catch (error) {
    console.warn('[资产语义索引] 关闭时清理失败:', error)
  }
}

export function getAssetVectorStatus(db: Database.Database): AssetVectorStatus {
  const enabled = isAssetVectorEnabled(db)
  const total = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM assetData WHERE isDelete = 0').get() as { n: number }).n
  )
  if (!enabled) {
    return {
      enabled: false,
      available: ensureSqliteVecLoaded(db),
      dimension: 0,
      indexed: 0,
      pending: 0,
      total,
      ready: false
    }
  }

  const pending = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM ${VECTOR_DIRTY_TABLE}`).get() as { n: number }).n
  )
  let indexed = 0
  try {
    indexed = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${VECTOR_TABLE}`).get() as { n: number }).n
    )
  } catch {
    indexed = 0
  }

  return {
    enabled: true,
    available: ensureSqliteVecLoaded(db),
    dimension: readDimension(db),
    indexed,
    pending,
    total,
    ready: pending === 0 && indexed > 0
  }
}

export interface PendingAsset {
  id: number
  assetKey: string
  /** 拼好的「资产卡」文本，直接送去算向量 */
  card: string
  /** 这条资产已经不在了（软删或真删），只需要把向量删掉 */
  gone: boolean
}

/**
 * 取一批待算向量的资产，连「资产卡」文本一起拼好。
 *
 * 卡片里塞什么是有讲究的：**名字 + 标签 + 备注**是用户真正会拿来找东西的信息，
 * 路径和类型放在后面兜底。全塞进去比只塞名字好得多 —— 「SM_Chair_Wood」
 * 单看几乎没有语义，加上文件夹「家具」和标签「木质」之后才对得上「木头椅子」。
 */
export function takePendingVectorAssets(
  db: Database.Database,
  publicDb: Database.Database | undefined,
  budget: number
): PendingAsset[] {
  const dirty = db
    .prepare(`SELECT assetId FROM ${VECTOR_DIRTY_TABLE} ORDER BY assetId LIMIT ?`)
    .all(Math.max(1, Math.floor(budget))) as Array<{ assetId: number }>
  if (dirty.length === 0) return []

  const ids = dirty.map((row) => row.assetId)
  const rows = db
    .prepare(
      `SELECT id, assetKey, assetName, folderName, assetType, classNameCn, note, softPath, isDelete
         FROM assetData WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as Array<{
    id: number
    assetKey: string
    assetName: string | null
    folderName: string | null
    assetType: string | null
    classNameCn: string | null
    note: string | null
    softPath: string | null
    isDelete: number
  }>

  const byId = new Map(rows.map((row) => [row.id, row]))
  const liveKeys = rows.filter((row) => row.isDelete === 0).map((row) => row.assetKey)
  const tagText = collectTagText(db, publicDb, liveKeys)

  return ids.map((id) => {
    const row = byId.get(id)
    if (!row || row.isDelete !== 0) {
      return { id, assetKey: row?.assetKey ?? '', card: '', gone: true }
    }
    const tags = tagText.get(row.assetKey)
    const card = [
      row.assetName,
      row.classNameCn || row.assetType,
      row.folderName ? `文件夹 ${row.folderName}` : '',
      tags ? `标签 ${tags}` : '',
      row.note ? `备注 ${row.note}` : '',
      row.softPath
    ]
      .filter((part) => part && String(part).trim())
      .join('；')
    return { id, assetKey: row.assetKey, card, gone: false }
  })
}

/** 把算好的向量写回去，并把这批从队列里划掉 */
export function commitVectors(
  db: Database.Database,
  entries: Array<{ id: number; embedding: number[] | null }>
): void {
  if (entries.length === 0) return
  const del = db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE rowid = ?`)
  const ins = db.prepare(`INSERT INTO ${VECTOR_TABLE} (rowid, embedding) VALUES (?, ?)`)
  const clear = db.prepare(`DELETE FROM ${VECTOR_DIRTY_TABLE} WHERE assetId = ?`)

  db.transaction(() => {
    for (const entry of entries) {
      // better-sqlite3 binds JS numbers as REAL; vec0 primary keys require INTEGER.
      const assetId = BigInt(entry.id)
      del.run(assetId)
      if (entry.embedding && entry.embedding.length > 0) {
        ins.run(assetId, JSON.stringify(entry.embedding))
      }
      clear.run(assetId)
    }
  })()
}

/**
 * 用查询向量取最近的 k 个资产 id，**按相关度从近到远**。
 *
 * 这里不做任何筛选 —— 筛选交给主查询去做。分开是因为向量表只认 rowid，
 * 在它上面拼文件夹/标签条件既拼不出来也没索引可用。
 */
export function searchAssetVectors(
  db: Database.Database,
  embedding: number[],
  k: number
): number[] {
  if (!isAssetVectorEnabled(db) || embedding.length === 0) return []
  try {
    const rows = db
      .prepare(
        `SELECT rowid AS assetId FROM ${VECTOR_TABLE}
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      )
      .all(JSON.stringify(embedding), Math.max(1, Math.floor(k))) as Array<{ assetId: number }>
    return rows.map((row) => row.assetId)
  } catch (error) {
    console.warn('[资产语义索引] 向量检索失败，这次只走关键词:', error)
    return []
  }
}

/** 标签关联在保管库、名字在公共库，跨库 JOIN 不行，只能分两步 */
function collectTagText(
  db: Database.Database,
  publicDb: Database.Database | undefined,
  assetKeys: string[]
): Map<string, string> {
  const result = new Map<string, string>()
  if (!publicDb || assetKeys.length === 0) return result
  try {
    const links = db
      .prepare(
        `SELECT assetKey, tagId FROM asset_tags WHERE assetKey IN (${assetKeys.map(() => '?').join(',')})`
      )
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
      result.set(link.assetKey, prev ? `${prev}、${name}` : name)
    }
  } catch (error) {
    console.warn('[资产语义索引] 取标签名失败，这一批资产卡里不含标签:', error)
  }
  return result
}
