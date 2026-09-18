import { toLocalResourceUrl } from './localResource'

export const THUMBNAILS_DIR_NAME = 'thumbnails'
// 网络库使用 .thumbnails 目录（带点前缀）
export const NETWORK_THUMBNAILS_DIR_NAME = '.thumbnails'

function buildRemoteAssetProxyUrl(
  serverUrl: string,
  vaultId: string,
  relativePath: string
): string {
  const params = new URLSearchParams({
    serverUrl,
    vaultId,
    path: relativePath
  })
  return `uebox-asset://file?${params.toString()}`
}

/**
 * 解析资产文件的完整路径
 * - 引用模式：优先使用 originPath
 * - 备份模式：使用 vaultPath + filePath 拼接
 * @param vaultPath 保管库路径
 * @param isBackup 是否为备份模式
 * @param originPath 资产的原始路径
 * @param filePath 资产的相对/绝对路径
 * @returns 解析后的完整路径，如果无法解析则返回 undefined
 */
export function resolveAssetFilePath(
  vaultPath: string | undefined,
  isBackup: boolean,
  originPath: string | undefined | null,
  filePath: string | undefined | null
): string | undefined {
  // 备份模式：优先使用 vaultPath + filePath 拼接
  if (isBackup && vaultPath && filePath) {
    const normalizedFilePath = String(filePath)
    // 如果 filePath 是相对路径（不以盘符开头），则拼接保管库路径
    if (!/^[a-zA-Z]:/.test(normalizedFilePath)) {
      return `${vaultPath}/${normalizedFilePath}`.replace(/\\/g, '/')
    }
    // 如果 filePath 已经是绝对路径（旧数据或备份失败），直接使用
    return normalizedFilePath
  }

  // 引用模式：优先使用 originPath
  if (originPath) {
    return String(originPath)
  }

  // 回退：使用 filePath
  if (filePath) {
    return String(filePath)
  }

  return undefined
}

/**
 * 构造缩略图的可加载 URL（local-resource://）
 * - 传入保管库路径和资产的本地缩略图相对路径
 * - 自动进行 Windows 路径分隔符归一化与 URI 编码
 * @param vaultPath 保管库路径
 * @param imgLocalPath 缩略图文件名或相对路径
 * @param isNetworkVault 是否为网络库（使用 .thumbnails 目录）
 */
export function buildThumbnailUrl(
  vaultPath?: string,
  imgLocalPath?: string,
  isNetworkVault?: boolean
): string | undefined {
  try {
    if (!vaultPath || !imgLocalPath) return undefined
    const normalizedVault = String(vaultPath).replace(/\\/g, '/')
    let normalizedFile = String(imgLocalPath).replace(/\\/g, '/')

    // 检查是否是绝对路径 (Windows 盘符或 Linux 根路径)
    const isAbsolute = normalizedFile.includes(':') || normalizedFile.startsWith('/')

    if (isAbsolute) {
      return toLocalResourceUrl(normalizedFile)
    }

    // 🔧 处理已包含 thumbnails/ 或 .thumbnails/ 前缀的路径
    // 根据 isNetworkVault 参数替换为正确的目录前缀
    const thumbDirPrefix = `${THUMBNAILS_DIR_NAME}/`
    const networkThumbDirPrefix = `${NETWORK_THUMBNAILS_DIR_NAME}/`

    if (normalizedFile.startsWith(thumbDirPrefix)) {
      // 路径以 thumbnails/ 开头
      const filename = normalizedFile.slice(thumbDirPrefix.length)
      const correctDir = isNetworkVault ? NETWORK_THUMBNAILS_DIR_NAME : THUMBNAILS_DIR_NAME
      normalizedFile = `${correctDir}/${filename}`
    } else if (normalizedFile.startsWith(networkThumbDirPrefix)) {
      // 路径以 .thumbnails/ 开头
      const filename = normalizedFile.slice(networkThumbDirPrefix.length)
      const correctDir = isNetworkVault ? NETWORK_THUMBNAILS_DIR_NAME : THUMBNAILS_DIR_NAME
      normalizedFile = `${correctDir}/${filename}`
    } else if (!normalizedFile.includes('/')) {
      // 纯文件名，添加正确的 thumbnails 目录
      const thumbDir = isNetworkVault ? NETWORK_THUMBNAILS_DIR_NAME : THUMBNAILS_DIR_NAME
      normalizedFile = `${thumbDir}/${normalizedFile}`
    }

    // Remote server mode uses the main-process asset proxy.
    if (normalizedVault.startsWith('http://') || normalizedVault.startsWith('https://')) {
      // 解析 URL 格式: http://host:port/remoteVaultId
      const lastSlash = normalizedVault.lastIndexOf('/')
      const serverBase = normalizedVault.substring(0, lastSlash) // http://host:port
      const remoteVaultId = normalizedVault.substring(lastSlash + 1) // remoteVaultId
      if (serverBase && remoteVaultId) {
        return buildRemoteAssetProxyUrl(serverBase, remoteVaultId, normalizedFile)
      }
    }

    // 相对路径，拼接 Vault 路径 → local-resource:// URL
    const fullPath = `${normalizedVault}/${normalizedFile}`
    return toLocalResourceUrl(fullPath)
  } catch {
    return undefined
  }
}

/**
 * 原图文件名 → 压缩缩略图文件名
 * `custom-xxx-123.png` → `custom-xxx-123_thumb.jpg`
 */
export function toThumbFilename(filename: string): string {
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx <= 0) return filename + '_thumb.jpg'
  return filename.substring(0, dotIdx) + '_thumb.jpg'
}

/**
 * 构造压缩缩略图的可加载 URL（local-resource://）
 * 自动将原图文件名转换为 _thumb 后缀版本
 * @param vaultPath       保管库路径
 * @param imgLocalPath    原图文件名或相对路径
 * @param isNetworkVault  是否为网络库
 */
export function buildCompressedThumbnailUrl(
  vaultPath?: string,
  imgLocalPath?: string,
  isNetworkVault?: boolean
): string | undefined {
  if (!imgLocalPath) return undefined
  const thumbPath = toThumbFilename(imgLocalPath)
  return buildThumbnailUrl(vaultPath, thumbPath, isNetworkVault)
}

/**
 * 构造 Vault 内文件的直接访问 URL（不经过 thumbnails 目录）
 * 用于图片/视频文件本身就是预览资源的场景
 * - 本地 Vault: local-resource://vaultPath/filePath
 * - Network Vault (HTTP): uebox-asset:// proxy URL
 * @param vaultPath   保管库路径（本地绝对路径或 http://host:port/vaultId 格式）
 * @param filePath    文件的相对路径（相对于 vault 根目录）
 * @param isNetworkVault 是否为网络库
 */
export function buildDirectFileUrl(
  vaultPath?: string,
  filePath?: string,
  _isNetworkVault?: boolean
): string | undefined {
  try {
    if (!vaultPath || !filePath) return undefined
    const normalizedVault = String(vaultPath).replace(/\\/g, '/')
    const normalizedFile = String(filePath).replace(/\\/g, '/')

    // 对于网络 Vault，需要通过 HTTP API 访问文件
    if (normalizedVault.startsWith('http://') || normalizedVault.startsWith('https://')) {
      // 如果 filePath 是服务端绝对路径，无法直接使用，返回 undefined
      const isAbsolute = normalizedFile.includes(':') || normalizedFile.startsWith('/')
      if (isAbsolute) return undefined

      // Build a main-process proxy URL so bearer tokens stay out of renderer URLs.
      const lastSlash = normalizedVault.lastIndexOf('/')
      const serverBase = normalizedVault.substring(0, lastSlash)
      const remoteVaultId = normalizedVault.substring(lastSlash + 1)
      if (serverBase && remoteVaultId) {
        return buildRemoteAssetProxyUrl(serverBase, remoteVaultId, normalizedFile)
      }
      return undefined
    }

    // 本地 Vault：检查是否是绝对路径
    const isAbsolute = normalizedFile.includes(':') || normalizedFile.startsWith('/')
    if (isAbsolute) {
      return toLocalResourceUrl(normalizedFile)
    }

    // 相对路径，拼接 Vault 路径 → local-resource:// URL
    const fullPath = `${normalizedVault}/${normalizedFile}`
    return toLocalResourceUrl(fullPath)
  } catch {
    return undefined
  }
}
