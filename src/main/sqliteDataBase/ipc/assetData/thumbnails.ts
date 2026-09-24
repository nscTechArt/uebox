import { ipcMain } from 'electron'
import { getAppWindows } from '../../../appWindows'
import { createWriteStream, promises as fs, existsSync, readFileSync } from 'fs'
import * as http from 'http'
import * as https from 'https'
import { hostname, tmpdir } from 'os'
import { basename, dirname, extname, isAbsolute, join } from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'

import { pushAssetUpdate, pushFolderUpdate } from '../../../networkV2/NetworkSyncBridge'
import { getCurrentRemoteHttpVaultContext } from '../../../networkV2/currentRemoteHttpVault'
import { normalizeVaultRelativePath } from '../../../utils/vaultPathNormalize'
import { FolderTypeDetector } from '../../../utils/folderTypeDetector'
import { PathManager } from '../../../utils/PathManager'
import ThumbnailManager from '../../../utils/ThumbnailManager'
import { UnrealAssetProcessor } from '../../../utils/fileProcessor/UnrealAssetProcessor'
import { VaultManager, VaultType } from '../../VaultManager'
import { vaultAccessKeyHeadersFromUrl } from '../../../networkV2/vaultAccessKeys'
import { getVaultDatabase } from '../../index'
import { getAssetDataByKey, updateAssetData } from '../../models/assetData'
import type { AssetData } from '../../models/assetData'
import { getAssetFolderByKey, updateAssetFolder } from '../../models/assetFolder'
import type { AssetFolder } from '../../models/assetFolder'
import { getSharp } from '../../../utils/sharpLoader'
import { isInsideDirectory } from '../../../utils/pathContainment'
import { projectThumbnailCandidates } from '../../../utils/projectPath'
import { denyMediaRead, isPlainFileName } from './thumbnailGuard'

interface ThumbnailRepairStats {
  scannedAssets: number
  scannedFolders: number
  checkedRefs: number
  regenerated: number
  updatedRecords: number
  uploadedOriginal: number
  uploadedThumb: number
  verifiedOriginal: number
  verifiedThumb: number
  alreadyRemotePresent: number
  missingLocal: number
  failed: number
  missingFiles: string[]
  failedFiles: Array<{ target: string; reason: string }>
}

interface UploadThumbnailBinaryResult {
  success: boolean
  error?: string
}

interface UploadThumbnailFileResult {
  fileName: string
  uploadedOriginal: boolean
  uploadedThumb: boolean
  missingLocal: boolean
  skipped: boolean
  errors: string[]
}

interface RepairAssetRow {
  assetKey: string
  assetName?: string | null
  filePath?: string | null
  originPath?: string | null
  fileExtension?: string | null
  imgLocalPath?: string | null
  customPoster?: string | null
}

interface RepairFolderRow {
  folderKey: string
  folderName?: string | null
  img?: string | null
}

interface EnsureRemoteReferenceResult {
  ok: boolean
  checkedRefs: number
  uploadedOriginal: number
  uploadedThumb: number
  verifiedOriginal: number
  verifiedThumb: number
  alreadyRemotePresent: number
  missingLocal: boolean
  errors: string[]
}

interface RegenerateThumbnailResult {
  success: boolean
  fileName?: string
  reason?: string
}

interface ReimportThumbnailFallbackResult {
  success: boolean
  fileName?: string
  reason?: string
  updatedRecords: number
  clearedExistingReference: boolean
}

interface ThumbnailRepairProgressEvent {
  phase: string
  current: number
  total: number
  percent: number
  message: string
}

type ThumbnailRepairAuditLevel = 'info' | 'warn' | 'error'

interface ThumbnailRepairAuditEntry {
  id: number
  level: ThumbnailRepairAuditLevel
  action: string
  assetKey?: string | null
  folderKey?: string | null
  target?: string | null
  message: string
  details?: Record<string, unknown> | null
  sourceHost: string
  createdAt: string
}

const THUMBNAIL_REPAIR_CONCURRENCY = 20
const remoteFileExistenceCache = new Map<string, boolean>()
const remoteReferenceEnsureCache = new Map<string, EnsureRemoteReferenceResult>()
const thumbnailRepairAuditTablesReady = new WeakSet<Database.Database>()

function ensureThumbnailRepairAuditTable(db: Database.Database): void {
  if (thumbnailRepairAuditTablesReady.has(db)) return

  db.exec(`
    CREATE TABLE IF NOT EXISTS thumbnail_repair_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      action TEXT NOT NULL,
      asset_key TEXT,
      folder_key TEXT,
      target TEXT,
      message TEXT NOT NULL,
      details_json TEXT,
      source_host TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_thumbnail_repair_audit_created_at
      ON thumbnail_repair_audit_log(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_thumbnail_repair_audit_asset_key
      ON thumbnail_repair_audit_log(asset_key);
    CREATE INDEX IF NOT EXISTS idx_thumbnail_repair_audit_folder_key
      ON thumbnail_repair_audit_log(folder_key);
  `)

  thumbnailRepairAuditTablesReady.add(db)
}

function appendThumbnailRepairAudit(
  db: Database.Database,
  entry: {
    level: ThumbnailRepairAuditLevel
    action: string
    assetKey?: string | null
    folderKey?: string | null
    target?: string | null
    message: string
    details?: Record<string, unknown> | null
  }
): void {
  try {
    ensureThumbnailRepairAuditTable(db)
    db.prepare(
      `
      INSERT INTO thumbnail_repair_audit_log (
        level, action, asset_key, folder_key, target, message, details_json, source_host
      ) VALUES (
        @level, @action, @assetKey, @folderKey, @target, @message, @detailsJson, @sourceHost
      )
    `
    ).run({
      level: entry.level,
      action: entry.action,
      assetKey: entry.assetKey ?? null,
      folderKey: entry.folderKey ?? null,
      target: entry.target ?? null,
      message: entry.message,
      detailsJson: entry.details ? JSON.stringify(entry.details) : null,
      sourceHost: hostname()
    })
  } catch (error) {
    console.warn('[ThumbnailRepairAudit] Failed to append audit log:', error)
  }
}

function listThumbnailRepairAudit(db: Database.Database, limit = 100): ThumbnailRepairAuditEntry[] {
  ensureThumbnailRepairAuditTable(db)

  const rows = db
    .prepare(
      `
    SELECT
      id,
      level,
      action,
      asset_key AS assetKey,
      folder_key AS folderKey,
      target,
      message,
      details_json AS detailsJson,
      source_host AS sourceHost,
      created_at AS createdAt
    FROM thumbnail_repair_audit_log
    ORDER BY id DESC
    LIMIT ?
  `
    )
    .all(Math.max(1, Math.min(limit, 500))) as Array<{
    id: number
    level: ThumbnailRepairAuditLevel
    action: string
    assetKey?: string | null
    folderKey?: string | null
    target?: string | null
    message: string
    detailsJson?: string | null
    sourceHost: string
    createdAt: string
  }>

  return rows.map((row) => ({
    id: row.id,
    level: row.level,
    action: row.action,
    assetKey: row.assetKey ?? null,
    folderKey: row.folderKey ?? null,
    target: row.target ?? null,
    message: row.message,
    details: row.detailsJson ? safeParseAuditDetails(row.detailsJson) : null,
    sourceHost: row.sourceHost,
    createdAt: row.createdAt
  }))
}

function safeParseAuditDetails(detailsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(detailsJson)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function appendCurrentVaultThumbnailAudit(entry: {
  level: ThumbnailRepairAuditLevel
  action: string
  assetKey?: string | null
  folderKey?: string | null
  target?: string | null
  message: string
  details?: Record<string, unknown> | null
}): void {
  try {
    appendThumbnailRepairAudit(getVaultDatabase(), entry)
  } catch {
    // Ignore audit failures to avoid blocking thumbnail flows.
  }
}

function getRemoteHttpVaultInfo(): { serverBase: string; remoteVaultId: string } | null {
  const vm = VaultManager.getInstance()
  const currentVault = vm.getCurrentVault()
  if (!currentVault) return null
  if (currentVault.vaultType !== VaultType.NETWORK) return null

  const networkPath = currentVault.networkPath
  if (!networkPath) return null
  if (!networkPath.startsWith('http://') && !networkPath.startsWith('https://')) return null

  const lastSlash = networkPath.lastIndexOf('/')
  const serverBase = networkPath.substring(0, lastSlash)
  const remoteVaultId = networkPath.substring(lastSlash + 1)
  if (!serverBase || !remoteVaultId) return null

  return { serverBase, remoteVaultId }
}

function emitThumbnailRepairProgress(payload: ThumbnailRepairProgressEvent): void {
  for (const win of getAppWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('asset:repairVaultThumbnailsProgress', payload)
    }
  }
}

async function yieldRepairProgress(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function invalidateRemoteFileCache(relativePath: string): void {
  remoteFileExistenceCache.delete(relativePath)
}

function setRemoteFileCache(relativePath: string, exists: boolean): void {
  remoteFileExistenceCache.set(relativePath, exists)
}

function invalidateEnsureReferenceCacheForFile(fileName: string): void {
  remoteReferenceEnsureCache.delete(`${fileName}::original-only`)
  remoteReferenceEnsureCache.delete(`${fileName}::with-thumb`)
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return

  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))

  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex
      nextIndex++
      if (currentIndex >= items.length) {
        return
      }
      await worker(items[currentIndex], currentIndex)
    }
  })

  await Promise.all(runners)
}

function createEmptyRepairStats(): ThumbnailRepairStats {
  return {
    scannedAssets: 0,
    scannedFolders: 0,
    checkedRefs: 0,
    regenerated: 0,
    updatedRecords: 0,
    uploadedOriginal: 0,
    uploadedThumb: 0,
    verifiedOriginal: 0,
    verifiedThumb: 0,
    alreadyRemotePresent: 0,
    missingLocal: 0,
    failed: 0,
    missingFiles: [],
    failedFiles: []
  }
}

function mergeRepairStats(
  target: ThumbnailRepairStats,
  partial: Partial<ThumbnailRepairStats>
): void {
  target.scannedAssets += partial.scannedAssets || 0
  target.scannedFolders += partial.scannedFolders || 0
  target.checkedRefs += partial.checkedRefs || 0
  target.regenerated += partial.regenerated || 0
  target.updatedRecords += partial.updatedRecords || 0
  target.uploadedOriginal += partial.uploadedOriginal || 0
  target.uploadedThumb += partial.uploadedThumb || 0
  target.verifiedOriginal += partial.verifiedOriginal || 0
  target.verifiedThumb += partial.verifiedThumb || 0
  target.alreadyRemotePresent += partial.alreadyRemotePresent || 0
  target.missingLocal += partial.missingLocal || 0
  target.failed += partial.failed || 0
  if (partial.missingFiles?.length) {
    target.missingFiles.push(...partial.missingFiles)
  }
  if (partial.failedFiles?.length) {
    target.failedFiles.push(...partial.failedFiles)
  }
}

function applyEnsureResultToStats(
  target: ThumbnailRepairStats,
  result: EnsureRemoteReferenceResult
): void {
  target.checkedRefs += result.checkedRefs
  target.uploadedOriginal += result.uploadedOriginal
  target.uploadedThumb += result.uploadedThumb
  target.verifiedOriginal += result.verifiedOriginal
  target.verifiedThumb += result.verifiedThumb
  target.alreadyRemotePresent += result.alreadyRemotePresent
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function normalizeRelativePathCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('file:') || isHttpUrl(trimmed)) return null
  if (isAbsolute(trimmed)) return null

  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.?\//, '')
  return normalized || null
}

function getRemoteVaultFileUrl(relativePath: string): string | null {
  const remoteInfo = getRemoteHttpVaultInfo()
  if (!remoteInfo) return null

  const encodedPath = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  return `${remoteInfo.serverBase}/api/vaults/${encodeURIComponent(remoteInfo.remoteVaultId)}/files/${encodedPath}`
}

async function uploadBufferToRemote(
  uploadUrl: string,
  fileBuffer: Buffer
): Promise<UploadThumbnailBinaryResult> {
  const url = new URL(uploadUrl)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http

  return await new Promise<UploadThumbnailBinaryResult>((resolve) => {
    const req = lib.request(
      {
        method: 'PUT',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileBuffer.length,
          // 服务端现在对文件读写都鉴权，不带码会 401
          ...vaultAccessKeyHeadersFromUrl(uploadUrl)
        },
        timeout: 30_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode || 0
          if (status >= 200 && status < 300) {
            resolve({ success: true })
            return
          }

          const body = Buffer.concat(chunks).toString('utf-8')
          resolve({
            success: false,
            error: `HTTP ${status}${body ? `: ${body}` : ''}`
          })
        })
      }
    )

    req.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, error: '请求超时' })
    })

    req.write(fileBuffer)
    req.end()
  })
}

async function uploadLocalThumbnailToRemote(
  relativePath: string,
  localPath: string,
  fallbackUploadUrl: string
): Promise<UploadThumbnailBinaryResult> {
  const remoteCtx = getCurrentRemoteHttpVaultContext()
  if (remoteCtx) {
    try {
      await remoteCtx.client.uploadLocalFile(localPath, relativePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return uploadBufferToRemote(fallbackUploadUrl, readFileSync(localPath))
}

/**
 * 远端库里有没有这个文件。导入那条链路也要用 —— 本地没有不等于引用悬空，
 * 网络库的缩略图本来就可能只在服务器上。
 */
export async function remoteFileExists(relativePath: string): Promise<boolean> {
  if (remoteFileExistenceCache.has(relativePath)) {
    return remoteFileExistenceCache.get(relativePath) || false
  }

  const fileUrl = getRemoteVaultFileUrl(relativePath)
  if (!fileUrl) return false

  const url = new URL(fileUrl)
  const lib = url.protocol === 'https:' ? https : http

  return await new Promise<boolean>((resolve) => {
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}?_repairCheck=${Date.now()}`,
        headers: vaultAccessKeyHeadersFromUrl(fileUrl),
        timeout: 15_000
      },
      (res) => {
        const status = res.statusCode || 0
        const ok = status >= 200 && status < 300
        remoteFileExistenceCache.set(relativePath, ok)
        // 只需要响应头，立即断开，避免把整张图下载下来
        res.destroy()
        resolve(ok)
      }
    )

    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

async function externalHttpFileExists(fileUrl: string): Promise<boolean> {
  try {
    const url = new URL(fileUrl)
    const lib = url.protocol === 'https:' ? https : http

    return await new Promise<boolean>((resolve) => {
      const req = lib.request(
        {
          method: 'GET',
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search || ''}`,
          timeout: 15_000
        },
        (res) => {
          const status = res.statusCode || 0
          const ok = status >= 200 && status < 300
          res.destroy()
          resolve(ok)
        }
      )

      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  } catch {
    return false
  }
}

async function downloadExternalHttpFileToTemp(
  fileUrl: string
): Promise<{ success: boolean; filePath?: string; tempDir?: string; error?: string }> {
  let url: URL
  try {
    url = new URL(fileUrl)
  } catch {
    return { success: false, error: 'Invalid external URL' }
  }

  const lib = url.protocol === 'https:' ? https : http
  const safeName = basename(url.pathname) || `external-thumb-${Date.now()}.bin`
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'uebox-external-thumb-'))
  const tempFilePath = join(tempDir, safeName)

  return await new Promise((resolve) => {
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search || ''}`,
        timeout: 60_000
      },
      (res) => {
        const status = res.statusCode || 0
        if (status < 200 || status >= 300) {
          res.resume()
          resolve({ success: false, tempDir, error: `Download failed: HTTP ${status}` })
          return
        }

        const stream = createWriteStream(tempFilePath)
        stream.on('error', (err) => {
          resolve({ success: false, tempDir, error: err.message })
        })
        stream.on('finish', () => {
          resolve({ success: true, filePath: tempFilePath, tempDir })
        })
        res.pipe(stream)
      }
    )

    req.on('error', (err) => {
      resolve({ success: false, tempDir, error: err.message })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, tempDir, error: 'External download timed out' })
    })
    req.end()
  })
}

async function downloadRemoteFileToTemp(
  relativePath: string
): Promise<{ success: boolean; filePath?: string; tempDir?: string; error?: string }> {
  const fileUrl = getRemoteVaultFileUrl(relativePath)
  if (!fileUrl) {
    return { success: false, error: '当前保管库不是 HTTP 网络库' }
  }

  const url = new URL(fileUrl)
  const lib = url.protocol === 'https:' ? https : http
  const safeName = basename(relativePath) || `repair-${Date.now()}.bin`
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'uebox-thumb-repair-'))
  const tempFilePath = join(tempDir, safeName)

  return await new Promise((resolve) => {
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: 60_000
      },
      (res) => {
        const status = res.statusCode || 0
        if (status < 200 || status >= 300) {
          res.resume()
          resolve({ success: false, tempDir, error: `下载失败: HTTP ${status}` })
          return
        }

        const stream = createWriteStream(tempFilePath)
        stream.on('error', (err) => {
          resolve({ success: false, tempDir, error: err.message })
        })
        stream.on('finish', () => {
          resolve({ success: true, filePath: tempFilePath, tempDir })
        })
        res.pipe(stream)
      }
    )

    req.on('error', (err) => {
      resolve({ success: false, tempDir, error: err.message })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, tempDir, error: '下载源文件超时' })
    })
    req.end()
  })
}

async function downloadFirstExistingRemoteFileToTemp(
  relativePaths: string[]
): Promise<{ success: boolean; filePath?: string; tempDir?: string; error?: string }> {
  for (const relativePath of relativePaths) {
    const exists = await remoteFileExists(relativePath)
    if (!exists) continue

    const result = await downloadRemoteFileToTemp(relativePath)
    if (result.success) {
      return result
    }
  }

  return { success: false, error: '远端未找到伴随缩略图资源' }
}

function shouldGenerateCompressedThumb(fileName: string): boolean {
  const ext = (extname(fileName).slice(1) || '').toLowerCase()
  return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tga'].includes(ext)
}

async function ensureLocalThumbVariant(fileName: string): Promise<void> {
  if (!shouldGenerateCompressedThumb(fileName)) return

  const pm = PathManager.getInstance()
  const originalPath = pm.getThumbnailFilePath(fileName)
  const thumbName = ThumbnailManager.toThumbFilename(fileName)
  const thumbPath = pm.getThumbnailFilePath(thumbName)

  if (!existsSync(originalPath) || existsSync(thumbPath)) return
  await ThumbnailManager.generateThumbForFile(originalPath, thumbName)
}

async function uploadThumbnailFileToRemote(
  fileName: string,
  options?: { uploadCompressedVariant?: boolean }
): Promise<UploadThumbnailFileResult> {
  const remoteInfo = getRemoteHttpVaultInfo()
  if (!remoteInfo) {
    return {
      fileName,
      uploadedOriginal: false,
      uploadedThumb: false,
      missingLocal: false,
      skipped: true,
      errors: ['当前保管库不是 HTTP 网络库']
    }
  }

  const pm = PathManager.getInstance()
  const localPath = pm.getThumbnailFilePath(fileName)
  if (!existsSync(localPath)) {
    return {
      fileName,
      uploadedOriginal: false,
      uploadedThumb: false,
      missingLocal: true,
      skipped: false,
      errors: ['本地缩略图不存在']
    }
  }

  const result: UploadThumbnailFileResult = {
    fileName,
    uploadedOriginal: false,
    uploadedThumb: false,
    missingLocal: false,
    skipped: false,
    errors: []
  }

  invalidateRemoteFileCache(`.thumbnails/${fileName}`)
  invalidateEnsureReferenceCacheForFile(fileName)
  const uploadUrl = `${remoteInfo.serverBase}/api/vaults/${encodeURIComponent(remoteInfo.remoteVaultId)}/files/.thumbnails/${encodeURIComponent(fileName)}`
  const uploadOriginal = await uploadLocalThumbnailToRemote(
    `.thumbnails/${fileName}`,
    localPath,
    uploadUrl
  )

  if (uploadOriginal.success) {
    result.uploadedOriginal = true
    setRemoteFileCache(`.thumbnails/${fileName}`, true)
    console.log(`[Thumbnail] 已上传到远程服务器: ${fileName}`)
  } else {
    const errorMessage = uploadOriginal.error || '原图上传失败'
    result.errors.push(`原图上传失败: ${errorMessage}`)
    console.warn(`[Thumbnail] 远程上传失败: ${fileName}, ${errorMessage}`)
  }

  const shouldUploadThumb =
    options?.uploadCompressedVariant !== false && !fileName.includes('_thumb')
  if (!shouldUploadThumb) {
    return result
  }

  const thumbFileName = ThumbnailManager.toThumbFilename(fileName)
  const thumbLocalPath = pm.getThumbnailFilePath(thumbFileName)
  if (!existsSync(thumbLocalPath)) {
    return result
  }

  invalidateRemoteFileCache(`.thumbnails/${thumbFileName}`)
  invalidateEnsureReferenceCacheForFile(fileName)
  const thumbUploadUrl = `${remoteInfo.serverBase}/api/vaults/${encodeURIComponent(remoteInfo.remoteVaultId)}/files/.thumbnails/${encodeURIComponent(thumbFileName)}`
  const uploadThumb = await uploadLocalThumbnailToRemote(
    `.thumbnails/${thumbFileName}`,
    thumbLocalPath,
    thumbUploadUrl
  )

  if (uploadThumb.success) {
    result.uploadedThumb = true
    setRemoteFileCache(`.thumbnails/${thumbFileName}`, true)
    console.log(`[Thumbnail] 已上传压缩版到远程: ${thumbFileName}`)
  } else {
    const errorMessage = uploadThumb.error || '压缩图上传失败'
    result.errors.push(`压缩图上传失败: ${errorMessage}`)
    console.warn(`[Thumbnail] 远程上传压缩版失败: ${thumbFileName}, ${errorMessage}`)
  }

  return result
}

async function ensureRemoteThumbnailReference(
  fileName: string,
  options?: { verifyThumbIfPossible?: boolean }
): Promise<EnsureRemoteReferenceResult> {
  const cacheKey = `${fileName}::${options?.verifyThumbIfPossible === true ? 'with-thumb' : 'original-only'}`
  const cached = remoteReferenceEnsureCache.get(cacheKey)
  if (cached) {
    return { ...cached, errors: [...cached.errors] }
  }

  const verifyThumbIfPossible = options?.verifyThumbIfPossible === true
  const pm = PathManager.getInstance()
  const localPath = pm.getThumbnailFilePath(fileName)
  const hasLocalOriginal = existsSync(localPath)
  const thumbFileName = ThumbnailManager.toThumbFilename(fileName)

  if (!hasLocalOriginal) {
    const originalExists = await remoteFileExists(`.thumbnails/${fileName}`)
    if (!originalExists) {
      const result = {
        ok: false,
        checkedRefs: 1,
        uploadedOriginal: 0,
        uploadedThumb: 0,
        verifiedOriginal: 0,
        verifiedThumb: 0,
        alreadyRemotePresent: 0,
        missingLocal: true,
        errors: ['本地与 NAS V2 都不存在']
      }
      remoteReferenceEnsureCache.set(cacheKey, result)
      return { ...result, errors: [...result.errors] }
    }

    const verifiedThumb =
      verifyThumbIfPossible && (await remoteFileExists(`.thumbnails/${thumbFileName}`)) ? 1 : 0

    const result = {
      ok: true,
      checkedRefs: 1,
      uploadedOriginal: 0,
      uploadedThumb: 0,
      verifiedOriginal: 1,
      verifiedThumb,
      alreadyRemotePresent: 1,
      missingLocal: false,
      errors: []
    }
    remoteReferenceEnsureCache.set(cacheKey, result)
    return { ...result, errors: [...result.errors] }
  }

  if (verifyThumbIfPossible) {
    await ensureLocalThumbVariant(fileName)
  }

  const originalAlreadyExists = await remoteFileExists(`.thumbnails/${fileName}`)
  const localThumbExists = existsSync(pm.getThumbnailFilePath(thumbFileName))
  const thumbAlreadyExists =
    verifyThumbIfPossible && localThumbExists
      ? await remoteFileExists(`.thumbnails/${thumbFileName}`)
      : false

  if (
    originalAlreadyExists &&
    (!verifyThumbIfPossible || !localThumbExists || thumbAlreadyExists)
  ) {
    const result = {
      ok: true,
      checkedRefs: 1,
      uploadedOriginal: 0,
      uploadedThumb: 0,
      verifiedOriginal: 1,
      verifiedThumb: thumbAlreadyExists ? 1 : 0,
      alreadyRemotePresent: 1,
      missingLocal: false,
      errors: []
    }
    remoteReferenceEnsureCache.set(cacheKey, result)
    return { ...result, errors: [...result.errors] }
  }

  const uploadResult = await uploadThumbnailFileToRemote(fileName, {
    uploadCompressedVariant: verifyThumbIfPossible
  })
  const originalExists = await remoteFileExists(`.thumbnails/${fileName}`)
  const thumbExists =
    verifyThumbIfPossible && localThumbExists
      ? await remoteFileExists(`.thumbnails/${thumbFileName}`)
      : false

  const errors = [...uploadResult.errors]
  if (!originalExists) {
    errors.push('远端校验失败: 原图不存在')
  }
  if (verifyThumbIfPossible && localThumbExists && !thumbExists) {
    errors.push('远端校验失败: 压缩图不存在')
  }

  const result = {
    ok: errors.length === 0,
    checkedRefs: 1,
    uploadedOriginal: uploadResult.uploadedOriginal ? 1 : 0,
    uploadedThumb: uploadResult.uploadedThumb ? 1 : 0,
    verifiedOriginal: originalExists ? 1 : 0,
    verifiedThumb: thumbExists ? 1 : 0,
    alreadyRemotePresent: 0,
    missingLocal: false,
    errors
  }
  remoteReferenceEnsureCache.set(cacheKey, result)
  return { ...result, errors: [...result.errors] }
}

function normalizeThumbnailReference(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!trimmed) return null
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('file:')
  ) {
    return null
  }

  const extracted = ThumbnailManager.extractFilenameFromFileUrl(trimmed) || trimmed
  const normalized = extracted.replace(/\\/g, '/')
  const fileName = normalized.split('/').filter(Boolean).pop()

  if (!fileName || fileName === '.' || fileName === '..') return null
  return fileName
}

function isExternalThumbnailReference(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return (
    trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('file:')
  )
}

function isFileUrl(value: string): boolean {
  return value.trim().startsWith('file:')
}

function resolveFileUrlToLocalPath(fileUrl: string): string | null {
  try {
    return fileURLToPath(fileUrl)
  } catch {
    return null
  }
}

function getCurrentVaultInfo() {
  return VaultManager.getInstance().getCurrentVault()
}

function resolveAssetRelativePath(
  row: Pick<RepairAssetRow, 'filePath' | 'originPath'>
): string | null {
  const direct =
    normalizeRelativePathCandidate(row.filePath) || normalizeRelativePathCandidate(row.originPath)
  if (direct) return direct

  const currentVault = getCurrentVaultInfo()
  const browsePath = currentVault?.browsePath
  if (!browsePath) return null

  return (
    normalizeVaultRelativePath(row.filePath, browsePath) ||
    normalizeVaultRelativePath(row.originPath, browsePath)
  )
}

function resolveLocalAssetSourcePath(
  row: Pick<RepairAssetRow, 'filePath' | 'originPath'>
): string | null {
  for (const candidate of [row.filePath, row.originPath]) {
    if (typeof candidate === 'string' && candidate.trim() && existsSync(candidate)) {
      return candidate
    }
  }

  const currentVault = getCurrentVaultInfo()
  if (!currentVault) return null

  const relativePath = resolveAssetRelativePath(row)
  if (!relativePath) return null

  if (currentVault.browsePath) {
    const browsePathCandidate = join(currentVault.browsePath, relativePath)
    if (existsSync(browsePathCandidate)) {
      return browsePathCandidate
    }
  }

  if (
    currentVault.vaultType !== VaultType.NETWORK ||
    !currentVault.networkPath ||
    !currentVault.networkPath.startsWith('http')
  ) {
    const pm = PathManager.getInstance()
    const vaultPathCandidate = pm.getAbsoluteFromVault(relativePath)
    if (existsSync(vaultPathCandidate)) {
      return vaultPathCandidate
    }
  }

  return null
}

async function saveImageThumbnailFromSource(
  sourcePath: string,
  assetKey: string,
  fileExtension?: string | null
): Promise<string | null> {
  const pm = PathManager.getInstance()
  await fs.mkdir(pm.getThumbnailsPath(), { recursive: true })

  const normalizedExt = (fileExtension || extname(sourcePath).slice(1) || 'png').toLowerCase()

  try {
    if (normalizedExt === 'svg') {
      const fileName = `thumbnail-${assetKey}.svg`
      const targetPath = pm.getThumbnailFilePath(fileName)
      await fs.copyFile(sourcePath, targetPath)
      return fileName
    }

    let outputExt = normalizedExt
    if (['tga', 'dds', 'bmp', 'tif', 'tiff'].includes(normalizedExt)) {
      outputExt = 'png'
    }

    const fileName = `thumbnail-${assetKey}.${outputExt}`
    const targetPath = pm.getThumbnailFilePath(fileName)
    const sharp = await getSharp()
    const image = sharp(sourcePath)
    const metadata = await image.metadata()

    if ((metadata.width && metadata.width > 1024) || (metadata.height && metadata.height > 1024)) {
      image.resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    }

    if (outputExt === 'jpg' || outputExt === 'jpeg') {
      image.jpeg({ quality: 80, mozjpeg: true })
    } else if (outputExt === 'png') {
      image.png({ quality: 80, compressionLevel: 8, palette: true })
    } else if (outputExt === 'webp') {
      image.webp({ quality: 80 })
    }

    await image.toFile(targetPath)
    return fileName
  } catch (err) {
    console.warn(`[ThumbnailRepair] 图片缩略图生成失败，尝试直接复制: ${sourcePath}`, err)
    try {
      const fileName = `thumbnail-${assetKey}.${normalizedExt || 'png'}`
      const targetPath = pm.getThumbnailFilePath(fileName)
      await fs.copyFile(sourcePath, targetPath)
      return fileName
    } catch (copyErr) {
      console.warn(`[ThumbnailRepair] 图片缩略图复制失败: ${sourcePath}`, copyErr)
      return null
    }
  }
}

async function savePluginThumbnailFromSource(
  sourcePath: string,
  assetKey: string,
  remoteIconPath?: string
): Promise<string | null> {
  try {
    const pluginIconPath =
      remoteIconPath || (await FolderTypeDetector.getPluginIconPath(dirname(sourcePath)))
    if (!pluginIconPath) return null

    const pm = PathManager.getInstance()
    await fs.mkdir(pm.getThumbnailsPath(), { recursive: true })
    const fileName = `thumbnail-${assetKey}.png`
    await fs.copyFile(pluginIconPath, pm.getThumbnailFilePath(fileName))
    return fileName
  } catch (error) {
    console.warn(`[ThumbnailRepair] 重新获取插件图标失败: ${sourcePath}`, error)
    return null
  }
}

async function saveProjectThumbnailFromSource(
  sourcePath: string,
  assetKey: string,
  remoteCandidatePath?: string
): Promise<string | null> {
  try {
    const found =
      remoteCandidatePath ||
      projectThumbnailCandidates(dirname(sourcePath), sourcePath).find((candidate) =>
        existsSync(candidate)
      )
    if (!found) return null

    const pm = PathManager.getInstance()
    await fs.mkdir(pm.getThumbnailsPath(), { recursive: true })
    const fileName = `thumbnail-${assetKey}${extname(found) || '.png'}`
    await fs.copyFile(found, pm.getThumbnailFilePath(fileName))
    return fileName
  } catch (error) {
    console.warn(`[ThumbnailRepair] 重新获取项目缩略图失败: ${sourcePath}`, error)
    return null
  }
}

async function migrateExternalCustomPoster(
  db: Database.Database,
  record: RepairAssetRow,
  externalRef: string
): Promise<{
  status: 'keep' | 'continue' | 'failed'
  stats: Partial<ThumbnailRepairStats>
}> {
  const stats = createEmptyRepairStats()
  const assetLabel = record.assetName || record.assetKey
  const tempDirsToCleanup = new Set<string>()
  let localSourcePath: string | null = null

  try {
    if (isFileUrl(externalRef)) {
      const resolvedPath = resolveFileUrlToLocalPath(externalRef)
      if (resolvedPath && existsSync(resolvedPath)) {
        localSourcePath = resolvedPath
      } else {
        const cleared = await persistAssetThumbnailFields(db, record.assetKey, { customPoster: '' })
        if (cleared) {
          appendThumbnailRepairAudit(db, {
            level: 'warn',
            action: 'external_custom_poster_cleared',
            assetKey: record.assetKey,
            target: externalRef,
            message: 'Cleared broken external file customPoster reference',
            details: { mode: 'file-url' }
          })
          stats.updatedRecords = 1
          return { status: 'continue', stats }
        }
        stats.failed = 1
        stats.failedFiles = [
          {
            target: `${assetLabel} / customPoster`,
            reason: 'Failed to clear broken external file poster reference'
          }
        ]
        return { status: 'failed', stats }
      }
    } else if (isHttpUrl(externalRef)) {
      const reachable = await externalHttpFileExists(externalRef)
      if (reachable) {
        return { status: 'keep', stats }
      }

      const downloadResult = await downloadExternalHttpFileToTemp(externalRef)
      if (downloadResult.success && downloadResult.filePath) {
        localSourcePath = downloadResult.filePath
        if (downloadResult.tempDir) tempDirsToCleanup.add(downloadResult.tempDir)
      } else {
        const cleared = await persistAssetThumbnailFields(db, record.assetKey, { customPoster: '' })
        if (cleared) {
          appendThumbnailRepairAudit(db, {
            level: 'warn',
            action: 'external_custom_poster_cleared',
            assetKey: record.assetKey,
            target: externalRef,
            message: 'Cleared unreachable external HTTP customPoster reference',
            details: {
              mode: 'http-url',
              reason: downloadResult.error || 'unreachable external poster'
            }
          })
          stats.updatedRecords = 1
          return { status: 'continue', stats }
        }
        stats.failed = 1
        stats.failedFiles = [
          {
            target: `${assetLabel} / customPoster`,
            reason: downloadResult.error || 'Failed to clear unreachable external poster reference'
          }
        ]
        return { status: 'failed', stats }
      }
    }

    if (!localSourcePath) {
      return { status: 'continue', stats }
    }

    const fileName = await ThumbnailManager.saveVaultThumbnailFromFile(
      localSourcePath,
      record.assetKey
    )
    if (!fileName) {
      const cleared = await persistAssetThumbnailFields(db, record.assetKey, { customPoster: '' })
      if (cleared) {
        stats.updatedRecords = 1
        return { status: 'continue', stats }
      }
      stats.failed = 1
      stats.failedFiles = [
        {
          target: `${assetLabel} / customPoster`,
          reason: 'Failed to migrate external poster into managed thumbnails'
        }
      ]
      return { status: 'failed', stats }
    }

    const updated = await persistAssetThumbnailFields(db, record.assetKey, {
      customPoster: fileName
    })
    if (updated) {
      appendThumbnailRepairAudit(db, {
        level: 'info',
        action: 'external_custom_poster_migrated',
        assetKey: record.assetKey,
        target: externalRef,
        message: 'Migrated external customPoster into managed thumbnails',
        details: { newFileName: fileName }
      })
      stats.updatedRecords = 1
    }

    const ensureResult = await ensureRemoteThumbnailReference(fileName, {
      verifyThumbIfPossible: true
    })
    applyEnsureResultToStats(stats, ensureResult)

    if (ensureResult.ok) {
      return { status: 'keep', stats }
    }

    const cleared = await persistAssetThumbnailFields(db, record.assetKey, { customPoster: '' })
    if (cleared) {
      appendThumbnailRepairAudit(db, {
        level: 'warn',
        action: 'external_custom_poster_cleared',
        assetKey: record.assetKey,
        target: externalRef,
        message: 'Cleared migrated customPoster after remote verification failed',
        details: { newFileName: fileName, errors: ensureResult.errors }
      })
      stats.updatedRecords += 1
      return { status: 'continue', stats }
    }

    stats.failed = (stats.failed || 0) + 1
    stats.failedFiles = [
      ...(stats.failedFiles || []),
      {
        target: `${assetLabel} / customPoster`,
        reason: ensureResult.errors.join(' | ') || 'Managed poster upload verification failed'
      }
    ]
    return { status: 'failed', stats }
  } finally {
    for (const tempDir of tempDirsToCleanup) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function regenerateAssetThumbnail(
  record: RepairAssetRow
): Promise<RegenerateThumbnailResult> {
  const extension = (record.fileExtension || '').toLowerCase()
  let localSourcePath = resolveLocalAssetSourcePath(record)
  const tempDirsToCleanup = new Set<string>()
  const relativePath = resolveAssetRelativePath(record)

  try {
    if (!localSourcePath) {
      if (relativePath) {
        const downloadResult = await downloadRemoteFileToTemp(relativePath)
        if (downloadResult.success && downloadResult.filePath) {
          localSourcePath = downloadResult.filePath
          if (downloadResult.tempDir) tempDirsToCleanup.add(downloadResult.tempDir)
        } else if (downloadResult.error) {
          return { success: false, reason: downloadResult.error }
        }
      }
    }

    if (!localSourcePath) {
      return { success: false, reason: '找不到源文件，无法重建缩略图' }
    }

    if (extension === 'uasset' || extension === 'umap') {
      const processor = new UnrealAssetProcessor()
      const metadata = await processor.processFile(localSourcePath)
      const fileName =
        typeof metadata.metadata?.imgLocalPath === 'string' ? metadata.metadata.imgLocalPath : ''
      if (!fileName) {
        return { success: false, reason: '源资产不包含可提取的缩略图' }
      }
      return { success: true, fileName }
    }

    if (
      ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tga', 'dds', 'tif', 'tiff'].includes(
        extension
      )
    ) {
      const fileName = await saveImageThumbnailFromSource(
        localSourcePath,
        record.assetKey,
        extension
      )
      return fileName
        ? { success: true, fileName }
        : { success: false, reason: '图片缩略图生成失败' }
    }

    if (extension === 'uplugin') {
      let remoteIconPath: string | undefined
      if (relativePath) {
        const baseDir = dirname(relativePath).replace(/\\/g, '/')
        const remoteIconRelative = `${baseDir === '.' ? '' : baseDir + '/'}Resources/Icon128.png`
        const remoteIconResult = await downloadFirstExistingRemoteFileToTemp([remoteIconRelative])
        if (remoteIconResult.success && remoteIconResult.filePath) {
          remoteIconPath = remoteIconResult.filePath
          if (remoteIconResult.tempDir) tempDirsToCleanup.add(remoteIconResult.tempDir)
        }
      }

      const fileName = await savePluginThumbnailFromSource(
        localSourcePath,
        record.assetKey,
        remoteIconPath
      )
      return fileName ? { success: true, fileName } : { success: false, reason: '未找到插件图标' }
    }

    if (extension === 'uproject') {
      let remoteCandidatePath: string | undefined
      if (relativePath) {
        const projectDir = dirname(relativePath).replace(/\\/g, '/')
        const projectName = basename(relativePath, extname(relativePath))
        const remoteCandidateResult = await downloadFirstExistingRemoteFileToTemp([
          `${projectDir === '.' ? '' : projectDir + '/'}${projectName}.png`,
          `${projectDir === '.' ? '' : projectDir + '/'}Saved/AutoScreenshot.png`
        ])
        if (remoteCandidateResult.success && remoteCandidateResult.filePath) {
          remoteCandidatePath = remoteCandidateResult.filePath
          if (remoteCandidateResult.tempDir) tempDirsToCleanup.add(remoteCandidateResult.tempDir)
        }
      }

      const fileName = await saveProjectThumbnailFromSource(
        localSourcePath,
        record.assetKey,
        remoteCandidatePath
      )
      return fileName ? { success: true, fileName } : { success: false, reason: '未找到项目缩略图' }
    }

    return { success: false, reason: `暂不支持为 .${extension || 'unknown'} 重建缩略图` }
  } catch (error) {
    return {
      success: false,
      reason: error instanceof Error ? error.message : String(error)
    }
  } finally {
    for (const tempDir of tempDirsToCleanup) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function tryReimportAssetThumbnailFallback(
  db: Database.Database,
  record: RepairAssetRow,
  options?: { clearExistingReference?: boolean }
): Promise<ReimportThumbnailFallbackResult> {
  const extension = (record.fileExtension || '').toLowerCase()
  if (extension !== 'uasset' && extension !== 'umap') {
    return {
      success: false,
      reason: 'Reimport fallback only supports uasset/umap',
      updatedRecords: 0,
      clearedExistingReference: false
    }
  }

  let updatedRecords = 0
  let clearedExistingReference = false

  if (options?.clearExistingReference) {
    const cleared = await persistAssetThumbnailFields(db, record.assetKey, { imgLocalPath: '' })
    if (!cleared) {
      return {
        success: false,
        reason: 'Failed to clear broken imgLocalPath before reimport fallback',
        updatedRecords,
        clearedExistingReference
      }
    }
    updatedRecords += 1
    clearedExistingReference = true
  }

  try {
    const { AssetImportService } = await import('../../../services/asset/AssetImportService')
    const service = new AssetImportService()
    const reimported = await service.reimportAsset(record.assetKey)
    if (!reimported) {
      return {
        success: false,
        reason: 'Asset reimport fallback returned false',
        updatedRecords,
        clearedExistingReference
      }
    }

    const refreshedAsset = getAssetDataByKey(db, record.assetKey)
    const fileName = normalizeThumbnailReference(refreshedAsset?.imgLocalPath)
    if (!fileName) {
      return {
        success: false,
        reason: 'Asset reimport fallback did not produce imgLocalPath',
        updatedRecords,
        clearedExistingReference
      }
    }

    updatedRecords += 1
    pushAssetUpdate(record.assetKey, refreshedAsset as Record<string, unknown>).catch(() => {})
    appendThumbnailRepairAudit(db, {
      level: 'info',
      action: 'reimport_thumbnail_fallback_succeeded',
      assetKey: record.assetKey,
      target: fileName,
      message: 'Recovered thumbnail reference through asset reimport fallback',
      details: { clearedExistingReference }
    })

    return {
      success: true,
      fileName,
      updatedRecords,
      clearedExistingReference
    }
  } catch (error) {
    return {
      success: false,
      reason: error instanceof Error ? error.message : String(error),
      updatedRecords,
      clearedExistingReference
    }
  }
}

async function persistAssetThumbnailReference(
  db: Database.Database,
  assetKey: string,
  fileName: string
): Promise<boolean> {
  return persistAssetThumbnailFields(db, assetKey, { imgLocalPath: fileName })
}

async function persistAssetThumbnailFields(
  db: Database.Database,
  assetKey: string,
  updates: Pick<AssetData, 'imgLocalPath' | 'customPoster'>
): Promise<boolean> {
  const success = updateAssetData(db, assetKey, updates)
  if (success) {
    const syncedAsset = getAssetDataByKey(db, assetKey)
    if (syncedAsset) {
      pushAssetUpdate(assetKey, syncedAsset as Record<string, unknown>).catch(() => {})
    }
  }
  return success
}

async function persistFolderThumbnailReference(
  db: Database.Database,
  folderKey: string,
  fileName: string
): Promise<boolean> {
  const success = updateAssetFolder(db, folderKey, { img: fileName })
  if (success) {
    const syncedFolder = getAssetFolderByKey(db, folderKey)
    if (syncedFolder) {
      pushFolderUpdate(folderKey, syncedFolder as AssetFolder as Record<string, unknown>).catch(
        () => {}
      )
    }
  }
  return success
}

async function repairAssetRow(
  db: Database.Database,
  record: RepairAssetRow
): Promise<Partial<ThumbnailRepairStats>> {
  const stats = createEmptyRepairStats()
  stats.scannedAssets = 1

  const assetLabel = record.assetName || record.assetKey
  if (isExternalThumbnailReference(record.customPoster)) {
    const externalRef = typeof record.customPoster === 'string' ? record.customPoster.trim() : ''
    const externalRepair = await migrateExternalCustomPoster(db, record, externalRef)
    mergeRepairStats(stats, externalRepair.stats)
    if (externalRepair.status !== 'continue') {
      return stats
    }
    record = { ...record, customPoster: '' }
  }

  const customPosterFile = normalizeThumbnailReference(record.customPoster)
  let customPosterWasCleared = false
  if (customPosterFile) {
    const customResult = await ensureRemoteThumbnailReference(customPosterFile, {
      verifyThumbIfPossible: true
    })
    applyEnsureResultToStats(stats, customResult)
    if (!customResult.ok) {
      if (customResult.missingLocal) {
        const cleared = await persistAssetThumbnailFields(db, record.assetKey, { customPoster: '' })
        if (cleared) {
          appendThumbnailRepairAudit(db, {
            level: 'warn',
            action: 'custom_poster_reference_cleared',
            assetKey: record.assetKey,
            target: customPosterFile,
            message: 'Cleared broken managed customPoster reference during repair',
            details: { errors: customResult.errors }
          })
          stats.updatedRecords += 1
          customPosterWasCleared = true
        } else {
          stats.failed += 1
          stats.failedFiles.push({
            target: `${assetLabel} / customPoster`,
            reason: 'Failed to clear broken customPoster reference'
          })
          return stats
        }
      } else {
        stats.failed += 1
        stats.failedFiles.push({
          target: `${assetLabel} / customPoster`,
          reason: customResult.errors.join(' | ')
        })
      }
    }
  }

  if (customPosterFile) {
    if (!customPosterWasCleared) {
      return stats
    }
  }

  const existingImgFile = normalizeThumbnailReference(record.imgLocalPath)
  if (existingImgFile) {
    const existingResult = await ensureRemoteThumbnailReference(existingImgFile)
    applyEnsureResultToStats(stats, existingResult)

    if (existingResult.ok) {
      return stats
    }

    if (!existingResult.missingLocal) {
      appendThumbnailRepairAudit(db, {
        level: 'error',
        action: 'thumbnail_reference_verification_failed',
        assetKey: record.assetKey,
        target: existingImgFile,
        message: 'Existing imgLocalPath could not be verified or repaired automatically',
        details: { errors: existingResult.errors }
      })
      stats.failed += 1
      stats.failedFiles.push({
        target: `${assetLabel} / imgLocalPath`,
        reason: existingResult.errors.join(' | ')
      })
      return stats
    }
  }

  const regenerateResult = await regenerateAssetThumbnail(record)
  if (!regenerateResult.success || !regenerateResult.fileName) {
    let imgLocalPathWasCleared = false
    let reimportFallbackReason = ''

    const extension = (record.fileExtension || '').toLowerCase()
    if (extension === 'uasset' || extension === 'umap') {
      const reimportResult = await tryReimportAssetThumbnailFallback(db, record, {
        clearExistingReference: Boolean(existingImgFile)
      })
      stats.updatedRecords += reimportResult.updatedRecords
      imgLocalPathWasCleared = reimportResult.clearedExistingReference
      if (!reimportResult.success) {
        appendThumbnailRepairAudit(db, {
          level: 'warn',
          action: 'reimport_thumbnail_fallback_failed',
          assetKey: record.assetKey,
          target: existingImgFile || record.assetKey,
          message: 'Asset reimport fallback did not recover thumbnail',
          details: { reason: reimportResult.reason || 'reimport fallback failed' }
        })
      }

      if (reimportResult.success && reimportResult.fileName) {
        const reimportEnsureResult = await ensureRemoteThumbnailReference(reimportResult.fileName)
        applyEnsureResultToStats(stats, reimportEnsureResult)
        if (reimportEnsureResult.ok) {
          return stats
        }

        reimportFallbackReason =
          reimportEnsureResult.errors.join(' | ') || 'Reimport fallback verification failed'

        if (reimportEnsureResult.missingLocal) {
          const cleared = await persistAssetThumbnailFields(db, record.assetKey, {
            imgLocalPath: ''
          })
          if (cleared) {
            stats.updatedRecords += 1
            imgLocalPathWasCleared = true
          } else {
            stats.failed += 1
            stats.failedFiles.push({
              target: `${assetLabel} / reimportFallback`,
              reason: 'Failed to clear broken imgLocalPath after reimport fallback'
            })
          }
        } else {
          stats.failed += 1
          stats.failedFiles.push({
            target: `${assetLabel} / reimportFallback`,
            reason: reimportFallbackReason
          })
          return stats
        }
      } else {
        reimportFallbackReason = reimportResult.reason || 'Reimport fallback failed'
      }
    }

    if (existingImgFile && !imgLocalPathWasCleared) {
      const cleared = await persistAssetThumbnailFields(db, record.assetKey, { imgLocalPath: '' })
      if (cleared) {
        appendThumbnailRepairAudit(db, {
          level: 'warn',
          action: 'img_local_path_cleared',
          assetKey: record.assetKey,
          target: existingImgFile,
          message: 'Cleared broken imgLocalPath reference after repair failed',
          details: {
            regenerateReason: regenerateResult.reason || 'unknown',
            reimportFallbackReason: reimportFallbackReason || null
          }
        })
        stats.updatedRecords += 1
      } else {
        stats.failed += 1
        stats.failedFiles.push({
          target: `${assetLabel} / imgLocalPath`,
          reason: 'Failed to clear broken imgLocalPath reference'
        })
      }
    }
    stats.failed += 1
    stats.failedFiles.push({
      target: `${assetLabel} / regenerate`,
      reason: [
        regenerateResult.reason || '缩略图重建失败',
        reimportFallbackReason ? `reimport fallback: ${reimportFallbackReason}` : ''
      ]
        .filter(Boolean)
        .join(' | ')
    })
    return stats
  }

  stats.regenerated += 1

  if (record.imgLocalPath !== regenerateResult.fileName) {
    const updated = await persistAssetThumbnailReference(
      db,
      record.assetKey,
      regenerateResult.fileName
    )
    if (updated) {
      stats.updatedRecords += 1
    }
  }

  const repairedResult = await ensureRemoteThumbnailReference(regenerateResult.fileName)
  applyEnsureResultToStats(stats, repairedResult)
  if (!repairedResult.ok) {
    if (repairedResult.missingLocal) {
      const cleared = await persistAssetThumbnailFields(db, record.assetKey, {
        imgLocalPath: '',
        ...(customPosterWasCleared ? { customPoster: '' } : {})
      })
      if (cleared) {
        appendThumbnailRepairAudit(db, {
          level: 'warn',
          action: 'repaired_thumbnail_reference_cleared',
          assetKey: record.assetKey,
          target: regenerateResult.fileName,
          message: 'Cleared regenerated thumbnail reference after remote verification failed',
          details: { errors: repairedResult.errors }
        })
        stats.updatedRecords += 1
      } else {
        stats.failed += 1
        stats.failedFiles.push({
          target: `${assetLabel} / repaired`,
          reason: 'Failed to clear broken repaired thumbnail reference'
        })
      }
    } else {
      stats.failed += 1
      stats.failedFiles.push({
        target: `${assetLabel} / repaired`,
        reason: repairedResult.errors.join(' | ')
      })
    }
  }

  return stats
}

async function repairFolderRow(
  db: Database.Database,
  record: RepairFolderRow
): Promise<Partial<ThumbnailRepairStats>> {
  const stats = createEmptyRepairStats()
  stats.scannedFolders = 1

  if (isExternalThumbnailReference(record.img)) {
    return stats
  }

  const fileName = normalizeThumbnailReference(record.img)
  if (!fileName) {
    return stats
  }

  const folderLabel = record.folderName || record.folderKey
  const result = await ensureRemoteThumbnailReference(fileName, {
    verifyThumbIfPossible: true
  })
  applyEnsureResultToStats(stats, result)

  if (result.ok) {
    if (record.img !== fileName) {
      const updated = await persistFolderThumbnailReference(db, record.folderKey, fileName)
      if (updated) {
        stats.updatedRecords += 1
      }
    }
    return stats
  }

  if (result.missingLocal) {
    const updated = await persistFolderThumbnailReference(db, record.folderKey, '')
    if (updated) {
      appendThumbnailRepairAudit(db, {
        level: 'warn',
        action: 'folder_cover_reference_cleared',
        folderKey: record.folderKey,
        target: fileName,
        message: 'Cleared broken folder cover reference during thumbnail repair'
      })
      stats.updatedRecords += 1
    } else {
      stats.failed += 1
      stats.failedFiles.push({
        target: `${folderLabel} / folder.img`,
        reason: 'Failed to clear broken folder cover reference'
      })
    }
  } else {
    stats.failed += 1
    stats.failedFiles.push({
      target: `${folderLabel} / folder.img`,
      reason: result.errors.join(' | ')
    })
  }

  return stats
}

/**
 * 如果当前活跃 vault 是 HTTP 远程库，将缩略图文件上传到远程服务器
 * 使用 PUT /api/vaults/:remoteVaultId/files/.thumbnails/filename
 */
export async function uploadThumbnailToRemoteIfNeeded(fileName: string): Promise<void> {
  try {
    console.log(`[Thumbnail] Checking whether remote upload is needed: ${fileName}`)
    const result = await uploadThumbnailFileToRemote(fileName)

    if (result.skipped) {
      return
    }

    const hasBlockingError =
      result.missingLocal || result.errors.length > 0 || !result.uploadedOriginal

    if (hasBlockingError) {
      throw new Error(
        `Remote thumbnail upload did not complete for ${fileName}: ${
          result.errors.join(' | ') || 'original thumbnail was not uploaded'
        }`
      )
    }
  } catch (err) {
    console.warn(
      `[Thumbnail] Remote upload failed: ${err instanceof Error ? err.message : String(err)}`
    )
    appendCurrentVaultThumbnailAudit({
      level: 'error',
      action: 'thumbnail_remote_upload_failed',
      target: fileName,
      message: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

export function registerAssetThumbnailIPC(): void {
  ipcMain.handle(
    'asset:saveThumbnail',
    async (
      _,
      base64Data: string,
      assetKey?: string
    ): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        const fileName = await ThumbnailManager.saveVaultThumbnail(base64Data, assetKey)
        if (fileName) {
          // Wait for remote upload before returning so the DB is not updated with a broken reference.
          await uploadThumbnailToRemoteIfNeeded(fileName)
          return { success: true, data: fileName }
        }
        return { success: false, error: '保存缩略图失败' }
      } catch (error) {
        console.error('保存缩略图失败', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'asset:saveThumbnailFile',
    async (
      _,
      srcPath: string,
      assetKey?: string
    ): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        const fileName = await ThumbnailManager.saveVaultThumbnailFromFile(srcPath, assetKey)
        if (fileName) {
          await uploadThumbnailToRemoteIfNeeded(fileName)
          return { success: true, data: fileName }
        }
        return { success: false, error: '保存缩略图文件失败' }
      } catch (error) {
        console.error('保存缩略图文件失败', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'asset:saveOriginalAndCroppedThumbnail',
    async (
      _,
      originalBase64: string,
      croppedBase64: string,
      assetKey?: string
    ): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        const fileName = await ThumbnailManager.saveOriginalAndCroppedThumbnail(
          originalBase64,
          croppedBase64,
          assetKey
        )
        if (fileName) {
          await uploadThumbnailToRemoteIfNeeded(fileName)
          return { success: true, data: fileName }
        }
        return { success: false, error: '保存双图缩略图失败' }
      } catch (error) {
        console.error('保存双图缩略图失败', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 当前保管库允许读取的媒体范围。
   *
   * 不能简单地要求「必须在保管库目录里」：引用型保管库只记录原始文件位置，
   * 资产本来就散在用户自己的目录里。所以另给一条出路 —— 库里确实有一条资产
   * 指向这个路径。
   */
  const checkAssetMediaReadAllowed = (filePath: string): string | null => {
    let roots: (string | undefined)[] = []
    try {
      const pm = PathManager.getInstance()
      const currentVault = VaultManager.getInstance().getCurrentVault()
      roots = [
        pm.getCurrentVaultPath(),
        pm.getThumbnailsPath(),
        currentVault?.networkPath && !currentVault.networkPath.startsWith('http')
          ? currentVault.networkPath
          : undefined
      ]
    } catch {
      // 还没选保管库 —— 只剩「库里有这条资产」这条路，下面会一并判掉
    }

    return denyMediaRead(filePath, {
      roots,
      isKnownAssetPath: (candidate) => {
        try {
          const db = getVaultDatabase()
          // 三列 OR 会让规划器退回 isDelete 单列索引整表扫（52 万行 4.7 秒，同步阻塞主进程）。
          // 拆成三条等值查询各走自己的索引，和 remoteImportPath.ts 同一个修法。
          const row = db
            .prepare(
              `SELECT 1 FROM (
                 SELECT 1 FROM assetData WHERE isDelete = 0 AND filePath = ?
                 UNION ALL
                 SELECT 1 FROM assetData WHERE isDelete = 0 AND originPath = ?
                 UNION ALL
                 SELECT 1 FROM assetData WHERE isDelete = 0 AND imgLocalPath = ?
               )
               LIMIT 1`
            )
            .get(candidate, candidate, candidate)
          return Boolean(row)
        } catch {
          return false
        }
      }
    })
  }

  ipcMain.handle(
    'asset:readFileAsBase64',
    async (_, filePath: string): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        // 这个通道原来把任意绝对路径原样读回 base64 —— 渲染层（或任何能往里注入
        // 一句脚本的东西）可以拿它读走本机任意文件。两个调用方读的都是资产库里的
        // 图片，所以按「媒体文件 + 属于当前保管库或库里有这条资产」收紧。
        const denial = checkAssetMediaReadAllowed(filePath)
        if (denial) return { success: false, error: denial }

        if (!existsSync(filePath)) {
          return { success: false, error: '文件不存在' }
        }

        const fileBuffer = await fs.readFile(filePath)
        return { success: true, data: fileBuffer.toString('base64') }
      } catch (error) {
        console.error('读取文件转 base64 失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'asset:overwriteThumb',
    async (
      _,
      posterFilename: string,
      croppedBase64: string
      // 第三个参数 assetKey 渲染层还在传，这里用不上了 —— 多出来的 IPC 参数会被忽略
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        // posterFilename 来自渲染层，原来是直接 join 进缩略图目录再写文件。
        // 传 `../../vault-data.db` 就能把一张 JPEG 覆盖到保管库数据库本体上。
        // 文件名就该是个文件名：不许带路径分隔符，拼完还要落在缩略图目录里。
        if (!isPlainFileName(posterFilename)) {
          return { success: false, error: '缩略图文件名不合法' }
        }
        const thumbFilename = ThumbnailManager.toThumbFilename(posterFilename)
        const pm = PathManager.getInstance()
        const thumbPath = pm.getThumbnailFilePath(thumbFilename)
        if (!isInsideDirectory(thumbPath, pm.getThumbnailsPath())) {
          return { success: false, error: '缩略图路径越界' }
        }

        const match = croppedBase64.match(/^data:(image|video)\/[\w+]+;base64,(.+)$/)
        if (!match) {
          return { success: false, error: '无效的 base64 数据' }
        }

        await ThumbnailManager.generateCompressedThumbnail(
          Buffer.from(match[2], 'base64'),
          thumbPath
        )
        console.log(`[asset:overwriteThumb] 已覆盖 _thumb: ${thumbFilename}`)

        // Keep the remote compressed preview in sync before reporting success.
        await uploadThumbnailToRemoteIfNeeded(thumbFilename)

        try {
          const { BrowserWindow } = require('electron')
          const win = BrowserWindow.getFocusedWindow()
          if (win) {
            await win.webContents.session.clearCache()
          }
        } catch {
          // ignore cache clear failures
        }

        return { success: true }
      } catch (error) {
        console.error('覆盖 _thumb 失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'asset:syncCurrentVaultThumbnailsToRemote',
    async (): Promise<{ success: boolean; data?: ThumbnailRepairStats; error?: string }> => {
      try {
        if (!getRemoteHttpVaultInfo()) {
          return { success: false, error: '当前保管库不是 NAS V2 HTTP 网络库' }
        }

        emitThumbnailRepairProgress({
          phase: '准备修复',
          current: 0,
          total: 0,
          percent: 0,
          message: '正在扫描资产记录...'
        })
        await yieldRepairProgress()

        const db = getVaultDatabase()
        const stats = createEmptyRepairStats()
        remoteFileExistenceCache.clear()
        remoteReferenceEnsureCache.clear()
        appendThumbnailRepairAudit(db, {
          level: 'info',
          action: 'thumbnail_repair_run_started',
          message: 'Started current vault thumbnail repair run'
        })

        const assetRows = db
          .prepare(
            `SELECT assetKey, assetName, filePath, originPath, fileExtension, imgLocalPath, customPoster
             FROM assetData
             WHERE isDelete = 0
               AND COALESCE(isDependency, 0) = 0
               AND (
                 (customPoster IS NOT NULL AND customPoster != '')
                 OR (imgLocalPath IS NOT NULL AND imgLocalPath != '')
                 OR LOWER(COALESCE(fileExtension, '')) IN ('uasset', 'umap', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tga', 'dds', 'tif', 'tiff', 'uplugin', 'uproject')
               )`
          )
          .all() as RepairAssetRow[]

        const folderRows = db
          .prepare(
            `SELECT folderKey, folderName, img
             FROM assetFolder
             WHERE isDelete = 0
               AND img IS NOT NULL
               AND img != ''`
          )
          .all() as RepairFolderRow[]

        const total = assetRows.length + folderRows.length
        let current = 0

        emitThumbnailRepairProgress({
          phase: '准备修复',
          current,
          total,
          percent: total > 0 ? 0 : 100,
          message: `准备修复 ${assetRows.length} 个资产和 ${folderRows.length} 个文件夹封面`
        })
        await yieldRepairProgress()

        await runWithConcurrency(assetRows, THUMBNAIL_REPAIR_CONCURRENCY, async (assetRow) => {
          const partial = await repairAssetRow(db, assetRow)
          mergeRepairStats(stats, partial)
          current++
          emitThumbnailRepairProgress({
            phase: '修复资产缩略图',
            current,
            total,
            percent: total > 0 ? Math.min(99, Math.round((current / total) * 100)) : 100,
            message: `已处理 ${current}/${total}：${assetRow.assetName || assetRow.assetKey}`
          })
          if (current % 5 === 0) {
            await yieldRepairProgress()
          }
        })

        await runWithConcurrency(folderRows, THUMBNAIL_REPAIR_CONCURRENCY, async (folderRow) => {
          const partial = await repairFolderRow(db, folderRow)
          mergeRepairStats(stats, partial)
          current++
          emitThumbnailRepairProgress({
            phase: '修复文件夹封面',
            current,
            total,
            percent: total > 0 ? Math.min(99, Math.round((current / total) * 100)) : 100,
            message: `已处理 ${current}/${total}：${folderRow.folderName || folderRow.folderKey}`
          })
          if (current % 5 === 0) {
            await yieldRepairProgress()
          }
        })

        stats.missingFiles = Array.from(new Set(stats.missingFiles)).sort((a, b) =>
          a.localeCompare(b)
        )
        stats.failedFiles = stats.failedFiles.filter(
          (item, index, arr) =>
            arr.findIndex(
              (entry) => entry.target === item.target && entry.reason === item.reason
            ) === index
        )
        for (const item of stats.failedFiles) {
          appendThumbnailRepairAudit(db, {
            level: 'error',
            action: 'thumbnail_repair_item_failed',
            target: item.target,
            message: item.reason
          })
        }
        for (const item of stats.missingFiles) {
          appendThumbnailRepairAudit(db, {
            level: 'warn',
            action: 'thumbnail_repair_missing_source',
            target: item,
            message: 'Missing local or source file during thumbnail repair'
          })
        }
        appendThumbnailRepairAudit(db, {
          level: stats.failed > 0 || stats.missingLocal > 0 ? 'warn' : 'info',
          action: 'thumbnail_repair_run_completed',
          message: 'Completed current vault thumbnail repair run',
          details: {
            scannedAssets: stats.scannedAssets,
            scannedFolders: stats.scannedFolders,
            regenerated: stats.regenerated,
            updatedRecords: stats.updatedRecords,
            uploadedOriginal: stats.uploadedOriginal,
            uploadedThumb: stats.uploadedThumb,
            verifiedOriginal: stats.verifiedOriginal,
            verifiedThumb: stats.verifiedThumb,
            alreadyRemotePresent: stats.alreadyRemotePresent,
            missingLocal: stats.missingLocal,
            failed: stats.failed,
            failedEntries: stats.failedFiles.length
          }
        })

        emitThumbnailRepairProgress({
          phase: '修复完成',
          current: total,
          total,
          percent: 100,
          message: `修复完成：重建 ${stats.regenerated} 个，上传原图 ${stats.uploadedOriginal} 个，上传压缩图 ${stats.uploadedThumb} 个`
        })
        await yieldRepairProgress()

        return { success: true, data: stats }
      } catch (error) {
        console.error('修复当前保管库缩略图失败:', error)
        appendCurrentVaultThumbnailAudit({
          level: 'error',
          action: 'thumbnail_repair_run_failed',
          message: error instanceof Error ? error.message : String(error)
        })
        emitThumbnailRepairProgress({
          phase: '修复失败',
          current: 0,
          total: 0,
          percent: 0,
          message: error instanceof Error ? error.message : String(error)
        })
        await yieldRepairProgress()
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'asset:listThumbnailRepairAuditLogs',
    async (
      _,
      limit = 100
    ): Promise<{ success: boolean; data?: ThumbnailRepairAuditEntry[]; error?: string }> => {
      try {
        const db = getVaultDatabase()
        return { success: true, data: listThumbnailRepairAudit(db, limit) }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}
