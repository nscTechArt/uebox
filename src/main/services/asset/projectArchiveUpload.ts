/**
 * projectArchiveUpload — 把一个 UE 工程目录当**一个文件**送进 HTTP 资产服务器。
 *
 * 背景：服务端的导入协议是「一个文件一个请求」，每个请求在服务端单线程上要付
 * 十几次同步磁盘操作的固定开销（NAS 上实测约 30 ms/文件）。几千个小文件的工程，
 * 时间全花在这笔固定开销上，而不是传字节。单个大文件走同一条协议时服务端能跑满网卡。
 *
 * 所以这里不改协议、不改服务端：客户端边读边打成一个存储模式的 zip，作为**一个**
 * 文件上传，一次会话、一条清单、一次提交。25 GB 的工程在千兆网上就是四五分钟。
 *
 * 代价是服务器上存的是整包而不是散文件 —— 这正是「工程库」要的形态：整个工程一次
 * 提交、一次取回，而不是逐个资产浏览。
 *
 * 用户直接选了压缩包（zip / rar / 7z）也走这里：不再打包，原样上传。
 */
import { createReadStream, readdirSync, statSync, type Dirent } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { ImportSessionClient, type ImportSessionData } from '../../networkV2/ImportSessionClient'
import { checkV2ImportReadiness } from './importFeatureFlag'
import { decideUploadRetry, getRetryAfterDelayMs } from './importUploadRetry'
import { createZipStoreStream, planZipStore, type ZipStoreSource } from './zipStoreStream'

/**
 * 默认不打进包里的目录。全是引擎重新生成得出来的缓存，往往比工程本体还大：
 * Intermediate / Saved / DerivedDataCache 是编辑器缓存，.vs/.idea/.git 是 IDE 与版本库。
 * Binaries 保留 —— 没装编译环境的美术要靠它打开 C++ 工程。
 * 只在工程根和插件根（同目录有 .uplugin）下生效，Content 里同名的普通文件夹不受影响。
 */
export const DEFAULT_EXCLUDED_DIR_NAMES = [
  'Intermediate',
  'Saved',
  'DerivedDataCache',
  '.vs',
  '.idea',
  '.vscode',
  '.git'
]

/** 用户直接选中这些扩展名的文件时，不打包、原样上传 */
export const ARCHIVE_SOURCE_EXTENSIONS = new Set(['.zip', '.rar', '.7z'])

export type ProjectArchiveStage =
  | 'scan'
  | 'preflight'
  | 'create_session'
  | 'upload_metadata'
  | 'pack_upload'
  | 'commit'
  | 'poll_status'

export type ProjectArchiveStageCallback = (
  stage: ProjectArchiveStage,
  progress: number,
  total: number,
  meta?: { sessionId?: string }
) => void

export interface ProjectArchiveScan {
  /** 工程目录名，也是包内顶层目录名 */
  rootName: string
  sources: ZipStoreSource[]
  totalBytes: number
  /** 被排除的目录（相对工程根），报告里给用户看 */
  excludedDirs: string[]
  /** 跳过的符号链接（相对工程根）。它们的内容没进包，用户有权知道 */
  skippedSymlinks: string[]
}

export interface ProjectArchiveUploadParams {
  serverUrl: string
  vaultId: string
  clientId: string
  apiKey?: string
  /** 工程目录，或一个现成的压缩包 */
  sourcePath: string
  targetFolderKey?: string | null
  /** 目标文件夹在库里的相对路径（例如 `工程库/2026`），根目录传空 */
  targetFolderPath?: string
  /** 目标文件夹记录。服务端按 folderKey 关联资产，这里随元数据一并送过去 */
  targetFolderRecord?: Record<string, unknown> | null
  excludedDirNames?: string[]
  onStage?: ProjectArchiveStageCallback
  /** 已发送字节 / 总字节。内部已按 500ms 节流 */
  onBytes?: (sent: number, total: number) => void
}

export interface ProjectArchiveUploadResult {
  status: 'committed' | 'failed'
  sessionId?: string
  assetKey: string
  archiveName: string
  remotePath: string
  archiveBytes: number
  /** 打进包里的文件数；直接上传压缩包时为 1 */
  fileCount: number
  excludedDirs: string[]
  /** 跳过的符号链接（相对工程根）。内容没进包，界面要能说出来 */
  skippedSymlinks: string[]
  /** 打包 + 上传阶段耗时 */
  uploadMs: number
  elapsedMs: number
  /** 按 archiveBytes / uploadMs 折算，MB/s（十进制兆） */
  mbPerSec: number
  uploadAttempts: number
  error?: string
  errorCode?: string
}

const PROGRESS_THROTTLE_MS = 500
/** 大包上传的空闲超时：这是「多久没有一个字节流动」而不是总时长，10 分钟足够宽 */
const ARCHIVE_UPLOAD_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const UPLOAD_MAX_RETRIES = 2
const UPLOAD_BUSY_MAX_RETRIES = 30
const COMMIT_POLL_INTERVAL_MS = 1000
const COMMIT_POLL_MAX_ATTEMPTS = 120
const STAGED_WAIT_MAX_ATTEMPTS = 10

function isImportSessionFailed(status: string): boolean {
  return status.startsWith('failed') || status === 'cancelled'
}

/**
 * 这个目录下的 Intermediate/Saved/… 才算引擎缓存。
 *
 * 按名字一刀切不行：`Content/Saved` 是美术自己建的目录，不能删。
 * 但按固定深度判也不行 —— 引擎自带插件常摆成 `Plugins/<分类>/<插件名>/`，
 * 缓存目录在第四级，写死「Plugins 下第三级」会把一整棵缓存树打进包。
 *
 * 真正的判据是「这里是不是一个工程根或插件根」：插件根的标志是同目录里有 .uplugin。
 */
/** 工程目录的层级上限。真实 UE 工程二十层都到不了，64 层只可能是环 */
const MAX_SCAN_DEPTH = 64

function hasPluginDescriptor(entries: Dirent[]): boolean {
  return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.uplugin'))
}

/**
 * 扫工程目录。同步遍历 —— 几万个条目的 readdir 在本地盘上是亚秒级的，
 * 换成异步只会让代码复杂，不会更快。跳过符号链接，避免把链接目标或死循环打进包。
 */
export function scanProjectFolder(
  rootDir: string,
  excludedDirNames: string[] = DEFAULT_EXCLUDED_DIR_NAMES,
  /** 层级上限。可调只是为了测这条兜底，不用真在磁盘上挖 65 层 */
  maxDepth: number = MAX_SCAN_DEPTH
): ProjectArchiveScan {
  const root = path.resolve(rootDir)
  const rootName = path.basename(root)
  const excluded = new Set(excludedDirNames)
  const sources: ZipStoreSource[] = []
  const excludedDirs: string[] = []
  const skippedSymlinks: string[] = []
  let totalBytes = 0

  /** @returns 这棵子树有没有往包里放进东西；没有的话调用方要补一条目录条目 */
  const walk = (dir: string, relativeParts: string[]): boolean => {
    // 目录环的兜底。符号链接已经跳过了，但 Windows 的 junction 不是每种文件系统
    // 都会被 Dirent 认成 symlink —— 一个指回上层的 junction 会让这段同步递归永不返回，
    // 表现是主进程直接卡死。宁可报错也不能挂着。
    if (relativeParts.length > maxDepth) {
      throw new Error(
        `目录层级超过 ${maxDepth} 层，疑似目录环（junction 指回上层？）：${relativeParts.join('/')}`
      )
    }
    const entries = readdirSync(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const isCacheHost = relativeParts.length === 0 || hasPluginDescriptor(entries)
    let contributed = false

    for (const entry of entries) {
      const nextParts = [...relativeParts, entry.name]
      if (entry.isSymbolicLink()) {
        // 记下来告诉用户，别让「包里少了一个插件」变成静默的
        skippedSymlinks.push(nextParts.join('/'))
        continue
      }
      const absPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isCacheHost && excluded.has(entry.name)) {
          excludedDirs.push(nextParts.join('/'))
          continue
        }
        if (!walk(absPath, nextParts)) {
          // 子树一个文件都没有：补一条目录条目，否则这个空目录取回时会凭空消失
          sources.push({
            absPath,
            zipPath: `${rootName}/${nextParts.join('/')}/`,
            size: 0,
            mtime: statSync(absPath).mtime,
            isDirectory: true
          })
        }
        contributed = true
        continue
      }
      if (!entry.isFile()) continue
      const st = statSync(absPath)
      sources.push({
        absPath,
        zipPath: `${rootName}/${nextParts.join('/')}`,
        size: st.size,
        mtime: st.mtime
      })
      totalBytes += st.size
      contributed = true
    }
    return contributed
  }

  walk(root, [])
  return { rootName, sources, totalBytes, excludedDirs, skippedSymlinks }
}

/**
 * 同一个包重传时资产记录要落到同一条上，所以 key 由远端路径决定，不掺时间戳。
 */
export function buildArchiveAssetKey(remotePath: string): string {
  const digest = createHash('sha1').update(remotePath, 'utf8').digest('hex').slice(0, 24)
  return `archive_${digest}`
}

function joinRemotePath(targetFolderPath: string | undefined, fileName: string): string {
  const folder = (targetFolderPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return folder ? `${folder}/${fileName}` : fileName
}

/** 服务端错误码挂在 Error 对象上（见 ImportSessionClient.collectJsonResponse），没有就给空串 */
function readErrorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('errorCode' in err)) return ''
  const code = (err as { errorCode?: unknown }).errorCode
  return code ? String(code) : ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ArchiveSourceDescriptor {
  archiveName: string
  archiveBytes: number
  fileCount: number
  excludedDirs: string[]
  skippedSymlinks: string[]
  openStream: (onBytes: (sent: number) => void) => NodeJS.ReadableStream
}

function describeArchiveSource(
  sourcePath: string,
  excludedDirNames: string[]
): ArchiveSourceDescriptor {
  const st = statSync(sourcePath)
  if (st.isFile()) {
    const ext = path.extname(sourcePath).toLowerCase()
    if (!ARCHIVE_SOURCE_EXTENSIONS.has(ext)) {
      throw new Error(`整包上传只接受工程目录或 zip / rar / 7z 压缩包：${sourcePath}`)
    }
    return {
      archiveName: path.basename(sourcePath),
      archiveBytes: st.size,
      fileCount: 1,
      excludedDirs: [],
      skippedSymlinks: [],
      openStream: (onBytes) => {
        let sent = 0
        const stream = createReadStream(sourcePath, { highWaterMark: 1024 * 1024 })
        stream.on('data', (chunk: Buffer | string) => {
          sent += chunk.length
          onBytes(sent)
        })
        return stream
      }
    }
  }

  const scan = scanProjectFolder(sourcePath, excludedDirNames)
  if (scan.sources.length === 0) {
    throw new Error(`工程目录里没有可上传的文件：${sourcePath}`)
  }
  const plan = planZipStore(scan.sources)
  return {
    archiveName: `${scan.rootName}.zip`,
    archiveBytes: plan.totalSize,
    // 只数文件：sources 里还有为空目录补的目录条目，把它们算进「N 个文件」
    // 会和取回侧对不上（extractZip 的 fileCount 不含目录）
    fileCount: scan.sources.filter((source) => !source.isDirectory).length,
    excludedDirs: scan.excludedDirs,
    skippedSymlinks: scan.skippedSymlinks,
    openStream: (onBytes) => createZipStoreStream(plan, { onBytes })
  }
}

function buildArchiveAssetRecord(params: {
  assetKey: string
  folderKey: string
  archiveName: string
  remotePath: string
  archiveBytes: number
  fileCount: number
  sourcePath: string
}): Record<string, unknown> {
  const ext = path.extname(params.archiveName).replace(/^\./, '').toLowerCase()
  const nameWithoutExt = params.archiveName.slice(0, params.archiveName.length - ext.length - 1)
  return {
    assetKey: params.assetKey,
    folderKey: params.folderKey,
    assetName: nameWithoutExt,
    filePath: params.remotePath,
    originPath: params.remotePath,
    fileSize: params.archiveBytes,
    fileExtension: ext,
    modifiedTime: new Date().toISOString(),
    processorType: 'FileSystem',
    assetType: 'ProjectArchive',
    classNameCn: '工程整包',
    // 与其它非虚幻资产同一个灰，见 assetData.ts 通用文件分支
    classColor: '#888888',
    assetConfig: JSON.stringify({
      projectArchive: true,
      fileCount: params.fileCount,
      sourcePath: params.sourcePath
    })
  }
}

export async function uploadProjectArchive(
  params: ProjectArchiveUploadParams
): Promise<ProjectArchiveUploadResult> {
  const startedAt = Date.now()
  const { onStage } = params
  const folderKey =
    params.targetFolderKey && params.targetFolderKey !== 'ALL' ? params.targetFolderKey : 'ALL'

  onStage?.('scan', 0, 1)
  // 扫描也要走「返回 failed 结果」这条路，不能靠 reject 逃出去 ——
  // 别的阶段全都返回 ProjectArchiveUploadResult，只有这里抛异常的话调用方没法统一处理
  let source: ArchiveSourceDescriptor
  try {
    source = describeArchiveSource(
      params.sourcePath,
      params.excludedDirNames ?? DEFAULT_EXCLUDED_DIR_NAMES
    )
  } catch (err) {
    return {
      status: 'failed',
      assetKey: '',
      archiveName: path.basename(params.sourcePath || ''),
      remotePath: '',
      archiveBytes: 0,
      fileCount: 0,
      excludedDirs: [],
      skippedSymlinks: [],
      uploadMs: 0,
      elapsedMs: Date.now() - startedAt,
      mbPerSec: 0,
      uploadAttempts: 0,
      error: err instanceof Error ? err.message : String(err),
      errorCode: 'SCAN_FAILED'
    }
  }
  const remotePath = joinRemotePath(params.targetFolderPath, source.archiveName)
  const assetKey = buildArchiveAssetKey(remotePath)
  onStage?.('scan', 1, 1)

  const base = {
    assetKey,
    archiveName: source.archiveName,
    remotePath,
    archiveBytes: source.archiveBytes,
    fileCount: source.fileCount,
    excludedDirs: source.excludedDirs,
    skippedSymlinks: source.skippedSymlinks
  }
  const fail = (
    error: string,
    errorCode: string,
    extra: { sessionId?: string; uploadMs?: number; uploadAttempts?: number } = {}
  ): ProjectArchiveUploadResult => ({
    ...base,
    status: 'failed',
    sessionId: extra.sessionId,
    uploadMs: extra.uploadMs ?? 0,
    elapsedMs: Date.now() - startedAt,
    mbPerSec: 0,
    uploadAttempts: extra.uploadAttempts ?? 0,
    error,
    errorCode
  })

  onStage?.('preflight', 0, 1)
  const readiness = await checkV2ImportReadiness(
    params.serverUrl,
    params.vaultId,
    params.clientId,
    folderKey,
    source.archiveBytes,
    { bypassCapabilityCache: true, apiKey: params.apiKey }
  )
  if (!readiness.supported || !readiness.ready) {
    return fail(
      readiness.userMessage || '资产服务器未通过导入前检查',
      readiness.errorCode || 'IMPORT_PREFLIGHT_BLOCKED'
    )
  }
  onStage?.('preflight', 1, 1)

  const client = new ImportSessionClient({
    serverUrl: params.serverUrl,
    vaultId: params.vaultId,
    clientId: params.clientId,
    apiKey: params.apiKey,
    fileUploadTimeoutMs: ARCHIVE_UPLOAD_IDLE_TIMEOUT_MS
  })

  let sessionId = ''
  try {
    onStage?.('create_session', 0, 1)
    const session = await client.createSession(1, folderKey)
    sessionId = session.sessionId
    onStage?.('create_session', 1, 1, { sessionId })

    onStage?.('upload_metadata', 0, 1, { sessionId })
    await client.uploadManifest(sessionId, {
      files: [{ remotePath, size: source.archiveBytes }],
      thumbnails: [],
      includeMissingPaths: true
    })
    const records: Array<Record<string, unknown>> = []
    if (params.targetFolderRecord && folderKey !== 'ALL') {
      records.push({ _type: 'folder', ...params.targetFolderRecord })
    }
    records.push({
      _type: 'asset',
      ...buildArchiveAssetRecord({
        assetKey,
        folderKey,
        archiveName: source.archiveName,
        remotePath,
        archiveBytes: source.archiveBytes,
        fileCount: source.fileCount,
        sourcePath: params.sourcePath
      })
    })
    await client.uploadMetadataChunk(sessionId, 0, records)
    onStage?.('upload_metadata', 1, 1, { sessionId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const errorCode = readErrorCode(err)
    return fail(message, errorCode || 'SESSION_SETUP_FAILED', { sessionId: sessionId || undefined })
  }

  // ── 打包 + 上传：一个请求。失败整包重来，宁可多传一遍也不做半截续传的花活 ──
  onStage?.('pack_upload', 0, source.archiveBytes, { sessionId })
  const uploadStartedAt = Date.now()
  let uploadAttempts = 0
  let defaultRetries = 0
  let busyRetries = 0
  let lastError: unknown = null
  let uploaded = false
  while (!uploaded) {
    uploadAttempts++
    let lastReportAt = 0
    const reportBytes = (sent: number): void => {
      const now = Date.now()
      if (now - lastReportAt < PROGRESS_THROTTLE_MS && sent < source.archiveBytes) return
      lastReportAt = now
      params.onBytes?.(sent, source.archiveBytes)
      onStage?.('pack_upload', sent, source.archiveBytes, { sessionId })
    }
    try {
      const stream = source.openStream(reportBytes)
      await client.uploadFileStream(
        sessionId,
        remotePath,
        stream as import('stream').Readable,
        source.archiveBytes,
        ARCHIVE_UPLOAD_IDLE_TIMEOUT_MS
      )
      uploaded = true
    } catch (err) {
      lastError = err
      const decision = decideUploadRetry(
        err,
        { defaultRetries, busyRetries },
        { defaultMaxRetries: UPLOAD_MAX_RETRIES, busyMaxRetries: UPLOAD_BUSY_MAX_RETRIES }
      )
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        `[ProjectArchiveUpload] upload attempt ${uploadAttempts} failed (${decision.bucket}, ` +
          `retry ${decision.retriesUsed}/${decision.maxRetries}) archive="${source.archiveName}" ` +
          `bytes=${source.archiveBytes} session=${sessionId}: ${message}`
      )
      if (!decision.shouldRetry) break
      if (decision.bucket === 'busy') busyRetries++
      else defaultRetries++
      const delay = getRetryAfterDelayMs(err) ?? Math.min(15_000, 2_000 * uploadAttempts)
      await sleep(delay)
    }
  }
  const uploadMs = Date.now() - uploadStartedAt
  if (!uploaded) {
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    const errorCode = readErrorCode(lastError)
    return fail(message, errorCode || 'ARCHIVE_UPLOAD_FAILED', {
      sessionId,
      uploadMs,
      uploadAttempts
    })
  }
  params.onBytes?.(source.archiveBytes, source.archiveBytes)
  onStage?.('pack_upload', source.archiveBytes, source.archiveBytes, { sessionId })

  // ── 提交 ──
  try {
    onStage?.('commit', 0, 1, { sessionId })
    let latest: ImportSessionData | null = null
    for (let attempt = 0; attempt < STAGED_WAIT_MAX_ATTEMPTS; attempt++) {
      latest = await client.getSession(sessionId)
      if (isImportSessionFailed(latest.status)) {
        return fail(
          latest.errorMessage || latest.errorCode || `服务端会话进入 ${latest.status} 状态`,
          latest.errorCode || 'SESSION_FAILED',
          { sessionId, uploadMs, uploadAttempts }
        )
      }
      if (latest.stagedFileCount >= 1) break
      await sleep(COMMIT_POLL_INTERVAL_MS)
    }
    if (!latest || latest.stagedFileCount < 1) {
      return fail('服务端未确认收到整包，未提交', 'STAGING_NOT_CONFIRMED', {
        sessionId,
        uploadMs,
        uploadAttempts
      })
    }

    let committed = await client.commitSession(sessionId)
    onStage?.('commit', 1, 1, { sessionId })
    for (
      let attempt = 0;
      attempt < COMMIT_POLL_MAX_ATTEMPTS &&
      committed.status !== 'committed' &&
      !isImportSessionFailed(committed.status);
      attempt++
    ) {
      onStage?.('poll_status', attempt, COMMIT_POLL_MAX_ATTEMPTS, { sessionId })
      await sleep(COMMIT_POLL_INTERVAL_MS)
      committed = await client.getSession(sessionId)
    }
    if (committed.status !== 'committed') {
      return fail(
        committed.errorMessage || committed.errorCode || `提交未完成：${committed.status}`,
        committed.errorCode || 'COMMIT_NOT_CONFIRMED',
        { sessionId, uploadMs, uploadAttempts }
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const errorCode = readErrorCode(err)
    return fail(message, errorCode || 'COMMIT_FAILED', { sessionId, uploadMs, uploadAttempts })
  }

  const elapsedMs = Date.now() - startedAt
  const mbPerSec =
    uploadMs > 0 ? Math.round((source.archiveBytes / 1e6 / (uploadMs / 1000)) * 10) / 10 : 0
  console.log(
    `[ProjectArchiveUpload] committed archive="${source.archiveName}" files=${source.fileCount} ` +
      `bytes=${source.archiveBytes} uploadMs=${uploadMs} rate=${mbPerSec}MB/s attempts=${uploadAttempts} ` +
      `excluded=${source.excludedDirs.length} symlinksSkipped=${source.skippedSymlinks.length} ` +
      `session=${sessionId}`
  )
  return {
    ...base,
    status: 'committed',
    sessionId,
    uploadMs,
    elapsedMs,
    mbPerSec,
    uploadAttempts
  }
}
