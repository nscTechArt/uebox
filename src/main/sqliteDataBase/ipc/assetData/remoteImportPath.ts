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

/**
 * 查重语句本体。导出是为了让执行计划的回归测试 EXPLAIN 这一条，
 * 而不是 EXPLAIN 一份抄进测试里的副本 —— 抄一份的话，把这里改回
 * `filePath IN (...) OR originPath IN (...)` 测试照样绿，等于没有盯住。
 */
export const ACTIVE_REMOTE_ASSET_BY_PATH_SQL = `
    SELECT *
    FROM (
      SELECT * FROM assetData WHERE isDelete = 0 AND filePath IN (?, ?)
      UNION ALL
      SELECT * FROM assetData WHERE isDelete = 0 AND originPath IN (?, ?)
    )
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `

export function findActiveRemoteAssetByPath(
  db: SqliteReadable,
  remotePath: string
): AssetData | undefined {
  const [slashPath, backslashPath] = buildRemoteImportPathCandidates(remotePath)
  // 远端模式写入阶段每个文件都要调一次这里，而且 better-sqlite3 是同步的，查多久主进程就卡多久。
  //
  // 原来写成 `filePath IN (...) OR originPath IN (...)`。OR 跨两列时规划器要么给两列各走一个
  // 索引（MULTI-INDEX OR），要么退回单列索引整表扫；库里没有 ANALYZE 统计信息的时候它会
  // 选中 idx_assetData_isDelete —— 一个只有 0/1 两个值的索引，等于全表扫。52 万行的
  // 镜像库上实测每次 4 秒多，一次几千个文件的导入就是「写入本地数据库」卡在 21% 几小时。
  // 即便补了复合索引，已经打开的连接也未必换计划。
  //
  // 拆成两条单列等值查询再 UNION ALL，每条各自只能走 (filePath, isDelete) /
  // (originPath, isDelete) 复合索引，不给规划器选错的机会。和服务端 aa166cf 的修法一致。
  const stmt = db.prepare(ACTIVE_REMOTE_ASSET_BY_PATH_SQL)

  return stmt.get(slashPath, backslashPath, slashPath, backslashPath) as AssetData | undefined
}
