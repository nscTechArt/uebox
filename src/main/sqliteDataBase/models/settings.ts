import Database from 'better-sqlite3'

export interface Setting {
  key: string
  value: any
}

const TABLE_NAME = 'app_settings'

export const initSettingsModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `
  db.exec(createTableSQL)
}

export const getSetting = <T = any>(db: Database.Database, key: string, defaultValue: T): T => {
  const row = db.prepare(`SELECT value FROM ${TABLE_NAME} WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  if (!row) return defaultValue
  try {
    return JSON.parse(row.value)
  } catch {
    return row.value as unknown as T
  }
}

export const setSetting = (db: Database.Database, key: string, value: any): void => {
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${TABLE_NAME} (key, value) VALUES (?, ?)`)
  stmt.run(key, JSON.stringify(value))
}
