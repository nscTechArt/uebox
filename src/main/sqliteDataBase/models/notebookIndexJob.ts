import Database from 'better-sqlite3'

const TABLE_NAME = 'notebook_index_jobs'

export type NotebookIndexJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface NotebookIndexJobRecord {
  id?: number
  jobId: string
  notebookId: string
  sourceId: string
  targetContentHash: string
  targetRevision: number
  status: NotebookIndexJobStatus
  attemptCount: number
  nextRetryAt?: string | null
  lastError?: string | null
  created_at?: string
  updated_at?: string
  started_at?: string | null
  completed_at?: string | null
}

export const initNotebookIndexJobModel = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      notebook_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_content_hash TEXT NOT NULL,
      target_revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT DEFAULT NULL,
      last_error TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      started_at TEXT DEFAULT NULL,
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY (notebook_id) REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES notebook_sources(source_id) ON DELETE CASCADE,
      UNIQUE(source_id, target_content_hash)
    );
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_notebook_index_jobs_status ON ${TABLE_NAME}(status);`)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notebook_index_jobs_retry ON ${TABLE_NAME}(status, next_retry_at);`
  )
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notebook_index_jobs_source ON ${TABLE_NAME}(source_id, target_revision);`
  )
}

export const getNotebookIndexJobByTarget = (
  db: Database.Database,
  sourceId: string,
  targetContentHash: string
): NotebookIndexJobRecord | undefined => {
  const stmt = db.prepare(
    `SELECT
      id,
      job_id as jobId,
      notebook_id as notebookId,
      source_id as sourceId,
      target_content_hash as targetContentHash,
      target_revision as targetRevision,
      status,
      attempt_count as attemptCount,
      next_retry_at as nextRetryAt,
      last_error as lastError,
      created_at,
      updated_at,
      started_at,
      completed_at
    FROM ${TABLE_NAME}
    WHERE source_id = ? AND target_content_hash = ?`
  )
  return stmt.get(sourceId, targetContentHash) as NotebookIndexJobRecord | undefined
}

export const createNotebookIndexJob = (
  db: Database.Database,
  job: Omit<
    NotebookIndexJobRecord,
    'id' | 'created_at' | 'updated_at' | 'started_at' | 'completed_at'
  >
): number => {
  const stmt = db.prepare(`
    INSERT INTO ${TABLE_NAME} (
      job_id,
      notebook_id,
      source_id,
      target_content_hash,
      target_revision,
      status,
      attempt_count,
      next_retry_at,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const result = stmt.run(
    job.jobId,
    job.notebookId,
    job.sourceId,
    job.targetContentHash,
    job.targetRevision,
    job.status,
    job.attemptCount,
    job.nextRetryAt ?? null,
    job.lastError ?? null
  )
  return Number(result.lastInsertRowid)
}

export const updateNotebookIndexJob = (
  db: Database.Database,
  jobId: string,
  updates: Partial<NotebookIndexJobRecord>
): boolean => {
  const fieldMap: Array<[keyof NotebookIndexJobRecord, string]> = [
    ['notebookId', 'notebook_id'],
    ['sourceId', 'source_id'],
    ['targetContentHash', 'target_content_hash'],
    ['targetRevision', 'target_revision'],
    ['status', 'status'],
    ['attemptCount', 'attempt_count'],
    ['nextRetryAt', 'next_retry_at'],
    ['lastError', 'last_error'],
    ['started_at', 'started_at'],
    ['completed_at', 'completed_at']
  ]

  const fields: string[] = []
  const values: Array<string | number | null> = []

  for (const [key, column] of fieldMap) {
    if (updates[key] !== undefined) {
      fields.push(`${column} = ?`)
      values.push((updates as Record<string, unknown>)[key] as string | number | null)
    }
  }

  if (fields.length === 0) return false

  fields.push("updated_at = datetime('now', 'localtime')")
  values.push(jobId)

  const stmt = db.prepare(`
    UPDATE ${TABLE_NAME}
    SET ${fields.join(', ')}
    WHERE job_id = ?
  `)

  const result = stmt.run(...values)
  return result.changes > 0
}

export const getNextRunnableNotebookIndexJob = (
  db: Database.Database,
  nowIso: string
): NotebookIndexJobRecord | undefined => {
  const stmt = db.prepare(`
    SELECT
      id,
      job_id as jobId,
      notebook_id as notebookId,
      source_id as sourceId,
      target_content_hash as targetContentHash,
      target_revision as targetRevision,
      status,
      attempt_count as attemptCount,
      next_retry_at as nextRetryAt,
      last_error as lastError,
      created_at,
      updated_at,
      started_at,
      completed_at
    FROM ${TABLE_NAME}
    WHERE status = 'pending'
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
    LIMIT 1
  `)

  return stmt.get(nowIso) as NotebookIndexJobRecord | undefined
}

export const getNextRunnableNotebookIndexAt = (db: Database.Database): string | undefined => {
  const stmt = db.prepare(`
    SELECT MIN(next_retry_at) as nextRetryAt
    FROM ${TABLE_NAME}
    WHERE status = 'pending' AND next_retry_at IS NOT NULL
  `)
  const row = stmt.get() as { nextRetryAt?: string | null } | undefined
  return row?.nextRetryAt ?? undefined
}

export const listNotebookIndexJobs = (
  db: Database.Database,
  notebookId?: string
): NotebookIndexJobRecord[] => {
  const baseSql = `
    SELECT
      id,
      job_id as jobId,
      notebook_id as notebookId,
      source_id as sourceId,
      target_content_hash as targetContentHash,
      target_revision as targetRevision,
      status,
      attempt_count as attemptCount,
      next_retry_at as nextRetryAt,
      last_error as lastError,
      created_at,
      updated_at,
      started_at,
      completed_at
    FROM ${TABLE_NAME}
  `

  if (notebookId) {
    const stmt = db.prepare(`${baseSql} WHERE notebook_id = ? ORDER BY created_at DESC`)
    return stmt.all(notebookId) as NotebookIndexJobRecord[]
  }

  const stmt = db.prepare(`${baseSql} ORDER BY created_at DESC`)
  return stmt.all() as NotebookIndexJobRecord[]
}
