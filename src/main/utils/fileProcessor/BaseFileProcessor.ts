/**
 * 文件处理器基类
 */
export interface FileMetadata {
  fileName: string
  filePath: string
  fileSize: number
  fileExtension: string
  modifiedTime: string
  processorType: string
  metadata?: Record<string, any>
  thumbnailData?: number[]
  assetType?: string
  engineVersion?: string
}

export abstract class BaseFileProcessor {
  /**
   * 获取支持的文件扩展名
   */
  abstract getSupportedExtensions(): string[]

  /**
   * 检查是否支持该文件
   */
  canProcess(filePath: string): boolean {
    const extension = this.getFileExtension(filePath)
    return this.getSupportedExtensions().includes(extension)
  }

  /**
   * 处理文件并提取元数据
   */
  abstract processFile(filePath: string): Promise<FileMetadata>

  /**
   * 获取文件扩展名
   */
  protected getFileExtension(filePath: string): string {
    return filePath.split('.').pop()?.toLowerCase() || ''
  }

  /**
   * 获取文件基本信息
   */
  protected async getBasicFileInfo(filePath: string): Promise<Partial<FileMetadata>> {
    const fs = await import('fs/promises')
    const path = await import('path')

    try {
      const stats = await fs.stat(filePath)
      return {
        fileName: path.basename(filePath),
        filePath,
        fileSize: stats.size,
        fileExtension: this.getFileExtension(filePath),
        modifiedTime: stats.mtime.toISOString()
      }
    } catch (error) {
      throw new Error(`无法读取文件信息: ${error}`)
    }
  }
}
