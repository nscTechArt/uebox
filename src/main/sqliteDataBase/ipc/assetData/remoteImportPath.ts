import type { AssetData } from '../../models/assetData'

type SqliteReadable = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown
  }
}

type RemoteImportFile = {
  path: string
  name: string
}

export function normalizeRemoteImportPath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

export function buildRemoteImportFilePath(
  file: RemoteImportFile,
  rootFolderPath: string,
  targetFolderPath = ''
): string {
  const normalizedRoot = normalizeRemoteImportPath(rootFolderPath)
  const normalizedFilePath = normalizeRemoteImportPath(file.path)
  const rootParent = normalizedRoot.substring(0, normalizedRoot.lastIndexOf('/'))
  const rootName = normalizedRoot.split('/').pop() || ''
  let relativeRemotePath = normalizeRemoteImportPath(file.name)

  if (rootFolderPath !== 'ALL') {
    if (rootParent && normalizedFilePath.startsWith(`${rootParent}/`)) {
      relativeRemotePath = normalizedFilePath.substring(rootParent.length + 1)
    } else if (normalizedRoot && normalizedFilePath.startsWith(`${normalizedRoot}/`)) {
      relativeRemotePath = `${rootName}/${normalizedFilePath.substring(normalizedRoot.length + 1)}`
    } else {
      relativeRemotePath = `${rootName}/${relativeRemotePath}`
    }
  }

  const normalizedTarget = normalizeRemoteImportPath(targetFolderPath)
  return normalizeRemoteImportPath(
    normalizedTarget ? `${normalizedTarget}/${relativeRemotePath}` : relativeRemotePath
  )
}

export function buildRemoteImportPathCandidates(remotePath: string): [string, string] {
  const slashPath = normalizeRemoteImportPath(remotePath)
  return [slashPath, slashPath.replace(/\//g, '\\')]
}

export function findActiveRemoteAssetByPath(
  db: SqliteReadable,
  remotePath: string
): AssetData | undefined {
  const [slashPath, backslashPath] = buildRemoteImportPathCandidates(remotePath)
  const stmt = db.prepare(`
    SELECT *
    FROM assetData
    WHERE isDelete = 0
      AND (filePath IN (?, ?) OR originPath IN (?, ?))
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `)

  return stmt.get(slashPath, backslashPath, slashPath, backslashPath) as AssetData | undefined
}
