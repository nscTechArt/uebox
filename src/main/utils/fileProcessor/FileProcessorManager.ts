import { BaseFileProcessor, FileMetadata } from './BaseFileProcessor'
import { UnrealAssetProcessor } from './UnrealAssetProcessor'

/**
 * 文件处理器管理器
 * 负责根据文件类型选择合适的处理器
 */
export class FileProcessorManager {
  private processors: BaseFileProcessor[] = []

  constructor() {
    this.initializeProcessors()
  }

  /**
   * 初始化所有处理器
   */
  private initializeProcessors(): void {
    // 注册虚幻引擎资产处理器
    this.processors.push(new UnrealAssetProcessor())

    // 未来可以在这里添加其他处理器
    // this.processors.push(new BlenderAssetProcessor())
    // this.processors.push(new MayaAssetProcessor())
    // this.processors.push(new GenericFileProcessor())
  }

  /**
   * 根据文件路径选择合适的处理器
   */
  private selectProcessor(filePath: string): BaseFileProcessor | null {
    for (const processor of this.processors) {
      if (processor.canProcess(filePath)) {
        return processor
      }
    }
    return null
  }

  /**
   * 处理单个文件
   */
  async processFile(filePath: string): Promise<FileMetadata | null> {
    const processor = this.selectProcessor(filePath)

    if (!processor) {
      console.warn(`没有找到适合处理文件的处理器: ${filePath}`)
      return null
    }

    try {
      return await processor.processFile(filePath)
    } catch (error) {
      console.error(`处理文件失败 ${filePath}:`, error)
      throw error
    }
  }

  /**
   * 批量处理文件
   */
  async processFiles(filePaths: string[]): Promise<FileMetadata[]> {
    const results: FileMetadata[] = []

    for (const filePath of filePaths) {
      try {
        const metadata = await this.processFile(filePath)
        if (metadata) {
          results.push(metadata)
        }
      } catch (error) {
        console.error(`批量处理文件失败 ${filePath}:`, error)
        // 继续处理其他文件，不中断整个批处理过程
      }
    }

    return results
  }

  /**
   * 检查文件是否支持处理
   */
  isFileSupported(filePath: string): boolean {
    return this.selectProcessor(filePath) !== null
  }

  /**
   * 获取所有支持的文件扩展名
   */
  getSupportedExtensions(): string[] {
    const extensions = new Set<string>()

    for (const processor of this.processors) {
      processor.getSupportedExtensions().forEach((ext) => extensions.add(ext))
    }

    return Array.from(extensions)
  }

  /**
   * 获取处理器统计信息
   */
  getProcessorStats(): { name: string; supportedExtensions: string[] }[] {
    return this.processors.map((processor) => ({
      name: processor.constructor.name,
      supportedExtensions: processor.getSupportedExtensions()
    }))
  }
}
