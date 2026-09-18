import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'

import { FolderTypeDetector } from '../../../utils/folderTypeDetector'
import { PathManager } from '../../../utils/PathManager'
import { getListThumbnail } from '../../../utils/listThumbnail'

/**
 * 导入过程中的「慢 I/O」—— 缩略图生成与插件元数据读取。
 *
 * 这些函数**必须在数据库事务之外**调用。
 *
 * 它们原本内联在 `db:importFolderStructureWithMetadata` 的逐文件写库事务里
 * （sharp 解码/缩放/编码、fs.copyFile、fs.readFile）。better-sqlite3 是同步 API，
 * 事务里一旦 await，BEGIN 就跨越事件循环挂在共享连接上：一张 4K 贴图的压缩
 * 要几百毫秒，一次两万文件的导入就是两万次「整库写锁被占住」，
 * 期间用户的任何其他操作都会撞 SQLITE_BUSY。
 *
 * 抽出来之后事务体退化成纯 DB 语句，锁持有时间从「N × 几百毫秒」降到
 * 「N × 几十微秒」，而且这些 I/O 现在可以并发跑。
 *
 * 三个函数都只依赖入参（文件路径 / assetKey / 扩展名），不读任何数据库状态，
 * 所以提到事务外是行为等价的。
 */

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'tga',
  'dds',
  'tif',
  'tiff',
  'avif',
  'svg',
  'gif'
])

/**
 * 生成导入资产的缩略图，返回缩略图文件名。
 *
 * 与列表共用串行生成器和缓存。失败不影响资产导入，也不复制高清原图作缩略图。
 */
export async function buildImportThumbnail(
  filePath: string,
  assetKey: string,
  fileExtension: string
): Promise<string | undefined> {
  if (!IMAGE_EXTENSIONS.has(fileExtension.toLowerCase())) return undefined
  try {
    const pm = PathManager.getInstance()
    const fileName = `thumbnail-${assetKey}.webp`
    const targetPath = pm.getThumbnailFilePath(fileName)
    await pm.ensureDirectoryExists(dirname(targetPath))

    const cacheDir = join(app.getPath('userData'), 'list-thumbnails')
    const cached = await getListThumbnail(filePath, cacheDir)
    await fs.copyFile(cached, targetPath)
    // The renderer requests imgLocalPath, so warm that exact source as well.
    await getListThumbnail(targetPath, cacheDir)
    return fileName
  } catch (err) {
    console.warn(
      '[ImportWithMetadata] Thumbnail generation failed; importing without thumbnail:',
      err
    )
    return undefined
  }
}

/**
 * 为 .uplugin 文件复制插件图标作为缩略图，返回缩略图文件名。
 */
export async function copyPluginIconThumbnail(
  filePath: string,
  assetKey: string
): Promise<string | undefined> {
  try {
    const pluginIconPath = await FolderTypeDetector.getPluginIconPath(dirname(filePath))
    if (!pluginIconPath) return undefined

    const pm = PathManager.getInstance()
    await pm.ensureDirectoryExists(pm.getThumbnailsPath())
    const fileName = `thumbnail-${assetKey}.png`
    await fs.copyFile(pluginIconPath, pm.getThumbnailFilePath(fileName))
    console.log(`🖼️ [ImportWithMetadata] 为 .uplugin 文件设置图标: ${fileName}`)
    return fileName
  } catch (err) {
    console.warn('为 .uplugin 文件设置图标失败:', err)
    return undefined
  }
}

export interface UpluginInfo {
  engineVersion?: string
  pluginInfo: string
}

/**
 * 读取 .uplugin 的插件元数据。
 */
export async function readUpluginInfo(
  filePath: string,
  fallbackName: string
): Promise<UpluginInfo | undefined> {
  try {
    // 移除 BOM (Byte Order Mark) —— UE 生成的 uplugin 文件可能包含 BOM。
    // 用码点判断而不是正则里塞一个不可见字符，免得后续编辑时被误删。
    const text = await fs.readFile(filePath, 'utf-8')
    const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    const pluginData = JSON.parse(raw)

    console.log(
      `🔌 [ImportWithMetadata] 插件信息已读取: ${fallbackName} (${pluginData?.VersionName || '未知版本'})`
    )

    return {
      engineVersion: pluginData?.EngineVersion || undefined,
      pluginInfo: JSON.stringify({
        friendlyName: pluginData?.FriendlyName || fallbackName,
        description: pluginData?.Description || '',
        category: pluginData?.Category || '',
        createdBy: pluginData?.CreatedBy || '',
        versionName: pluginData?.VersionName || '',
        version: pluginData?.Version || 1,
        engineVersion: pluginData?.EngineVersion || '',
        isBetaVersion: pluginData?.IsBetaVersion || false,
        isExperimentalVersion: pluginData?.IsExperimentalVersion || false,
        canContainContent: pluginData?.CanContainContent || false,
        modules: pluginData?.Modules || [],
        plugins: pluginData?.Plugins || []
      })
    }
  } catch (pluginErr) {
    console.warn(`⚠️ [ImportWithMetadata] 读取插件元数据失败: ${filePath}`, pluginErr)
    return undefined
  }
}

export interface PluginVersionInfo {
  versionName?: string
  engineVersion?: string
}

export interface FolderTypeInfo {
  type: string
  iconPath?: string
  pluginVersion?: PluginVersionInfo
}

const PREFETCH_CONCURRENCY = 8

/** 有界并发地跑一批任务 */
async function runBounded<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(PREFETCH_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      await task(items[cursor++])
    }
  })
  await Promise.all(workers)
}

/**
 * 批量预取文件夹类型与图标（可选带插件版本）。
 *
 * 原实现在 folderInit 事务里逐个 `await FolderTypeDetector.detectFolderTypeWithIcon()`
 * （stat + readdir，网络库上是网络 I/O）。提到事务外之后顺带把串行改成有界并发。
 *
 * @param isNetworkMode 网络模式原本就跳过检测，这里保持一致
 * @param pluginVersionForPaths 额外需要插件版本的路径。调用方按原有条件传入
 *   （AssetImportService：根目录无条件 + 子目录仅当 type === 'plugin'），
 *   保证行为与内联版本一致，不多做也不少做 I/O。
 */
export async function prefetchFolderTypes(
  paths: readonly string[],
  isNetworkMode: boolean,
  pluginVersionForPaths?: 'root-and-plugins' | 'none',
  rootPath?: string
): Promise<Map<string, FolderTypeInfo>> {
  const result = new Map<string, FolderTypeInfo>()
  if (isNetworkMode) {
    for (const path of paths) result.set(path, { type: 'normal' })
    return result
  }

  await runBounded(paths, async (path) => {
    try {
      const info = await FolderTypeDetector.detectFolderTypeWithIcon(path)
      result.set(path, { type: info.type, iconPath: info.iconPath })
    } catch {
      result.set(path, { type: 'normal' })
    }
  })

  if (pluginVersionForPaths === 'root-and-plugins') {
    // 与内联实现同样的触发条件：根目录无条件取，子目录只有 plugin 类型才取
    const needVersion = paths.filter(
      (path) => path === rootPath || result.get(path)?.type === 'plugin'
    )
    await runBounded(needVersion, async (path) => {
      try {
        const version = await FolderTypeDetector.getPluginVersion(path)
        if (version) {
          const existing = result.get(path) ?? { type: 'normal' }
          result.set(path, { ...existing, pluginVersion: version })
        }
      } catch {
        // 取不到版本不影响导入，与原实现一致
      }
    })
  }

  return result
}
