/**
 * RemoteImportService.ts — 远程导入编排器
 *
 * 职责：
 * 1. V2 Import Session 全流程：create → metadata chunks → files → thumbnails → commit → poll
 * 2. 若 V2 不可用（flag/probe），走 V1 /batch + uploadLocalFile
 * 3. 暴露 stage 回调，让调用方（assetData.ts）更新进度 UI
 *
 * Fallback 安全语义：
 * - 仅当 shouldUseV2ImportSession() 返回 false 时，走 V1 path
 * - 一旦 V2 session 已创建（sessionId 存在），任何后续错误都返回 V2 failed，
 *   绝不自动 fallback 到 V1，避免"未知 side effects + 二次导入"
 */

import { promises as fsPromises, createReadStream, existsSync, statSync } from 'fs'
import { extname } from 'path'
import {
  ImportSessionClient,
  DEFAULT_FILE_UPLOAD_TIMEOUT_MS
} from '../../networkV2/ImportSessionClient'
import type {
  ImportSessionData,
  ImportSessionReconcileRequest,
  ImportSessionReconcileResult
} from '../../networkV2/ImportSessionClient'
import { VaultServiceManager } from '../../networkV2/VaultServiceManager'
import { checkV2ImportReadiness } from './importFeatureFlag'
import { decideUploadRetry, getRetryAfterDelayMs } from './importUploadRetry'

// ─── 类型定义 ───────────────────────────────────────────────

export type ImportStage =
  | 'preflight'
  | 'create_session'
  | 'upload_metadata'
  | 'upload_files'
  | 'upload_thumbnails'
  | 'commit'
  | 'poll_status'
  | 'fallback_to_v1'
  | 'v1_batch_push'
  | 'v1_upload_files'
  | 'v1_upload_thumbnails'

export interface StageMeta {
  sessionId?: string
  mode?: 'v2-session' | 'v1-batch'
}

export type StageCallback = (
  stage: ImportStage,
  progress: number,
  total: number,
  meta?: StageMeta
) => void

export interface RemoteImportIssueEntry {
  stage:
    | 'remote_file_upload'
    | 'remote_thumbnail_upload'
    | 'remote_file_skipped_large'
    | 'remote_preflight'
    | 'remote_pre_commit_verify'
    | 'remote_commit_poll'
  fileName: string
  path: string
  error: string
  sessionId?: string
  remotePath?: string
  errorCode?: string
  statusCode?: string
  details?: Record<string, unknown>
}

interface ThumbnailBundleBuildResult {
  bundles: Buffer[]
  builtEntries: number
  issueEntries: RemoteImportIssueEntry[]
}

export interface RemoteImportResult {
  mode: 'v2-session' | 'v1-batch'
  status:
    | 'committed'
    | 'failed'
    | 'partial'
    | 'fallback_v1_completed'
    | 'fallback_v1_failed'
    | 'fallback_v1_partial'
  sessionId?: string
  error?: string
  errorCode?: string
  filesUploaded: number
  filesFailed: number
  /** 因超过服务端单文件上限而被跳过的文件数 */
  filesSkippedLarge: number
  thumbsUploaded: number
  thumbsFailed: number
  committedFolders?: number
  committedAssets?: number
  expectedFolders?: number
  expectedAssets?: number
  committedFiles?: number
  expectedFiles?: number
  committedThumbnails?: number
  expectedThumbnails?: number
  reconcile?: ImportSessionReconcileResult | null
  commitAttempted?: boolean
  issueEntries?: RemoteImportIssueEntry[]
}

export interface RemoteImportParams {
  signal?: AbortSignal
  /** Server HTTP base URL, e.g. http://192.168.1.100:18900 */
  serverUrl: string
  /** Vault ID on the remote server */
  vaultId: string
  /** Client unique identifier */
  clientId: string
  /** Folders to push (pre-collected) */
  folders: Array<Record<string, unknown>>
  /** Assets to push (pre-collected) */
  assets: Array<Record<string, unknown>>
  /** Thumbnails to push */
  thumbnails: Array<{ localPath: string; remotePath: string }>
  /** Original files for upload */
  files: Array<{ path: string; name: string }>
  /** Root folder path (for computing relative remote paths) */
  rootFolderPath: string
  /** Existing target folder relative path on remote vault, e.g. Characters/Heroes */
  targetFolderPath?: string
  /** Existing target folder key on remote vault */
  targetFolderKey?: string
  /** Standalone server admin KEY used by temporary KEY-only write mode. */
  apiKey?: string
  /** Stage progress callback */
  onStage?: StageCallback
}

// ─── 常量 ────────────────────────────────────────────────────
// 可通过环境变量覆盖，便于后续调参不必到处改代码

const METADATA_CHUNK_SIZE = 500

/** 文件/缩略图上传并发数 — SSD NAS 默认 4，机械盘或高负载场景可通过环境变量调低 */
const UPLOAD_CONCURRENCY = parseInt(process.env.V2_IMPORT_UPLOAD_CONCURRENCY || '', 10) || 4
const LARGE_FILE_UPLOAD_CONCURRENCY =
  parseInt(process.env.V2_IMPORT_LARGE_FILE_UPLOAD_CONCURRENCY || '', 10) || 1
const LARGE_FILE_THRESHOLD_BYTES =
  parseInt(process.env.V2_IMPORT_LARGE_FILE_THRESHOLD_BYTES || '', 10) || 64 * 1024 * 1024
const LARGE_FILE_TIMEOUT_PER_MB_MS =
  parseInt(process.env.V2_IMPORT_LARGE_FILE_TIMEOUT_PER_MB_MS || '', 10) || 1_500
const MAX_FILE_UPLOAD_TIMEOUT_MS =
  parseInt(process.env.V2_IMPORT_MAX_FILE_UPLOAD_TIMEOUT_MS || '', 10) || 30 * 60 * 1000
const LARGE_FILE_EXTENSIONS = new Set(['.mp4', '.mov', '.mxf', '.bin'])
const MAX_THUMBNAIL_BUNDLE_BYTES =
  parseInt(process.env.V2_IMPORT_MAX_THUMBNAIL_BUNDLE_BYTES || '', 10) || 32 * 1024 * 1024
const MAX_THUMBNAIL_BUNDLE_ENTRIES =
  parseInt(process.env.V2_IMPORT_MAX_THUMBNAIL_BUNDLE_ENTRIES || '', 10) || 2_000

/** 单文件上传最大重试次数（不含首次） */
const UPLOAD_MAX_RETRIES = parseInt(process.env.V2_IMPORT_UPLOAD_MAX_RETRIES || '', 10) || 3
const UPLOAD_BUSY_MAX_RETRIES =
  parseInt(process.env.V2_IMPORT_UPLOAD_BUSY_MAX_RETRIES || '', 10) || 120
const UPLOAD_BUSY_RETRY_BASE_DELAY_MS =
  parseInt(process.env.V2_IMPORT_UPLOAD_BUSY_RETRY_BASE_DELAY_MS || '', 10) || 5_000

/** V2 session 控制面重试次数（create / metadata / commit / poll） */
const SESSION_CONTROL_MAX_RETRIES =
  parseInt(process.env.V2_IMPORT_SESSION_MAX_RETRIES || '', 10) || 3

/** V2 session 控制面重试基础退避（ms） */
const SESSION_CONTROL_RETRY_BASE_DELAY_MS =
  parseInt(process.env.V2_IMPORT_SESSION_RETRY_BASE_DELAY_MS || '', 10) || 1000

/**
 * V2 单文件上传保护阈值（bytes）— Phase 1 风险控制值
 *
 * ⚠️ 重要：此值不是协议极限，而是客户端内存安全阈值。
 * - 服务端已支持流式接收，无硬限。
 * - Phase 2 起主文件上传已改为 createReadStream→pipe→req，
 *   不再为单个文件额外分配整块 Buffer。
 * - 当前仍保留 512MB 默认阈值作为保守保护阀，避免与旧服务端/历史环境组合时
 *   一次导入超大文件造成异常；稳定后可继续放宽。
 * - 高级用户可通过 V2_IMPORT_MAX_SINGLE_FILE_BYTES 环境变量覆盖
 *   （例如设为 2147483648 即 2GB），但需自行承担内存风险。
 * - 后续如果缩略图 bundle 也改为流式/分块，可进一步放宽此阈值。
 */
const parsedMaxSingleFileBytes = parseInt(process.env.V2_IMPORT_MAX_SINGLE_FILE_BYTES || '', 10)
export const MAX_V2_SINGLE_FILE_BYTES =
  Number.isFinite(parsedMaxSingleFileBytes) && parsedMaxSingleFileBytes > 0
    ? parsedMaxSingleFileBytes
    : 0
const HAS_V2_SINGLE_FILE_LIMIT = MAX_V2_SINGLE_FILE_BYTES > 0

const POLL_INTERVAL_MS = 1500
const POLL_MAX_ATTEMPTS = 40 // 60s max poll

const PRE_COMMIT_VERIFY_BASE_WAIT_MS =
  parseInt(process.env.V2_IMPORT_PRECOMMIT_VERIFY_BASE_WAIT_MS || '', 10) || 8_000
const PRE_COMMIT_VERIFY_PER_ITEM_WAIT_MS =
  parseInt(process.env.V2_IMPORT_PRECOMMIT_VERIFY_PER_ITEM_WAIT_MS || '', 10) || 2
const PRE_COMMIT_VERIFY_MAX_WAIT_MS =
  parseInt(process.env.V2_IMPORT_PRECOMMIT_VERIFY_MAX_WAIT_MS || '', 10) || 90_000
const PRE_COMMIT_VERIFY_POLL_INTERVAL_MS =
  parseInt(process.env.V2_IMPORT_PRECOMMIT_VERIFY_POLL_INTERVAL_MS || '', 10) || 1_000
const PRE_COMMIT_VERIFY_PROGRESS_GRACE_MS =
  parseInt(process.env.V2_IMPORT_PRECOMMIT_VERIFY_PROGRESS_GRACE_MS || '', 10) || 15_000
const PRE_COMMIT_VERIFY_EXTRA_WAIT_MS =
  parseInt(process.env.V2_IMPORT_PRECOMMIT_VERIFY_EXTRA_WAIT_MS || '', 10) || 60_000

// UATB bundle 常量（必须和服务端 ImportSessionStore 一致）
const UATB_MAGIC = Buffer.from('UATB', 'ascii')
const UATB_VERSION = 0x01

// V2 thumbnail 路径前缀 — 客户端主链传入 `.thumbnails/xxx`，V2 API 只需 `xxx`
const THUMBNAIL_PREFIX = '.thumbnails/'

class AsyncQueue {
  private chain: Promise<unknown> = Promise.resolve()

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }
}

const vaultControlQueues = new Map<string, AsyncQueue>()

function getVaultControlQueue(vaultId: string): AsyncQueue {
  let queue = vaultControlQueues.get(vaultId)
  if (!queue) {
    queue = new AsyncQueue()
    vaultControlQueues.set(vaultId, queue)
  }
  return queue
}

async function runInVaultControlPlane<T>(
  vaultId: string,
  label: string,
  task: () => Promise<T>
): Promise<T> {
  return getVaultControlQueue(vaultId).enqueue(async () => {
    console.log(`[RemoteImportService] [control-plane] enter vault=${vaultId} label=${label}`)
    try {
      return await task()
    } finally {
      console.log(`[RemoteImportService] [control-plane] leave vault=${vaultId} label=${label}`)
    }
  })
}

function isRetriableSessionError(err: unknown): boolean {
  const errMsg = err instanceof Error ? err.message : String(err)
  const statusCode =
    typeof err === 'object' && err && 'statusCode' in err ? Number((err as any).statusCode) : NaN

  if (Number.isFinite(statusCode)) {
    return (
      statusCode >= 500 ||
      statusCode === 408 ||
      statusCode === 409 ||
      statusCode === 425 ||
      statusCode === 429
    )
  }

  return (
    /timeout/i.test(errMsg) ||
    /ECONNRESET/i.test(errMsg) ||
    /EPIPE/i.test(errMsg) ||
    /socket hang up/i.test(errMsg) ||
    /ETIMEDOUT/i.test(errMsg) ||
    /ECONNREFUSED/i.test(errMsg) ||
    /network/i.test(errMsg)
  )
}

async function withSessionRetry<T>(
  operationName: string,
  task: () => Promise<T>,
  context: {
    sessionId?: string
    maxRetries?: number
    retryBaseDelayMs?: number
  } = {}
): Promise<T> {
  const maxRetries = context.maxRetries ?? SESSION_CONTROL_MAX_RETRIES
  const retryBaseDelayMs = context.retryBaseDelayMs ?? SESSION_CONTROL_RETRY_BASE_DELAY_MS
  let lastErr: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await task()
    } catch (err) {
      lastErr = err
      const retriable = attempt < maxRetries && isRetriableSessionError(err)
      const errMsg = err instanceof Error ? err.message : String(err)
      const statusCode =
        typeof err === 'object' && err && 'statusCode' in err
          ? String((err as any).statusCode || '')
          : ''
      console.warn(
        `[RemoteImportService] ${operationName} failed ` +
          `(attempt ${attempt + 1}/${maxRetries + 1}) ` +
          `sessionId=${context.sessionId || '-'} status=${statusCode || '-'} retriable=${retriable}: ${errMsg}`
      )
      if (!retriable) break
      const delay = getRetryAfterDelayMs(err) ?? retryBaseDelayMs * Math.pow(2, attempt)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function computePreCommitVerifyBudgetMs(
  expectedFileCount: number,
  expectedThumbnailCount: number
): number {
  const totalItems = Math.max(0, expectedFileCount) + Math.max(0, expectedThumbnailCount)
  const scaledWaitMs =
    PRE_COMMIT_VERIFY_BASE_WAIT_MS + totalItems * PRE_COMMIT_VERIFY_PER_ITEM_WAIT_MS
  return Math.max(
    PRE_COMMIT_VERIFY_BASE_WAIT_MS,
    Math.min(PRE_COMMIT_VERIFY_MAX_WAIT_MS, scaledWaitMs)
  )
}

function isLargeFileCandidate(filePath: string, fileSizeBytes: number): boolean {
  const normalizedExt = extname(filePath).toLowerCase()
  return fileSizeBytes >= LARGE_FILE_THRESHOLD_BYTES || LARGE_FILE_EXTENSIONS.has(normalizedExt)
}

function computeFileUploadTimeoutMs(fileSizeBytes: number, defaultTimeoutMs: number): number {
  const sizeMb = Math.max(1, Math.ceil(fileSizeBytes / (1024 * 1024)))
  const scaledTimeoutMs = sizeMb * LARGE_FILE_TIMEOUT_PER_MB_MS
  return Math.max(defaultTimeoutMs, Math.min(MAX_FILE_UPLOAD_TIMEOUT_MS, scaledTimeoutMs))
}

function safeStatSize(filePath: string): number | null {
  try {
    return statSync(filePath).size
  } catch {
    return null
  }
}

function computeExpectedUploadBytes(params: RemoteImportParams): number {
  const fileBytes = params.files.reduce((sum, file) => sum + (safeStatSize(file.path) || 0), 0)
  const thumbnailBytes = params.thumbnails.reduce(
    (sum, thumbnail) => sum + (safeStatSize(thumbnail.localPath) || 0),
    0
  )
  return fileBytes + thumbnailBytes
}

function samplePaths(paths: string[] | undefined, limit = 20): string[] {
  return (paths || []).slice(0, limit)
}

function summarizeReconcile(result: ImportSessionReconcileResult): string {
  return (
    `reconcile: files expected ${result.expected.files}, staged ${result.staged.files}, ` +
    `missing ${result.missingFiles}, sizeMismatch ${result.sizeMismatchFiles || 0}, ` +
    `duplicates ${result.duplicateFiles || 0}, unexpected ${result.unexpectedFiles || 0}; ` +
    `thumbnails expected ${result.expected.thumbnails}, staged ${result.staged.thumbnails}, ` +
    `missing ${result.missingThumbnails}, sizeMismatch ${result.sizeMismatchThumbnails || 0}, ` +
    `duplicates ${result.duplicateThumbnails || 0}, unexpected ${result.unexpectedThumbnails || 0}`
  )
}

function hasReconcileBlockingIssues(result: ImportSessionReconcileResult): boolean {
  return (
    result.consistent === false ||
    result.missingFiles > 0 ||
    result.missingThumbnails > 0 ||
    (result.sizeMismatchFiles || 0) > 0 ||
    (result.sizeMismatchThumbnails || 0) > 0 ||
    (result.duplicateFiles || 0) > 0 ||
    (result.duplicateThumbnails || 0) > 0 ||
    (result.unexpectedFiles || 0) > 0 ||
    (result.unexpectedThumbnails || 0) > 0
  )
}

function isImportSessionFailed(status: string): boolean {
  return status === 'failed' || status === 'failed_recoverable'
}

function buildReconcileIssueEntry(
  sessionId: string,
  rootFolderPath: string,
  error: string,
  reconcile: ImportSessionReconcileResult | null
): RemoteImportIssueEntry {
  return {
    stage: 'remote_pre_commit_verify',
    fileName: sessionId,
    path: rootFolderPath,
    error: reconcile ? `${error}; ${summarizeReconcile(reconcile)}` : error,
    sessionId,
    errorCode: 'PRE_COMMIT_STAGING_MISMATCH',
    details: reconcile
      ? {
          consistent: reconcile.consistent,
          expected: reconcile.expected,
          staged: reconcile.staged,
          missingFiles: reconcile.missingFiles,
          missingThumbnails: reconcile.missingThumbnails,
          sizeMismatchFiles: reconcile.sizeMismatchFiles || 0,
          sizeMismatchThumbnails: reconcile.sizeMismatchThumbnails || 0,
          duplicateFiles: reconcile.duplicateFiles || 0,
          duplicateThumbnails: reconcile.duplicateThumbnails || 0,
          unexpectedFiles: reconcile.unexpectedFiles || 0,
          unexpectedThumbnails: reconcile.unexpectedThumbnails || 0,
          missingFileSamples: samplePaths(reconcile.missingFilePaths),
          missingThumbnailSamples: samplePaths(reconcile.missingThumbnailPaths),
          sizeMismatchFileSamples: samplePaths(reconcile.sizeMismatchFilePaths),
          sizeMismatchThumbnailSamples: samplePaths(reconcile.sizeMismatchThumbnailPaths),
          duplicateFileSamples: samplePaths(reconcile.duplicateFileRemotePaths),
          duplicateThumbnailSamples: samplePaths(reconcile.duplicateThumbnailRemotePaths),
          unexpectedFileSamples: samplePaths(reconcile.unexpectedStagedFilePaths),
          unexpectedThumbnailSamples: samplePaths(reconcile.unexpectedStagedThumbnailPaths),
          diagnostics: reconcile.diagnostics || null
        }
      : undefined
  }
}

// 启动时打印一次当前配置，方便日志排查
console.log(
  `[RemoteImportService] config: UPLOAD_CONCURRENCY=${UPLOAD_CONCURRENCY}, ` +
    `UPLOAD_MAX_RETRIES=${UPLOAD_MAX_RETRIES}, ` +
    `UPLOAD_BUSY_MAX_RETRIES=${UPLOAD_BUSY_MAX_RETRIES}, ` +
    `MAX_V2_SINGLE_FILE_BYTES=${
      HAS_V2_SINGLE_FILE_LIMIT
        ? `${MAX_V2_SINGLE_FILE_BYTES} (${(MAX_V2_SINGLE_FILE_BYTES / 1024 / 1024).toFixed(0)}MB)`
        : 'disabled'
    }`
)

/**
 * 剥离 `.thumbnails/` 前缀，得到服务端 V2 Import Session 期望的裸相对路径
 * V1 fallback 不调用此函数（V1 直接 uploadLocalFile 到 vault 根相对路径）
 */
export function stripThumbnailPrefix(remotePath: string): string {
  if (remotePath.startsWith(THUMBNAIL_PREFIX)) {
    return remotePath.substring(THUMBNAIL_PREFIX.length)
  }
  // 兼容 backslash
  const normalized = remotePath.replace(/\\/g, '/')
  if (normalized.startsWith(THUMBNAIL_PREFIX)) {
    return normalized.substring(THUMBNAIL_PREFIX.length)
  }
  return remotePath
}

// ─── 主入口 ──────────────────────────────────────────────────

/**
 * 远程导入主入口
 *
 * Fallback 决策：
 * - 导入前先做 NAS V2 体检；HTTP 资产服务器不满足要求时直接拦截
 * - 体检通过后走 V2，V2 内部错误不 fallback
 */
export async function runRemoteImport(params: RemoteImportParams): Promise<RemoteImportResult> {
  const { serverUrl, vaultId, clientId, onStage } = params

  params.signal?.throwIfAborted()
  onStage?.('preflight', 0, 1, { mode: 'v2-session' })
  const readiness = await checkV2ImportReadiness(
    serverUrl,
    vaultId,
    clientId,
    params.targetFolderKey,
    computeExpectedUploadBytes(params),
    { bypassCapabilityCache: true, apiKey: params.apiKey }
  )

  if (readiness.supported && readiness.ready) {
    onStage?.('preflight', 1, 1, { mode: 'v2-session' })
    console.log(
      `[RemoteImportService] ▶ V2 session mode — ${params.assets.length} assets, ${params.files.length} files`
    )
    // 不 catch：V2 内部已做完整错误处理，返回 failed 而非抛异常
    return await runV2ImportSession(params)
  }

  // remote-http 模式下 V2 不可用 → 服务器版本太旧，不支持 Import Session API
  // 此时 V1 回退也不可能成功（remote-http 没有 V1 SyncClient），直接返回明确错误
  if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
    const userMessage =
      readiness.userMessage ||
      (readiness.errorCode === 'CLIENT_UPDATE_REQUIRED'
        ? '请更新客户端后再导入'
        : '当前 NAS 服务器版本过旧，请更新 NAS V2 服务端后再导入')
    console.error(
      `[RemoteImportService] ❌ NAS V2 import preflight blocked (${readiness.errorCode || '-'}): ` +
        userMessage
    )
    return {
      mode: 'v2-session',
      status: 'failed',
      error: userMessage,
      errorCode: readiness.errorCode || 'IMPORT_PREFLIGHT_BLOCKED',
      filesUploaded: 0,
      filesFailed: 0,
      filesSkippedLarge: 0,
      thumbsUploaded: 0,
      thumbsFailed: 0,
      expectedFiles: params.files.length,
      expectedThumbnails: params.thumbnails.length,
      issueEntries: [
        {
          stage: 'remote_preflight',
          fileName: vaultId,
          path: serverUrl,
          error: userMessage,
          errorCode: readiness.errorCode || 'IMPORT_PREFLIGHT_BLOCKED',
          details: {
            preflight: readiness.preflight || null
          }
        }
      ]
    }
  }

  // SMB 模式下 V2 不可用 → 正常回退到 V1 batch
  console.log(`[RemoteImportService] ▶ V1 batch mode (feature flag / capability)`)
  onStage?.('fallback_to_v1', 0, 1, { mode: 'v1-batch' })
  return await runV1BatchFallback(params)
}

// ─── V2 Import Session ──────────────────────────────────────

async function runV2ImportSession(params: RemoteImportParams): Promise<RemoteImportResult> {
  const {
    serverUrl,
    vaultId,
    clientId,
    folders,
    assets,
    thumbnails,
    rootFolderPath,
    targetFolderPath,
    targetFolderKey,
    onStage
  } = params
  let { files } = params

  const client = new ImportSessionClient({
    serverUrl,
    vaultId,
    clientId,
    apiKey: params.apiKey
  })
  let sessionId = ''
  let filesSkippedLarge = 0

  const normalizedRoot = rootFolderPath.replace(/\\/g, '/')
  const rootParent = normalizedRoot.substring(0, normalizedRoot.lastIndexOf('/'))
  const rootName = normalizedRoot.split('/').pop() || ''
  const normalizedTargetFolderPath = (targetFolderPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  const getRemotePath = (file: { path: string; name: string }): string => {
    const normalizedFilePath = file.path.replace(/\\/g, '/')
    let relativeRemotePath = file.name
    if (rootFolderPath !== 'ALL') {
      if (rootParent && normalizedFilePath.startsWith(rootParent + '/')) {
        relativeRemotePath = normalizedFilePath.substring(rootParent.length + 1)
      } else if (normalizedFilePath.startsWith(normalizedRoot + '/')) {
        relativeRemotePath =
          rootName + '/' + normalizedFilePath.substring(normalizedRoot.length + 1)
      } else {
        relativeRemotePath = rootName + '/' + file.name
      }
    }
    return normalizedTargetFolderPath
      ? `${normalizedTargetFolderPath}/${relativeRemotePath}`.replace(/\/+/g, '/')
      : relativeRemotePath
  }

  // 0. Pre-flight: 过滤超过客户端单文件保护阈值的文件，同步排除对应 metadata
  //    超阈值文件不上传、不入 metadata、不产生孤立记录（客户端内存保护）
  const oversizedFilePaths = new Set<string>()
  const eligibleFiles: typeof files = []
  if (HAS_V2_SINGLE_FILE_LIMIT) {
    for (const file of files) {
      try {
        const st = statSync(file.path)
        if (st.size > MAX_V2_SINGLE_FILE_BYTES) {
          oversizedFilePaths.add(file.path.replace(/\\/g, '/'))
          filesSkippedLarge++
          console.warn(
            `[RemoteImportService] ⚠️ SKIPPED oversized file: "${file.name}" ` +
              `size=${st.size} (${(st.size / 1024 / 1024).toFixed(1)}MB) ` +
              `exceeds client memory-safe upload limit (${(MAX_V2_SINGLE_FILE_BYTES / 1024 / 1024).toFixed(0)}MB) — ` +
              `will NOT upload or include in metadata`
          )
        } else {
          eligibleFiles.push(file)
        }
      } catch (statErr) {
        // stat 失败仍保留（让后续 upload 自然报错）
        eligibleFiles.push(file)
      }
    }
    files = eligibleFiles
  }
  const issueEntries: RemoteImportIssueEntry[] = []
  oversizedFilePaths.forEach((oversizedPath) => {
    const fileName = oversizedPath.split(/[\\/]/).pop() || oversizedPath
    issueEntries.push({
      stage: 'remote_file_skipped_large',
      fileName,
      path: oversizedPath,
      error: `文件超过客户端 ${(MAX_V2_SINGLE_FILE_BYTES / 1024 / 1024).toFixed(0)}MB 安全上传上限，已跳过`
    })
  })

  const remotePathByLocalPath = new Map<string, string>()
  for (const file of files) {
    remotePathByLocalPath.set(file.path.replace(/\\/g, '/'), getRemotePath(file))
  }

  // 过滤对应的 asset metadata — 避免孤立 asset 记录
  let filteredAssets = assets
  if (oversizedFilePaths.size > 0) {
    filteredAssets = assets.filter((asset) => {
      const originPath = String(asset.originPath || asset.filePath || '').replace(/\\/g, '/')
      if (oversizedFilePaths.has(originPath)) {
        console.log(
          `[RemoteImportService] 🗑️ Excluded metadata for oversized file: assetName="${asset.assetName || ''}" originPath="${originPath}"`
        )
        return false
      }
      return true
    })
    console.log(
      `[RemoteImportService] Pre-flight summary: ${filesSkippedLarge} oversized files skipped, ` +
        `${files.length} files eligible, ${filteredAssets.length}/${assets.length} assets in metadata`
    )
  }

  const manifestRequest: ImportSessionReconcileRequest = {
    files: files.map((file) => ({
      remotePath: getRemotePath(file),
      size: safeStatSize(file.path)
    })),
    thumbnails: thumbnails.map((thumbnail) => ({
      remotePath: stripThumbnailPrefix(thumbnail.remotePath),
      size: safeStatSize(thumbnail.localPath)
    })),
    includeMissingPaths: true
  }

  // 对远程服务器库，metadata.filePath 必须是 vault 内相对路径；
  // 如果继续保留本地绝对路径，后续 projectImport 会把它当成下载相对路径并触发 404。
  filteredAssets = filteredAssets.map((asset) => {
    const originPath = String(asset.originPath || '').replace(/\\/g, '/')
    const filePath = String(asset.filePath || '').replace(/\\/g, '/')
    const remoteFilePath =
      remotePathByLocalPath.get(originPath) || remotePathByLocalPath.get(filePath)
    if (!remoteFilePath) return asset
    console.log(
      `[RemoteImportService] 🔄 filePath rewrite: "${filePath}" → "${remoteFilePath}" (asset: ${asset.assetName || asset.assetKey || ''})`
    )
    return {
      ...asset,
      filePath: remoteFilePath
    }
  })

  // 1. Build metadata records (using filtered assets)
  const metadataRecords: Array<Record<string, unknown>> = []
  for (const folder of folders) {
    metadataRecords.push({ _type: 'folder', ...folder })
  }
  for (const asset of filteredAssets) {
    metadataRecords.push({ _type: 'asset', ...asset })
  }

  const totalChunks = Math.max(1, Math.ceil(metadataRecords.length / METADATA_CHUNK_SIZE))
  const importTraceLabel =
    `vault=${vaultId} root=${rootFolderPath} target=${normalizedTargetFolderPath || 'ALL'} ` +
    `folders=${folders.length} assets=${filteredAssets.length} files=${files.length} thumbs=${thumbnails.length}`

  console.log(`[RemoteImportService] session import start: ${importTraceLabel}`)

  // 2. Create session + upload metadata:
  //    对同一 vault 的控制面请求进行串行调度，避免多目录并发时 create/commit/poll 相互挤压。
  try {
    await runInVaultControlPlane(vaultId, `create+metadata:${rootFolderPath}`, async () => {
      onStage?.('create_session', 0, 1, { mode: 'v2-session' })
      const session = await withSessionRetry(
        'createSession',
        () => client.createSession(totalChunks, targetFolderKey || 'ALL'),
        { maxRetries: SESSION_CONTROL_MAX_RETRIES }
      )
      sessionId = session.sessionId
      console.log(
        `[RemoteImportService] Session created: sessionId=${sessionId}, ${importTraceLabel}`
      )
      onStage?.('create_session', 1, 1, { sessionId, mode: 'v2-session' })

      const manifest = await withSessionRetry(
        'uploadManifest',
        () => client.uploadManifest(sessionId, manifestRequest),
        { sessionId }
      )
      console.log(
        `[RemoteImportService] Manifest uploaded: sessionId=${sessionId}, ` +
          `files=${manifest.files}/${manifest.uniqueFiles}, ` +
          `thumbnails=${manifest.thumbnails}/${manifest.uniqueThumbnails}, ` +
          `duplicates=${manifest.duplicateFiles}/${manifest.duplicateThumbnails}`
      )

      for (let i = 0; i < totalChunks; i++) {
        params.signal?.throwIfAborted()
        onStage?.('upload_metadata', i, totalChunks, { sessionId, mode: 'v2-session' })
        const chunk = metadataRecords.slice(i * METADATA_CHUNK_SIZE, (i + 1) * METADATA_CHUNK_SIZE)
        const r = await withSessionRetry(
          `uploadMetadataChunk[${i + 1}/${totalChunks}]`,
          () => client.uploadMetadataChunk(sessionId, i, chunk),
          { sessionId }
        )
        console.log(
          `[RemoteImportService] Metadata chunk ${i}/${totalChunks}: ${r.recordCount} records`
        )
      }
      onStage?.('upload_metadata', totalChunks, totalChunks, { sessionId, mode: 'v2-session' })
    })
  } catch (controlErr) {
    const msg = controlErr instanceof Error ? controlErr.message : String(controlErr)
    const errorPrefix = sessionId ? 'Metadata upload failed' : 'createSession failed'
    console.error(`[RemoteImportService] ❌ ${errorPrefix}: ${msg}`)
    return {
      mode: 'v2-session',
      status: 'failed',
      sessionId: sessionId || undefined,
      error: `${errorPrefix}: ${msg}`,
      filesUploaded: 0,
      filesFailed: 0,
      filesSkippedLarge,
      thumbsUploaded: 0,
      thumbsFailed: 0
    }
  }

  // 4. Upload files (concurrent, with retry)
  let filesUploaded = 0
  let filesFailed = 0
  let abortedByFatalUpload = false
  let fatalUploadMessage = ''

  if (files.length > 0) {
    type PreparedUploadFile = {
      file: { path: string; name: string }
      remotePath: string
      fileSizeBytes: number
      timeoutMs: number
      useLargeFileLane: boolean
    }

    const preparedFiles: PreparedUploadFile[] = files.map((file) => {
      let fileSizeBytes = 0
      try {
        fileSizeBytes = statSync(file.path).size
      } catch {
        fileSizeBytes = 0
      }
      return {
        file,
        remotePath: getRemotePath(file),
        fileSizeBytes,
        timeoutMs: computeFileUploadTimeoutMs(fileSizeBytes, DEFAULT_FILE_UPLOAD_TIMEOUT_MS),
        useLargeFileLane: isLargeFileCandidate(file.path, fileSizeBytes)
      }
    })

    const normalFiles = preparedFiles.filter((file) => !file.useLargeFileLane)
    const largeFiles = preparedFiles.filter((file) => file.useLargeFileLane)
    const uploadOneFile = async (preparedFile: PreparedUploadFile): Promise<void> => {
      if (abortedByFatalUpload || params.signal?.aborted) return

      const { file, remotePath, timeoutMs, fileSizeBytes } = preparedFile
      let lastErr: unknown
      let totalAttempts = 0
      let defaultRetries = 0
      let busyRetries = 0
      while (true) {
        if (params.signal?.aborted || (abortedByFatalUpload && totalAttempts > 0)) return
        totalAttempts++
        try {
          const stream = createReadStream(file.path)
          await client.uploadFileStream(sessionId, remotePath, stream, fileSizeBytes, timeoutMs)
          filesUploaded++
          onStage?.('upload_files', filesUploaded + filesFailed, files.length, {
            sessionId,
            mode: 'v2-session'
          })
          return
        } catch (uploadErr) {
          lastErr = uploadErr
          const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr)
          const errorCode =
            typeof uploadErr === 'object' && uploadErr && 'errorCode' in uploadErr
              ? String((uploadErr as any).errorCode || '')
              : ''
          const statusCode =
            typeof uploadErr === 'object' && uploadErr && 'statusCode' in uploadErr
              ? String((uploadErr as any).statusCode || '')
              : ''
          const isTimeout = errMsg.includes('TIMEOUT') || errMsg.includes('timeout')
          const retryDecision = decideUploadRetry(
            uploadErr,
            { defaultRetries, busyRetries },
            {
              defaultMaxRetries: UPLOAD_MAX_RETRIES,
              busyMaxRetries: UPLOAD_BUSY_MAX_RETRIES
            }
          )
          console.warn(
            `[RemoteImportService] File upload ${isTimeout ? 'TIMEOUT' : 'ERROR'} ` +
              `(attempt ${totalAttempts}, retryBucket=${retryDecision.bucket} ` +
              `${retryDecision.retriesUsed}/${retryDecision.maxRetries}) ` +
              `file="${file.name}" size=${fileSizeBytes} timeout=${timeoutMs} remotePath="${remotePath}" ` +
              `sessionId=${sessionId} errorCode=${errorCode || '-'} status=${statusCode || '-'}: ${errMsg}`
          )
          if (retryDecision.shouldRetry) {
            if (retryDecision.bucket === 'busy') {
              busyRetries++
            } else {
              defaultRetries++
            }
            const delay =
              getRetryAfterDelayMs(uploadErr) ??
              (retryDecision.bucket === 'busy'
                ? UPLOAD_BUSY_RETRY_BASE_DELAY_MS
                : 1000 * Math.pow(2, retryDecision.retriesUsed))
            console.warn(`[RemoteImportService] ⏳ Retrying in ${delay}ms...`)
            await new Promise((r) => setTimeout(r, delay))
          } else {
            if (retryDecision.nonRetriable) {
              abortedByFatalUpload = true
              fatalUploadMessage = errMsg
              console.warn(
                `[RemoteImportService] ⛔ Retrying skipped for non-retriable upload error ` +
                  `file="${file.name}" sessionId=${sessionId}`
              )
            } else {
              console.warn(
                `[RemoteImportService] ⛔ Upload attempts exhausted ` +
                  `file="${file.name}" sessionId=${sessionId}`
              )
            }
            break
          }
        }
      }
      filesFailed++
      const finalMsg = lastErr instanceof Error ? lastErr.message : String(lastErr)
      const finalErrorCode =
        typeof lastErr === 'object' && lastErr && 'errorCode' in lastErr
          ? String((lastErr as any).errorCode || '')
          : ''
      const finalStatusCode =
        typeof lastErr === 'object' && lastErr && 'statusCode' in lastErr
          ? String((lastErr as any).statusCode || '')
          : ''
      issueEntries.push({
        stage: 'remote_file_upload',
        fileName: file.name,
        path: file.path,
        error: finalMsg,
        sessionId,
        remotePath,
        errorCode: finalErrorCode || undefined,
        statusCode: finalStatusCode || undefined
      })
      console.error(
        `[RemoteImportService] ❌ File upload FAILED after ${totalAttempts} attempts: ` +
          `file="${file.name}" size=${fileSizeBytes} timeout=${timeoutMs} remotePath="${remotePath}" ` +
          `sessionId=${sessionId} status=${finalStatusCode || '-'} errorCode=${finalErrorCode || '-'} error="${finalMsg}"`
      )
      onStage?.('upload_files', filesUploaded + filesFailed, files.length, {
        sessionId,
        mode: 'v2-session'
      })
    }

    const runFileQueue = async (
      queueFiles: PreparedUploadFile[],
      concurrency: number,
      lane: 'normal' | 'large'
    ): Promise<void> => {
      let uploadIndex = 0
      const workers: Promise<void>[] = []
      for (let w = 0; w < concurrency; w++) {
        workers.push(
          (async () => {
            while (
              !params.signal?.aborted &&
              !abortedByFatalUpload &&
              uploadIndex < queueFiles.length
            ) {
              const idx = uploadIndex++
              if (idx >= queueFiles.length) break
              await uploadOneFile(queueFiles[idx])
            }
          })()
        )
      }
      await Promise.all(workers)
      console.log(
        `[RemoteImportService] ${lane} file lane finished: ${queueFiles.length} queued, ` +
          `${filesUploaded}/${files.length} uploaded, ${filesFailed} failed`
      )
    }

    if (normalFiles.length > 0) {
      await runFileQueue(normalFiles, UPLOAD_CONCURRENCY, 'normal')
    }
    if (!abortedByFatalUpload && largeFiles.length > 0) {
      console.log(
        `[RemoteImportService] large file lane enabled: ${largeFiles.length} files, ` +
          `threshold=${LARGE_FILE_THRESHOLD_BYTES} bytes, concurrency=${LARGE_FILE_UPLOAD_CONCURRENCY}`
      )
      await runFileQueue(largeFiles, LARGE_FILE_UPLOAD_CONCURRENCY, 'large')
    }
    console.log(
      `[RemoteImportService] Files uploaded: ${filesUploaded}/${files.length} (${filesFailed} failed)`
    )

    if (abortedByFatalUpload || filesFailed > 0 || filesUploaded < files.length) {
      if (filesUploaded < files.length && filesFailed === 0) {
        issueEntries.push({
          stage: 'remote_file_upload',
          fileName: sessionId,
          path: params.rootFolderPath,
          error: `File upload stopped before all files were staged: uploaded ${filesUploaded}/${files.length}`,
          sessionId,
          errorCode: 'INCOMPLETE_FILE_UPLOAD'
        })
      }
      const reason = abortedByFatalUpload
        ? `fatal file upload error: ${fatalUploadMessage || 'unknown'}`
        : filesFailed > 0
          ? `file upload failures: ${filesFailed}/${files.length}`
          : `incomplete file upload: ${filesUploaded}/${files.length}`
      return {
        mode: 'v2-session',
        status: 'failed',
        sessionId,
        error: `File upload failed before commit: ${reason}`,
        errorCode: abortedByFatalUpload ? 'FATAL_FILE_UPLOAD' : 'INCOMPLETE_FILE_UPLOAD',
        filesUploaded,
        filesFailed,
        filesSkippedLarge,
        thumbsUploaded: 0,
        thumbsFailed: 0,
        committedFiles: filesUploaded,
        expectedFiles: files.length,
        issueEntries
      }
    }
  }

  // 5. Upload thumbnails (concurrent, with retry)
  let thumbsUploaded = 0
  let thumbsFailed = 0

  if (thumbnails.length > 0) {
    // V2 路径归一化：剥离 .thumbnails/ 前缀（服务端 staging 目录已隐含）
    const v2Thumbnails = thumbnails.map((t) => ({
      localPath: t.localPath,
      remotePath: stripThumbnailPrefix(t.remotePath)
    }))

    const bundleBuild = await buildThumbnailBundles(v2Thumbnails)
    if (bundleBuild.issueEntries.length > 0) {
      thumbsFailed += bundleBuild.issueEntries.length
      issueEntries.push(...bundleBuild.issueEntries)
    }

    // Try bundle mode first (split into smaller bundles to reduce memory pressure and proxy resets)
    if (bundleBuild.issueEntries.length === 0) {
      try {
        if (bundleBuild.bundles.length > 0) {
          onStage?.('upload_thumbnails', 0, bundleBuild.bundles.length, {
            sessionId,
            mode: 'v2-session'
          })
          for (let bundleIndex = 0; bundleIndex < bundleBuild.bundles.length; bundleIndex++) {
            params.signal?.throwIfAborted()
            const bundle = bundleBuild.bundles[bundleIndex]
            const timeoutMs = computeFileUploadTimeoutMs(
              bundle.byteLength,
              DEFAULT_FILE_UPLOAD_TIMEOUT_MS
            )
            await client.uploadThumbnailBundle(sessionId, bundle, timeoutMs)
            onStage?.('upload_thumbnails', bundleIndex + 1, bundleBuild.bundles.length, {
              sessionId,
              mode: 'v2-session'
            })
          }
          thumbsUploaded = bundleBuild.builtEntries
          console.log(
            `[RemoteImportService] Thumbnails bundle uploaded: ${bundleBuild.builtEntries} entries across ${bundleBuild.bundles.length} bundles`
          )
        }
      } catch (bundleErr) {
        console.warn(
          '[RemoteImportService] Bundle upload failed, falling back to individual uploads:',
          bundleErr
        )
        // Fallback: upload thumbnails individually
        let thumbIdx = 0
        const uploadOneThumb = async (thumb: {
          localPath: string
          remotePath: string
        }): Promise<void> => {
          try {
            if (!existsSync(thumb.localPath)) {
              throw new Error('Local thumbnail file is missing before upload')
            }
            const data = await fsPromises.readFile(thumb.localPath)
            await client.uploadThumbnail(sessionId, thumb.remotePath, data)
            thumbsUploaded++
          } catch (thumbErr) {
            thumbsFailed++
            const errMsg = thumbErr instanceof Error ? thumbErr.message : String(thumbErr)
            issueEntries.push({
              stage: 'remote_thumbnail_upload',
              fileName: thumb.remotePath.split('/').pop() || thumb.remotePath,
              path: thumb.localPath,
              error: errMsg
            })
            console.warn(
              `[RemoteImportService] Thumbnail upload failed: remotePath="${thumb.remotePath}" ` +
                `sessionId=${sessionId} error="${errMsg}"`
            )
          }
          onStage?.('upload_thumbnails', thumbsUploaded + thumbsFailed, thumbnails.length, {
            sessionId,
            mode: 'v2-session'
          })
        }

        const thumbWorkers: Promise<void>[] = []
        for (let w = 0; w < UPLOAD_CONCURRENCY; w++) {
          thumbWorkers.push(
            (async () => {
              while (!params.signal?.aborted && thumbIdx < v2Thumbnails.length) {
                const idx = thumbIdx++
                if (idx >= v2Thumbnails.length) break
                await uploadOneThumb(v2Thumbnails[idx])
              }
            })()
          )
        }
        await Promise.all(thumbWorkers)
      }
    }
    console.log(
      `[RemoteImportService] Thumbnails: ${thumbsUploaded}/${thumbnails.length} (${thumbsFailed} failed)`
    )

    if (thumbsFailed > 0 || thumbsUploaded < thumbnails.length) {
      const missingThumbnailCount = Math.max(0, thumbnails.length - thumbsUploaded - thumbsFailed)
      if (missingThumbnailCount > 0) {
        issueEntries.push({
          stage: 'remote_thumbnail_upload',
          fileName: sessionId,
          path: rootFolderPath,
          error: `${missingThumbnailCount} thumbnail(s) were not uploaded`
        })
      }
      const reason =
        thumbsFailed > 0
          ? `thumbnail upload failures: ${thumbsFailed}/${thumbnails.length}`
          : `thumbnail upload incomplete: ${thumbsUploaded}/${thumbnails.length}`
      return {
        mode: 'v2-session',
        status: 'failed',
        sessionId,
        error: `Thumbnail upload failed before commit: ${reason}`,
        errorCode: 'THUMBNAIL_UPLOAD_FAILED',
        filesUploaded,
        filesFailed,
        filesSkippedLarge,
        thumbsUploaded,
        thumbsFailed,
        committedFiles: filesUploaded,
        expectedFiles: files.length,
        committedThumbnails: thumbsUploaded,
        expectedThumbnails: thumbnails.length,
        issueEntries
      }
    }
  }

  const expectedFileCount = files.length
  const expectedThumbnailCount = thumbnails.length
  const reconcileRequest = manifestRequest
  const preCommitVerifyBudgetMs = computePreCommitVerifyBudgetMs(
    expectedFileCount,
    expectedThumbnailCount
  )
  const preCommitVerifyHardBudgetMs = preCommitVerifyBudgetMs + PRE_COMMIT_VERIFY_EXTRA_WAIT_MS
  let preCommitReconcile: ImportSessionReconcileResult | null = null
  try {
    await runInVaultControlPlane(vaultId, `pre-commit-verify:${sessionId}`, async () => {
      const verifyStartedAt = Date.now()
      const softBudgetDeadlineAt = verifyStartedAt + preCommitVerifyBudgetMs
      const hardBudgetDeadlineAt = verifyStartedAt + preCommitVerifyHardBudgetMs
      let latestSession: ImportSessionData | null = null
      let bestFileCount = 0
      let bestThumbCount = 0
      let lastProgressAt = verifyStartedAt
      let softBudgetReachedAt: number | null = null
      let attempt = 0
      while (true) {
        params.signal?.throwIfAborted()
        attempt++
        latestSession = await withSessionRetry(
          `getSession[pre-commit ${attempt}]`,
          () => client.getSession(sessionId),
          {
            sessionId,
            maxRetries: 2,
            retryBaseDelayMs: Math.min(SESSION_CONTROL_RETRY_BASE_DELAY_MS, 500)
          }
        )

        if (isImportSessionFailed(latestSession.status)) {
          throw new Error(
            latestSession.errorMessage ||
              latestSession.errorCode ||
              'Server session entered failed state before commit'
          )
        }

        const filesReady = latestSession.stagedFileCount >= expectedFileCount
        const thumbsReady = latestSession.stagedThumbnailCount >= expectedThumbnailCount
        if (filesReady && thumbsReady) {
          return
        }

        const nextBestFileCount = Math.max(bestFileCount, latestSession.stagedFileCount)
        const nextBestThumbCount = Math.max(bestThumbCount, latestSession.stagedThumbnailCount)
        const progressAdvanced =
          nextBestFileCount > bestFileCount || nextBestThumbCount > bestThumbCount
        bestFileCount = nextBestFileCount
        bestThumbCount = nextBestThumbCount

        const now = Date.now()
        if (progressAdvanced) {
          lastProgressAt = now
        }
        if (now >= softBudgetDeadlineAt && softBudgetReachedAt === null) {
          softBudgetReachedAt = now
        }

        const quietSince = Math.max(lastProgressAt, softBudgetReachedAt ?? verifyStartedAt)
        const quietMs = now - quietSince
        const softBudgetExpired =
          softBudgetReachedAt !== null && quietMs >= PRE_COMMIT_VERIFY_PROGRESS_GRACE_MS
        const hardBudgetExpired = now >= hardBudgetDeadlineAt

        if (softBudgetExpired || hardBudgetExpired) {
          break
        }

        await new Promise((resolve) => setTimeout(resolve, PRE_COMMIT_VERIFY_POLL_INTERVAL_MS))
      }

      const finalFileCount = latestSession?.stagedFileCount ?? bestFileCount
      const finalThumbCount = latestSession?.stagedThumbnailCount ?? bestThumbCount
      const fileProgress = `${finalFileCount}/${expectedFileCount}`
      const thumbProgress = `${finalThumbCount}/${expectedThumbnailCount}`
      const elapsedMs = Date.now() - verifyStartedAt
      throw new Error(
        `Server staging mismatch before commit after ${elapsedMs}ms ` +
          `(softBudget=${preCommitVerifyBudgetMs}ms, hardBudget=${preCommitVerifyHardBudgetMs}ms): ` +
          `files ${fileProgress}, thumbnails ${thumbProgress}`
      )
    })

    preCommitReconcile = await withSessionRetry(
      'reconcile[pre-commit]',
      () => client.reconcileSession(sessionId, reconcileRequest),
      { sessionId, maxRetries: 2 }
    )
    if (hasReconcileBlockingIssues(preCommitReconcile)) {
      throw new Error(
        `Server reconcile rejected pre-commit: ${summarizeReconcile(preCommitReconcile)}`
      )
    }
  } catch (verifyErr) {
    const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr)
    let reconcile: ImportSessionReconcileResult | null = preCommitReconcile
    try {
      if (!reconcile) {
        reconcile = await client.reconcileSession(sessionId, reconcileRequest)
      }
    } catch (reconcileErr) {
      console.warn('[RemoteImportService] reconcile after pre-commit failure failed:', reconcileErr)
    }
    const reportEntry = buildReconcileIssueEntry(sessionId, rootFolderPath, msg, reconcile)
    console.error(
      `[RemoteImportService] ❌ Pre-commit verification failed; session kept for recovery: ` +
        `${reportEntry.error}`
    )
    return {
      mode: 'v2-session',
      status: 'failed',
      sessionId,
      error: `Pre-commit verification failed: ${msg}`,
      errorCode: 'PRE_COMMIT_STAGING_MISMATCH',
      filesUploaded,
      filesFailed,
      filesSkippedLarge,
      thumbsUploaded,
      thumbsFailed,
      expectedFiles: expectedFileCount,
      expectedThumbnails: expectedThumbnailCount,
      reconcile,
      issueEntries: [...issueEntries, reportEntry]
    }
  }

  // 6. Commit + 7. Poll:
  //    同样走每个 vault 的控制面串行调度，避免多目录同时 commit/poll 造成会话级随机失败。
  let finalSession: ImportSessionData
  try {
    ;({ finalSession } = await runInVaultControlPlane(
      vaultId,
      `commit+poll:${sessionId}`,
      async () => {
        onStage?.('commit', 0, 1, { sessionId, mode: 'v2-session' })
        const committedSession = await withSessionRetry(
          'commitSession',
          async () => {
            try {
              params.signal?.throwIfAborted()
              return await client.commitSession(sessionId)
            } catch (commitErr) {
              try {
                return await client.getSession(sessionId)
              } catch {
                throw commitErr
              }
            }
          },
          { sessionId }
        )
        console.log(`[RemoteImportService] Commit response: status=${committedSession.status}`)
        onStage?.('commit', 1, 1, { sessionId, mode: 'v2-session' })

        let final = committedSession
        if (
          committedSession.status !== 'committed' &&
          !isImportSessionFailed(committedSession.status)
        ) {
          for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
            onStage?.('poll_status', i, POLL_MAX_ATTEMPTS, { sessionId, mode: 'v2-session' })
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
            final = await withSessionRetry(
              `getSession[poll ${i + 1}/${POLL_MAX_ATTEMPTS}]`,
              () => client.getSession(sessionId),
              {
                sessionId,
                maxRetries: 2,
                retryBaseDelayMs: Math.min(SESSION_CONTROL_RETRY_BASE_DELAY_MS, 500)
              }
            )
            if (final.status === 'committed' || isImportSessionFailed(final.status)) break
          }
        }

        return { finalSession: final }
      }
    ))
  } catch (controlErr) {
    const msg = controlErr instanceof Error ? controlErr.message : String(controlErr)
    console.error(`[RemoteImportService] ❌ Commit/poll failed: ${msg}`)
    return {
      mode: 'v2-session',
      status: 'failed',
      sessionId,
      error: `Commit/poll failed: ${msg}`,
      filesUploaded,
      filesFailed,
      filesSkippedLarge,
      thumbsUploaded,
      thumbsFailed,
      commitAttempted: true,
      issueEntries: [
        ...issueEntries,
        {
          stage: 'remote_commit_poll',
          fileName: sessionId,
          path: rootFolderPath,
          error: msg
        }
      ]
    }
  }

  console.log(
    `[RemoteImportService] session import final: ${importTraceLabel}, sessionId=${sessionId}, ` +
      `status=${finalSession.status}, committedFolders=${finalSession.committedFolders}, ` +
      `committedAssets=${finalSession.committedAssets}, errorCode=${finalSession.errorCode || '-'}`
  )

  // 8. Map to result
  let status: RemoteImportResult['status']
  const expectedFolderCount = folders.length
  const expectedAssetCount = filteredAssets.length
  const committedFileCount = finalSession.committedFileCount || 0
  const committedThumbnailCount = finalSession.committedThumbnailCount || 0
  const committedCountMismatch =
    finalSession.status === 'committed' &&
    (finalSession.committedFolders < expectedFolderCount ||
      finalSession.committedAssets < expectedAssetCount ||
      committedFileCount < expectedFileCount ||
      committedThumbnailCount < expectedThumbnailCount)
  const committedCountMismatchMessage = committedCountMismatch
    ? `Committed count mismatch: folders ${finalSession.committedFolders}/${expectedFolderCount}, assets ${finalSession.committedAssets}/${expectedAssetCount}, files ${committedFileCount}/${expectedFileCount}, thumbnails ${committedThumbnailCount}/${expectedThumbnailCount}`
    : ''
  if (finalSession.status === 'committed') {
    status =
      filesFailed > 0 || thumbsFailed > 0 || filesSkippedLarge > 0 || committedCountMismatch
        ? 'partial'
        : 'committed'
  } else {
    status = 'failed'
  }

  if (committedCountMismatch) {
    console.warn(
      `[RemoteImportService] ${committedCountMismatchMessage}; ${importTraceLabel}, sessionId=${sessionId}`
    )
  }

  if (filesSkippedLarge > 0) {
    console.log(
      `[RemoteImportService] ⚠️ ${filesSkippedLarge} file(s) were skipped (exceed ${(MAX_V2_SINGLE_FILE_BYTES / 1024 / 1024).toFixed(0)}MB client memory-safe limit). Status → ${status}`
    )
  }

  return {
    mode: 'v2-session',
    status,
    sessionId,
    error:
      finalSession.errorMessage ||
      (committedCountMismatch
        ? committedCountMismatchMessage
        : filesSkippedLarge > 0
          ? `${filesSkippedLarge} file(s) skipped: exceed client ${(MAX_V2_SINGLE_FILE_BYTES / 1024 / 1024).toFixed(0)}MB memory-safe upload limit`
          : undefined),
    errorCode:
      finalSession.errorCode || (committedCountMismatch ? 'COMMITTED_COUNT_MISMATCH' : undefined),
    filesUploaded,
    filesFailed,
    filesSkippedLarge,
    thumbsUploaded,
    thumbsFailed,
    committedFolders: finalSession.committedFolders,
    committedAssets: finalSession.committedAssets,
    expectedFolders: expectedFolderCount,
    expectedAssets: expectedAssetCount,
    committedFiles: committedFileCount,
    expectedFiles: expectedFileCount,
    committedThumbnails: committedThumbnailCount,
    expectedThumbnails: expectedThumbnailCount,
    issueEntries
  }
}

// ─── V1 Batch Fallback ───────────────────────────────────────

async function runV1BatchFallback(params: RemoteImportParams): Promise<RemoteImportResult> {
  const {
    serverUrl,
    vaultId,
    folders,
    assets,
    thumbnails,
    files,
    rootFolderPath,
    targetFolderPath,
    onStage
  } = params

  // remote-http 模式下不可能有 V1 SyncClient，直接拒绝
  // V1 SyncClient 仅存在于 SMB 共享路径模式
  if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
    return {
      mode: 'v1-batch',
      status: 'fallback_v1_failed',
      error:
        '远程客户端未连接, 无法导入 (remote-http 模式不支持 V1 回退, 请检查远程服务器连接状态)',
      filesUploaded: 0,
      filesFailed: 0,
      filesSkippedLarge: 0,
      thumbsUploaded: 0,
      thumbsFailed: 0
    }
  }

  const vsm = VaultServiceManager.getInstance()
  const syncClient = vsm.getClient(vaultId)
  if (!syncClient) {
    return {
      mode: 'v1-batch',
      status: 'fallback_v1_failed',
      error: '远程同步客户端未连接, 无法执行 V1 批量导入',
      filesUploaded: 0,
      filesFailed: 0,
      filesSkippedLarge: 0,
      thumbsUploaded: 0,
      thumbsFailed: 0
    }
  }

  let batchFailed = false
  let batchError = ''

  // 1. Push batch operations (folders + assets)
  onStage?.('v1_batch_push', 0, 1, { mode: 'v1-batch' })
  try {
    const batchOps: Array<{
      type: 'insert' | 'update' | 'delete'
      table: 'assetData' | 'assetFolder'
      data: Record<string, unknown>
    }> = []
    for (const folder of folders) {
      batchOps.push({ type: 'insert', table: 'assetFolder', data: folder })
    }
    for (const asset of assets) {
      batchOps.push({ type: 'insert', table: 'assetData', data: asset })
    }

    if (batchOps.length > 0) {
      const BATCH_SIZE = 200
      for (let i = 0; i < batchOps.length; i += BATCH_SIZE) {
        const batch = batchOps.slice(i, i + BATCH_SIZE)
        await syncClient.batch(batch)
        console.log(`[RemoteImportService/V1] Batch ${i + batch.length}/${batchOps.length}`)
      }
      console.log(`[RemoteImportService/V1] ✅ Batch push done: ${batchOps.length} records`)
    }
  } catch (pushErr) {
    batchFailed = true
    batchError = pushErr instanceof Error ? pushErr.message : String(pushErr)
    console.error('[RemoteImportService/V1] ❌ Batch push failed:', pushErr)
  }
  onStage?.('v1_batch_push', 1, 1, { mode: 'v1-batch' })

  let thumbsUploaded = 0
  let thumbsFailed = 0
  let filesUploaded = 0
  let filesFailed = 0

  // 2. Upload thumbnails (only if batch succeeded)
  if (!batchFailed && thumbnails.length > 0) {
    onStage?.('v1_upload_thumbnails', 0, thumbnails.length, { mode: 'v1-batch' })
    for (const thumb of thumbnails) {
      try {
        await syncClient.uploadLocalFile(thumb.localPath, thumb.remotePath)
        thumbsUploaded++
      } catch {
        thumbsFailed++
        console.warn(`[RemoteImportService/V1] Thumbnail upload failed: ${thumb.remotePath}`)
      }
      onStage?.('v1_upload_thumbnails', thumbsUploaded + thumbsFailed, thumbnails.length, {
        mode: 'v1-batch'
      })
    }
    console.log(`[RemoteImportService/V1] Thumbnails: ${thumbsUploaded}/${thumbnails.length}`)
  }

  // 3. Upload files (only if batch succeeded)
  if (!batchFailed && files.length > 0) {
    // Pause remote FileWatcher
    let watcherLeaseToken: string | null = null
    let leaseHeartbeat: ReturnType<typeof setInterval> | null = null
    try {
      watcherLeaseToken = await syncClient.pauseFileWatcher()
      console.log(`[RemoteImportService/V1] FileWatcher paused, token=${watcherLeaseToken}`)
      leaseHeartbeat = setInterval(async () => {
        if (watcherLeaseToken) {
          try {
            await syncClient.renewFileWatcherLease(watcherLeaseToken)
          } catch {}
        }
      }, 30_000)
    } catch {
      console.warn('[RemoteImportService/V1] FileWatcher pause failed, continuing')
    }

    try {
      const normalizedRoot = rootFolderPath.replace(/\\/g, '/')
      const rootParent = normalizedRoot.substring(0, normalizedRoot.lastIndexOf('/'))
      const rootName = normalizedRoot.split('/').pop() || ''
      const normalizedTargetFolderPath = (targetFolderPath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')

      const getRemotePath = (file: { path: string; name: string }): string => {
        const normalizedFilePath = file.path.replace(/\\/g, '/')
        let relativeRemotePath = file.name
        if (rootFolderPath !== 'ALL') {
          if (rootParent && normalizedFilePath.startsWith(rootParent + '/')) {
            relativeRemotePath = normalizedFilePath.substring(rootParent.length + 1)
          } else if (normalizedFilePath.startsWith(normalizedRoot + '/')) {
            relativeRemotePath =
              rootName + '/' + normalizedFilePath.substring(normalizedRoot.length + 1)
          } else {
            relativeRemotePath = rootName + '/' + file.name
          }
        }
        return normalizedTargetFolderPath
          ? `${normalizedTargetFolderPath}/${relativeRemotePath}`.replace(/\/+/g, '/')
          : relativeRemotePath
      }

      let uploadIndex = 0
      const uploadOneFile = async (file: { path: string; name: string }): Promise<void> => {
        const remotePath = getRemotePath(file)
        let lastErr: unknown
        for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
          try {
            await syncClient.uploadLocalFile(file.path, remotePath)
            filesUploaded++
            onStage?.('v1_upload_files', filesUploaded + filesFailed, files.length, {
              mode: 'v1-batch'
            })
            return
          } catch (uploadErr) {
            lastErr = uploadErr
            if (attempt < UPLOAD_MAX_RETRIES) {
              const delay = 1000 * Math.pow(2, attempt)
              await new Promise((r) => setTimeout(r, delay))
            }
          }
        }
        filesFailed++
        console.warn(`[RemoteImportService/V1] ❌ File upload failed: ${file.name}`, lastErr)
        onStage?.('v1_upload_files', filesUploaded + filesFailed, files.length, {
          mode: 'v1-batch'
        })
      }

      const workers: Promise<void>[] = []
      for (let w = 0; w < UPLOAD_CONCURRENCY; w++) {
        workers.push(
          (async () => {
            while (uploadIndex < files.length) {
              const idx = uploadIndex++
              if (idx >= files.length) break
              await uploadOneFile(files[idx])
            }
          })()
        )
      }
      await Promise.all(workers)
      console.log(
        `[RemoteImportService/V1] Files: ${filesUploaded}/${files.length} (${filesFailed} failed)`
      )
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat)
      if (watcherLeaseToken) {
        try {
          await syncClient.resumeFileWatcher(watcherLeaseToken)
        } catch {}
      }
    }
  }

  // 4. Determine result status
  let status: RemoteImportResult['status']
  if (batchFailed) {
    status = 'fallback_v1_failed'
  } else if (filesFailed > 0 || thumbsFailed > 0) {
    status = 'fallback_v1_partial'
  } else {
    status = 'fallback_v1_completed'
  }

  return {
    mode: 'v1-batch',
    status,
    error: batchError || undefined,
    filesUploaded,
    filesFailed,
    filesSkippedLarge: 0,
    thumbsUploaded,
    thumbsFailed
  }
}

// ─── 工具函数 ────────────────────────────────────────────────

/**
 * 构建 UATB 缩略图 bundle（与服务端 receiveThumbnailBundleStream 协议严格一致）
 *
 * 格式:
 *   [MAGIC: 4 bytes "UATB"]
 *   [VERSION: 1 byte = 0x01]
 *   [ENTRY_COUNT: 4 bytes uint32 LE]
 *   repeated {
 *     [PATH_LEN: 2 bytes uint16 LE]
 *     [PATH: PATH_LEN bytes UTF-8]
 *     [DATA_LEN: 4 bytes uint32 LE]
 *     [DATA: DATA_LEN bytes]
 *   }
 */
export async function buildThumbnailBundles(
  thumbnails: Array<{ localPath: string; remotePath: string }>
): Promise<ThumbnailBundleBuildResult> {
  // 1. 先收集所有可读的 entries
  const bundles: Buffer[] = []
  const issueEntries: RemoteImportIssueEntry[] = []
  let currentEntries: Array<{ pathBuf: Buffer; data: Buffer }> = []
  let currentBytes = 9
  let builtEntries = 0

  const flushBundle = () => {
    if (currentEntries.length === 0) return

    const header = Buffer.alloc(9)
    UATB_MAGIC.copy(header, 0)
    header[4] = UATB_VERSION
    header.writeUInt32LE(currentEntries.length, 5)

    const parts: Buffer[] = [header]
    for (const entry of currentEntries) {
      const pathLenBuf = Buffer.alloc(2)
      pathLenBuf.writeUInt16LE(entry.pathBuf.length, 0)

      const dataLenBuf = Buffer.alloc(4)
      dataLenBuf.writeUInt32LE(entry.data.length, 0)

      parts.push(pathLenBuf, entry.pathBuf, dataLenBuf, entry.data)
    }

    bundles.push(Buffer.concat(parts))
    currentEntries = []
    currentBytes = 9
  }

  for (const thumb of thumbnails) {
    if (!existsSync(thumb.localPath)) {
      issueEntries.push({
        stage: 'remote_thumbnail_upload',
        fileName: thumb.remotePath.split('/').pop() || thumb.remotePath,
        path: thumb.localPath,
        error: 'Local thumbnail file is missing before bundle upload'
      })
      continue
    }
    try {
      const data = await fsPromises.readFile(thumb.localPath)
      const pathBuf = Buffer.from(thumb.remotePath, 'utf-8')
      const entryBytes = 2 + pathBuf.length + 4 + data.length
      const shouldFlushCurrent =
        currentEntries.length > 0 &&
        (currentEntries.length >= MAX_THUMBNAIL_BUNDLE_ENTRIES ||
          currentBytes + entryBytes > MAX_THUMBNAIL_BUNDLE_BYTES)

      if (shouldFlushCurrent) {
        flushBundle()
      }

      currentEntries.push({ pathBuf, data })
      currentBytes += entryBytes
      builtEntries++

      if (
        currentEntries.length >= MAX_THUMBNAIL_BUNDLE_ENTRIES ||
        currentBytes >= MAX_THUMBNAIL_BUNDLE_BYTES
      ) {
        flushBundle()
      }
    } catch (err) {
      issueEntries.push({
        stage: 'remote_thumbnail_upload',
        fileName: thumb.remotePath.split('/').pop() || thumb.remotePath,
        path: thumb.localPath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  flushBundle()
  return {
    bundles,
    builtEntries,
    issueEntries
  }
}
