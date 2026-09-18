/**
 * 服务模块入口
 */
import { logger } from './logger'
import { config } from './config'
import { WebSocketService } from './websocket/server'
import type { HttpServer } from './http/server'
import { TaskManager } from './task/taskManager'
import { MessageRouter } from './messaging/router'
import { registerHandlers } from './messaging/handlers'
import { registerExecutors } from './task/executors'
import { metricsCollector } from './monitoring/metrics'
import { healthCheckService } from './monitoring/healthCheck'

export interface ServiceManagerOptions {
  autoStart?: boolean
  enableMetrics?: boolean
  enableHealthCheck?: boolean
}

export class ServiceManager {
  private websocketService: WebSocketService
  /** HTTP 服务器只在 config.http.enabled 时才创建，默认关闭 */
  private httpServer: HttpServer | null = null
  private taskManager: TaskManager
  private messageRouter: MessageRouter
  private isStarted: boolean = false
  private isShuttingDown: boolean = false
  private signalsBound: boolean = false
  private options: Required<ServiceManagerOptions>
  /**
   * 启动时有哪个可选服务没起来。
   *
   * 应用照常启动，但这句话要能被拿到 —— 界面用它告诉用户「引擎连不上是因为
   * 端口被占」，而不是让他自己去猜为什么插件死活握不上手。
   */
  private startupWarning?: string

  constructor(options: ServiceManagerOptions = {}) {
    this.options = {
      autoStart: options.autoStart ?? true,
      enableMetrics: options.enableMetrics ?? true,
      enableHealthCheck: options.enableHealthCheck ?? true
    }

    // 初始化服务实例
    this.messageRouter = new MessageRouter()
    this.taskManager = new TaskManager()
    this.websocketService = new WebSocketService(this.messageRouter.route.bind(this.messageRouter))

    this.setupServices()
  }

  /**
   * 设置服务依赖关系
   */
  private setupServices(): void {
    // HTTP 服务器的依赖注入挪到 start() 里，跟它的延迟创建放在一起

    // 注册消息处理器
    registerHandlers(this.messageRouter, (connectionId, envelope) =>
      this.websocketService.sendToClient(connectionId, envelope)
    )

    // 注册任务执行器
    registerExecutors(this.taskManager)

    logger.info('服务依赖关系已设置')
  }

  /**
   * 启动所有服务
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      logger.warn('服务已启动')
      return
    }

    try {
      logger.info('开始启动服务...')

      // 下面每个 start() 自己都会打一行「XX 已启动」，而且带着端口、间隔这类细节。
      // 这里不再复述一遍 —— 同一件事打两行，控制台里只是噪音。

      // 启动指标收集
      if (this.options.enableMetrics) {
        metricsCollector.startCollection()
      }

      // 启动健康检查
      if (this.options.enableHealthCheck) {
        healthCheckService.startPeriodicCheck()
      }

      // 启动任务管理器
      await this.taskManager.start()

      // 启动 WebSocket 服务。
      //
      // **起不来不算致命错误。** 以前这里的异常一路冒到 `index.ts` 的
      // `app.quit()`，结果是：端口 17860 被占用时，盒子连窗口都不创建，
      // 用户只看到程序闪一下就没了，没有任何提示 —— 他既不知道是端口的事，
      // 也无从判断该关掉哪个程序。
      //
      // 而这个服务只管一件事：和 UE 插件的桥接。它没起来，资产库、笔记本、
      // 材质库、设置这些**全都照常能用**。为了一个可选能力把整个应用杀掉，
      // 代价和收益完全不成比例。
      //
      // 单实例锁已经挡掉了「同一个盒子开两次」，所以真走到这里多半是别的程序
      // 占了端口 —— 那更需要把原因显示给用户，而不是一走了之。
      try {
        await this.websocketService.start()
      } catch (error) {
        this.startupWarning = this.websocketService.getStatus().startError ?? String(error)
        logger.error(`[ServiceManager] ${this.startupWarning}`)
        logger.warn('[ServiceManager] 引擎桥接不可用，其余功能照常启动')
      }

      // 启动HTTP服务器
      //
      // 默认关闭。UE 插件走的是 WebSocket，渲染进程也不访问它，剩下的
      // 只有一组无鉴权的 debug 路由 —— 让它在每个用户机器上无条件监听没有收益。
      // 需要时用 HTTP_ENABLED=true 打开（pnpm dev:smoke 就是这么做的）。
      //
      // 模块本身也是动态 import 的：express + multer 光加载就要几百毫秒，
      // 静态 import 会把这笔开销转嫁到每一次启动上，哪怕服务器根本不启动。
      if (config.http.enabled) {
        const { HttpServer } = await import('./http/server')
        const httpServer = new HttpServer()
        httpServer.setTaskManager(this.taskManager)
        httpServer.setConnectionManager(this.websocketService.getConnectionManager())
        this.httpServer = httpServer

        await httpServer.start()
      } else {
        logger.info('HTTP服务器已跳过（如需调试接口，设置 HTTP_ENABLED=true）')
      }

      this.isStarted = true
      logger.info('所有服务启动完成')

      // 设置进程退出处理
      this.setupGracefulShutdown()
    } catch (error) {
      logger.error('服务启动失败:', error)
      await this.stop()
      throw error
    }
  }

  /**
   * 停止所有服务
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      logger.warn('服务未启动')
      return
    }

    try {
      logger.info('开始停止服务...')

      // 停止HTTP服务器（没启动过就没有实例）
      if (this.httpServer) {
        await this.httpServer.stop()
        this.httpServer = null
        logger.info('HTTP服务器已停止')
      }

      // 停止WebSocket服务
      await this.websocketService.stop()
      logger.info('WebSocket服务已停止')

      // 停止任务管理器
      await this.taskManager.stop()
      logger.info('任务管理器已停止')

      // 停止健康检查
      if (this.options.enableHealthCheck) {
        healthCheckService.stopPeriodicCheck()
        logger.info('健康检查已停止')
      }

      // 停止指标收集
      if (this.options.enableMetrics) {
        metricsCollector.stopCollection()
        logger.info('指标收集已停止')
      }

      this.isStarted = false
      logger.info('所有服务停止完成')
    } catch (error) {
      logger.error('服务停止失败:', error)
      throw error
    }
  }

  /**
   * 重启所有服务
   */
  async restart(): Promise<void> {
    logger.info('重启服务...')
    await this.stop()
    await this.start()
    logger.info('服务重启完成')
  }

  /**
   * 获取服务状态
   */
  getStatus(): {
    isStarted: boolean
    /** 有可选服务没起来时的原因（目前只有引擎桥接） */
    startupWarning?: string
    services: {
      websocket: any
      http: any
      taskManager: any
    }
    metrics?: any
    health?: any
  } {
    const status = {
      isStarted: this.isStarted,
      ...(this.startupWarning ? { startupWarning: this.startupWarning } : {}),
      services: {
        websocket: this.websocketService.getStatus(),
        http: this.httpServer?.getStatus() ?? { running: false, enabled: false },
        taskManager: this.taskManager.getStats()
      }
    }

    // 添加指标信息
    if (this.options.enableMetrics) {
      ;(status as any).metrics = metricsCollector.getMetricsSummary()
    }

    // 添加健康检查信息
    if (this.options.enableHealthCheck) {
      ;(status as any).health = healthCheckService.getOverallHealth()
    }

    return status
  }

  /**
   * 获取WebSocket服务
   */
  getWebSocketService(): WebSocketService {
    return this.websocketService
  }

  /**
   * 获取任务管理器
   */
  getTaskManager(): TaskManager {
    return this.taskManager
  }

  /**
   * 获取消息路由器
   */
  getMessageRouter(): MessageRouter {
    return this.messageRouter
  }

  /**
   * 获取指标收集器
   */
  getMetricsCollector() {
    return metricsCollector
  }

  /**
   * 获取健康检查服务
   */
  getHealthCheckService() {
    return healthCheckService
  }

  /**
   * 设置优雅关闭
   */
  private setupGracefulShutdown(): void {
    // 避免 restart() → start() 后重复注册
    if (this.signalsBound) return
    this.signalsBound = true

    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return
      this.isShuttingDown = true

      logger.info(`收到 ${signal} 信号，开始优雅关闭...`)

      try {
        await this.stop()
        logger.info('优雅关闭完成')
        process.exit(0)
      } catch (error) {
        logger.error('优雅关闭失败:', error)
        process.exit(1)
      }
    }

    // 监听进程信号
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

    // 监听未捕获的异常
    process.on('uncaughtException', (error) => {
      logger.error('未捕获的异常:', error)
      shutdown('uncaughtException')
    })

    /*
     * 未处理的 Promise 拒绝**只记录，不关应用**。
     *
     * 这里原来跟 uncaughtException 一样调 `shutdown()`。代价在 2026-09-04 真机上
     * 兑现了：Agent 浏览器打开一个连不上的政务网站（`ERR_CONNECTION_CLOSED`），
     * 加载失败的 promise 比 await 它的那行代码早了一个 tick，Node 判成
     * unhandledRejection —— **整个盒子当场退出**，用户正在跑的活一起没了。
     * 日志里紧跟着就是 `PromiseRejectionHandledWarning`：那条 rejection 其实
     * 一个 tick 之后就被接住了。
     *
     * 两件事的性质不一样：
     *   - `uncaughtException` 之后进程状态可能已经坏了，收摊是对的；
     *   - 一条没人接的 rejection 通常只是某一处 await 慢了一拍，或者某个后台任务
     *     失败了。为它关掉用户的整个工作区，是**用最重的手段处理最轻的故障**。
     *
     * 所以这里连 promise 一起记下来（带上 reason 的堆栈），让它在日志里显眼，
     * 但不动进程。真正该修的是漏掉 catch 的那一处 —— 日志里有它。
     */
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('未处理的Promise拒绝（已记录，不中断应用）:', reason, promise)
    })
  }
}

// 创建全局服务管理器实例
export const serviceManager = new ServiceManager()

// 导出服务实例
export { logger, config, metricsCollector, healthCheckService }
