import Database from 'better-sqlite3'

export type ImportRecoveryContextStatus =
  | 'ready'
  | 'resuming'
  | 'committed'
  | 'failed'
  | 'expired'
  | 'dismissed'

export interface ImportRecoveryContextRecord {
  id?: number
  taskId: string
  diagnosticId?: string | null
  vaultId: string
  sessionId: string
  contextPath: string
  status: ImportRecoveryContextStatus
  last_error?: string | null
  created_at?: string
  updated_at?: string
}

const TABLE_NAME = 'import_recovery_context'

export const initImportRecoveryContextModel = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId TEXT NOT NULL UNIQUE,
      diagnosticId TEXT,
      vaultId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      contextPath TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_recovery_task ON ${TABLE_NAME}(taskId);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_recovery_diag ON ${TABLE_NAME}(diagnosticId);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_recovery_session ON ${TABLE_NAME}(sessionId);`)
}

export const upsertImportRecoveryContext = (
  db: Database.Database,
  record: Omit<ImportRecoveryContextRecord, 'id' | 'created_at' | 'updated_at'>
): void => {
  db.prepare(
    `INSERT INTO ${TABLE_NAME}
      (taskId, diagnosticId, vaultId, sessionId, contextPath, status, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(taskId) DO UPDATE SET
      diagnosticId = COALESCE(excluded.diagnosticId, ${TABLE_NAME}.diagnosticId),
      vaultId = excluded.vaultId,
      sessionId = excluded.sessionId,
      contextPath = excluded.contextPath,
      status = excluded.status,
      last_error = excluded.last_error,
      updated_at = datetime('now', 'localtime')`
  ).run(
    record.taskId,
    record.diagnosticId ?? null,
    record.vaultId,
    record.sessionId,
    record.contextPath,
    record.status,
    record.last_error ?? null
  )
}

export const getImportRecoveryContextByTaskId = (
  db: Database.Database,
  taskId: string
): ImportRecoveryContextRecord | undefined => {
  return db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE taskId = ?`).get(taskId) as
    | ImportRecoveryContextRecord
    | undefined
}

export const getImportRecoveryContextByDiagnosticId = (
  db: Database.Database,
  diagnosticId: string
): ImportRecoveryContextRecord | undefined => {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAME} WHERE diagnosticId = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(diagnosticId) as ImportRecoveryContextRecord | undefined
}

export const listImportRecoveryContexts = (
  db: Database.Database,
  statuses: ImportRecoveryContextStatus[] = ['ready', 'resuming'],
  limit = 10
): ImportRecoveryContextRecord[] => {
  const selectedStatuses = statuses.length > 0 ? statuses : ['ready', 'resuming']
  const placeholders = selectedStatuses.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT * FROM ${TABLE_NAME}
       WHERE status IN (${placeholders})
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(
      ...selectedStatuses,
      Math.max(1, Math.min(50, Math.floor(limit)))
    ) as ImportRecoveryContextRecord[]
}

export const updateImportRecoveryContextStatus = (
  db: Database.Database,
  taskId: string,
  status: ImportRecoveryContextStatus,
  error?: string | null,
  diagnosticId?: string | null
): boolean => {
  const result = db
    .prepare(
      `UPDATE ${TABLE_NAME}
       SET status = ?,
           last_error = ?,
           diagnosticId = COALESCE(?, diagnosticId),
           updated_at = datetime('now', 'localtime')
       WHERE taskId = ?`
    )
    .run(status, error ? String(error).slice(0, 2000) : null, diagnosticId ?? null, taskId)
  return result.changes > 0
}
