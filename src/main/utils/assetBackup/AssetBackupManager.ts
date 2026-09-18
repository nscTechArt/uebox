import { promises as fs, createReadStream } from 'fs'
import { pipeline } from 'stream/promises'
import { join, basename, resolve, relative, isAbsolute, sep } from 'path'
import { existsSync } from 'fs'
import { PathManager } from '../PathManager'

/**
 * 资产备份管理器
 * 负责管理资产的备份保管功能
 */
export class AssetBackupManager {
  private pathManager: PathManager

  constructor() {
    this.pathManager = PathManager.getInstance()
    // console.log('🔧 [AssetBackupManager] 初始化备份管理器')
  }

  /**
   * 确保备份根目录存在
   */
  private async ensureBackupDirectory(): Promise<void> {
    const assetDataPath = this.pathManager.getAssetDataPath()
    // console.log('📁 [AssetBackupManager] 获取资产数据路径:', assetDataPath)

    try {
      if (!existsSync(assetDataPath)) {
        await fs.mkdir(assetDataPath, { recursive: true })
        // console.log('✅ [AssetBackupManager] 创建资产备份目录:', assetDataPath)
      } else {
        // console.log('✅ [AssetBackupManager] 资产备份目录已存在:', assetDataPath)
      }
    } catch (error) {
      console.error('❌ [AssetBackupManager] 创建备份目录失败:', error)
      throw new Error(`创建备份目录失败: ${(error as Error).message}`)
    }
  }

  /**
   * 创建时间戳文件夹
   * 用于区分不同版本的资产导入
   */
  async createTimestampFolder(): Promise<string> {
    // console.log('⏰ [AssetBackupManager] 开始创建时间戳文件夹')
    await this.ensureBackupDirectory()

    const timestamp = Date.now().toString()
    const timestampFolderPath = join(this.pathManager.getAssetDataPath(), timestamp)
    // console.log('📂 [AssetBackupManager] 时间戳文件夹路径:', timestampFolderPath)

    try {
      return await fs.mkdtemp(`${timestampFolderPath}-`)
      // console.log('✅ [AssetBackupManager] 创建时间戳文件夹成功:', timestampFolderPath)
    } catch (error) {
      console.error('❌ [AssetBackupManager] 创建时间戳文件夹失败:', error)
      throw new Error(`创建时间戳文件夹失败: ${(error as Error).message}`)
    }
  }

  /**
   * 解析软路径，提取路径层级信息
   * @param softPath 虚幻引擎软路径，如 "/Game/Characters/Hero"
   *                 或 Windows 绝对路径，如 "I:\xxx\img\file.png"
   * @returns 路径层级数组，如 ["Game", "Characters", "Hero"]
   *          或对于 Windows 路径返回 ["img", "file.png"]（父目录名 + 文件名）
   */
  parseSoftPath(softPath: string): string[] {
    if (!softPath) {
      return []
    }

    const normalized = softPath.replace(/\\/g, '/')
    if (
      normalized
        .split('/')
        .some(
          (segment) =>
            segment === '..' || segment === '.' || (segment.length > 0 && /[. ]$/.test(segment))
        )
    ) {
      throw new Error('备份路径不能包含父目录或当前目录片段')
    }
    // 🔧 检测并处理 Windows 绝对路径（如 I:\xxx 或 C:\xxx）
    // 提取父目录名作为目标目录，保持一定的组织结构
    const windowsAbsolutePathPattern = /^[A-Za-z]:\//
    if (windowsAbsolutePathPattern.test(normalized)) {
      // 标准化路径分隔符并拆分
      const segments = softPath
        .replace(/\\/g, '/')
        .split('/')
        .filter((s) => s.length > 0)
        .slice(1)
      if (segments.length >= 2) {
        // 返回最后两段：父目录名 + 文件名
        // 例如 I:/xxx/img/file.png -> ["img", "file.png"]
        const parentDir = segments[segments.length - 2]
        const fileName = segments[segments.length - 1]
        return [parentDir, fileName]
      } else if (segments.length === 1) {
        // 只有文件名，返回文件名
        return [segments[0]]
      }
      return []
    }

    // 移除开头的斜杠并分割路径
    const cleanPath = normalized.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!cleanPath) {
      return []
    }

    const segments = cleanPath.split('/').filter((segment) => segment.length > 0)
    if (
      segments.some(
        (segment) =>
          /[:<>"|?*]/.test(segment) || [...segment].some((char) => char.charCodeAt(0) < 32)
      )
    ) {
      throw new Error('备份路径包含非法字符')
    }
    return segments
  }

  getTargetRelativePath(sourcePath: string, softPath: string): string {
    return join(...this.parseSoftPath(softPath).slice(0, -1), basename(sourcePath))
  }

  /**
   * 根据软路径创建文件夹层级结构
   * @param timestampFolderPath 时间戳文件夹路径
   * @param softPath 软路径
   * @returns 创建的完整目录路径
   */
  async createDirectoryStructure(timestampFolderPath: string, softPath: string): Promise<string> {
    const pathSegments = this.parseSoftPath(softPath)

    if (pathSegments.length === 0) {
      // 如果没有软路径，直接返回时间戳文件夹
    }

    // 构建完整的目录路径（不包含文件名）
    const directoryPath = join(timestampFolderPath, ...pathSegments.slice(0, -1))
    const inside = relative(resolve(timestampFolderPath), resolve(directoryPath))
    if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
      throw new Error('备份目标超出归档目录')
    }

    try {
      // Never follow a junction or symlink introduced into the archive tree.
      let cursor = resolve(timestampFolderPath)
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('备份目录不能是链接')
      for (const segment of pathSegments.slice(0, -1)) {
        cursor = join(cursor, segment)
        await fs.mkdir(cursor).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
        const stat = await fs.lstat(cursor)
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw new Error('备份目录不能是链接或文件')
      }
      //  // console.log('创建目录结构:', directoryPath)
      return directoryPath
    } catch (error) {
      console.error('创建目录结构失败:', error)
      throw new Error(`创建目录结构失败: ${(error as Error).message}`)
    }
  }

  /**
   * 复制资产文件到备份目录
   * @param sourcePath 源文件路径
   * @param timestampFolderPath 时间戳文件夹路径
   * @param softPath 软路径
   * @returns 备份文件的完整路径
   */
  async backupAssetFile(
    sourcePath: string,
    timestampFolderPath: string,
    softPath: string
  ): Promise<string> {
    // console.log('📋 [AssetBackupManager] 开始备份资产文件')
    // console.log('📋 [AssetBackupManager] 源文件路径:', sourcePath)
    // console.log('📋 [AssetBackupManager] 时间戳文件夹:', timestampFolderPath)
    // console.log('📋 [AssetBackupManager] 软路径:', softPath)

    // 创建目录结构
    const targetDirectory = await this.createDirectoryStructure(timestampFolderPath, softPath)
    // console.log('📋 [AssetBackupManager] 目标目录:', targetDirectory)

    // 构建目标文件路径
    const fileName = basename(sourcePath)
    const targetFilePath = join(targetDirectory, fileName)
    // console.log('📋 [AssetBackupManager] 目标文件路径:', targetFilePath)

    try {
      // 检查源文件是否存在
      if (!existsSync(sourcePath)) {
        console.error('❌ [AssetBackupManager] 源文件不存在:', sourcePath)
        throw new Error(`源文件不存在: ${sourcePath}`)
      }

      // 复制文件
      const handle = await fs.open(targetFilePath, 'wx')
      try {
        await pipeline(createReadStream(sourcePath), handle.createWriteStream())
      } catch (error) {
        await handle.close().catch(() => undefined)
        await fs.unlink(targetFilePath)
        throw error
      }
      // console.log('✅ [AssetBackupManager] 文件复制成功:', targetFilePath)
      return targetFilePath
    } catch (error) {
      console.error('❌ [AssetBackupManager] 复制文件失败:', error)
      throw new Error(`复制文件失败: ${(error as Error).message}`)
    }
  }

  /**
   * 获取资产备份的相对路径
   * 用于存储到数据库中
   * @param backupFilePath 备份文件的完整路径
   * @returns 相对于当前保管库的路径
   */
  getRelativeBackupPath(backupFilePath: string): string {
    const vaultPath = this.pathManager.getCurrentVaultPath()
    const path = relative(vaultPath, backupFilePath)
    if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) {
      throw new Error('备份文件不在保管库内')
    }
    return path
  }

  /**
   * 批量备份资产文件
   */
  async batchBackupAssets(
    assets: Array<{ sourcePath: string; softPath: string; assetKey: string }>,
    timestampFolderPath: string,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<Array<{ assetKey: string; backupPath: string; relativePath: string }>> {
    // console.log('🔄 [AssetBackupManager] 开始批量备份资产')
    // console.log('🔄 [AssetBackupManager] 资产数量:', assets.length)
    // console.log('🔄 [AssetBackupManager] 时间戳文件夹:', timestampFolderPath)

    const results: Array<{ assetKey: string; backupPath: string; relativePath: string }> = []
    let processedCount = 0

    for (const asset of assets) {
      signal?.throwIfAborted()
      try {
        // console.log('📦 [AssetBackupManager] 备份资产:', asset.assetKey)
        const backupPath = await this.backupAssetFile(
          asset.sourcePath,
          timestampFolderPath,
          asset.softPath
        )
        const relativePath = this.getRelativeBackupPath(backupPath)

        results.push({
          assetKey: asset.assetKey,
          backupPath,
          relativePath
        })
        // console.log('✅ [AssetBackupManager] 资产备份成功:', asset.assetKey)
      } catch (error) {
        console.error('❌ [AssetBackupManager] 资产备份失败:', asset.assetKey, error)
        // 继续处理其他资产，不中断整个流程
      } finally {
        processedCount++
        if (onProgress) {
          onProgress(processedCount, assets.length)
        }
      }
    }

    console.log(
      '🎉 [AssetBackupManager] 批量备份完成，成功:',
      results.length,
      '失败:',
      assets.length - results.length
    )
    return results
  }
}
