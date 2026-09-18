import { join, resolve } from 'path'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { app } from 'electron'
import { VaultManager } from '../sqliteDataBase/VaultManager'

/**
 * 磁盘空间信息
 */
export interface DiskSpaceInfo {
  totalSpace: number
  freeSpace: number
  usedSpace: number
}

/**
 * 路径验证结果
 */
export interface PathValidationResult {
  valid: boolean
  error?: string
  warnings?: string[]
  diskInfo?: DiskSpaceInfo
}

/**
 * 路径管理器
 * 负责管理多保管库环境下的动态路径处理
 */
export class PathManager {
  private static instance: PathManager | null = null
  private vaultManager!: VaultManager

  private constructor() {
    // 延迟初始化，避免循环依赖
  }

  /**
   * 获取单例实例
   */
  static getInstance(): PathManager {
    if (!PathManager.instance) {
      PathManager.instance = new PathManager()
    }
    return PathManager.instance
  }

  /**
   * 初始化路径管理器
   */
  initialize(vaultManager: VaultManager): void {
    this.vaultManager = vaultManager
  }

  /**
   * 获取当前保管库路径
   */
  getCurrentVaultPath(): string {
    const currentVault = this.vaultManager?.getCurrentVault()
    if (!currentVault) {
      throw new Error('未选择保管库')
    }
    return currentVault.path
  }

  /**
   * 获取缩略图目录路径
   * SMB 网络库返回 networkPath/.thumbnails，远程服务器模式和本地库返回 path/thumbnails
   */
  getThumbnailsPath(): string {
    const currentVault = this.vaultManager?.getCurrentVault()
    // SMB 网络库使用 networkPath/.thumbnails 目录（仅限 \\ 开头的 SMB 共享路径）
    if (
      currentVault?.vaultType === 'network' &&
      currentVault.networkPath &&
      !currentVault.networkPath.startsWith('http')
    ) {
      return join(currentVault.networkPath, '.thumbnails')
    }
    // 本地库和远程服务器模式（http:// 路径）使用本地 path/thumbnails 目录
    return join(this.getCurrentVaultPath(), 'thumbnails')
  }

  /**
   * 获取公共数据库所在目录（与 app-data.db 同级的 database 目录）
   */
  getPublicDatabaseDir(): string {
    const userDataPath = app.getPath('userData')
    return join(userDataPath, 'database')
  }

  /**
   * 获取公共缩略图目录路径（与 app-data.db 同级）
   */
  getPublicThumbnailsPath(): string {
    return join(this.getPublicDatabaseDir(), 'thumbnails')
  }

  /**
   * 获取公共缩略图文件的绝对路径
   */
  getPublicThumbnailFilePath(filename: string): string {
    return join(this.getPublicThumbnailsPath(), filename)
  }

  /**
   * 构造公共缩略图的 file:/// URL
   */
  getPublicThumbnailFileUrl(filename: string): string {
    const abs = this.getPublicThumbnailFilePath(filename).replace(/\\/g, '/')
    return `file:///${encodeURI(abs)}`
  }

  /**
   * 获取资产数据目录路径
   */
  getAssetDataPath(): string {
    return join(this.getCurrentVaultPath(), 'assetData')
  }

  /**
   * 获取特定缩略图文件路径
   */
  getThumbnailFilePath(filename: string): string {
    return join(this.getThumbnailsPath(), filename)
  }

  /**
   * 获取特定资产备份路径
   */
  getAssetBackupPath(relativePath: string): string {
    return join(this.getAssetDataPath(), relativePath)
  }

  /**
   * 获取保管库数据库文件路径
   */
  getVaultDatabasePath(): string {
    return join(this.getCurrentVaultPath(), 'vault-data.db')
  }

  /**
   * 验证路径有效性
   */
  async validatePath(path: string): Promise<PathValidationResult> {
    try {
      const resolvedPath = resolve(path)
      const result: PathValidationResult = {
        valid: true,
        warnings: []
      }

      // 检查路径是否存在
      if (!existsSync(resolvedPath)) {
        return {
          valid: false,
          error: '指定的路径不存在'
        }
      }

      // 检查是否为目录
      const stats = await fs.stat(resolvedPath)
      if (!stats.isDirectory()) {
        return {
          valid: false,
          error: '指定的路径不是一个目录'
        }
      }

      // 检查权限
      const hasPermission = await this.checkPathPermissions(resolvedPath)
      if (!hasPermission) {
        return {
          valid: false,
          error: '没有足够的读写权限'
        }
      }

      // 检查磁盘空间
      try {
        const diskInfo = await this.checkDiskSpace(resolvedPath)
        result.diskInfo = diskInfo

        // 如果可用空间小于1GB，给出警告
        if (diskInfo.freeSpace < 1024 * 1024 * 1024) {
          result.warnings?.push('可用磁盘空间不足1GB，可能影响保管库使用')
        }
      } catch (error) {
        result.warnings?.push('无法获取磁盘空间信息')
      }

      return result
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 检查路径权限
   */
  async checkPathPermissions(path: string): Promise<boolean> {
    try {
      // 检查读权限
      await fs.access(path, fs.constants.R_OK)

      // 检查写权限
      await fs.access(path, fs.constants.W_OK)

      // 尝试创建测试文件
      const testFile = join(path, '.permission_test')
      await fs.writeFile(testFile, 'test')
      await fs.unlink(testFile)

      return true
    } catch {
      return false
    }
  }

  /**
   * 检查磁盘空间
   */
  async checkDiskSpace(path: string): Promise<DiskSpaceInfo> {
    try {
      void path
      // 在 Node.js 中获取磁盘空间信息需要使用系统命令或第三方库
      // 这里提供一个基础实现，实际项目中可能需要使用 statvfs 或其他方法

      // 简化实现：返回模拟数据
      // 实际实现中应该调用系统API获取真实的磁盘空间信息
      return {
        totalSpace: 1024 * 1024 * 1024 * 100, // 100GB
        freeSpace: 1024 * 1024 * 1024 * 50, // 50GB
        usedSpace: 1024 * 1024 * 1024 * 50 // 50GB
      }
    } catch (error) {
      throw new Error(
        `无法获取磁盘空间信息: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * 确保目录存在
   */
  async ensureDirectoryExists(path: string): Promise<void> {
    if (!existsSync(path)) {
      await fs.mkdir(path, { recursive: true })
    }
  }

  /**
   * 获取相对于保管库的相对路径
   */
  getRelativeToVault(absolutePath: string): string {
    const vaultPath = this.getCurrentVaultPath()
    const resolvedAbsolute = resolve(absolutePath)
    const resolvedVault = resolve(vaultPath)

    if (resolvedAbsolute.startsWith(resolvedVault)) {
      return resolvedAbsolute.substring(resolvedVault.length + 1)
    }

    return absolutePath
  }

  /**
   * 将相对路径转换为绝对路径
   */
  getAbsoluteFromVault(relativePath: string): string {
    return join(this.getCurrentVaultPath(), relativePath)
  }

  /**
   * 规范化路径
   */
  normalizePath(path: string): string {
    return resolve(path).replace(/\\/g, '/')
  }

  /**
   * 检查路径是否在当前保管库内
   */
  isPathInCurrentVault(path: string): boolean {
    const vaultPath = this.getCurrentVaultPath()
    const resolvedPath = resolve(path)
    const resolvedVaultPath = resolve(vaultPath)

    return resolvedPath.startsWith(resolvedVaultPath)
  }

  /**
   * 获取安全的文件名（移除非法字符）
   */
  getSafeFileName(fileName: string): string {
    return fileName.replace(/[<>:"/\\|?*]/g, '_')
  }

  /**
   * 生成唯一的文件路径
   */
  generateUniqueFilePath(basePath: string, fileName: string): string {
    const safeName = this.getSafeFileName(fileName)
    let filePath = join(basePath, safeName)
    let counter = 1

    while (existsSync(filePath)) {
      const nameWithoutExt = safeName.replace(/\.[^/.]+$/, '')
      const ext = safeName.match(/\.[^/.]+$/)?.[0] || ''
      filePath = join(basePath, `${nameWithoutExt}_${counter}${ext}`)
      counter++
    }

    return filePath
  }

  /**
   * 清理过期的临时文件
   */
  async cleanupTempFiles(): Promise<void> {
    try {
      const vaultPath = this.getCurrentVaultPath()
      const tempPath = join(vaultPath, 'temp')

      if (existsSync(tempPath)) {
        const files = await fs.readdir(tempPath)
        const now = Date.now()
        const maxAge = 24 * 60 * 60 * 1000 // 24小时

        for (const file of files) {
          const filePath = join(tempPath, file)
          const stats = await fs.stat(filePath)

          if (now - stats.mtime.getTime() > maxAge) {
            await fs.unlink(filePath)
            console.log(`[PathManager] 清理过期临时文件: ${file}`)
          }
        }
      }
    } catch (error) {
      console.warn('[PathManager] 清理临时文件失败:', error)
    }
  }
}
