/**
 * 缓存清理服务
 * 清理保管库中未使用的缩略图/视频文件
 */
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import type Database from 'better-sqlite3'

/**
 * 清理结果
 */
export interface CleanupResult {
  success: boolean
  deletedCount: number
  freedBytes: number
  totalScanned: number
  error?: string
}

/**
 * 未使用的缩略图信息
 */
export interface UnusedThumbnail {
  filename: string
  path: string
  size: number
  modifiedTime: Date
}

/**
 * 检查网络路径是否有写入权限
 */
export async function checkWritePermission(path: string): Promise<boolean> {
  try {
    if (!existsSync(path)) {
      return false
    }
    // 尝试创建测试文件
    const testFile = join(path, `.write_test_${Date.now()}`)
    await fs.writeFile(testFile, 'test')
    await fs.unlink(testFile)
    return true
  } catch {
    return false
  }
}

/**
 * 原图文件名 → 压缩缩略图文件名
 * `custom-xxx-123.png` → `custom-xxx-123_thumb.jpg`
 */
function toThumbFilename(filename: string): string {
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx <= 0) return filename + '_thumb.jpg'
  return filename.substring(0, dotIdx) + '_thumb.jpg'
}

/**
 * 将一个文件名及其 _thumb 压缩变体都加入 Set
 */
function addWithThumbVariant(set: Set<string>, filename: string): void {
  set.add(filename)
  // 同时保护 _thumb.jpg 压缩版本
  const thumbName = toThumbFilename(filename)
  if (thumbName !== filename) {
    set.add(thumbName)
  }
}

/**
 * 获取数据库中所有正在使用的缩略图文件名
 *
 * 🔧 修复：
 * 1. 同时查询 customPoster 字段（用户自定义封面图，可能与 imgLocalPath 不同）
 * 2. 同时保护 _thumb.jpg 压缩版本（ThumbnailManager 会生成压缩缩略图）
 * 3. 包含已软删除资产的缩略图（防止永久丢失，软删除资产可恢复）
 */
export function getUsedThumbnailFilenames(vaultDb: Database.Database): Set<string> {
  const usedFilenames = new Set<string>()

  // 1. 获取资产的缩略图 (imgLocalPath + customPoster)
  // 🔧 修复：不再限制 isDelete = 0，软删除的资产缩略图也需要保留
  //    否则用户软删除资产后点清除缓存，缩略图就永久丢失无法恢复了
  const assetRows = vaultDb
    .prepare(
      `SELECT imgLocalPath, customPoster FROM assetData
       WHERE (imgLocalPath IS NOT NULL AND imgLocalPath != '')
          OR (customPoster IS NOT NULL AND customPoster != '')`
    )
    .all() as { imgLocalPath: string | null; customPoster: string | null }[]

  for (const row of assetRows) {
    // imgLocalPath
    if (row.imgLocalPath) {
      const filename = basename(row.imgLocalPath)
      if (filename) {
        addWithThumbVariant(usedFilenames, filename)
      }
    }
    // 🔧 修复：customPoster 可能存储了与 imgLocalPath 不同的自定义封面文件
    if (row.customPoster) {
      const filename = basename(row.customPoster)
      if (filename && !filename.startsWith('http') && !filename.startsWith('file:')) {
        addWithThumbVariant(usedFilenames, filename)
      }
    }
  }

  // 2. 获取文件夹封面图 (img) — 同样包含已软删除文件夹
  const folderRows = vaultDb
    .prepare(`SELECT img FROM assetFolder WHERE img IS NOT NULL AND img != ''`)
    .all() as { img: string }[]

  for (const row of folderRows) {
    if (row.img) {
      const filename = basename(row.img)
      if (filename) {
        addWithThumbVariant(usedFilenames, filename)
      }
    }
  }

  return usedFilenames
}

/**
 * 扫描缩略图目录中的所有文件
 */
export async function scanThumbnailDirectory(
  thumbnailsDir: string
): Promise<{ filename: string; path: string; size: number; modifiedTime: Date }[]> {
  const files: { filename: string; path: string; size: number; modifiedTime: Date }[] = []

  if (!existsSync(thumbnailsDir)) {
    return files
  }

  try {
    const entries = await fs.readdir(thumbnailsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = join(thumbnailsDir, entry.name)
        try {
          const stats = await fs.stat(filePath)
          files.push({
            filename: entry.name,
            path: filePath,
            size: stats.size,
            modifiedTime: stats.mtime
          })
        } catch {
          // 忽略无法访问的文件
        }
      }
    }
  } catch (error) {
    console.error('[CacheCleanupService] 扫描缩略图目录失败:', error)
  }

  return files
}

/**
 * 获取未使用的缩略图列表
 */
export async function getUnusedThumbnails(
  vaultDb: Database.Database,
  thumbnailsDir: string
): Promise<UnusedThumbnail[]> {
  const usedFilenames = getUsedThumbnailFilenames(vaultDb)
  const allFiles = await scanThumbnailDirectory(thumbnailsDir)

  // 过滤出未使用的文件
  return allFiles.filter((file) => !usedFilenames.has(file.filename))
}

/**
 * 清理未使用的缩略图
 */
export async function cleanThumbnailCache(
  vaultDb: Database.Database,
  thumbnailsDir: string,
  checkPermission = true
): Promise<CleanupResult> {
  // 权限检查
  if (checkPermission) {
    const hasPermission = await checkWritePermission(thumbnailsDir)
    if (!hasPermission) {
      return {
        success: false,
        deletedCount: 0,
        freedBytes: 0,
        totalScanned: 0,
        error: 'NO_WRITE_PERMISSION'
      }
    }
  }

  try {
    const unusedFiles = await getUnusedThumbnails(vaultDb, thumbnailsDir)
    const allFiles = await scanThumbnailDirectory(thumbnailsDir)

    // 🔍 诊断日志：检查是否有 custom- 前缀的缩略图被误判为未使用
    const customUnused = unusedFiles.filter((f) => f.filename.startsWith('custom-'))
    if (customUnused.length > 0) {
      const usedFilenames = getUsedThumbnailFilenames(vaultDb)
      console.warn(
        `[CacheCleanupService] ⚠️ 发现 ${customUnused.length} 个 custom- 前缀缩略图被判定为未使用！`
      )
      console.warn(
        `[CacheCleanupService] 数据库中在用缩略图数: ${usedFilenames.size}, 磁盘总缩略图数: ${allFiles.length}`
      )
      for (const f of customUnused.slice(0, 10)) {
        console.warn(`[CacheCleanupService]   - 将删除: ${f.filename}`)
      }
      console.warn(`[CacheCleanupService] 调用栈:`, new Error().stack)
    }

    let deletedCount = 0
    let freedBytes = 0

    // 并行批量删除（每批500个文件，提高吞吐量）
    const BATCH_SIZE = 500
    const LOG_INTERVAL = 1000 // 每1000个文件输出一次日志
    for (let i = 0; i < unusedFiles.length; i += BATCH_SIZE) {
      const batch = unusedFiles.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map(async (file) => {
          await fs.unlink(file.path)
          return file.size
        })
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          deletedCount++
          freedBytes += result.value
        }
      }

      // 每1000个文件或最后一批输出进度
      const processed = Math.min(i + BATCH_SIZE, unusedFiles.length)
      if (processed % LOG_INTERVAL < BATCH_SIZE || processed === unusedFiles.length) {
        console.log(`[CacheCleanupService] 清理进度: ${processed}/${unusedFiles.length}`)
      }
    }

    console.log(
      `[CacheCleanupService] 清理完成: 删除 ${deletedCount} 个文件, 释放 ${(freedBytes / 1024 / 1024).toFixed(2)} MB`
    )

    return {
      success: true,
      deletedCount,
      freedBytes,
      totalScanned: allFiles.length
    }
  } catch (error) {
    console.error('[CacheCleanupService] 清理缓存失败:', error)
    return {
      success: false,
      deletedCount: 0,
      freedBytes: 0,
      totalScanned: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
