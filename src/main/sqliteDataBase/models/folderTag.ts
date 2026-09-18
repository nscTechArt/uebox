import Database from 'better-sqlite3'

/**
 * 文件夹-标签关联模型接口
 */
export interface FolderTagMap {
  id?: number
  folderKey: string
  tagId: number
  created_at?: string
  updated_at?: string
}

const TABLE_NAME = 'folder_tags'

/**
 * 初始化文件夹-标签关联表
 * @param db 保管库数据库实例
 */
export const initFolderTagModel = (db: Database.Database): void => {
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
        folderKey TEXT NOT NULL,
        tagId INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(folderKey, tagId)
      )
    `
    db.exec(createTableSQL)

    // 索引
    db.exec(`CREATE INDEX idx_folder_tags_folderKey ON ${TABLE_NAME}(folderKey)`)
    db.exec(`CREATE INDEX idx_folder_tags_tagId ON ${TABLE_NAME}(tagId)`)

    console.log(`文件夹标签关联表 ${TABLE_NAME} 创建成功`)
  }
}

/**
 * 为文件夹添加标签
 * @param db 数据库实例
 * @param mapping 文件夹-标签映射
 * @returns 新增记录的ID
 */
export const addFolderTag = (db: Database.Database, mapping: FolderTagMap): number => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO ${TABLE_NAME} (folderKey, tagId)
    VALUES (?, ?)
  `)
  const result = stmt.run(mapping.folderKey, mapping.tagId)
  return result.lastInsertRowid as number
}

/**
 * 移除文件夹的某个标签
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @param tagId 标签ID
 * @returns 是否删除成功
 */
export const removeFolderTag = (
  db: Database.Database,
  folderKey: string,
  tagId: number
): boolean => {
  const stmt = db.prepare(`
    DELETE FROM ${TABLE_NAME} WHERE folderKey = ? AND tagId = ?
  `)
  const result = stmt.run(folderKey, tagId)
  return result.changes > 0
}

/**
 * 获取文件夹的标签ID列表
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @returns 标签ID数组
 */
export const getTagIdsByFolderKey = (db: Database.Database, folderKey: string): number[] => {
  const stmt = db.prepare(`
    SELECT tagId FROM ${TABLE_NAME} WHERE folderKey = ? ORDER BY tagId ASC
  `)
  const rows = stmt.all(folderKey) as { tagId: number }[]
  return rows.map((r) => r.tagId)
}

/**
 * 根据单个标签ID获取文件夹列表
 * @param db 数据库实例
 * @param tagId 标签ID
 * @returns 文件夹列表
 */
export const getFoldersByTagId = (db: Database.Database, tagId: number): unknown[] => {
  const stmt = db.prepare(`
    SELECT af.* FROM assetFolder af
    INNER JOIN ${TABLE_NAME} ft ON af.folderKey = ft.folderKey
    WHERE ft.tagId = ? AND af.isDelete = 0
    ORDER BY af.folderName ASC
  `)
  return stmt.all(tagId)
}

/**
 * 根据任意一个标签ID集合获取文件夹（并集）
 * @param db 数据库实例
 * @param tagIds 标签ID数组
 * @returns 文件夹列表
 */
export const getFoldersByAnyTag = (db: Database.Database, tagIds: number[]): unknown[] => {
  if (tagIds.length === 0) return []
  const placeholders = tagIds.map(() => '?').join(',')
  const stmt = db.prepare(`
    SELECT DISTINCT af.* FROM assetFolder af
    INNER JOIN ${TABLE_NAME} ft ON af.folderKey = ft.folderKey
    WHERE af.isDelete = 0 AND ft.tagId IN (${placeholders})
    ORDER BY af.folderName ASC
  `)
  return stmt.all(...tagIds)
}

/**
 * 根据标签ID集合获取同时命中的文件夹（交集）
 * @param db 数据库实例
 * @param tagIds 标签ID数组
 * @returns 文件夹列表
 */
export const getFoldersByAllTags = (db: Database.Database, tagIds: number[]): unknown[] => {
  if (tagIds.length === 0) return []
  const placeholders = tagIds.map(() => '?').join(',')
  const stmt = db.prepare(`
    SELECT af.* FROM assetFolder af
    WHERE af.folderKey IN (
      SELECT folderKey FROM ${TABLE_NAME}
      WHERE tagId IN (${placeholders})
      GROUP BY folderKey
      HAVING COUNT(DISTINCT tagId) = ?
    ) AND af.isDelete = 0
    ORDER BY af.folderName ASC
  `)
  return stmt.all(...tagIds, tagIds.length)
}

/**
 * 设置文件夹的标签（覆盖式）
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @param tagIds 新的标签ID数组
 * @returns 操作统计
 */
export const setTagsForFolder = (
  db: Database.Database,
  folderKey: string,
  tagIds: number[]
): { added: number; deleted: number } => {
  const deleteStmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE folderKey = ?`)
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ${TABLE_NAME} (folderKey, tagId) VALUES (?, ?)`
  )

  const transaction = db.transaction((folderKey: string, tagIds: number[]) => {
    const delResult = deleteStmt.run(folderKey)
    let added = 0
    for (const tagId of tagIds) {
      const res = insertStmt.run(folderKey, tagId)
      if ((res.changes || 0) > 0) added += 1
    }
    return { added, deleted: delResult.changes || 0 }
  })

  return transaction(folderKey, tagIds)
}

/**
 * 批量为文件夹添加标签
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @param tagIds 要添加的标签ID数组
 * @returns 添加的数量
 */
export const addTagsToFolder = (
  db: Database.Database,
  folderKey: string,
  tagIds: number[]
): number => {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ${TABLE_NAME} (folderKey, tagId) VALUES (?, ?)`
  )
  let added = 0
  for (const tagId of tagIds) {
    const res = insertStmt.run(folderKey, tagId)
    if ((res.changes || 0) > 0) added += 1
  }
  return added
}

/**
 * 批量从文件夹移除标签
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @param tagIds 要移除的标签ID数组
 * @returns 移除的数量
 */
export const removeTagsFromFolder = (
  db: Database.Database,
  folderKey: string,
  tagIds: number[]
): number => {
  if (tagIds.length === 0) return 0
  const placeholders = tagIds.map(() => '?').join(',')
  const stmt = db.prepare(`
    DELETE FROM ${TABLE_NAME} WHERE folderKey = ? AND tagId IN (${placeholders})
  `)
  const result = stmt.run(folderKey, ...tagIds)
  return result.changes
}

/**
 * 删除文件夹的所有标签关联（当文件夹被删除时使用）
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @returns 删除的记录数
 */
export const clearFolderTags = (db: Database.Database, folderKey: string): number => {
  const stmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE folderKey = ?`)
  const result = stmt.run(folderKey)
  return result.changes
}

/**
 * 获取带有特定标签的文件夹数量
 * @param db 数据库实例
 * @param tagId 标签ID
 * @returns 文件夹数量
 */
export const countFoldersWithTag = (db: Database.Database, tagId: number): number => {
  const stmt = db.prepare(`
    SELECT COUNT(DISTINCT ft.folderKey) as count FROM ${TABLE_NAME} ft
    INNER JOIN assetFolder af ON ft.folderKey = af.folderKey
    WHERE ft.tagId = ? AND af.isDelete = 0
  `)
  const result = stmt.get(tagId) as { count: number }
  return result.count
}
