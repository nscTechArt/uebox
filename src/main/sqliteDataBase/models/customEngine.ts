import Database from 'better-sqlite3'

export interface CustomEngineRecord {
  id?: number
  rootPath: string
  name: string
  version: string
  createdAt?: string
}

const TABLE_NAME = 'custom_engines'

/**
 * 初始化自定义引擎表（公共数据库）
 */
export const initCustomEngineModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `
  db.exec(createTableSQL)

  // 创建索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_engines_root_path ON ${TABLE_NAME}(root_path)`)
}

/**
 * 添加自定义引擎记录（INSERT OR REPLACE，以 rootPath 去重）
 */
export const addCustomEngine = (
  db: Database.Database,
  record: { rootPath: string; name: string; version: string }
): void => {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${TABLE_NAME} (root_path, name, version) VALUES (?, ?, ?)`
  )
  stmt.run(record.rootPath, record.name, record.version)
}

/**
 * 根据 rootPath 删除自定义引擎记录
 */
export const removeCustomEngine = (db: Database.Database, rootPath: string): void => {
  const stmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE root_path = ?`)
  stmt.run(rootPath)
}

/**
 * 获取所有自定义引擎记录
 */
export const getAllCustomEngines = (db: Database.Database): CustomEngineRecord[] => {
  const rows = db
    .prepare(
      `SELECT id, root_path, name, version, created_at FROM ${TABLE_NAME} ORDER BY created_at DESC`
    )
    .all() as Array<{
    id: number
    root_path: string
    name: string
    version: string
    created_at: string
  }>

  return rows.map((row) => ({
    id: row.id,
    rootPath: row.root_path,
    name: row.name,
    version: row.version,
    createdAt: row.created_at
  }))
}

/**
 * 检查 rootPath 是否已存在
 */
export const hasCustomEngine = (db: Database.Database, rootPath: string): boolean => {
  const row = db.prepare(`SELECT 1 FROM ${TABLE_NAME} WHERE root_path = ? LIMIT 1`).get(rootPath)
  return !!row
}
