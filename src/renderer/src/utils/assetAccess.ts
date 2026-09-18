import { buildDirectFileUrl, resolveAssetFilePath } from './thumbnails'
import { toLocalResourceUrl } from './localResource'

const HTTP_URL_RE = /^https?:\/\//i
const FILE_URL_RE = /^file:/i
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}|\/)/

export interface AssetAccessOptions {
  vaultType?: string | null
  vaultPath?: string | null
  networkPath?: string | null
  originPath?: string | null
  filePath?: string | null
}

export interface AssetAccessResult {
  localPath?: string
  fileUrl?: string
  isRemoteHttp: boolean
}

export interface RemoteTextPreviewOptions {
  maxBytes?: number
  timeoutMs?: number
}

export interface RemoteTextPreviewResult {
  content: string
  truncated: boolean
}

export interface AssetUrlFallbackOptions extends AssetAccessOptions {
  assetKey?: string | null
  assetName?: string | null
  fileExtension?: string | null
  folderKey?: string | null
  resolveAssetByKey?: (assetKey: string) => Promise<
    | {
        originPath?: string | null
        filePath?: string | null
        assetName?: string | null
        fileExtension?: string | null
        folderKey?: string | null
      }
    | null
    | undefined
  >
  resolveFolderRelativePath?: (folderKey: string) => Promise<string | null | undefined>
}

export interface RemoteBinaryReadOptions {
  timeoutMs?: number
  maxBytes?: number
}

const DEFAULT_REMOTE_BINARY_LIMIT_BYTES = 10 * 1024 * 1024

export const isHttpUrl = (value?: string | null): boolean =>
  HTTP_URL_RE.test(String(value || '').trim())

export const isFileUrl = (value?: string | null): boolean =>
  FILE_URL_RE.test(String(value || '').trim())

export const isAbsolutePathOrUrl = (value?: string | null): boolean => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return false
  return ABSOLUTE_PATH_RE.test(trimmed) || isFileUrl(trimmed) || isHttpUrl(trimmed)
}

/**
 * 本地路径 / file:// URL → 渲染进程可加载的 URL。
 * 走 local-resource 协议：dev 模式下 file:/// 会被 Chromium 拒掉，
 * 而且 renderer 里的 fetch() 也读不了 file:，local-resource 两样都能用。
 */
export const toAssetFileUrl = (value?: string | null): string | undefined => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return undefined
  if (isHttpUrl(trimmed)) {
    return trimmed
  }
  return toLocalResourceUrl(trimmed)
}

export function resolveAssetLocalPath(options: AssetAccessOptions): string | undefined {
  const vaultType = String(options.vaultType || '')
    .trim()
    .toLowerCase()
  const vaultPath = String(options.vaultPath || '').trim() || undefined
  const networkPath = String(options.networkPath || '').trim() || undefined
  const originPath = String(options.originPath || '').trim() || undefined
  const filePath = String(options.filePath || '').trim() || undefined

  if (vaultType === 'network' && networkPath) {
    if (isHttpUrl(networkPath)) {
      return undefined
    }

    if (filePath) {
      if (isAbsolutePathOrUrl(filePath)) {
        return filePath
      }
      return `${networkPath}/${filePath}`.replace(/\\/g, '/')
    }

    if (originPath && !isHttpUrl(originPath)) {
      return originPath
    }

    return undefined
  }

  return resolveAssetFilePath(vaultPath, vaultType === 'backup', originPath, filePath)
}

export function resolveAssetUrl(options: AssetAccessOptions): string | undefined {
  const vaultType = String(options.vaultType || '')
    .trim()
    .toLowerCase()
  const networkPath = String(options.networkPath || '').trim() || undefined
  const originPath = String(options.originPath || '').trim() || undefined
  const filePath = String(options.filePath || '').trim() || undefined

  if (vaultType === 'network' && networkPath && isHttpUrl(networkPath)) {
    for (const candidate of [filePath, originPath]) {
      if (!candidate) continue

      if (isHttpUrl(candidate)) {
        return candidate
      }

      if (isFileUrl(candidate)) {
        return toLocalResourceUrl(candidate)
      }

      const built = buildDirectFileUrl(networkPath, candidate, true)
      if (built) {
        return built
      }
    }
    return undefined
  }

  return toAssetFileUrl(resolveAssetLocalPath(options))
}

export function resolveAssetAccess(options: AssetAccessOptions): AssetAccessResult {
  const networkPath = String(options.networkPath || '').trim()
  const isRemoteHttp =
    String(options.vaultType || '')
      .trim()
      .toLowerCase() === 'network' && isHttpUrl(networkPath)

  const localPath = resolveAssetLocalPath(options)
  const fileUrl = resolveAssetUrl(options)

  return {
    localPath,
    fileUrl,
    isRemoteHttp
  }
}

const normalizeRelativePath = (value?: string | null): string => {
  let normalized = String(value || '').trim()
  if (!normalized) return ''

  normalized = normalized.replace(/^[\\/]+/, '')
  if (normalized === 'ALL') return ''

  if (normalized.startsWith('ALL/') || normalized.startsWith('ALL\\')) {
    normalized = normalized.slice(4)
  }

  return normalized.replace(/^[\\/]+/, '')
}

const buildAssetFileName = (
  assetName?: string | null,
  fileExtension?: string | null
): string | undefined => {
  const normalizedName = String(assetName || '').trim()
  const normalizedExt = String(fileExtension || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase()

  if (!normalizedName) return undefined
  if (!normalizedExt) return normalizedName

  return normalizedName.toLowerCase().endsWith(`.${normalizedExt}`)
    ? normalizedName
    : `${normalizedName}.${normalizedExt}`
}

export async function resolveAssetUrlWithFallback(
  options: AssetUrlFallbackOptions
): Promise<string | undefined> {
  let resolvedOptions = { ...options }
  let directUrl = resolveAssetUrl(resolvedOptions)
  if (directUrl) return directUrl

  const missingPathInfo =
    !String(resolvedOptions.filePath || '').trim() &&
    !String(resolvedOptions.originPath || '').trim()

  if (missingPathInfo && resolvedOptions.assetKey && resolvedOptions.resolveAssetByKey) {
    const asset = await resolvedOptions.resolveAssetByKey(resolvedOptions.assetKey)
    if (asset) {
      resolvedOptions = {
        ...resolvedOptions,
        originPath: asset.originPath ?? resolvedOptions.originPath,
        filePath: asset.filePath ?? resolvedOptions.filePath,
        assetName: asset.assetName ?? resolvedOptions.assetName,
        fileExtension: asset.fileExtension ?? resolvedOptions.fileExtension,
        folderKey: asset.folderKey ?? resolvedOptions.folderKey
      }
      directUrl = resolveAssetUrl(resolvedOptions)
      if (directUrl) return directUrl
    }
  }

  const vaultType = String(resolvedOptions.vaultType || '')
    .trim()
    .toLowerCase()
  const networkPath = String(resolvedOptions.networkPath || '').trim()
  if (vaultType !== 'network' || !isHttpUrl(networkPath)) {
    return undefined
  }

  const fileName = buildAssetFileName(resolvedOptions.assetName, resolvedOptions.fileExtension)
  if (!fileName) {
    return undefined
  }

  let relativePath = fileName
  const folderKey = String(resolvedOptions.folderKey || '').trim()
  if (folderKey && folderKey !== 'ALL' && resolvedOptions.resolveFolderRelativePath) {
    const folderRelativePath = normalizeRelativePath(
      await resolvedOptions.resolveFolderRelativePath(folderKey)
    )
    if (folderRelativePath) {
      relativePath = `${folderRelativePath}/${fileName}`
    }
  }

  return buildDirectFileUrl(networkPath, relativePath, true)
}

export async function fetchRemoteTextPreview(
  url: string,
  options: RemoteTextPreviewOptions = {}
): Promise<RemoteTextPreviewResult> {
  const maxBytes = Math.max(options.maxBytes || 1024 * 1024, 1)
  const timeoutMs = Math.max(options.timeoutMs || 15000, 1000)
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  if (!response.body) {
    const text = await response.text()
    return {
      content: text.slice(0, maxBytes),
      truncated: text.length > maxBytes
    }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = false

  while (received < maxBytes) {
    const { done, value } = await reader.read()
    if (done || !value) break

    let chunk = value
    if (received + chunk.byteLength > maxBytes) {
      chunk = chunk.subarray(0, maxBytes - received)
      truncated = true
    }

    if (chunk.byteLength > 0) {
      chunks.push(chunk)
      received += chunk.byteLength
    }

    if (truncated) {
      await reader.cancel()
      break
    }
  }

  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return {
    content: new TextDecoder('utf-8').decode(merged),
    truncated
  }
}

export async function readRemoteArrayBuffer(
  url: string,
  options: RemoteBinaryReadOptions = {}
): Promise<ArrayBuffer> {
  const timeoutMs = Math.max(options.timeoutMs || 30000, 1000)
  const maxBytes = Math.max(options.maxBytes || DEFAULT_REMOTE_BINARY_LIMIT_BYTES, 1)
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const contentLength = Number(response.headers.get('content-length') || '')
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`文件过大，超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`)
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) {
      throw new Error(`文件过大，超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`)
    }
    return buffer
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new Error(`文件过大，超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`)
    }

    chunks.push(value)
  }

  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return merged.buffer.slice(0)
}

export async function writeRemoteArrayBuffer(
  url: string,
  data: Uint8Array,
  contentType = 'application/octet-stream',
  timeoutMs = 30000,
  maxBytes?: number
): Promise<void> {
  if (maxBytes && data.byteLength > maxBytes) {
    throw new Error(`文件过大，超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`)
  }
  const body = data.slice().buffer
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType
    },
    body: new Blob([body], { type: contentType }),
    signal: AbortSignal.timeout(timeoutMs)
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
}
