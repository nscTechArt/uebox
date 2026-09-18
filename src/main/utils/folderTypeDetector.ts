import { promises as fs } from 'fs'
import { readUeTextFile } from './ueTextFile'

/**
 * 文件夹类型枚举
 */
export enum FolderType {
  NORMAL = 'normal',
  PLUGIN = 'plugin',
  PROJECT = 'project'
}

/**
 * 文件夹类型检测器
 * 用于检测文件夹是否为虚幻引擎插件或项目文件夹
 */
export class FolderTypeDetector {
  /**
   * 检测文件夹类型
   * @param folderPath 文件夹路径
   * @returns 文件夹类型
   */
  static async detectFolderType(folderPath: string): Promise<FolderType> {
    try {
      // 检查文件夹是否存在
      const stats = await fs.stat(folderPath)
      if (!stats.isDirectory()) {
        return FolderType.NORMAL
      }

      // 读取文件夹内容
      const files = await fs.readdir(folderPath)

      // 检查是否包含 .uproject 文件
      const hasUprojectFile = files.some((file) => file.toLowerCase().endsWith('.uproject'))
      if (hasUprojectFile) {
        return FolderType.PROJECT
      }

      // 检查是否包含 .uplugin 文件
      const hasUpluginFile = files.some((file) => file.toLowerCase().endsWith('.uplugin'))
      if (hasUpluginFile) {
        return FolderType.PLUGIN
      }

      return FolderType.NORMAL
    } catch (error) {
      console.error('检测文件夹类型失败:', error)
      return FolderType.NORMAL
    }
  }

  /**
   * 检测文件夹类型及图标
   * 对于插件文件夹，会尝试获取 Resources/Icon128.png 作为图标
   * @param folderPath 文件夹路径
   * @returns 文件夹类型和图标路径（如果是插件且有图标）
   */
  static async detectFolderTypeWithIcon(
    folderPath: string
  ): Promise<{ type: FolderType; iconPath?: string }> {
    try {
      // 检查文件夹是否存在
      const stats = await fs.stat(folderPath)
      if (!stats.isDirectory()) {
        return { type: FolderType.NORMAL }
      }

      // 读取文件夹内容
      const files = await fs.readdir(folderPath)

      // 检查是否包含 .uproject 文件
      const hasUprojectFile = files.some((file) => file.toLowerCase().endsWith('.uproject'))
      if (hasUprojectFile) {
        return { type: FolderType.PROJECT }
      }

      // 检查是否包含 .uplugin 文件
      const hasUpluginFile = files.some((file) => file.toLowerCase().endsWith('.uplugin'))
      if (hasUpluginFile) {
        // 尝试获取插件图标 Resources/Icon128.png
        const iconPath = await this.getPluginIconPath(folderPath)
        return { type: FolderType.PLUGIN, iconPath }
      }

      return { type: FolderType.NORMAL }
    } catch (error) {
      console.error('检测文件夹类型失败:', error)
      return { type: FolderType.NORMAL }
    }
  }

  /**
   * 获取插件图标路径
   * @param pluginFolderPath 插件文件夹路径
   * @returns 图标文件路径，如果不存在则返回 undefined
   */
  static async getPluginIconPath(pluginFolderPath: string): Promise<string | undefined> {
    // 动态导入 path 模块
    const { join } = await import('path')

    // 常见的插件图标位置
    const iconCandidates = [
      'Resources/Icon128.png',
      'Resources/Icon128.jpg',
      'Resources/Icon64.png',
      'Resources/Icon.png'
    ]

    for (const candidate of iconCandidates) {
      // 使用 path.join 正确处理跨平台路径
      const iconPath = join(pluginFolderPath, ...candidate.split('/'))
      try {
        await fs.access(iconPath)
        console.log(`🖼️ [FolderTypeDetector] 找到插件图标: ${iconPath}`)
        return iconPath
      } catch {
        // 文件不存在，继续尝试下一个
      }
    }

    console.log(`⚠️ [FolderTypeDetector] 未找到插件图标: ${pluginFolderPath}`)
    return undefined
  }

  /**
   * 批量检测文件夹类型
   * @param folderPaths 文件夹路径数组
   * @returns 文件夹类型映射
   */
  static async detectMultipleFolderTypes(folderPaths: string[]): Promise<Map<string, FolderType>> {
    const typeMap = new Map<string, FolderType>()

    const promises = folderPaths.map(async (folderPath) => {
      const type = await this.detectFolderType(folderPath)
      typeMap.set(folderPath, type)
    })

    await Promise.all(promises)
    return typeMap
  }

  /**
   * 检测文件夹内容中的特殊文件
   * @param folderPath 文件夹路径
   * @returns 特殊文件信息
   */
  static async getSpecialFiles(folderPath: string): Promise<{
    uprojectFiles: string[]
    upluginFiles: string[]
  }> {
    try {
      const files = await fs.readdir(folderPath)

      const uprojectFiles = files.filter((file) => file.toLowerCase().endsWith('.uproject'))
      const upluginFiles = files.filter((file) => file.toLowerCase().endsWith('.uplugin'))

      return {
        uprojectFiles,
        upluginFiles
      }
    } catch (error) {
      console.error('获取特殊文件失败:', error)
      return {
        uprojectFiles: [],
        upluginFiles: []
      }
    }
  }

  /**
   * 验证项目文件夹结构
   * @param folderPath 文件夹路径
   * @returns 是否为有效的项目文件夹
   */
  static async validateProjectFolder(folderPath: string): Promise<boolean> {
    try {
      const specialFiles = await this.getSpecialFiles(folderPath)

      // 项目文件夹应该只有一个 .uproject 文件
      if (specialFiles.uprojectFiles.length !== 1) {
        return false
      }

      // 检查是否存在常见的项目文件夹结构
      const files = await fs.readdir(folderPath)
      const commonFolders = ['Content', 'Source', 'Config']
      const hasCommonFolders = commonFolders.some((folder) => files.includes(folder))

      return hasCommonFolders
    } catch (error) {
      console.error('验证项目文件夹失败:', error)
      return false
    }
  }

  /**
   * 获取插件版本信息
   * @param pluginFolderPath 插件文件夹路径
   * @returns 插件版本信息，如果无法读取则返回 undefined
   */
  static async getPluginVersion(
    pluginFolderPath: string
  ): Promise<{ versionName?: string; engineVersion?: string } | undefined> {
    try {
      const { join } = await import('path')

      // 读取文件夹内容，查找 .uplugin 文件
      const files = await fs.readdir(pluginFolderPath)
      const upluginFile = files.find((file) => file.toLowerCase().endsWith('.uplugin'))

      if (!upluginFile) {
        return undefined
      }

      // 读取并解析 .uplugin 文件
      const upluginPath = join(pluginFolderPath, upluginFile)
      // 引擎可能把描述文件存成 UTF-16，解码和剥 BOM 都在 readUeTextFile 里
      const content = await readUeTextFile(upluginPath)

      // 移除可能的 BOM 和空白字符
      const cleanContent = content.replace(/^\uFEFF/, '').trim()
      const pluginInfo = JSON.parse(cleanContent)

      return {
        versionName: pluginInfo?.VersionName || pluginInfo?.Version?.toString() || undefined,
        engineVersion: pluginInfo?.EngineVersion || undefined
      }
    } catch (error) {
      console.warn('获取插件版本失败:', error)
      return undefined
    }
  }

  /**
   * 验证插件文件夹结构
   * @param folderPath 文件夹路径
   * @returns 是否为有效的插件文件夹
   */
  static async validatePluginFolder(folderPath: string): Promise<boolean> {
    try {
      const specialFiles = await this.getSpecialFiles(folderPath)

      // 插件文件夹应该只有一个 .uplugin 文件
      if (specialFiles.upluginFiles.length !== 1) {
        return false
      }

      // 检查是否存在常见的插件文件夹结构
      const files = await fs.readdir(folderPath)
      const commonFolders = ['Source', 'Content', 'Resources']
      const hasCommonFolders = commonFolders.some((folder) => files.includes(folder))

      return hasCommonFolders
    } catch (error) {
      console.error('验证插件文件夹失败:', error)
      return false
    }
  }
}
