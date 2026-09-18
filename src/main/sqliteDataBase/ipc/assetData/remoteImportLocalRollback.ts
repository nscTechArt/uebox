import type Database from 'better-sqlite3'

export interface RemoteImportLocalRollbackInput {
  assetKeys: Iterable<string>
  folderKeys: Iterable<string>
  previousAssets?: Iterable<Record<string, unknown>>
}

export interface RemoteImportLocalRollbackResult {
  deletedAssets: number
  deletedFolders: number
  assetKeys: string[]
  folderKeys: string[]
}

export interface RemoteImportLocalRollbackDecisionInput {
  remoteSyncStatus: 'committed' | 'failed' | 'partial' | 'skipped'
  remoteCommittedChanges: boolean
  createdAssetCount: number
  createdFolderCount: number
}

const SQLITE_PARAM_BATCH_SIZE = 500

const uniqueKeys = (keys: Iterable<string>): string[] =>
  Array.from(
    new Set(
      Array.from(keys)
        .map(String)
        .map((key) => key.trim())
        .filter(Boolean)
    )
  )

const chunkKeys = (keys: string[]): string[][] => {
  const chunks: string[][] = []
  for (let i = 0; i < keys.length; i += SQLITE_PARAM_BATCH_SIZE) {
    chunks.push(keys.slice(i, i + SQLITE_PARAM_BATCH_SIZE))
  }
  return chunks
}

const tableExists = (db: Database.Database, tableName: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined
  return !!row
}

const deleteByKeys = (
  db: Database.Database,
  tableName: string,
  keyColumn: string,
  keys: string[]
): number => {
  if (keys.length === 0 || !tableExists(db, tableName)) return 0
  let deleted = 0
  for (const batch of chunkKeys(keys)) {
    const placeholders = batch.map(() => '?').join(',')
    const result = db
      .prepare(`DELETE FROM ${tableName} WHERE ${keyColumn} IN (${placeholders})`)
      .run(...batch)
    deleted += Number(result.changes || 0)
  }
  return deleted
}

const getFolderDepth = (db: Database.Database, folderKey: string): number => {
  if (!tableExists(db, 'assetFolder')) return 0
  const row = db
    .prepare('SELECT depth, fullPath FROM assetFolder WHERE folderKey = ?')
    .get(folderKey) as { depth?: number; fullPath?: string } | undefined
  if (!row) return 0
  const depth = Number(row.depth)
  if (Number.isFinite(depth)) return depth
  return String(row.fullPath || '')
    .split('/')
    .filter(Boolean).length
}

const getFolderSubtreeKeys = (db: Database.Database, folderKey: string): string[] => {
  if (!tableExists(db, 'assetFolder')) return []
  const rows = db
    .prepare(
      `
      WITH RECURSIVE subtree(folderKey) AS (
        SELECT folderKey FROM assetFolder WHERE folderKey = ?
        UNION ALL
        SELECT child.folderKey
        FROM assetFolder child
        INNER JOIN subtree parent ON child.fatherKey = parent.folderKey
      )
      SELECT folderKey FROM subtree
    `
    )
    .all(folderKey) as Array<{ folderKey: string }>
  return rows.map((row) => row.folderKey)
}

const canDeleteFolderSafely = (
  db: Database.Database,
  folderKey: string,
  rollbackFolderKeys: Set<string>
): boolean => {
  const subtreeKeys = getFolderSubtreeKeys(db, folderKey)
  if (subtreeKeys.length === 0) return false
  if (subtreeKeys.some((key) => !rollbackFolderKeys.has(key))) return false

  const placeholders = subtreeKeys.map(() => '?').join(',')
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM assetData WHERE folderKey IN (${placeholders})`)
    .get(...subtreeKeys) as { count: number }
  return row.count === 0
}

const deleteFoldersSafely = (db: Database.Database, folderKeys: string[]): number => {
  if (folderKeys.length === 0 || !tableExists(db, 'assetFolder')) return 0

  const rollbackFolderKeys = new Set(folderKeys)
  const sorted = [...folderKeys].sort((a, b) => getFolderDepth(db, b) - getFolderDepth(db, a))
  let deleted = 0
  for (const folderKey of sorted) {
    if (!canDeleteFolderSafely(db, folderKey, rollbackFolderKeys)) continue
    const result = db.prepare('DELETE FROM assetFolder WHERE folderKey = ?').run(folderKey)
    deleted += Number(result.changes || 0)
  }
  return deleted
}

export const shouldRollbackRemoteImportLocalRows = (
  input: RemoteImportLocalRollbackDecisionInput
): boolean =>
  input.remoteSyncStatus === 'failed' &&
  !input.remoteCommittedChanges &&
  (input.createdAssetCount > 0 || input.createdFolderCount > 0)

export const rollbackRemoteImportLocalRows = (
  db: Database.Database,
  input: RemoteImportLocalRollbackInput
): RemoteImportLocalRollbackResult => {
  const assetKeys = uniqueKeys(input.assetKeys)
  const folderKeys = uniqueKeys(input.folderKeys).filter((folderKey) => folderKey !== 'ALL')

  for (const relationTable of ['asset_tags', 'asset_favorites']) {
    deleteByKeys(db, relationTable, 'assetKey', assetKeys)
  }

  const deletedAssets = deleteByKeys(db, 'assetData', 'assetKey', assetKeys)
  for (const row of input.previousAssets ?? []) {
    const columns = Object.keys(row).filter((column) => column !== 'assetKey')
    if (!columns.length) continue
    const assignments = columns.map((column) => `"${column.replace(/"/g, '""')}" = ?`)
    db.prepare(`UPDATE assetData SET ${assignments.join(', ')} WHERE assetKey = ?`).run(
      ...columns.map((column) => row[column]),
      row.assetKey
    )
  }
  const deletedFolders = deleteFoldersSafely(db, folderKeys)

  return {
    deletedAssets,
    deletedFolders,
    assetKeys,
    folderKeys
  }
}
