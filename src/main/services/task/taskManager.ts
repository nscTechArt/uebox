/**
 * 任务管理器
 */
import { v4 as uuidv4 } from 'uuid'
import { TaskState, TaskStatus, Task } from '../types'
import { logger } from '../logger'
import { config } from '../config'

export class TaskManager {
  private tasks = new Map<string, Task>()
  private taskExecutors = new Map<string, (task: Task) => Promise<void>>()
  private isProcessing = false
  private processingTimer?: NodeJS.Timeout
  private maxConcurrentTasks = 5
  private runningTasks = new Set<string>()

  constructor() {
    this.maxConcurrentTasks = config.task?.maxConcurrent || 5
  }

  /**
   * 启动任务管理器
   */
  start(): void {
    if (this.isProcessing) {
      logger.warn('任务管理器已在运行')
      return
    }

    this.isProcessing = true
    this.startProcessing()
    logger.info('任务管理器已启动')
  }

  /**
   * 停止任务管理器
   */
  stop(): void {
    if (!this.isProcessing) {
      return
    }

    this.isProcessing = false
    if (this.processingTimer) {
      clearTimeout(this.processingTimer)
      this.processingTimer = undefined
    }

    // 取消所有运行中的任务
    for (const taskId of this.runningTasks) {
      this.cancelTask(taskId)
    }

    logger.info('任务管理器已停止')
  }

  /**
   * 创建任务
   */
  async createTask(taskData: {
    type: string
    payload: any
    metadata?: any
    priority?: number
    connectionId?: string
  }): Promise<string> {
    const taskId = uuidv4()
    const now = Date.now()

    const task: Task = {
      id: taskId,
      type: taskData.type,
      state: TaskState.PENDING,
      status: TaskStatus.PENDING,
      payload: taskData.payload,
      metadata: taskData.metadata || {},
      priority: taskData.priority || 0,
      percent: 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      connectionId: taskData.connectionId
    }

    this.tasks.set(taskId, task)
    logger.info(`任务已创建: ${taskId} (${task.type})`)

    // 触发任务处理
    this.scheduleProcessing()

    return taskId
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): Task | null {
    return this.tasks.get(taskId) || null
  }

  /**
   * 更新任务
   */
  async updateTask(taskId: string, updates: Partial<Task>): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) {
      logger.warn(`任务不存在: ${taskId}`)
      return false
    }

    // 更新任务字段
    Object.assign(task, updates, { updatedAt: Date.now() })

    logger.debug(`任务已更新: ${taskId}`)
    return true
  }

  /**
   * 更新任务进度
   */
  async updateTaskProgress(taskId: string, progress: number, message?: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) {
      logger.warn(`任务不存在: ${taskId}`)
      return false
    }

    task.progress = Math.max(0, Math.min(100, progress))
    task.progressMessage = message
    task.updatedAt = Date.now()

    logger.debug(`任务进度更新: ${taskId} - ${progress}%`)

    // 发送进度事件
    this.emitTaskEvent(taskId, 'progress', {
      progress: task.progress,
      message: task.progressMessage
    })

    return true
  }

  /**
   * 取消任务
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) {
      logger.warn(`任务不存在: ${taskId}`)
      return false
    }

    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
      logger.warn(`任务已完成，无法取消: ${taskId}`)
      return false
    }

    task.status = TaskStatus.CANCELLED
    task.updatedAt = Date.now()
    task.completedAt = Date.now()

    // 从运行中任务列表移除
    this.runningTasks.delete(taskId)

    logger.info(`任务已取消: ${taskId}`)

    // 发送取消事件
    this.emitTaskEvent(taskId, 'cancelled', { reason: '用户取消' })

    return true
  }

  /**
   * 列出任务
   */
  listTasks(
    options: {
      status?: TaskStatus
      type?: string
      limit?: number
      offset?: number
    } = {}
  ): Task[] {
    let tasks = Array.from(this.tasks.values())

    // 过滤条件
    if (options.status) {
      tasks = tasks.filter((task) => task.status === options.status)
    }

    if (options.type) {
      tasks = tasks.filter((task) => task.type === options.type)
    }

    // 排序（按创建时间倒序）
    tasks.sort((a, b) => b.createdAt - a.createdAt)

    // 分页
    const offset = options.offset || 0
    const limit = options.limit || 50
    return tasks.slice(offset, offset + limit)
  }

  /**
   * 注册任务执行器
   */
  registerExecutor(taskType: string, executor: (task: Task) => Promise<void>): void {
    this.taskExecutors.set(taskType, executor)
    logger.debug(`任务执行器已注册: ${taskType}`)
  }

  /**
   * 注销任务执行器
   */
  unregisterExecutor(taskType: string): boolean {
    const removed = this.taskExecutors.delete(taskType)
    if (removed) {
      logger.debug(`任务执行器已注销: ${taskType}`)
    }
    return removed
  }

  /**
   * 获取任务统计
   */
  getStats(): {
    total: number
    pending: number
    running: number
    completed: number
    failed: number
    cancelled: number
  } {
    const tasks = Array.from(this.tasks.values())

    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === TaskStatus.PENDING).length,
      running: tasks.filter((t) => t.status === TaskStatus.RUNNING).length,
      completed: tasks.filter((t) => t.status === TaskStatus.COMPLETED).length,
      failed: tasks.filter((t) => t.status === TaskStatus.FAILED).length,
      cancelled: tasks.filter((t) => t.status === TaskStatus.CANCELLED).length
    }
  }

  /**
   * 清理已完成的任务
   */
  cleanupCompletedTasks(olderThanMs = 24 * 60 * 60 * 1000): number {
    const now = Date.now()
    let cleaned = 0

    for (const [taskId, task] of this.tasks) {
      if (
        (task.status === TaskStatus.COMPLETED ||
          task.status === TaskStatus.FAILED ||
          task.status === TaskStatus.CANCELLED) &&
        task.completedAt &&
        now - task.completedAt > olderThanMs
      ) {
        this.tasks.delete(taskId)
        cleaned++
      }
    }

    if (cleaned > 0) {
      logger.info(`清理了 ${cleaned} 个已完成的任务`)
    }

    return cleaned
  }

  /**
   * 开始处理任务
   */
  private startProcessing(): void {
    this.processNextTasks()
  }

  /**
   * 调度任务处理
   */
  private scheduleProcessing(): void {
    if (!this.processingTimer) {
      this.processingTimer = setTimeout(() => {
        this.processingTimer = undefined
        this.processNextTasks()
      }, 100)
    }
  }

  /**
   * 处理下一批任务
   */
  private async processNextTasks(): Promise<void> {
    if (!this.isProcessing) {
      return
    }

    try {
      // 获取可执行的任务
      const availableSlots = this.maxConcurrentTasks - this.runningTasks.size
      if (availableSlots <= 0) {
        // 没有可用槽位，稍后重试
        setTimeout(() => this.processNextTasks(), 1000)
        return
      }

      // 获取待执行任务
      const pendingTasks = Array.from(this.tasks.values())
        .filter((task) => task.status === TaskStatus.PENDING)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0)) // 按优先级排序
        .slice(0, availableSlots)

      // 执行任务
      for (const task of pendingTasks) {
        this.executeTask(task)
      }

      // 调度下一次处理
      if (this.isProcessing) {
        setTimeout(() => this.processNextTasks(), 1000)
      }
    } catch (error) {
      logger.error('任务处理循环错误:', error)
      setTimeout(() => this.processNextTasks(), 5000)
    }
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: Task): Promise<void> {
    const executor = this.taskExecutors.get(task.type)
    if (!executor) {
      logger.warn(`未找到任务执行器: ${task.type}`)
      task.status = TaskStatus.FAILED
      task.error = '未找到任务执行器'
      task.completedAt = Date.now()
      task.updatedAt = Date.now()
      return
    }

    // 更新任务状态
    task.status = TaskStatus.RUNNING
    task.startedAt = Date.now()
    task.updatedAt = Date.now()
    this.runningTasks.add(task.id)

    logger.info(`开始执行任务: ${task.id} (${task.type})`)

    // 发送开始事件
    this.emitTaskEvent(task.id, 'started', {})

    try {
      // 执行任务
      await executor(task)

      // 任务成功完成
      if (task.status === TaskStatus.RUNNING) {
        task.status = TaskStatus.COMPLETED
        task.progress = 100
        task.completedAt = Date.now()
        task.updatedAt = Date.now()

        logger.info(`任务执行成功: ${task.id}`)
        this.emitTaskEvent(task.id, 'completed', {})
      }
    } catch (error) {
      // 任务执行失败
      task.status = TaskStatus.FAILED
      task.error = error instanceof Error ? error.message : String(error)
      task.completedAt = Date.now()
      task.updatedAt = Date.now()

      logger.error(`任务执行失败: ${task.id}`, error)
      this.emitTaskEvent(task.id, 'failed', { error: task.error })
    } finally {
      // 从运行中任务列表移除
      this.runningTasks.delete(task.id)
    }
  }

  /**
   * 发送任务事件。
   *
   * 以前这里把 `task.*` 事件序列化后经网关发给 UE —— 而插件的
   * `ProcessMessage` 只处理 `type` 为 `req`/`res` 的消息，收到就打一行
   * "Ignore non-request message" 扔掉。也就是说这条链路从头到尾没有接收方。
   *
   * 留一行日志就够了。真需要把任务进度送到 UE 时，得先在插件那侧
   * 有个接收端，那时再接回来。
   */
  private emitTaskEvent(taskId: string, event: string, data: unknown): void {
    logger.debug(`任务事件: ${taskId} - ${event}`, data)
  }
}
