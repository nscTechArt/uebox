import { PathManager } from './PathManager'
import { promises as fs } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { nativeImage } from 'electron'

// ─── 压缩参数 ───
const THUMB_MAX_WIDTH = 400
const THUMB_JPEG_QUALITY = 80
const THUMB_SKIP_THRESHOLD = 200 * 1024 // 200KB 以下跳过压缩

/**
 * 缩略图管理工具
 * 支持原图 + 压缩缩略图双图存储
 */
export class ThumbnailManager {
  // ─────────── 文件名约定工具 ───────────

  /**
   * 原图文件名 → 压缩缩略图文件名
   * `custom-xxx-123.png` → `custom-xxx-123_thumb.jpg`
   */
  static toThumbFilename(filename: string): string {
    const dotIdx = filename.lastIndexOf('.')
    if (dotIdx <= 0) return filename + '_thumb.jpg'
    return filename.substring(0, dotIdx) + '_thumb.jpg'
  }

  /**
   * 判断文件扩展名是否为可压缩的图片类型（排除 gif、视频等）
   */
  private static isCompressibleImage(filename: string): boolean {
    const ext = (filename.split('.').pop() || '').toLowerCase()
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tga'].includes(ext)
  }

  // ─────────── 压缩核心 ───────────

  /**
   * 使用 Electron nativeImage 生成压缩缩略图
   * @param srcBuffer 原图的 Buffer 数据
   * @param destPath  _thumb 文件的输出路径
   * @param maxWidth  最大宽度，默认 400px
   */
  static async generateCompressedThumbnail(
    srcBuffer: Buffer,
    destPath: string,
    maxWidth: number = THUMB_MAX_WIDTH
  ): Promise<void> {
    // 如果原图已经足够小，直接复制
    if (srcBuffer.length <= THUMB_SKIP_THRESHOLD) {
      await fs.writeFile(destPath, srcBuffer)
      return
    }

    const img = nativeImage.createFromBuffer(srcBuffer)
    if (img.isEmpty()) {
      // 无法解析的图片格式，回退为直接复制
      await fs.writeFile(destPath, srcBuffer)
      return
    }

    const { width } = img.getSize()
    let resized = img
    if (width > maxWidth) {
      // 按比例缩放
      resized = img.resize({ width: maxWidth })
    }

    const jpegBuffer = resized.toJPEG(THUMB_JPEG_QUALITY)
    await fs.writeFile(destPath, jpegBuffer)
  }

  /**
   * 为已存在的文件生成 _thumb 压缩版本
   * @param originalFilePath 原图在 thumbnails 目录中的绝对路径
   * @param thumbFileName    _thumb 文件名
   */
  static async generateThumbForFile(
    originalFilePath: string,
    thumbFileName: string
  ): Promise<void> {
    try {
      const pathManager = PathManager.getInstance()
      const thumbPath = pathManager.getThumbnailFilePath(thumbFileName)
      const srcBuffer = await fs.readFile(originalFilePath)
      await ThumbnailManager.generateCompressedThumbnail(srcBuffer, thumbPath)
      console.log(`[ThumbnailManager] Generated compressed thumb: ${thumbFileName}`)
    } catch (err) {
      console.warn('[ThumbnailManager] Failed to generate compressed thumb:', err)
    }
  }

  // ─────────── 双图保存（原图 + 裁剪压缩图） ───────────

  /**
   * 保存原图 + 裁剪后的压缩缩略图（双图保存）
   *
   * 流程：
   *  1. 原图保存到 thumbnails/ 目录 → 用于空格键预览
   *  2. 裁剪后的图片压缩为 _thumb → 用于列表卡片显示
   *
   * @param originalBase64 原图 base64（含 data:image/xxx;base64, 前缀）
   * @param croppedBase64  裁剪后 base64（含 data:image/xxx;base64, 前缀）
   * @param assetKey       资产键，用于生成文件名
   * @returns 原图文件名（DB customPoster 存这个），失败返回 null
   */
  static async saveOriginalAndCroppedThumbnail(
    originalBase64: string,
    croppedBase64: string,
    assetKey?: string
  ): Promise<string | null> {
    try {
      // 1. 保存原图
      const originalFileName = await ThumbnailManager.saveVaultThumbnail(originalBase64, assetKey)
      if (!originalFileName) return null

      // 2. 解析裁剪后的 base64
      const croppedMatch = croppedBase64.match(/^data:(image|video)\/([\w+]+);base64,(.+)$/)
      if (!croppedMatch) {
        console.warn('[ThumbnailManager] Cropped data invalid, skipping thumb generation')
        return originalFileName
      }

      const croppedBuffer = Buffer.from(croppedMatch[3], 'base64')
      const thumbFileName = ThumbnailManager.toThumbFilename(originalFileName)
      const pathManager = PathManager.getInstance()
      const thumbPath = pathManager.getThumbnailFilePath(thumbFileName)

      // 3. 压缩裁剪后的图片并保存为 _thumb
      await ThumbnailManager.generateCompressedThumbnail(croppedBuffer, thumbPath)
      console.log(`[ThumbnailManager] Saved original: ${originalFileName}, thumb: ${thumbFileName}`)

      return originalFileName
    } catch (error) {
      console.error('[ThumbnailManager] Failed to save original+cropped thumbnail:', error)
      return null
    }
  }

  // ─────────── 原有方法（保持兼容） ───────────

  /**
   * 保存 base64 图片/视频到 vault 的 thumbnails 目录
   * @param base64Data 完整的 base64 字符串（包含 data:image/xxx;base64, 或 data:video/xxx;base64, 前缀）
   * @param assetKey 可选的资产键，用于生成文件名
   * @returns 保存后的文件名（相对路径）
   */
  static async saveVaultThumbnail(base64Data: string, assetKey?: string): Promise<string | null> {
    try {
      const pathManager = PathManager.getInstance()
      const thumbnailsDir = pathManager.getThumbnailsPath()

      // 确保目录存在
      await fs.mkdir(thumbnailsDir, { recursive: true })

      // 解析 base64 数据（支持 image 和 video）
      const matches = base64Data.match(/^data:(image|video)\/([\w+]+);base64,(.+)$/)
      if (!matches) {
        console.error('[ThumbnailManager] Invalid base64 format')
        return null
      }

      const mediaType = matches[1] // image or video
      const mimeSubtype = matches[2] // jpeg, png, mp4, quicktime, etc.
      const data = matches[3]
      const buffer = Buffer.from(data, 'base64')

      // 映射 MIME subtype 到文件扩展名
      const extMap: Record<string, string> = {
        jpeg: 'jpg',
        quicktime: 'mov',
        'x-msvideo': 'avi',
        'x-ms-wmv': 'wmv'
      }
      const ext = extMap[mimeSubtype] || mimeSubtype

      // 生成文件名
      const uniqueId = assetKey || uuidv4()
      const fileName = `custom-${uniqueId}-${Date.now()}.${ext}`
      const filePath = pathManager.getThumbnailFilePath(fileName)

      // 写入文件
      await fs.writeFile(filePath, buffer)

      console.log(`[ThumbnailManager] Saved ${mediaType} thumbnail: ${fileName}`)
      return fileName
    } catch (error) {
      console.error('[ThumbnailManager] Failed to save thumbnail:', error)
      return null
    }
  }

  /**
   * Copy a file (video/gif/image) to vault thumbnails directory.
   * For compressible images, also generates a _thumb compressed version.
   * @param srcPath Source file path
   * @param assetKey Optional asset key for filename generation
   * @returns Saved filename (relative path)
   */
  static async saveVaultThumbnailFromFile(
    srcPath: string,
    assetKey?: string
  ): Promise<string | null> {
    try {
      const pathManager = PathManager.getInstance()
      const thumbnailsDir = pathManager.getThumbnailsPath()

      // Ensure directory exists
      await fs.mkdir(thumbnailsDir, { recursive: true })

      // Generate filename
      const ext = srcPath.split('.').pop()?.toLowerCase() || 'dat'
      const uniqueId = assetKey || uuidv4()
      const fileName = `custom-${uniqueId}-${Date.now()}.${ext}`
      const destPath = pathManager.getThumbnailFilePath(fileName)

      // Copy file
      await fs.copyFile(srcPath, destPath)

      // 对可压缩图片生成 _thumb 版本
      if (ThumbnailManager.isCompressibleImage(fileName)) {
        const thumbFileName = ThumbnailManager.toThumbFilename(fileName)
        await ThumbnailManager.generateThumbForFile(destPath, thumbFileName)
      }

      return fileName
    } catch (error) {
      console.error('[ThumbnailManager] Failed to copy thumbnail file:', error)
      return null
    }
  }

  // ─────────── URL / 文件名解析 ───────────

  /**
   * 从 file:/// URL 中解析文件名
   */
  static extractFilenameFromFileUrl(url?: string | null): string | null {
    if (!url) return null
    try {
      const u = new URL(url)
      const pathname = decodeURI(u.pathname || '')
      if (!pathname) return null
      const parts = pathname.split(/[/\\]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : null
    } catch {
      // 非法URL的兜底处理
      const cleaned = String(url)
        .replace(/^file:\/\//, '')
        .replace(/^\//, '')
      const parts = cleaned.split(/[/\\]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : null
    }
  }

  // ─────────── 删除 ───────────

  /**
   * 删除当前保管库中的缩略图（按文件名）
   * 同时删除对应的 _thumb 压缩版本（如果存在）
   */
  static async deleteVaultThumbnailByFilename(filename?: string | null): Promise<boolean> {
    if (!filename) return true
    const pathManager = PathManager.getInstance()
    const abs = pathManager.getThumbnailFilePath(filename)
    try {
      // 🔍 诊断日志：追踪 custom- 前缀缩略图的删除调用栈
      if (filename.startsWith('custom-')) {
        console.warn(`[ThumbnailManager] ⚠️ 正在删除自定义缩略图: ${filename}`)
        console.warn(`[ThumbnailManager] 删除路径: ${abs}`)
        console.warn(`[ThumbnailManager] 调用栈:`, new Error().stack)
      }
      await fs.unlink(abs)

      // 同时尝试删除 _thumb 版本
      if (!filename.includes('_thumb')) {
        const thumbName = ThumbnailManager.toThumbFilename(filename)
        const thumbAbs = pathManager.getThumbnailFilePath(thumbName)
        try {
          await fs.unlink(thumbAbs)
        } catch {
          /* ignore */
        }
      }

      return true
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return true
      return false
    }
  }
}

export default ThumbnailManager
