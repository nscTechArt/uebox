import Database from 'better-sqlite3'

import { deletionStamp } from './assetData'

// 资产文件夹模型接口
export interface AssetFolder {
  [key: string]: unknown
  id?: number
  folderKey: string
  fatherKey?: string | null
  img?: string
  type: string
  folderName: string
  fullPath?: string // 完整路径字符串，如："/root/folder1/subfolder"
  pathArray?: string // 路径key数组的JSON字符串，如：'["root_key", "folder1_key", "subfolder_key"]'
  depth?: number // 节点深度，根节点为0
  ancestorKeys?: string // 所有祖先节点key的JSON数组字符串
  isDelete?: number
  /** 进回收站的时刻；一次删除里整棵子树盖同一个值（见 assetData.deletionStamp） */
  deletedAt?: string | null
  created_at?: string
  updated_at?: string
  hasChildren?: boolean // 是否有子文件夹（运行时计算）
  color?: string // 用户自定义颜色（十六进制格式，如 #FF5733）
  note?: string // 一句话备注（纯文本）。和资产的 note 一样，保持纯文本
  noteId?: number | null // 关联的富文本说明书，指向 note 表；没写过就是 null
}

/**
 * 数据库查询返回的原始行类型（hasChildren 为数字 0/1）
 * 用于类型断言，避免与 AssetFolder.hasChildren: boolean 冲突
 */
interface AssetFolderDbRow extends Omit<AssetFolder, 'hasChildren'> {
  hasChildren: number
}

// 文件夹表名
const TABLE_NAME = 'assetFolder'

/**
 * 初始化资产文件夹模型（创建文件夹表）
 * @param db 数据库实例
 */
export const initAssetFolderModel = (db: Database.Database): void => {
  // 创建资产文件夹表
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderKey TEXT NOT NULL UNIQUE,
      fatherKey TEXT,
      img TEXT,
      type TEXT NOT NULL,
      folderName TEXT NOT NULL,
      fullPath TEXT,
      pathArray TEXT,
      depth INTEGER DEFAULT 0,
      ancestorKeys TEXT,
      isDelete INTEGER NOT NULL DEFAULT 0,
      deletedAt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (fatherKey) REFERENCES ${TABLE_NAME}(folderKey) ON DELETE CASCADE
    )
  `

  db.exec(createTableSQL)

  // 添加索引以提高查询性能
  const createIndexSQL = `
    CREATE INDEX IF NOT EXISTS idx_assetFolder_fullPath ON ${TABLE_NAME}(fullPath);
    CREATE INDEX IF NOT EXISTS idx_assetFolder_depth ON ${TABLE_NAME}(depth);
    CREATE INDEX IF NOT EXISTS idx_assetFolder_fatherKey ON ${TABLE_NAME}(fatherKey);
    CREATE INDEX IF NOT EXISTS idx_assetFolder_isDelete ON ${TABLE_NAME}(isDelete);
  `

  db.exec(createIndexSQL)

  // 检查并添加缺失的列（数据库迁移）
  const columns = db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all() as { name: string }[]
  const existingColumns = columns.map((col) => col.name)

  // 需要迁移的新列
  const newColumns = [
    { name: 'color', type: 'TEXT' },
    { name: 'note', type: 'TEXT' },
    { name: 'noteId', type: 'INTEGER' },
    // 进回收站的时刻（老库补列后为 NULL，排序时退回 updated_at）
    { name: 'deletedAt', type: 'TEXT' }
  ]

  for (const column of newColumns) {
    if (!existingColumns.includes(column.name)) {
      try {
        db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN ${column.name} ${column.type}`)
        console.log(`添加列 ${column.name} 到表 ${TABLE_NAME}`)
      } catch (error) {
        console.warn(`添加列 ${column.name} 失败:`, error)
      }
    }
  }

  console.log(`资产文件夹表 ${TABLE_NAME} 初始化完成`)
}

/**
 * 创建文件夹
 * @param db 数据库实例
 * @param folder 文件夹数据
 * @returns 创建的文件夹ID
 */
export const createAssetFolder = (db: Database.Database, folder: AssetFolder): number => {
  const { folderKey, fatherKey, img, type, folderName } = folder

  // 计算路径相关字段
  let fullPath = `/${folderName}`
  let pathArray = JSON.stringify([folderKey])
  let depth = 0
  let ancestorKeys = JSON.stringify([])

  // 如果有父文件夹，获取父文件夹信息来构建路径
  if (fatherKey) {
    const parentFolder = getAssetFolderByKey(db, fatherKey)
    if (parentFolder) {
      // 🔧 修复：当父级是 ALL（fullPath='/'）时，避免双斜杠问题
      const parentPath = parentFolder.fullPath || ''
      if (parentPath === '/' || parentPath === '') {
        // 父级是根目录，直接用 /folderName
        fullPath = `/${folderName}`
      } else {
        // 父级是普通文件夹，拼接路径
        fullPath = `${parentPath}/${folderName}`
      }
      const parentPathArray = parentFolder.pathArray ? JSON.parse(parentFolder.pathArray) : []
      pathArray = JSON.stringify([...parentPathArray, folderKey])
      depth = (parentFolder.depth || 0) + 1
      ancestorKeys = JSON.stringify([...parentPathArray])
    }
  }

  const stmt = db.prepare(`
    INSERT INTO ${TABLE_NAME} (folderKey, fatherKey, img, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const result = stmt.run(
    folderKey,
    fatherKey,
    img,
    type,
    folderName,
    fullPath,
    pathArray,
    depth,
    ancestorKeys,
    folder.isDelete ?? 0
  )
  return result.lastInsertRowid as number
}

/**
 * 根据folderKey获取文件夹
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @returns 文件夹信息
 */
export const getAssetFolderByKey = (
  db: Database.Database,
  folderKey: string
): AssetFolder | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE folderKey = ? AND isDelete = 0`)
  return stmt.get(folderKey) as AssetFolder | undefined
}

/**
 * 根据文件夹名称和父级键值获取文件夹（用于去重检查）
 * @param db 数据库实例
 * @param folderName 文件夹名称
 * @param fatherKey 父文件夹键值（null 或 'ALL' 表示根级）
 * @returns 文件夹信息
 */
export const getAssetFolderByNameAndParent = (
  db: Database.Database,
  folderName: string,
  fatherKey: string | null
): AssetFolder | undefined => {
  // 处理父级为 null 或 'ALL' 的情况
  if (!fatherKey || fatherKey === 'ALL') {
    const stmt = db.prepare(`
      SELECT * FROM ${TABLE_NAME}
      WHERE folderName = ? AND (fatherKey IS NULL OR fatherKey = 'ALL') AND isDelete = 0
    `)
    return stmt.get(folderName) as AssetFolder | undefined
  }
  const stmt = db.prepare(`
    SELECT * FROM ${TABLE_NAME}
    WHERE folderName = ? AND fatherKey = ? AND isDelete = 0
  `)
  return stmt.get(folderName, fatherKey) as AssetFolder | undefined
}

/**
 * 同父级下有同名文件夹就复用，没有才新建
 *
 * 同一个目录被导入两次（比如在虚幻里点了两次「导入到盒子」）必须落到同一个文件夹上：
 * 文件夹的物理位置是「父路径 + 文件夹名」，同名兄弟本来就指向同一个磁盘目录，
 * 库里建两条只会让树里多出一个空壳，资产还是一份。
 *
 * @param db 数据库实例
 * @param folder 文件夹数据，`folderKey` 只在确实要新建时才会被用上
 * @returns 最终生效的 folderKey，以及这次是不是新建的
 */
export const findOrCreateAssetFolder = (
  db: Database.Database,
  folder: AssetFolder
): { folderKey: string; created: boolean } => {
  const existing = getAssetFolderByNameAndParent(db, folder.folderName, folder.fatherKey ?? null)
  if (existing) {
    // 复用的可能是更早一次导入建的，那时还没识别出插件图标 —— 补上
    if (folder.img && !existing.img) {
      db.prepare(`UPDATE ${TABLE_NAME} SET img = ?, type = ? WHERE folderKey = ?`).run(
        folder.img,
        folder.type,
        existing.folderKey
      )
    }
    return { folderKey: existing.folderKey, created: false }
  }

  createAssetFolder(db, folder)
  return { folderKey: folder.folderKey, created: true }
}

/**
 * 根据完整路径获取文件夹
 * @param db 数据库实例
 * @param fullPath 文件夹完整路径
 * @returns 文件夹信息
 */
export const getAssetFolderByPath = (
  db: Database.Database,
  fullPath: string
): AssetFolder | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE fullPath = ? AND isDelete = 0`)
  return stmt.get(fullPath) as AssetFolder | undefined
}

/**
 * 根据父级folderKey获取子文件夹列表
 * @param db 数据库实例
 * @param fatherKey 父级文件夹键值
 * @param sortBy 排序字段
 * @param sortOrder 排序顺序
 * @returns 子文件夹列表（包含 hasChildren 字段）
 */
export const getAssetFoldersByFatherKey = (
  db: Database.Database,
  fatherKey: string | null,
  sortBy: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType' = 'assetName',
  sortOrder: 'asc' | 'desc' = 'asc',
  limit?: number,
  offset?: number
): AssetFolder[] => {
  // 映射排序字段：folderName -> folderName, modifiedTime -> updated_at, fileSize -> (文件夹没有大小，通常按名称或默认)
  // 这里简单处理：如果是fileSize，则按folderName排（或者后续添加文件夹大小统计）
  // 目前保持与AssetData一致的参数接口，但内部映射到文件夹字段
  let dbSortCol = 'folderName'
  if (sortBy === 'modifiedTime') dbSortCol = 'updated_at'
  else if (sortBy === 'assetName') dbSortCol = 'folderName'
  // fileSize 对文件夹暂无意义，回退到 folderName

  const validOrders = ['asc', 'desc']
  const safeSortOrder = validOrders.includes(sortOrder.toLowerCase())
    ? sortOrder.toUpperCase()
    : 'ASC'

  const orderByClause =
    dbSortCol === 'folderName'
      ? `${dbSortCol} COLLATE NOCASE ${safeSortOrder}`
      : `${dbSortCol} ${safeSortOrder}`

  // 使用子查询一次性计算 hasChildren，零额外开销
  // For ALL, include legacy orphan folders but keep each folderKey visible.
  const isALL = fatherKey === 'ALL'
  const limitClause =
    typeof limit === 'number' ? `LIMIT ? ${typeof offset === 'number' ? 'OFFSET ?' : ''}` : ''
  const stmt = db.prepare(`
    SELECT
      af.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM ${TABLE_NAME} child
        WHERE child.fatherKey = af.folderKey AND child.isDelete = 0
      ) THEN 1 ELSE 0 END AS hasChildren
    FROM ${TABLE_NAME} af
    WHERE (
      af.fatherKey = ?
      ${isALL ? `OR (af.fatherKey IS NULL AND af.folderKey != 'ALL' AND af.isDelete = 0)` : ''}
    ) AND af.isDelete = 0
    ORDER BY ${orderByClause}
    ${limitClause}
  `)
  const params: Array<string | number | null> = [fatherKey]
  if (typeof limit === 'number') {
    params.push(limit)
    if (typeof offset === 'number') {
      params.push(offset)
    }
  }
  const rows = stmt.all(...params) as AssetFolderDbRow[]

  // 转换 hasChildren 从数字到布尔值
  return rows.map(
    (row) =>
      ({
        ...row,
        hasChildren: row.hasChildren === 1
      }) as AssetFolder
  )
}

/**
 * Get the direct child folder count for a folder key.
 * For ALL, orphan folders are counted as direct children as well.
 */
export const getChildFolderCount = (db: Database.Database, fatherKey: string | null): number => {
  const isAllFolder = fatherKey === 'ALL'
  const stmt = db.prepare(`
    SELECT COUNT(DISTINCT af.folderKey) as count
    FROM ${TABLE_NAME} af
    WHERE (
      af.fatherKey = ?
      ${isAllFolder ? `OR (af.fatherKey IS NULL AND af.folderKey != 'ALL' AND af.isDelete = 0)` : ''}
    ) AND af.isDelete = 0
  `)
  const result = stmt.get(fatherKey) as { count: number }
  return result.count || 0
}

/**
 * 获取根级文件夹列表
 * @param db 数据库实例
 * @param sortBy 排序字段
 * @param sortOrder 排序顺序
 * @returns 根级文件夹列表（包含 hasChildren 字段）
 */
export const getRootAssetFolders = (
  db: Database.Database,
  sortBy: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType' = 'assetName',
  sortOrder: 'asc' | 'desc' = 'asc'
): AssetFolder[] => {
  let dbSortCol = 'folderName'
  if (sortBy === 'modifiedTime') dbSortCol = 'updated_at'
  else if (sortBy === 'assetName') dbSortCol = 'folderName'

  const validOrders = ['asc', 'desc']
  const safeSortOrder = validOrders.includes(sortOrder.toLowerCase())
    ? sortOrder.toUpperCase()
    : 'ASC'

  const orderByClause =
    dbSortCol === 'folderName'
      ? `${dbSortCol} COLLATE NOCASE ${safeSortOrder}`
      : `${dbSortCol} ${safeSortOrder}`

  // 使用子查询一次性计算 hasChildren，零额外开销
  // hasChildren 要包含孤儿文件夹（fatherKey IS NULL 但不是 ALL 的文件夹也算 ALL 的子级）
  const stmt = db.prepare(`
    SELECT
      af.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM ${TABLE_NAME} child
        WHERE (child.fatherKey = af.folderKey OR (af.folderKey = 'ALL' AND child.fatherKey IS NULL AND child.folderKey != 'ALL'))
          AND child.isDelete = 0
      ) THEN 1 ELSE 0 END AS hasChildren
    FROM ${TABLE_NAME} af
    WHERE af.folderKey = 'ALL' AND af.isDelete = 0
    ORDER BY ${orderByClause}
  `)
  const rows = stmt.all() as AssetFolderDbRow[]

  // 转换 hasChildren 从数字到布尔值
  return rows.map(
    (row) =>
      ({
        ...row,
        hasChildren: row.hasChildren === 1
      }) as AssetFolder
  )
}

/**
 * 更新文件夹信息
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @param updates 更新数据
 * @returns 是否更新成功
 */
export const updateAssetFolder = (
  db: Database.Database,
  folderKey: string,
  updates: Partial<AssetFolder>
): boolean => {
  // 获取表中实际存在的列
  const tableColumns = db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all() as { name: string }[]
  const existingColumnNames = new Set(tableColumns.map((col) => col.name))

  // 过滤掉表中不存在的列和保留字段
  const fields = Object.keys(updates).filter(
    (key) => key !== 'folderKey' && key !== 'id' && existingColumnNames.has(key)
  )
  if (fields.length === 0) return false

  const setClause = fields.map((field) => `${field} = ?`).join(', ')
  const values = fields.map((field) => updates[field as keyof AssetFolder])

  const stmt = db.prepare(`
    UPDATE ${TABLE_NAME}
    SET ${setClause}, updated_at = datetime('now', 'localtime')
    WHERE folderKey = ?
  `)

  const result = stmt.run(...values, folderKey)
  return result.changes > 0
}

/**
 * 删除文件夹
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @param deletedAt 删除时刻，整棵子树盖同一个值 —— 恢复时靠它认出「这一次删的是哪些」
 * @returns 是否删除成功
 */
export const deleteAssetFolder = (
  db: Database.Database,
  folderKey: string,
  deletedAt: string = deletionStamp()
): boolean => {
  // 递归软删除：目标文件夹及其子孙文件夹，并软删除其中所有资产
  const sqlFolderTree = `
    WITH RECURSIVE folder_tree AS (
      SELECT folderKey FROM ${TABLE_NAME} WHERE folderKey = ?
      UNION ALL
      SELECT af.folderKey FROM ${TABLE_NAME} af
      JOIN folder_tree ft ON af.fatherKey = ft.folderKey
    )
    SELECT folderKey FROM folder_tree
  `

  const treeStmt = db.prepare(sqlFolderTree)
  const rows = treeStmt.all(folderKey) as { folderKey: string }[]
  const keys = rows.map((r) => r.folderKey)
  if (keys.length === 0) return false

  const BATCH_SIZE = 500
  const success = true

  // 分批处理软删除
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batchKeys = keys.slice(i, i + BATCH_SIZE)
    const placeholders = batchKeys.map(() => '?').join(',')

    const updateFolders = db.prepare(`
      UPDATE ${TABLE_NAME}
      SET isDelete = 1, deletedAt = ?, updated_at = datetime('now', 'localtime')
      WHERE folderKey IN (${placeholders}) AND isDelete = 0
    `)
    const updateAssets = db.prepare(`
      UPDATE assetData
      SET isDelete = 1, deletedAt = ?, updated_at = datetime('now', 'localtime')
      WHERE folderKey IN (${placeholders}) AND isDelete = 0
    `)

    const folderResult = updateFolders.run(deletedAt, ...batchKeys)
    const assetResult = updateAssets.run(deletedAt, ...batchKeys)

    if (folderResult.changes + assetResult.changes <= 0 && i === 0 && keys.length === 1) {
      // 只有单个删除且没有任何变更时，才可能算失败？
      // 实际上对于批量操作，只要没报错就算成功
    }
  }

  return success
}

/**
 * 恢复文件夹（递归恢复目标文件夹及其子孙文件夹，并恢复其中所有资产）
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @returns 是否恢复成功
 */
export const restoreAssetFolder = (db: Database.Database, folderKey: string): boolean => {
  const target = db
    .prepare(
      `SELECT folderKey, fatherKey, isDelete, deletedAt FROM ${TABLE_NAME} WHERE folderKey = ?`
    )
    .get(folderKey) as
    | { folderKey: string; fatherKey: string | null; isDelete: number; deletedAt: string | null }
    | undefined
  if (!target) return false

  const sqlFolderTree = `
    WITH RECURSIVE folder_tree AS (
      SELECT folderKey FROM ${TABLE_NAME} WHERE folderKey = ?
      UNION ALL
      SELECT af.folderKey FROM ${TABLE_NAME} af
      JOIN folder_tree ft ON af.fatherKey = ft.folderKey
    )
    SELECT folderKey FROM folder_tree
  `

  const treeStmt = db.prepare(sqlFolderTree)
  const rows = treeStmt.all(folderKey) as { folderKey: string }[]
  const keys = rows.map((r) => r.folderKey)
  if (keys.length === 0) return false

  /**
   * 只恢复「这一次删除带走的那些」。
   *
   * 判据是删除时间戳：删文件夹时整棵子树盖的是同一个值，而用户在那之前
   * 单独删掉的东西盖的是别的值。不加这一条的话，恢复文件夹会把用户几个月前
   * 特意清掉的资产一并翻出来 —— 删除是按「当时还活着」挑的，恢复却是按
   * 「现在标着删」挑的，两头对不上。
   *
   * 老库（deletedAt 为 NULL）没有这个信息，只能退回原来的行为：整棵子树全恢复。
   */
  const stamp = target.deletedAt
  const stampCondition = stamp ? ' AND deletedAt = ?' : ''
  const stampParams = stamp ? [stamp] : []

  const BATCH_SIZE = 500
  const success = true

  // 分批处理恢复
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batchKeys = keys.slice(i, i + BATCH_SIZE)
    const placeholders = batchKeys.map(() => '?').join(',')

    const updateFolders = db.prepare(`
      UPDATE ${TABLE_NAME}
      SET isDelete = 0, deletedAt = NULL, updated_at = datetime('now', 'localtime')
      WHERE folderKey IN (${placeholders}) AND isDelete = 1${stampCondition}
    `)
    const updateAssets = db.prepare(`
      UPDATE assetData
      SET isDelete = 0, deletedAt = NULL, updated_at = datetime('now', 'localtime')
      WHERE folderKey IN (${placeholders}) AND isDelete = 1${stampCondition}
    `)

    updateFolders.run(...batchKeys, ...stampParams)
    updateAssets.run(...batchKeys, ...stampParams)
  }

  // 头顶上那条链也得活过来，否则恢复出来的文件夹挂在一个还在回收站里的父级下面，
  // 树上一样看不见（和资产恢复同一个道理，见 assetData.restoreAncestorFolders）
  const reviveAncestor = db.prepare(`
    UPDATE ${TABLE_NAME}
    SET isDelete = 0, deletedAt = NULL, updated_at = datetime('now', 'localtime')
    WHERE folderKey = ? AND isDelete = 1
  `)
  const selectFolder = db.prepare(
    `SELECT folderKey, fatherKey, isDelete FROM ${TABLE_NAME} WHERE folderKey = ?`
  )
  const seen = new Set<string>([folderKey])
  let cursor: string | null = target.fatherKey
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const ancestor = selectFolder.get(cursor) as
      | { folderKey: string; fatherKey: string | null; isDelete: number }
      | undefined
    if (!ancestor) break
    if (ancestor.isDelete === 1) reviveAncestor.run(ancestor.folderKey)
    cursor = ancestor.fatherKey
  }

  return success
}

/**
 * 获取所有文件夹
 * @param db 数据库实例
 * @returns 文件夹列表
 */
/**
 * 这个文件夹连同它所有子孙里，还有多少个没被删除的资产。
 *
 * 删文件夹是**连里面的资产一起软删**（见 `deleteAssetFolder`）。删之前必须能说出
 * 「这一下会带走多少东西」—— 不然用户听到的只是「文件夹删了」，
 * 而实际上一整个包的素材跟着进了回收站。
 */
export const countAssetsInFolderTree = (db: Database.Database, folderKey: string): number => {
  const stmt = db.prepare(`
    WITH RECURSIVE folder_tree AS (
      SELECT folderKey FROM ${TABLE_NAME} WHERE folderKey = ? AND isDelete = 0
      UNION ALL
      SELECT af.folderKey FROM ${TABLE_NAME} af
      JOIN folder_tree ft ON af.fatherKey = ft.folderKey
      WHERE af.isDelete = 0
    )
    SELECT COUNT(*) AS count FROM assetData ad
    JOIN folder_tree ft ON ad.folderKey = ft.folderKey
    WHERE ad.isDelete = 0
  `)
  return (stmt.get(folderKey) as { count: number } | undefined)?.count ?? 0
}

export const getAllAssetFolders = (db: Database.Database): AssetFolder[] => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE isDelete = 0 ORDER BY folderName ASC`)
  return stmt.all() as AssetFolder[]
}

/**
 * 检查文件夹是否存在
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @returns 是否存在
 */
export const assetFolderExists = (db: Database.Database, folderKey: string): boolean => {
  const stmt = db.prepare(
    `SELECT 1 FROM ${TABLE_NAME} WHERE folderKey = ? AND isDelete = 0 LIMIT 1`
  )
  const result = stmt.get(folderKey)
  return !!result
}

/**
 * 高效获取文件夹的完整路径数组（使用预存储的pathArray字段）
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @returns 路径key数组
 */
export const getFolderPathArray = (db: Database.Database, folderKey: string): string[] => {
  const stmt = db.prepare(`SELECT pathArray FROM ${TABLE_NAME} WHERE folderKey = ?`)
  const result = stmt.get(folderKey) as { pathArray?: string } | undefined

  if (!result || !result.pathArray) {
    return []
  }

  try {
    return JSON.parse(result.pathArray)
  } catch {
    return []
  }
}

/**
 * 批量获取多个文件夹的路径信息
 * @param db 数据库实例
 * @param folderKeys 文件夹键值数组
 * @returns 文件夹路径信息映射
 */
export const getBatchFolderPaths = (
  db: Database.Database,
  folderKeys: string[]
): Record<string, string[]> => {
  if (folderKeys.length === 0) return {}

  const placeholders = folderKeys.map(() => '?').join(',')
  const stmt = db.prepare(
    `SELECT folderKey, pathArray FROM ${TABLE_NAME} WHERE folderKey IN (${placeholders})`
  )
  const results = stmt.all(...folderKeys) as { folderKey: string; pathArray?: string }[]

  const pathMap: Record<string, string[]> = {}

  results.forEach((result) => {
    try {
      pathMap[result.folderKey] = result.pathArray ? JSON.parse(result.pathArray) : []
    } catch {
      pathMap[result.folderKey] = []
    }
  })

  return pathMap
}

/**
 * 根据深度获取文件夹列表
 * @param db 数据库实例
 * @param depth 深度级别
 * @returns 指定深度的文件夹列表
 */
export const getFoldersByDepth = (db: Database.Database, depth: number): AssetFolder[] => {
  const stmt = db.prepare(
    `SELECT * FROM ${TABLE_NAME} WHERE depth = ? AND isDelete = 0 ORDER BY folderName ASC`
  )
  return stmt.all(depth) as AssetFolder[]
}

/**
 * 更新文件夹及其所有子文件夹的路径信息（当文件夹移动时使用）
 * @param db 数据库实例
 * @param folderKey 被移动的文件夹键值
 */
export const updateFolderPathsRecursively = (db: Database.Database, folderKey: string): void => {
  const updateFolder = (currentFolderKey: string): void => {
    const folder = getAssetFolderByKey(db, currentFolderKey)
    if (!folder) return

    // 重新计算路径信息
    let fullPath = `/${folder.folderName}`
    let pathArray = JSON.stringify([currentFolderKey])
    let depth = 0
    let ancestorKeys = JSON.stringify([])

    if (folder.fatherKey) {
      const parentFolder = getAssetFolderByKey(db, folder.fatherKey)
      if (parentFolder) {
        fullPath = `${parentFolder.fullPath || ''}/${folder.folderName}`
        const parentPathArray = parentFolder.pathArray ? JSON.parse(parentFolder.pathArray) : []
        pathArray = JSON.stringify([...parentPathArray, currentFolderKey])
        depth = (parentFolder.depth || 0) + 1
        ancestorKeys = JSON.stringify([...parentPathArray])
      }
    }

    // 更新当前文件夹
    const updateStmt = db.prepare(`
      UPDATE ${TABLE_NAME}
      SET fullPath = ?, pathArray = ?, depth = ?, ancestorKeys = ?, updated_at = datetime('now', 'localtime')
      WHERE folderKey = ?
    `)
    updateStmt.run(fullPath, pathArray, depth, ancestorKeys, currentFolderKey)

    // 递归更新子文件夹
    const children = getAssetFoldersByFatherKey(db, currentFolderKey)
    children.forEach((child) => updateFolder(child.folderKey))
  }

  updateFolder(folderKey)
}

/**
 * 回收站里的文件夹（isDelete = 1），支持分页。
 *
 * 只返回**这一次删除的根**：父级还活着（或者压根没有父级）的那些。删一个文件夹
 * 会把整棵子树都标成删除，全铺出来的话回收站里会出现几十个"孙文件夹"条目，
 * 而它们本来就跟着父文件夹一起回来 —— 和系统回收站的行为也对不上：那里删一个
 * 目录只会看到一个条目。
 *
 * @param db 数据库实例
 * @param page 页码（从1开始），如果未提供则返回所有
 * @param pageSize 每页数量
 * @returns 文件夹列表和总数
 */
export const getDeletedAssetFolders = (
  db: Database.Database,
  page?: number,
  pageSize?: number
): { list: AssetFolder[]; total: number } => {
  const TOP_LEVEL_CONDITION = `
    af.isDelete = 1
    AND NOT EXISTS (
      SELECT 1 FROM ${TABLE_NAME} parent
      WHERE parent.folderKey = af.fatherKey AND parent.isDelete = 1
    )
  `

  // 获取总数
  const countStmt = db.prepare(
    `SELECT COUNT(*) as count FROM ${TABLE_NAME} af WHERE ${TOP_LEVEL_CONDITION}`
  )
  const total = (countStmt.get() as { count: number }).count

  // 按删除时间倒序。老库补列之前删的那些 deletedAt 是 NULL，退回 updated_at
  let sql = `SELECT af.* FROM ${TABLE_NAME} af WHERE ${TOP_LEVEL_CONDITION}
             ORDER BY COALESCE(af.deletedAt, af.updated_at) DESC, af.folderName ASC`

  // 应用分页
  if (page && pageSize) {
    const offset = (page - 1) * pageSize
    sql += ` LIMIT ${pageSize} OFFSET ${offset}`
  } else if (total > 2000) {
    // 安全防护：如果未指定分页且数据量过大，强制限制 2000 条
    console.warn('[AssetFolder] 警告：回收站数据量过大且未指定分页，强制限制返回前2000条')
    sql += ` LIMIT 2000`
  }

  const list = db.prepare(sql).all() as AssetFolder[]

  return { list, total }
}

/**
 * 在回收站里按 folderKey 或完整路径精确找一个（含子孙层）。
 *
 * [getDeletedAssetFolders] 只列「这一次删除的根」，子孙不铺出来。但单独恢复
 * 其中某个子文件夹是支持的（restoreAssetFolder 会把头顶那条链一起救活），
 * 所以调用方需要一个能越过列表、直接按 key / 路径认人的入口 ——
 * 否则「列表里没有」会被当成「做不到」。
 *
 * 同路径有多个时返回 undefined：宁可让调用方报「认不准」，也不猜。
 */
export const findDeletedAssetFolder = (
  db: Database.Database,
  identifier: string
): AssetFolder | undefined => {
  const raw = (identifier || '').trim()
  if (!raw) return undefined
  const rows = db
    .prepare(
      `SELECT * FROM ${TABLE_NAME}
        WHERE isDelete = 1 AND (folderKey = ? OR LOWER(fullPath) = LOWER(?))
        LIMIT 2`
    )
    .all(raw, raw) as AssetFolder[]
  return rows.length === 1 ? rows[0] : undefined
}

/**
 * 按条件搜索文件夹（支持关键字与递归子文件夹）
 */
export interface FolderSearchCriteria {
  folderKey?: string
  includeSubfolders?: boolean
  keyword?: string
  sortBy?: 'folderName' | 'created_at' | 'updated_at' | 'depth'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export const searchAssetFoldersByCriteria = (
  db: Database.Database,
  criteria: FolderSearchCriteria
): AssetFolder[] => {
  const whereClauses: string[] = ['af.isDelete = 0']
  const params: (string | number)[] = []
  let withClause = ''

  if (criteria.folderKey) {
    if (criteria.includeSubfolders) {
      withClause = `
        WITH RECURSIVE folder_tree AS (
          SELECT folderKey FROM ${TABLE_NAME} WHERE folderKey = ? AND isDelete = 0
          UNION ALL
          SELECT af.folderKey FROM ${TABLE_NAME} af
          JOIN folder_tree ft ON af.fatherKey = ft.folderKey
          WHERE af.isDelete = 0
        )
      `
      whereClauses.push('af.folderKey IN (SELECT folderKey FROM folder_tree)')
      params.push(criteria.folderKey)
    } else {
      // 仅当前层：父级为指定folderKey 或自身为指定folderKey（匹配自身名称也有意义）
      whereClauses.push('(af.fatherKey = ? OR af.folderKey = ?)')
      params.push(criteria.folderKey, criteria.folderKey)
    }
  }

  const keyword = (criteria.keyword || '').trim()
  if (keyword) {
    whereClauses.push('(af.folderName LIKE ? COLLATE NOCASE OR af.fullPath LIKE ? COLLATE NOCASE)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }

  const sortBy = criteria.sortBy || 'folderName'
  const sortOrder = (criteria.sortOrder || 'asc').toUpperCase()
  const allowed = new Set(['folderName', 'created_at', 'updated_at', 'depth'])
  const orderBy = `ORDER BY ${allowed.has(sortBy) ? sortBy : 'folderName'} ${sortOrder}`

  const limitParts: string[] = []
  if (typeof criteria.limit === 'number') {
    limitParts.push('LIMIT ?')
    params.push(criteria.limit)
    if (typeof criteria.offset === 'number') {
      limitParts.push('OFFSET ?')
      params.push(criteria.offset)
    }
  }

  const sql = `
    ${withClause}
    SELECT af.* FROM ${TABLE_NAME} af
    ${whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : ''}
    ${orderBy}
    ${limitParts.join(' ')}
  `

  const stmt = db.prepare(sql)
  const rows = stmt.all(...params) as AssetFolder[]
  return rows
}
