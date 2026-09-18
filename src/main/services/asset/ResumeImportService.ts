import { createReadStream, existsSync, statSync } from 'fs'
import { promises as fs } from 'fs'
import { basename, extname } from 'path'
import { hostname, userInfo } from 'os'

import {
  DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
  ImportSessionClient,
  type ImportSessionData,
  type ImportSessionReconcileResult
} from '../../networkV2/ImportSessionClient'
import { VaultServiceManager } from '../../networkV2/VaultServiceManager'
import { getDatabaseManager, getPublicDatabase } from '../../sqliteDataBase'
import {
  type ImportRecoveryContextStatus,
  updateImportRecoveryContextStatus
} from '../../sqliteDataBase/models/importRecoveryContext'
import {
  type ImportRecoveryContext,
  type ImportRecoveryFileEntry,
  type ImportRecoveryThumbnailEntry,
  loadImportRecoveryContext,
  saveImportRecoveryContext
} from './ImportRecoveryContextService'
import { checkV2ImportReadiness } from './importFeatureFlag'
import { decideUploadRetry, getRetryAfterDelayMs } from './importUploadRetry'

export interface ResumeImportReportFile {
  path?: string
  name?: string
  remotePath?: string
}

export interface ResumeImportReportContext {
  taskId?: string
  diagnosticId?: string
  vaultId?: string
  localVaultId?: string
  serverUrl?: string
  remoteVaultId?: string
  sessionId?: string
  rootFolderPath?: string
  targetFolderKey?: string | null
  targetFolderPath?: string | null
  files?: ResumeImportReportFile[]
}

export interface ResumeImportRequest {
  taskId?: string
  diagnosticId?: string
  report?: ResumeImportReportContext
}

export interface ResumeImportResult {
  success: boolean
  status: 'committed' | 'failed' | 'not_resumable' | 'not_found' | 'expired'
  uploadedFiles: number
  uploadedThumbnails: number
  committed: boolean
  diagnosticId?: string
  sessionId?: string
  missingFiles?: number
  missingThumbnails?: number
  error?: string
}

const RESUME_UPLOAD_CONCURRENCY =
  parseInt(process.env.V2_IMPORT_RESUME_UPLOAD_CONCURRENCY || '', 10) || 4
const RESUME_UPLOAD_MAX_RETRIES = parseInt(process.env.V2_IMPORT_UPLOAD_MAX_RETRIES || '', 10) || 3
const RESUME_UPLOAD_BUSY_MAX_RETRIES =
  parseInt(process.env.V2_IMPORT_UPLOAD_BUSY_MAX_RETRIES || '', 10) || 120
const RESUME_UPLOAD_BUSY_RETRY_BASE_DELAY_MS =
  parseInt(process.env.V2_IMPORT_UPLOAD_BUSY_RETRY_BASE_DELAY_MS || '', 10) || 5_000
const LARGE_FILE_THRESHOLD_BYTES =
  parseInt(process.env.V2_IMPORT_LARGE_FILE_THRESHOLD_BYTES || '', 10) || 64 * 1024 * 1024
const LARGE_FILE_TIMEOUT_PER_MB_MS =
  parseInt(process.env.V2_IMPORT_LARGE_FILE_TIMEOUT_PER_MB_MS || '', 10) || 1_500
const MAX_FILE_UPLOAD_TIMEOUT_MS =
  parseInt(process.env.V2_IMPORT_MAX_FILE_UPLOAD_TIMEOUT_MS || '', 10) || 30 * 60 * 1000
const LARGE_FILE_EXTENSIONS = new Set(['.mp4', '.mov', '.mxf', '.bin'])
const POLL_INTERVAL_MS = 1500
const POLL_MAX_ATTEMPTS = 40

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function getClientId(): string {
  const name = (() => {
    try {
      return userInfo().username
    } catch {
      return 'unknown'
    }
  })()
  return `${hostname() || 'client'}-${name}`
}

function getRecordedOrCurrentSize(
  recordedSize: number | null | undefined,
  filePath: string
): number {
  if (Number.isFinite(recordedSize) && (recordedSize || 0) > 0) {
    return Math.ceil(recordedSize || 0)
  }
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

function safeCurrentSize(filePath: string): number | null {
  try {
    return statSync(filePath).size
  } catch {
    return null
  }
}

function parseRemoteHttpNetworkPath(
  networkPath?: string | null
): { serverUrl: string; remoteVaultId: string } | null {
  const value = typeof networkPath === 'string' ? networkPath.trim() : ''
  if (!/^https?:\/\//i.test(value)) return null
  const lastSlash = value.lastIndexOf('/')
  const schemeIndex = value.indexOf('://')
  if (lastSlash <= schemeIndex + 2) return null
  const serverUrl = value.substring(0, lastSlash)
  const remoteVaultId = value.substring(lastSlash + 1)
  return serverUrl && remoteVaultId ? { serverUrl, remoteVaultId } : null
}

async function buildContextFromReport(
  report: ResumeImportReportContext,
  diagnosticId?: string
): Promise<{ context?: ImportRecoveryContext; error?: string }> {
  const sessionId = report.sessionId
  if (!sessionId) {
    return { error: 'JSON 报告里缺少 sessionId，无法定位服务端导入会话' }
  }

  const reportFiles = (Array.isArray(report.files) ? report.files : []).filter(
    (file) => file?.path && file.remotePath
  )
  if (reportFiles.length === 0) {
    return { error: 'JSON 报告里没有可补传的 remote_file_upload 文件明细' }
  }

  let localVaultId = report.localVaultId || report.vaultId || ''
  let serverUrl = report.serverUrl || ''
  let remoteVaultId = report.remoteVaultId || ''

  if (!serverUrl || !remoteVaultId || !localVaultId) {
    let parsed: { serverUrl: string; remoteVaultId: string } | null = null
    let resolvedLocalVaultId = ''
    try {
      const vaultManager = getDatabaseManager().getVaultManager()
      const reportVault = localVaultId ? vaultManager.getVaultById(localVaultId) : null
      const currentVault = vaultManager.getCurrentVault()
      const vault = reportVault || currentVault
      parsed = parseRemoteHttpNetworkPath(vault?.networkPath)
      resolvedLocalVaultId = vault?.id || ''
    } catch (error) {
      console.warn('[ResumeImportService] resolve report vault failed:', error)
    }

    if (!resolvedLocalVaultId || !parsed) {
      return {
        error:
          '本机没有找到这份 JSON 对应的 HTTP 资产库。请先重新连接到原来的 NAS 资产库，再拖入 JSON 续传。'
      }
    }

    localVaultId = resolvedLocalVaultId
    serverUrl = serverUrl || parsed.serverUrl
    remoteVaultId = remoteVaultId || parsed.remoteVaultId
  }

  const taskId = report.taskId || `report:${sessionId}`
  const files: ImportRecoveryFileEntry[] = reportFiles.map((file) => {
    const path = String(file.path)
    return {
      path,
      name: file.name || basename(path),
      remotePath: normalizeRemotePath(String(file.remotePath)),
      size: safeCurrentSize(path)
    }
  })

  const context: ImportRecoveryContext = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    taskId,
    localVaultId,
    serverUrl,
    remoteVaultId,
    sessionId,
    rootFolderPath: report.rootFolderPath || '',
    targetFolderKey: report.targetFolderKey || null,
    targetFolderPath: report.targetFolderPath || null,
    files,
    thumbnails: []
  }

  try {
    await saveImportRecoveryContext(context, diagnosticId || report.diagnosticId || null)
  } catch (error) {
    console.warn('[ResumeImportService] save report recovery context failed:', error)
  }

  return { context }
}

function computeResumeFileUploadBytes(
  context: ImportRecoveryContext,
  remotePaths: string[]
): number {
  const fileMap = makeEntryMap(context.files)
  return remotePaths.reduce((sum, remotePath) => {
    const file = fileMap.get(normalizeRemotePath(remotePath))
    return sum + (file ? getRecordedOrCurrentSize(file.size, file.path) : 0)
  }, 0)
}

function computeResumeThumbnailUploadBytes(
  context: ImportRecoveryContext,
  remotePaths: string[]
): number {
  const thumbnailMap = makeEntryMap(context.thumbnails)
  return remotePaths.reduce((sum, remotePath) => {
    const thumbnail = thumbnailMap.get(normalizeRemotePath(remotePath))
    return sum + (thumbnail ? getRecordedOrCurrentSize(thumbnail.size, thumbnail.localPath) : 0)
  }, 0)
}

async function getResumeReadinessError(
  context: ImportRecoveryContext,
  clientId: string,
  expectedUploadBytes = 0
): Promise<string | null> {
  const readiness = await checkV2ImportReadiness(
    context.serverUrl,
    context.remoteVaultId,
    clientId,
    context.targetFolderKey || 'ALL',
    expectedUploadBytes,
    { bypassCapabilityCache: true, apiKey: getStoredNetworkApiKey(context.localVaultId) }
  )
  if (readiness.supported && readiness.ready) return null
  return (
    readiness.userMessage ||
    (readiness.errorCode === 'CLIENT_UPDATE_REQUIRED'
      ? '请更新客户端后再继续上传'
      : '当前 NAS V2 服务器暂时不支持继续上传，请检查服务器状态后重试')
  )
}

function computeFileUploadTimeoutMs(fileSizeBytes: number, defaultTimeoutMs: number): number {
  const sizeMb = Math.max(1, Math.ceil(fileSizeBytes / (1024 * 1024)))
  const scaledTimeoutMs = sizeMb * LARGE_FILE_TIMEOUT_PER_MB_MS
  return Math.max(defaultTimeoutMs, Math.min(MAX_FILE_UPLOAD_TIMEOUT_MS, scaledTimeoutMs))
}

function isLargeFileCandidate(filePath: string, fileSizeBytes: number): boolean {
  const normalizedExt = extname(filePath).toLowerCase()
  return fileSizeBytes >= LARGE_FILE_THRESHOLD_BYTES || LARGE_FILE_EXTENSIONS.has(normalizedExt)
}

function isImportSessionFailed(status: string): boolean {
  return status === 'failed' || status === 'failed_recoverable'
}

function isSessionNotFoundError(error: unknown): boolean {
  const errorCode =
    typeof error === 'object' && error && 'errorCode' in error
      ? String((error as any).errorCode || '')
      : ''
  const message = error instanceof Error ? error.message : String(error)
  return errorCode === 'SESSION_NOT_FOUND' || /\bSession not found\b/i.test(message)
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function runLimited<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const current = items[nextIndex++]
        await worker(current)
      }
    })
  )
}

function makeEntryMap<T extends { remotePath: string }>(entries: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const entry of entries) {
    map.set(normalizeRemotePath(entry.remotePath), entry)
  }
  return map
}

function getStoredNetworkApiKey(localVaultId: string): string | undefined {
  try {
    const databaseManager = getDatabaseManager() as unknown as {
      getVaultManager?: () => { getNetworkVaultApiKey?: (vaultId: string) => string | undefined }
    }
    return databaseManager?.getVaultManager?.()?.getNetworkVaultApiKey?.(localVaultId)
  } catch (error) {
    console.warn('[ResumeImportService] read network API key failed:', error)
    return undefined
  }
}

async function createImportSessionClient(
  context: ImportRecoveryContext
): Promise<ImportSessionClient> {
  return new ImportSessionClient({
    serverUrl: context.serverUrl,
    vaultId: context.remoteVaultId,
    clientId: getClientId(),
    apiKey: getStoredNetworkApiKey(context.localVaultId)
  })
}

async function reconcile(
  client: ImportSessionClient,
  context: ImportRecoveryContext
): Promise<ImportSessionReconcileResult> {
  return client.reconcileSession(context.sessionId, {
    files: context.files.map((file) => ({
      remotePath: file.remotePath,
      size: file.size
    })),
    thumbnails: context.thumbnails.map((thumbnail) => ({
      remotePath: thumbnail.remotePath,
      size: thumbnail.size
    })),
    includeMissingPaths: true
  })
}

async function uploadMissingFiles(
  client: ImportSessionClient,
  context: ImportRecoveryContext,
  missingPaths: string[]
): Promise<number> {
  const fileMap = makeEntryMap(context.files)
  const missingFiles = missingPaths.map((path) => {
    const entry = fileMap.get(normalizeRemotePath(path))
    if (!entry) throw new Error(`恢复上下文缺少文件: ${path}`)
    return entry
  })
  let uploaded = 0

  await runLimited<ImportRecoveryFileEntry>(
    missingFiles,
    RESUME_UPLOAD_CONCURRENCY,
    async (file) => {
      if (!existsSync(file.path)) {
        throw new Error(`本地文件不存在，无法续传: ${file.path}`)
      }
      const stat = statSync(file.path)
      const timeoutMs = isLargeFileCandidate(file.path, stat.size)
        ? computeFileUploadTimeoutMs(stat.size, DEFAULT_FILE_UPLOAD_TIMEOUT_MS)
        : DEFAULT_FILE_UPLOAD_TIMEOUT_MS
      await uploadMissingFileWithRetry(
        client,
        context.sessionId,
        file.remotePath,
        file.path,
        stat.size,
        timeoutMs
      )
      uploaded++
    }
  )

  return uploaded
}

async function uploadMissingFileWithRetry(
  client: ImportSessionClient,
  sessionId: string,
  remotePath: string,
  localPath: string,
  fileSize: number,
  timeoutMs: number
): Promise<void> {
  let totalAttempts = 0
  let defaultRetries = 0
  let busyRetries = 0
  let lastErr: unknown

  while (true) {
    totalAttempts++
    try {
      await client.uploadFileStream(
        sessionId,
        remotePath,
        createReadStream(localPath),
        fileSize,
        timeoutMs
      )
      return
    } catch (err) {
      lastErr = err
      const retryDecision = decideUploadRetry(
        err,
        { defaultRetries, busyRetries },
        {
          defaultMaxRetries: RESUME_UPLOAD_MAX_RETRIES,
          busyMaxRetries: RESUME_UPLOAD_BUSY_MAX_RETRIES
        }
      )
      if (!retryDecision.shouldRetry) break

      if (retryDecision.bucket === 'busy') {
        busyRetries++
      } else {
        defaultRetries++
      }
      const retryDelayMs =
        getRetryAfterDelayMs(err) ??
        (retryDecision.bucket === 'busy'
          ? RESUME_UPLOAD_BUSY_RETRY_BASE_DELAY_MS
          : 1000 * Math.pow(2, retryDecision.retriesUsed))
      console.warn(
        `[ResumeImportService] file retry in ${retryDelayMs}ms ` +
          `(attempt=${totalAttempts}, retryBucket=${retryDecision.bucket} ` +
          `${retryDecision.retriesUsed}/${retryDecision.maxRetries}) ` +
          `sessionId=${sessionId} remotePath="${remotePath}"`
      )
      await delay(retryDelayMs)
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(
    `续传文件失败 after ${totalAttempts} attempts: remotePath="${remotePath}" error="${msg}"`
  )
}

async function uploadMissingThumbnails(
  client: ImportSessionClient,
  context: ImportRecoveryContext,
  missingPaths: string[]
): Promise<number> {
  const thumbnailMap = makeEntryMap(context.thumbnails)
  const missingThumbnails = missingPaths.map((path) => {
    const entry = thumbnailMap.get(normalizeRemotePath(path))
    if (!entry) throw new Error(`恢复上下文缺少缩略图: ${path}`)
    return entry
  })
  let uploaded = 0

  await runLimited<ImportRecoveryThumbnailEntry>(
    missingThumbnails,
    RESUME_UPLOAD_CONCURRENCY,
    async (thumbnail) => {
      if (!existsSync(thumbnail.localPath)) {
        throw new Error(`本地缩略图不存在，无法续传: ${thumbnail.localPath}`)
      }
      const data = await fs.readFile(thumbnail.localPath)
      await client.uploadThumbnail(context.sessionId, thumbnail.remotePath, data)
      uploaded++
    }
  )

  return uploaded
}

async function waitForCommit(
  client: ImportSessionClient,
  sessionId: string
): Promise<ImportSessionData> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const session = await client.getSession(sessionId)
    if (session.status === 'committed' || isImportSessionFailed(session.status)) {
      return session
    }
    await delay(POLL_INTERVAL_MS)
  }
  return client.getSession(sessionId)
}

async function pullLocalVaultChanges(localVaultId: string): Promise<void> {
  const client = VaultServiceManager.getInstance().getClient(localVaultId)
  if (!client) return
  await client.pullChanges()
}

/** 返回值 = 这条状态真的写进去了吗。多数调用点不在乎，放弃导入那条在乎。 */
function markContextStatus(
  context: ImportRecoveryContext,
  status: ImportRecoveryContextStatus,
  error?: string | null,
  diagnosticId?: string | null
): boolean {
  try {
    return updateImportRecoveryContextStatus(
      getPublicDatabase(),
      context.taskId,
      status,
      error || null,
      diagnosticId || null
    )
  } catch (dbErr) {
    console.warn('[ResumeImportService] update recovery context failed:', dbErr)
    return false
  }
}

export async function resumeImport(request: ResumeImportRequest): Promise<ResumeImportResult> {
  let context = await loadImportRecoveryContext({
    taskId: request.taskId,
    diagnosticId: request.diagnosticId
  })

  if (!context && request.report) {
    const restored = await buildContextFromReport(request.report, request.diagnosticId)
    if (!restored.context) {
      return {
        success: false,
        status: 'not_found',
        uploadedFiles: 0,
        uploadedThumbnails: 0,
        committed: false,
        diagnosticId: request.diagnosticId,
        sessionId: request.report.sessionId,
        error: restored.error || '无法从 JSON 报告重建续传上下文'
      }
    }
    context = restored.context
  }

  if (!context) {
    return {
      success: false,
      status: 'not_found',
      uploadedFiles: 0,
      uploadedThumbnails: 0,
      committed: false,
      diagnosticId: request.diagnosticId,
      error: '未找到可续传的本地恢复上下文'
    }
  }

  markContextStatus(context, 'resuming', null, request.diagnosticId || null)
  let uploadedFiles = 0
  let uploadedThumbnails = 0

  try {
    const clientId = getClientId()
    const initialReadinessError = await getResumeReadinessError(context, clientId)
    if (initialReadinessError) {
      const error = initialReadinessError
      markContextStatus(context, 'failed', error, request.diagnosticId || null)
      return {
        success: false,
        status: 'failed',
        uploadedFiles: 0,
        uploadedThumbnails: 0,
        committed: false,
        diagnosticId: request.diagnosticId,
        sessionId: context.sessionId,
        error
      }
    }

    const client = await createImportSessionClient(context)
    const firstReconcile = await reconcile(client, context)
    if (firstReconcile.sessionStatus === 'committed') {
      markContextStatus(context, 'committed', null, request.diagnosticId || null)
      await pullLocalVaultChanges(context.localVaultId).catch((pullErr) => {
        console.warn('[ResumeImportService] pull after already committed session failed:', pullErr)
      })
      return {
        success: true,
        status: 'committed',
        uploadedFiles: 0,
        uploadedThumbnails: 0,
        committed: true,
        diagnosticId: request.diagnosticId,
        sessionId: context.sessionId,
        missingFiles: 0,
        missingThumbnails: 0
      }
    }

    if (!firstReconcile.canResume) {
      const error = `该导入会话当前状态不支持续传: ${firstReconcile.sessionStatus}`
      markContextStatus(context, 'failed', error, request.diagnosticId || null)
      return {
        success: false,
        status: 'not_resumable',
        uploadedFiles: 0,
        uploadedThumbnails: 0,
        committed: false,
        diagnosticId: request.diagnosticId,
        sessionId: context.sessionId,
        missingFiles: firstReconcile.missingFiles,
        missingThumbnails: firstReconcile.missingThumbnails,
        error
      }
    }

    const missingFilePaths = firstReconcile.repairFilePaths || firstReconcile.missingFilePaths || []
    const missingFileBytes = computeResumeFileUploadBytes(context, missingFilePaths)
    if (missingFileBytes > 0) {
      const fileReadinessError = await getResumeReadinessError(context, clientId, missingFileBytes)
      if (fileReadinessError) {
        markContextStatus(context, 'failed', fileReadinessError, request.diagnosticId || null)
        return {
          success: false,
          status: 'failed',
          uploadedFiles,
          uploadedThumbnails,
          committed: false,
          diagnosticId: request.diagnosticId,
          sessionId: context.sessionId,
          missingFiles: firstReconcile.missingFiles,
          missingThumbnails: firstReconcile.missingThumbnails,
          error: fileReadinessError
        }
      }
    }

    uploadedFiles = await uploadMissingFiles(client, context, missingFilePaths)
    const afterFilesReconcile = await reconcile(client, context)
    const missingThumbnailPaths =
      afterFilesReconcile.repairThumbnailPaths || afterFilesReconcile.missingThumbnailPaths || []
    const missingThumbnailBytes = computeResumeThumbnailUploadBytes(context, missingThumbnailPaths)
    if (missingThumbnailBytes > 0) {
      const thumbnailReadinessError = await getResumeReadinessError(
        context,
        clientId,
        missingThumbnailBytes
      )
      if (thumbnailReadinessError) {
        markContextStatus(context, 'failed', thumbnailReadinessError, request.diagnosticId || null)
        return {
          success: false,
          status: 'failed',
          uploadedFiles,
          uploadedThumbnails,
          committed: false,
          diagnosticId: request.diagnosticId,
          sessionId: context.sessionId,
          missingFiles: afterFilesReconcile.missingFiles,
          missingThumbnails: afterFilesReconcile.missingThumbnails,
          error: thumbnailReadinessError
        }
      }
    }

    uploadedThumbnails = await uploadMissingThumbnails(client, context, missingThumbnailPaths)

    const finalReconcile = await reconcile(client, context)
    const finalBlockingIssues =
      finalReconcile.missingFiles +
      finalReconcile.missingThumbnails +
      (finalReconcile.sizeMismatchFiles || 0) +
      (finalReconcile.sizeMismatchThumbnails || 0) +
      (finalReconcile.duplicateFiles || 0) +
      (finalReconcile.duplicateThumbnails || 0) +
      (finalReconcile.unexpectedFiles || 0) +
      (finalReconcile.unexpectedThumbnails || 0)
    if (finalBlockingIssues > 0) {
      const error =
        `续传后对账仍未通过: missing files ${finalReconcile.missingFiles}, ` +
        `missing thumbnails ${finalReconcile.missingThumbnails}, ` +
        `size mismatch files ${finalReconcile.sizeMismatchFiles || 0}, ` +
        `size mismatch thumbnails ${finalReconcile.sizeMismatchThumbnails || 0}, ` +
        `duplicates ${finalReconcile.duplicateFiles || 0}/${finalReconcile.duplicateThumbnails || 0}, ` +
        `unexpected ${finalReconcile.unexpectedFiles || 0}/${finalReconcile.unexpectedThumbnails || 0}`
      markContextStatus(context, 'failed', error, request.diagnosticId || null)
      return {
        success: false,
        status: 'failed',
        uploadedFiles,
        uploadedThumbnails,
        committed: false,
        diagnosticId: request.diagnosticId,
        sessionId: context.sessionId,
        missingFiles: finalReconcile.missingFiles,
        missingThumbnails: finalReconcile.missingThumbnails,
        error
      }
    }

    const committed = await client.commitSession(context.sessionId)
    const finalSession =
      committed.status === 'committed' || isImportSessionFailed(committed.status)
        ? committed
        : await waitForCommit(client, context.sessionId)

    if (finalSession.status !== 'committed') {
      const error = finalSession.errorMessage || `commit 后状态异常: ${finalSession.status}`
      markContextStatus(context, 'failed', error, request.diagnosticId || null)
      return {
        success: false,
        status: 'failed',
        uploadedFiles,
        uploadedThumbnails,
        committed: false,
        diagnosticId: request.diagnosticId,
        sessionId: context.sessionId,
        error
      }
    }

    markContextStatus(context, 'committed', null, request.diagnosticId || null)
    await pullLocalVaultChanges(context.localVaultId).catch((pullErr) => {
      console.warn('[ResumeImportService] pull after resumed import failed:', pullErr)
    })
    return {
      success: true,
      status: 'committed',
      uploadedFiles,
      uploadedThumbnails,
      committed: true,
      diagnosticId: request.diagnosticId,
      sessionId: context.sessionId,
      missingFiles: 0,
      missingThumbnails: 0
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const expired = isSessionNotFoundError(error)
    markContextStatus(
      context,
      expired ? 'expired' : 'failed',
      message,
      request.diagnosticId || null
    )
    return {
      success: false,
      status: expired ? 'expired' : 'failed',
      uploadedFiles,
      uploadedThumbnails,
      committed: false,
      diagnosticId: request.diagnosticId,
      sessionId: context.sessionId,
      error: message
    }
  }
}

export interface AbandonImportRequest {
  taskId?: string
  diagnosticId?: string
  /** 本地恢复上下文没了的时候，用导出的 JSON 报告重建 —— 和续传同一条退路 */
  report?: ResumeImportReportContext
}

export interface AbandonImportResult {
  success: boolean
  sessionId?: string
  /** 服务端确认清掉暂存区了吗 —— 没确认就不许说清掉了 */
  stagingCleared: boolean
  /** 本地那条「未完成的导入」记录真的标掉了吗 —— 同理，没确认就不许说消掉了 */
  locallyDismissed: boolean
  error?: string
}

/** 服务端认为「这个会话已经取消、暂存区归我清」的终态 */
const CANCELLED_SESSION_STATUS = 'cancelled'

/**
 * 放弃一次卡住的导入。
 *
 * 为什么必须有这个入口：导入失败后会话停在 `failed_recoverable`，它在服务器上占着
 * 一整个暂存目录（`.system/imports/<sessionId>/`，一次大导入就是几十 G）。而界面上
 * 原本只有「继续完成」和「稍后处理」—— 前者对某些错误（比如元数据引用了没上传的
 * 缩略图）永远失败，后者什么也不清。于是那坨文件永远留在别人的 NAS 上，只能让人
 * 手动进目录删。服务端的取消接口一直都在，只是没人调。
 *
 * 服务端取消会顺带清 staging。本地这份恢复上下文也一并标掉，免得以后还提示「有未
 * 完成的导入」—— 服务端那步失败也照样标：用户已经说了不要这一单，不能因为服务器
 * 一时连不上就把提示永远挂在他脸上。但那时候 `stagingCleared` 是 false，界面得如实
 * 告诉他服务器上还留着东西。
 */
export async function abandonImport(request: AbandonImportRequest): Promise<AbandonImportResult> {
  let context = await loadImportRecoveryContext({
    taskId: request.taskId,
    diagnosticId: request.diagnosticId
  })

  // 上下文文件没了（重装、换机器、清过 userData）但用户手上还有导出的 JSON —— 续传
  // 有这条退路，放弃也得有。最需要把 NAS 腾出来的就是这批人。
  if (!context && request.report) {
    const restored = await buildContextFromReport(request.report, request.diagnosticId)
    context = restored.context ?? null
    if (!context) {
      return {
        success: false,
        stagingCleared: false,
        locallyDismissed: false,
        sessionId: request.report.sessionId,
        error: restored.error || '无法从 JSON 报告重建导入上下文'
      }
    }
  }

  if (!context) {
    return {
      success: false,
      stagingCleared: false,
      locallyDismissed: false,
      error: '未找到这次导入的本地恢复上下文'
    }
  }

  let stagingCleared = false
  let error: string | undefined
  try {
    const client = await createImportSessionClient(context)
    // 回读服务端给的状态再说话。POST 没抛不等于暂存区清了 —— 会话可能已经
    // committed／处于别的终态，服务端照样 200，而那几十 G 一点没动。
    const session = await client.cancelSession(context.sessionId)
    if (session?.status === CANCELLED_SESSION_STATUS) {
      stagingCleared = true
    } else {
      error = `服务端没有取消这次会话（当前状态：${session?.status || '未知'}）`
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    console.warn(
      `[ResumeImportService] 取消服务端会话失败 sessionId=${context.sessionId}: ${error}`
    )
  }

  const locallyDismissed = markContextStatus(
    context,
    'dismissed',
    error || null,
    request.diagnosticId || null
  )
  return {
    success: true,
    sessionId: context.sessionId,
    stagingCleared,
    locallyDismissed,
    error
  }
}
