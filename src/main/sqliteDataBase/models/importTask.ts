import Database from 'better-sqlite3'

export interface ImportTaskRecord {
  id?: number
  taskId: string
  vaultId?: string | null
  rootPath: string
  targetFolderKey?: string | null
  status: string
  stage: string
  percent: number
  totalItems: number
  doneItems: number
  pauseRequested: number
  resumeCursor: number
  errorMessage?: string | null
  created_at?: string
  updated_at?: string
  completed_at?: string | null
}

const TABLE_NAME = 'import_tasks'

export const initImportTaskModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId TEXT UNIQUE NOT NULL,
      vaultId TEXT,
      rootPath TEXT NOT NULL,
      targetFolderKey TEXT,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      percent INTEGER DEFAULT 0,
      totalItems INTEGER DEFAULT 0,
      doneItems INTEGER DEFAULT 0,
      pauseRequested INTEGER DEFAULT 0,
      resumeCursor INTEGER DEFAULT 0,
      errorMessage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      completed_at TEXT
    );
  `
  db.exec(createTableSQL)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_tasks_status ON ${TABLE_NAME}(status);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_tasks_stage ON ${TABLE_NAME}(stage);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_tasks_taskId ON ${TABLE_NAME}(taskId);`)
}

export const createImportTask = (db: Database.Database, task: ImportTaskRecord): number => {
  const stmt = db.prepare(
    `INSERT INTO ${TABLE_NAME} (
      taskId, vaultId, rootPath, targetFolderKey, status, stage, percent,
      totalItems, doneItems, pauseRequested, resumeCursor, errorMessage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(taskId) DO UPDATE SET
      vaultId=excluded.vaultId,
      rootPath=excluded.rootPath,
      targetFolderKey=excluded.targetFolderKey,
      status=excluded.status,
      stage=excluded.stage,
      percent=excluded.percent,
      totalItems=excluded.totalItems,
      doneItems=excluded.doneItems,
      pauseRequested=excluded.pauseRequested,
      resumeCursor=excluded.resumeCursor,
      errorMessage=excluded.errorMessage,
      updated_at=(datetime('now','localtime'))
    `
  )
  const result = stmt.run(
    task.taskId,
    task.vaultId ?? null,
    task.rootPath,
    task.targetFolderKey ?? null,
    task.status,
    task.stage,
    task.percent ?? 0,
    task.totalItems ?? 0,
    task.doneItems ?? 0,
    task.pauseRequested ?? 0,
    task.resumeCursor ?? 0,
    task.errorMessage ?? null
  )
  return Number(result.lastInsertRowid)
}

export const updateImportTask = (
  db: Database.Database,
  taskId: string,
  updates: Partial<ImportTaskRecord>
): boolean => {
  const keys = Object.keys(updates)
  if (keys.length === 0) return false
  const setClause = keys
    .map((k) => `${k} = ?`)
    .concat(["updated_at = (datetime('now','localtime'))"])
    .join(', ')
  const stmt = db.prepare(`UPDATE ${TABLE_NAME} SET ${setClause} WHERE taskId = ?`)
  const params = keys.map((k) => (updates as any)[k])
  const result = stmt.run(...params, taskId)
  return result.changes > 0
}

export const getImportTaskByTaskId = (
  db: Database.Database,
  taskId: string
): ImportTaskRecord | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE taskId = ?`)
  return stmt.get(taskId) as ImportTaskRecord | undefined
}

export const listImportTasks = (db: Database.Database): ImportTaskRecord[] => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} ORDER BY created_at DESC`)
  return stmt.all() as ImportTaskRecord[]
}
