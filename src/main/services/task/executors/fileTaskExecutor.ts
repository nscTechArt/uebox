/**
 * 文件任务执行器
 */
import { Task } from '../../types'
import { TaskManager } from '../taskManager'
import { logger } from '../../logger'
import * as fs from 'fs/promises'
import * as path from 'path'

export class FileTaskExecutor {
  /**
   * 注册执行器
   */
  registerExecutors(taskManager: TaskManager): void {
    taskManager.registerExecutor('file.batch.copy', this.executeBatchCopy.bind(this))
    taskManager.registerExecutor('file.batch.move', this.executeBatchMove.bind(this))
    taskManager.registerExecutor('file.batch.delete', this.executeBatchDelete.bind(this))
    taskManager.registerExecutor('file.compress', this.executeCompress.bind(this))
    taskManager.registerExecutor('file.extract', this.executeExtract.bind(this))
    taskManager.registerExecutor('file.sync', this.executeSync.bind(this))

    logger.debug('文件任务执行器已注册')
  }

  /**
   * 执行批量复制任务
   */
  private async executeBatchCopy(task: Task): Promise<void> {
    logger.info(`执行批量复制任务: ${task.id}`)

    try {
      const { files, destination } = task.payload

      if (!files || !Array.isArray(files) || !destination) {
        throw new Error('缺少文件列表或目标目录')
      }

      // 确保目标目录存在
      await fs.mkdir(destination, { recursive: true })

      const total = files.length
      let completed = 0

      for (const file of files) {
        try {
          const sourcePath = file.source || file
          const fileName = path.basename(sourcePath)
          const targetPath = path.join(destination, fileName)

          // 复制文件
          await fs.copyFile(sourcePath, targetPath)

          completed++
          const progress = Math.round((completed / total) * 100)
          await this.updateProgress(task, progress, `已复制 ${completed}/${total} 个文件`)

          logger.debug(`文件复制成功: ${sourcePath} -> ${targetPath}`)
        } catch (error) {
          logger.error(`文件复制失败: ${file}`, error)
          // 继续处理其他文件
        }
      }

      logger.info(`批量复制完成: ${completed}/${total} 个文件`)
    } catch (error) {
      logger.error(`批量复制任务失败: ${task.id}`, error)
      throw error
    }
  }

  /**
   * 执行批量移动任务
   */
  private async executeBatchMove(task: Task): Promise<void> {
    logger.info(`执行批量移动任务: ${task.id}`)

    try {
      const { files, destination } = task.payload

      if (!files || !Array.isArray(files) || !destination) {
        throw new Error('缺少文件列表或目标目录')
      }

      // 确保目标目录存在
      await fs.mkdir(destination, { recursive: true })

      const total = files.length
      let completed = 0

      for (const file of files) {
        try {
          const sourcePath = file.source || file
          const fileName = path.basename(sourcePath)
          const targetPath = path.join(destination, fileName)

          // 移动文件
          await fs.rename(sourcePath, targetPath)

          completed++
          const progress = Math.round((completed / total) * 100)
          await this.updateProgress(task, progress, `已移动 ${completed}/${total} 个文件`)

          logger.debug(`文件移动成功: ${sourcePath} -> ${targetPath}`)
        } catch (error) {
          logger.error(`文件移动失败: ${file}`, error)
          // 继续处理其他文件
        }
      }

      logger.info(`批量移动完成: ${completed}/${total} 个文件`)
    } catch (error) {
      logger.error(`批量移动任务失败: ${task.id}`, error)
      throw error
    }
  }

  /**
   * 执行批量删除任务
   */
  private async executeBatchDelete(task: Task): Promise<void> {
    logger.info(`执行批量删除任务: ${task.id}`)

    try {
      const { files } = task.payload

      if (!files || !Array.isArray(files)) {
        throw new Error('缺少文件列表')
      }

      const total = files.length
      let completed = 0

      for (const file of files) {
        try {
          const filePath = file.path || file

          // 检查文件是否存在
          const stats = await fs.stat(filePath)

          if (stats.isDirectory()) {
            // 删除目录
            await fs.rmdir(filePath, { recursive: true })
          } else {
            // 删除文件
            await fs.unlink(filePath)
          }

          completed++
          const progress = Math.round((completed / total) * 100)
          await this.updateProgress(task, progress, `已删除 ${completed}/${total} 个文件`)

          logger.debug(`文件删除成功: ${filePath}`)
        } catch (error) {
          logger.error(`文件删除失败: ${file}`, error)
          // 继续处理其他文件
        }
      }

      logger.info(`批量删除完成: ${completed}/${total} 个文件`)
    } catch (error) {
      logger.error(`批量删除任务失败: ${task.id}`, error)
      throw error
    }
  }

  /**
   * 执行压缩任务
   */
  private async executeCompress(task: Task): Promise<void> {
    logger.info(`执行压缩任务: ${task.id}`)

    try {
      const { source, destination, format = 'zip' } = task.payload

      if (!source || !destination) {
        throw new Error('缺少源路径或目标路径')
      }

      // 更新进度
      await this.updateProgress(task, 10, '准备压缩')

      // 模拟压缩过程
      await this.simulateCompress(task, source, destination, format)

      logger.info(`压缩完成: ${source} -> ${destination}`)
    } catch (error) {
      logger.error(`压缩任务失败: ${task.id}`, error)
      throw error
    }
  }

  /**
   * 执行解压任务
   */
  private async executeExtract(task: Task): Promise<void> {
    logger.info(`执行解压任务: ${task.id}`)

    try {
      const { source, destination } = task.payload

      if (!source || !destination) {
        throw new Error('缺少源文件或目标目录')
      }

      // 确保目标目录存在
      await fs.mkdir(destination, { recursive: true })

      // 更新进度
      await this.updateProgress(task, 10, '准备解压')

      // 模拟解压过程
      await this.simulateExtract(task, source, destination)

      logger.info(`解压完成: ${source} -> ${destination}`)
    } catch (error) {
      logger.error(`解压任务失败: ${task.id}`, error)
      throw error
    }
  }

  /**
   * 执行同步任务
   */
  private async executeSync(task: Task): Promise<void> {
    logger.info(`执行同步任务: ${task.id}`)

    try {
      const { source, destination, options = {} } = task.payload

      if (!source || !destination) {
        throw new Error('缺少源目录或目标目录')
      }

      // 更新进度
      await this.updateProgress(task, 10, '分析目录结构')

      // 模拟同步过程
      await this.simulateSync(task, source, destination, options)

      logger.info(`同步完成: ${source} -> ${destination}`)
    } catch (error) {
      logger.error(`同步任务失败: ${task.id}`, error)
      throw error
    }
  }

  /**
   * 模拟压缩过程
   */
  private async simulateCompress(
    task: Task,
    _source: string,
    _destination: string,
    _format: string
  ): Promise<void> {
    const steps = [
      { progress: 20, message: '扫描文件' },
      { progress: 40, message: '计算压缩率' },
      { progress: 60, message: '压缩文件' },
      { progress: 80, message: '写入压缩包' },
      { progress: 100, message: '压缩完成' }
    ]

    for (const step of steps) {
      await this.delay(1000)
      await this.updateProgress(task, step.progress, step.message)
    }
  }

  /**
   * 模拟解压过程
   */
  private async simulateExtract(task: Task, _source: string, _destination: string): Promise<void> {
    const steps = [
      { progress: 20, message: '读取压缩包' },
      { progress: 40, message: '验证文件完整性' },
      { progress: 60, message: '解压文件' },
      { progress: 80, message: '设置文件权限' },
      { progress: 100, message: '解压完成' }
    ]

    for (const step of steps) {
      await this.delay(800)
      await this.updateProgress(task, step.progress, step.message)
    }
  }

  /**
   * 模拟同步过程
   */
  private async simulateSync(
    task: Task,
    _source: string,
    _destination: string,
    _options: any
  ): Promise<void> {
    const steps = [
      { progress: 20, message: '比较文件差异' },
      { progress: 40, message: '复制新文件' },
      { progress: 60, message: '更新修改文件' },
      { progress: 80, message: '删除多余文件' },
      { progress: 100, message: '同步完成' }
    ]

    for (const step of steps) {
      await this.delay(1200)
      await this.updateProgress(task, step.progress, step.message)
    }
  }

  /**
   * 更新任务进度
   */
  private async updateProgress(task: Task, progress: number, message: string): Promise<void> {
    task.progress = progress
    task.progressMessage = message
    task.updatedAt = Date.now()

    logger.debug(`任务进度: ${task.id} - ${progress}% - ${message}`)
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
