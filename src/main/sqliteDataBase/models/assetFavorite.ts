import Database from 'better-sqlite3'

/**
 * 收藏项类型：资产或文件夹
 */
export type FavoriteItemType = 'asset' | 'folder'

// 资产收藏模型接口
export interface AssetFavorite {
  id?: number
  assetKey: string // 资产唯一标识（资产的assetKey或文件夹的folderKey）
  itemType?: FavoriteItemType // 收藏项类型: 'asset' | 'folder'
  userId?: number // 用户ID（预留字段，当前版本可为空）
  vaultId?: string // 保管库ID（预留字段）
  created_at?: string
  updated_at?: string
}

// 资产收藏表名
const TABLE_NAME = 'asset_favorites'

/**
 * 初始化资产收藏模型（创建收藏表）
 * @param db 数据库实例
 */
export const initAssetFavoriteModel = (db: Database.Database): void => {
  // 检查表是否存在
  const tableExists = db
    .prepare(
      `
    SELECT name FROM sqlite_master WHERE type='table' AND name=?
  `
    )
    .get(TABLE_NAME)

  if (!tableExists) {
    // 创建新表（包含 itemType 字段）
    const createTableSQL = `
      CREATE TABLE ${TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetKey TEXT NOT NULL,
        itemType TEXT DEFAULT 'asset',
        userId INTEGER,
        vaultId TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(assetKey, itemType, userId, vaultId)
      )
    `
    db.exec(createTableSQL)

    // 创建索引以优化查询性能
    db.exec(`CREATE INDEX idx_asset_favorites_assetKey ON ${TABLE_NAME}(assetKey)`)
    db.exec(`CREATE INDEX idx_asset_favorites_itemType ON ${TABLE_NAME}(itemType)`)
    db.exec(`CREATE INDEX idx_asset_favorites_userId ON ${TABLE_NAME}(userId)`)
    db.exec(`CREATE INDEX idx_asset_favorites_vaultId ON ${TABLE_NAME}(vaultId)`)

    console.log(`资产收藏表 ${TABLE_NAME} 创建成功`)
  } else {
    // 表存在，检查是否需要迁移
    migrateAssetFavoriteTable(db)
  }
}

/**
 * 迁移资产收藏表：添加 itemType 列（如果不存在）
 * @param db 数据库实例
 */
const migrateAssetFavoriteTable = (db: Database.Database): void => {
  try {
    // 检查 itemType 列是否存在
    const columnInfo = db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all() as Array<{
      name: string
    }>
    const hasItemTypeColumn = columnInfo.some((col) => col.name === 'itemType')

    if (!hasItemTypeColumn) {
      console.log(`正在为 ${TABLE_NAME} 表添加 itemType 字段...`)

      // 添加 itemType 字段，默认值为 'asset'
      db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN itemType TEXT DEFAULT 'asset'`)

      // 为现有记录设置默认值
      db.exec(`UPDATE ${TABLE_NAME} SET itemType = 'asset' WHERE itemType IS NULL`)

      // 创建索引（如果不存在）
      try {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_asset_favorites_itemType ON ${TABLE_NAME}(itemType)`
        )
      } catch {
        // 索引可能已存在，忽略错误
        console.log('索引 idx_asset_favorites_itemType 可能已存在')
      }

      console.log(`资产收藏表 ${TABLE_NAME} 已迁移，添加了 itemType 字段`)
    } else {
      console.log(`资产收藏表 ${TABLE_NAME} 已包含 itemType 字段，无需迁移`)
    }
  } catch (error) {
    console.error(`迁移 ${TABLE_NAME} 表失败:`, error)
  }
}

/**
 * 添加资产或文件夹到收藏
 * @param db 数据库实例
 * @param favorite 收藏信息
 * @returns 收藏记录ID
 */
export const addAssetFavorite = (db: Database.Database, favorite: AssetFavorite): number => {
  const itemType = favorite.itemType || 'asset'
  const stmt = db.prepare(`
    INSERT INTO ${TABLE_NAME} (assetKey, itemType, userId, vaultId)
    VALUES (?, ?, ?, ?)
  `)

  const result = stmt.run(
    favorite.assetKey,
    itemType,
    favorite.userId || null,
    favorite.vaultId || null
  )
  return result.lastInsertRowid as number
}

/**
 * 从收藏中移除资产或文件夹
 * @param db 数据库实例
 * @param assetKey 资产键值或文件夹键值
 * @param userId 用户ID（可选）
 * @param vaultId 保管库ID（可选）
 * @param itemType 收藏项类型（可选，默认为 'asset'）
 * @returns 是否删除成功
 */
export const removeAssetFavorite = (
  db: Database.Database,
  assetKey: string,
  userId?: number,
  vaultId?: string,
  itemType?: FavoriteItemType
): boolean => {
  const type = itemType || 'asset'
  const stmt = db.prepare(`
    DELETE FROM ${TABLE_NAME}
    WHERE assetKey = ? AND itemType = ? AND (userId IS ? OR userId IS NULL) AND (vaultId IS ? OR vaultId IS NULL)
  `)

  const result = stmt.run(assetKey, type, userId || null, vaultId || null)
  return result.changes > 0
}

/**
 * 检查资产或文件夹是否已收藏
 * @param db 数据库实例
 * @param assetKey 资产键值或文件夹键值
 * @param userId 用户ID（可选）
 * @param vaultId 保管库ID（可选）
 * @param itemType 收藏项类型（可选，默认为 'asset'）
 * @returns 是否已收藏
 */
export const isAssetFavorited = (
  db: Database.Database,
  assetKey: string,
  userId?: number,
  vaultId?: string,
  itemType?: FavoriteItemType
): boolean => {
  const type = itemType || 'asset'
  const stmt = db.prepare(`
    SELECT 1 FROM ${TABLE_NAME}
    WHERE assetKey = ? AND itemType = ? AND (userId IS ? OR userId IS NULL) AND (vaultId IS ? OR vaultId IS NULL)
  `)

  const result = stmt.get(assetKey, type, userId || null, vaultId || null)
  return !!result
}

/**
 * 获取用户的所有收藏资产
 * @param db 数据库实例
 * @param userId 用户ID（可选）
 * @param vaultId 保管库ID（可选）
 * @returns 收藏列表
 */
export const getUserFavorites = (
  db: Database.Database,
  userId?: number,
  vaultId?: string
): AssetFavorite[] => {
  const stmt = db.prepare(`
    SELECT * FROM ${TABLE_NAME}
    WHERE (userId IS ? OR userId IS NULL) AND (vaultId IS ? OR vaultId IS NULL)
    ORDER BY created_at DESC
  `)

  return stmt.all(userId || null, vaultId || null) as AssetFavorite[]
}

/**
 * 获取收藏的资产键值列表（仅资产，不含文件夹）
 * @param db 数据库实例
 * @param userId 用户ID（可选）
 * @param vaultId 保管库ID（可选）
 * @returns 资产键值数组
 */
export const getFavoriteAssetKeys = (
  db: Database.Database,
  userId?: number,
  vaultId?: string
): string[] => {
  const stmt = db.prepare(`
    SELECT assetKey FROM ${TABLE_NAME}
    WHERE itemType = 'asset' AND (userId IS ? OR userId IS NULL) AND (vaultId IS ? OR vaultId IS NULL)
    ORDER BY created_at DESC
  `)

  const results = stmt.all(userId || null, vaultId || null) as { assetKey: string }[]
  return results.map((row) => row.assetKey)
}

/**
 * 获取收藏的文件夹键值列表
 * @param db 数据库实例
 * @param userId 用户ID（可选）
 * @param vaultId 保管库ID（可选）
 * @returns 文件夹键值数组
 */
export const getFavoriteFolderKeys = (
  db: Database.Database,
  userId?: number,
  vaultId?: string
): string[] => {
  const stmt = db.prepare(`
    SELECT assetKey FROM ${TABLE_NAME}
    WHERE itemType = 'folder' AND (userId IS ? OR userId IS NULL) AND (vaultId IS ? OR vaultId IS NULL)
    ORDER BY created_at DESC
  `)

  const results = stmt.all(userId || null, vaultId || null) as { assetKey: string }[]
  return results.map((row) => row.assetKey)
}

/**
 * 批量检查资产收藏状态
 * @param db 数据库实例
 * @param assetKeys 资产键值数组
 * @param userId 用户ID（可选）
 * @param vaultId 保管库ID（可选）
 * @returns 收藏状态映射 { assetKey: boolean }
 */
export const batchCheckFavoriteStatus = (
  db: Database.Database,
  assetKeys: string[],
  userId?: number,
  vaultId?: string
): Record<string, boolean> => {
  if (assetKeys.length === 0) return {}

  const placeholders = assetKeys.map(() => '?').join(',')
  const stmt = db.prepare(`
    SELECT assetKey FROM ${TABLE_NAME}
    WHERE assetKey IN (${placeholders})
    AND (userId IS ? OR userId IS NULL)
    AND (vaultId IS ? OR vaultId IS NULL)
  `)

  const favoriteKeys = stmt.all(...assetKeys, userId || null, vaultId || null) as {
    assetKey: string
  }[]
  const favoriteSet = new Set(favoriteKeys.map((row) => row.assetKey))

  const result: Record<string, boolean> = {}
  assetKeys.forEach((key) => {
    result[key] = favoriteSet.has(key)
  })

  return result
}

/**
 * 获取收藏总数
 * @param db 数据库实例
 * @param userId 用户ID（可选）
 * @param vaultId 保管库ID（可选）
 * @returns 收藏总数
 */
export const getFavoriteCount = (
  db: Database.Database,
  userId?: number,
  vaultId?: string
): number => {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM ${TABLE_NAME}
    WHERE (userId IS ? OR userId IS NULL) AND (vaultId IS ? OR vaultId IS NULL)
  `)

  const result = stmt.get(userId || null, vaultId || null) as { count: number }
  return result.count
}

/**
 * 清空用户的所有收藏
 * @param db 数据库实例
 * @param userId 用户ID（可选）
 * @param vaultId 保管库ID（可选）
 * @returns 删除的记录数
 */
export const clearUserFavorites = (
  db: Database.Database,
  userId?: number,
  vaultId?: string
): number => {
  const stmt = db.prepare(`
    DELETE FROM ${TABLE_NAME}
    WHERE (userId IS ? OR userId IS NULL) AND (vaultId IS ? OR vaultId IS NULL)
  `)

  const result = stmt.run(userId || null, vaultId || null)
  return result.changes
}
