import Database from 'better-sqlite3'

// 资产-标签关联模型接口
export interface AssetTagMap {
  id?: number
  assetKey: string
  tagId: number
  created_at?: string
  updated_at?: string
}

const TABLE_NAME = 'asset_tags'

/**
 * 初始化资产-标签关联表
 * @param db 保管库数据库实例
 */
export const initAssetTagModel = (db: Database.Database): void => {
  const tableExists = db
    .prepare(
      `
    SELECT name FROM sqlite_master WHERE type='table' AND name=?
  `
    )
    .get(TABLE_NAME)

  if (!tableExists) {
    const createTableSQL = `
      CREATE TABLE ${TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetKey TEXT NOT NULL,
        tagId INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(assetKey, tagId)
      )
    `
    db.exec(createTableSQL)

    // 索引
    db.exec(`CREATE INDEX idx_asset_tags_assetKey ON ${TABLE_NAME}(assetKey)`)
    db.exec(`CREATE INDEX idx_asset_tags_tagId ON ${TABLE_NAME}(tagId)`)

    console.log(`资产标签关联表 ${TABLE_NAME} 创建成功`)
  }
}

/**
 * 为资产添加标签
 */
export const addAssetTag = (db: Database.Database, mapping: AssetTagMap): number => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO ${TABLE_NAME} (assetKey, tagId)
    VALUES (?, ?)
  `)
  const result = stmt.run(mapping.assetKey, mapping.tagId)
  return result.lastInsertRowid as number
}

/**
 * 移除资产的某个标签
 */
export const removeAssetTag = (db: Database.Database, assetKey: string, tagId: number): boolean => {
  const stmt = db.prepare(`
    DELETE FROM ${TABLE_NAME} WHERE assetKey = ? AND tagId = ?
  `)
  const result = stmt.run(assetKey, tagId)
  return result.changes > 0
}

/**
 * 这个标签挂在哪些资产上 —— **连回收站里的一起算**。
 *
 * 和 `getAssetsByTagId` 的区别就在这儿：那个为了给界面列资产，把已删除的资产和
 * 已删除文件夹里的资产都滤掉了。而合并/删除标签要动的是**全部关联行**：
 * 漏掉回收站里那些，标签一删，它们就指向一个不存在的 tagId —— 用户把资产恢复
 * 回来时标签已经烂了，而且没有任何地方会报错。
 */
export const getAssetKeysByTagId = (db: Database.Database, tagId: number): string[] => {
  const stmt = db.prepare(`SELECT assetKey FROM ${TABLE_NAME} WHERE tagId = ?`)
  return (stmt.all(tagId) as { assetKey: string }[]).map((row) => row.assetKey)
}

/**
 * 删掉一个标签的全部关联行。
 *
 * 标签表在公共库、关联表在保管库，跨库没有外键级联 —— 删标签时不主动清这一边，
 * 留下的就是一堆指向不存在标签的孤儿行。
 *
 * @returns 清掉了几行
 */
export const removeAllAssetTagsByTagId = (db: Database.Database, tagId: number): number => {
  const stmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE tagId = ?`)
  return stmt.run(tagId).changes
}

/**
 * 获取资产的标签ID列表
 */
export const getTagIdsByAssetKey = (db: Database.Database, assetKey: string): number[] => {
  const stmt = db.prepare(`
    SELECT tagId FROM ${TABLE_NAME} WHERE assetKey = ? ORDER BY tagId ASC
  `)
  const rows = stmt.all(assetKey) as { tagId: number }[]
  return rows.map((r) => r.tagId)
}

/**
 * 根据单个标签ID获取资产详细信息
 */
export const getAssetsByTagId = (db: Database.Database, tagId: number): any[] => {
  const stmt = db.prepare(`
    SELECT ad.* FROM assetData ad
    INNER JOIN ${TABLE_NAME} at ON ad.assetKey = at.assetKey
    INNER JOIN assetFolder fol ON ad.folderKey = fol.folderKey AND fol.isDelete = 0
    WHERE at.tagId = ? AND ad.isDelete = 0
    ORDER BY ad.assetName ASC
  `)
  return stmt.all(tagId)
}

/**
 * 根据任意一个标签ID集合获取资产（并集）
 */
export const getAssetsByAnyTag = (db: Database.Database, tagIds: number[]): any[] => {
  if (tagIds.length === 0) return []
  const placeholders = tagIds.map(() => '?').join(',')
  const stmt = db.prepare(`
    SELECT DISTINCT ad.* FROM assetData ad
    INNER JOIN ${TABLE_NAME} at ON ad.assetKey = at.assetKey
    INNER JOIN assetFolder fol ON ad.folderKey = fol.folderKey AND fol.isDelete = 0
    WHERE ad.isDelete = 0 AND at.tagId IN (${placeholders})
    ORDER BY ad.assetName ASC
  `)
  return stmt.all(...tagIds)
}

/**
 * 根据标签ID集合获取同时命中的资产（交集）
 */
export const getAssetsByAllTags = (db: Database.Database, tagIds: number[]): any[] => {
  if (tagIds.length === 0) return []
  const placeholders = tagIds.map(() => '?').join(',')
  const stmt = db.prepare(`
    SELECT ad.* FROM assetData ad
    INNER JOIN assetFolder fol ON ad.folderKey = fol.folderKey AND fol.isDelete = 0
    WHERE ad.assetKey IN (
      SELECT assetKey FROM ${TABLE_NAME}
      WHERE tagId IN (${placeholders})
      GROUP BY assetKey
      HAVING COUNT(DISTINCT tagId) = ?
    ) AND ad.isDelete = 0
    ORDER BY ad.assetName ASC
  `)
  return stmt.all(...tagIds, tagIds.length)
}

/**
 * 设置资产的标签（覆盖式）
 */
export const setTagsForAsset = (
  db: Database.Database,
  assetKey: string,
  tagIds: number[]
): { added: number; deleted: number } => {
  const deleteStmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE assetKey = ?`)
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ${TABLE_NAME} (assetKey, tagId) VALUES (?, ?)`
  )

  const transaction = db.transaction((assetKey: string, tagIds: number[]) => {
    const delResult = deleteStmt.run(assetKey)
    let added = 0
    for (const tagId of tagIds) {
      const res = insertStmt.run(assetKey, tagId)
      if ((res.changes || 0) > 0) added += 1
    }
    return { added, deleted: delResult.changes || 0 }
  })

  return transaction(assetKey, tagIds)
}

/**
 * 综合标签筛选（包含/排除/模式/按文件夹）
 */
export interface TagFilterOptions {
  includeTagIds?: number[]
  excludeTagIds?: number[]
  matchMode?: 'any' | 'all'
  folderKey?: string
}

export const filterAssetsByTags = (db: Database.Database, options: TagFilterOptions): any[] => {
  const include = Array.isArray(options.includeTagIds)
    ? options.includeTagIds.filter((n) => typeof n === 'number')
    : []
  const exclude = Array.isArray(options.excludeTagIds)
    ? options.excludeTagIds.filter((n) => typeof n === 'number')
    : []
  const mode = options.matchMode === 'all' ? 'all' : 'any'
  const folderKey = options.folderKey

  let sql = ''
  const params: any[] = []

  if (include.length > 0) {
    const includePlaceholders = include.map(() => '?').join(',')
    if (mode === 'all') {
      sql = `
        SELECT ad.* FROM assetData ad
        WHERE ${folderKey ? 'ad.folderKey = ? AND ' : ''} ad.isDelete = 0 AND ad.assetKey IN (
          SELECT assetKey FROM ${TABLE_NAME}
          WHERE tagId IN (${includePlaceholders})
          GROUP BY assetKey
          HAVING COUNT(DISTINCT tagId) = ?
        )
      `
      if (folderKey) params.push(folderKey)
      params.push(...include)
      params.push(include.length)
    } else {
      sql = `
        SELECT DISTINCT ad.* FROM assetData ad
        INNER JOIN ${TABLE_NAME} at ON ad.assetKey = at.assetKey
        WHERE ${folderKey ? 'ad.folderKey = ? AND ' : ''} ad.isDelete = 0 AND at.tagId IN (${includePlaceholders})
      `
      if (folderKey) params.push(folderKey)
      params.push(...include)
    }
  } else {
    sql = `
      SELECT ad.* FROM assetData ad
      WHERE ${folderKey ? 'ad.folderKey = ? AND ad.isDelete = 0' : 'ad.isDelete = 0'}
    `
    if (folderKey) params.push(folderKey)
  }

  if (exclude.length > 0) {
    const excludePlaceholders = exclude.map(() => '?').join(',')
    sql += `
      AND ad.assetKey NOT IN (
        SELECT assetKey FROM ${TABLE_NAME}
        WHERE tagId IN (${excludePlaceholders})
      )
    `
    params.push(...exclude)
  }

  sql += '\n    ORDER BY ad.assetName ASC\n  '

  const stmt = db.prepare(sql)
  return stmt.all(...params)
}

/**
 * 每个标签下挂着几个资产（已删除的不算）。
 *
 * 「这个库里的标签体系长什么样」要靠它来答：光有标签名看不出哪些是主力分类、
 * 哪些是一次性打的孤儿标签，而这正是决定「该复用哪个标签」的依据。
 *
 * @param db 保管库数据库实例（asset_tags 和 assetData 都在这个库里）
 */
export const getAssetCountsByTag = (
  db: Database.Database
): Array<{ tagId: number; count: number }> => {
  const stmt = db.prepare(`
    SELECT at.tagId AS tagId, COUNT(DISTINCT at.assetKey) AS count
    FROM ${TABLE_NAME} at
    JOIN assetData ad ON ad.assetKey = at.assetKey AND ad.isDelete = 0
    GROUP BY at.tagId
  `)
  return stmt.all() as Array<{ tagId: number; count: number }>
}

/**
 * 获取资产关联的标签名称列表
 * 用于网络库同步：将标签名称（而非ID）同步到网络清单
 */
export const getTagNamesByAssetKey = (db: Database.Database, assetKey: string): string[] => {
  const stmt = db.prepare(`
    SELECT t.name
    FROM ${TABLE_NAME} at
    JOIN tags t ON at.tagId = t.id
    WHERE at.assetKey = ?
    ORDER BY t.name ASC
  `)
  const rows = stmt.all(assetKey) as Array<{ name: string }>
  return rows.map((r) => r.name)
}
