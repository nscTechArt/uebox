/**
 * 监控指标收集
 */
import { logger } from '../logger'

export interface SystemMetrics {
  memory: {
    used: number
    total: number
    percentage: number
  }
  cpu: {
    usage: number
    loadAverage: number[]
  }
  uptime: number
  timestamp: number
}

export interface ServiceMetrics {
  websocket: {
    connections: number
    messagesReceived: number
    messagesSent: number
    errors: number
  }
  http: {
    requests: number
    responses: number
    errors: number
    averageResponseTime: number
  }
  tasks: {
    total: number
    running: number
    completed: number
    failed: number
  }
}

export class MetricsCollector {
  private systemMetrics: SystemMetrics[] = []
  private serviceMetrics: ServiceMetrics[] = []
  private maxHistorySize: number = 1000
  private collectInterval: NodeJS.Timeout | null = null
  private isCollecting: boolean = false

  // 服务指标计数器
  private counters = {
    websocket: {
      connections: 0,
      messagesReceived: 0,
      messagesSent: 0,
      errors: 0
    },
    http: {
      requests: 0,
      responses: 0,
      errors: 0,
      totalResponseTime: 0
    },
    tasks: {
      total: 0,
      running: 0,
      completed: 0,
      failed: 0
    }
  }

  constructor(options: { maxHistorySize?: number; collectInterval?: number } = {}) {
    this.maxHistorySize = options.maxHistorySize || 1000

    if (options.collectInterval) {
      this.startCollection(options.collectInterval)
    }
  }

  /**
   * 开始收集指标
   */
  startCollection(interval: number = 60000): void {
    if (this.isCollecting) {
      logger.warn('指标收集已在运行中')
      return
    }

    this.isCollecting = true
    this.collectInterval = setInterval(() => {
      this.collectSystemMetrics()
      this.collectServiceMetrics()
    }, interval)

    logger.info(`指标收集已启动，间隔: ${interval}ms`)
  }

  /**
   * 停止收集指标
   */
  stopCollection(): void {
    if (this.collectInterval) {
      clearInterval(this.collectInterval)
      this.collectInterval = null
    }

    this.isCollecting = false
    logger.info('指标收集已停止')
  }

  /**
   * 收集系统指标
   */
  collectSystemMetrics(): void {
    try {
      const memoryUsage = process.memoryUsage()
      const totalMemory = memoryUsage.heapTotal + memoryUsage.external

      const metrics: SystemMetrics = {
        memory: {
          used: memoryUsage.heapUsed,
          total: totalMemory,
          percentage: (memoryUsage.heapUsed / totalMemory) * 100
        },
        cpu: {
          usage: process.cpuUsage().user / 1000000, // 转换为秒
          loadAverage: process.platform !== 'win32' ? require('os').loadavg() : [0, 0, 0]
        },
        uptime: process.uptime(),
        timestamp: Date.now()
      }

      this.systemMetrics.push(metrics)

      // 保持历史记录大小限制
      if (this.systemMetrics.length > this.maxHistorySize) {
        this.systemMetrics.shift()
      }

      // logger.debug('系统指标已收集', metrics)
    } catch (error) {
      logger.error('收集系统指标失败:', error)
    }
  }

  /**
   * 收集服务指标
   */
  collectServiceMetrics(): void {
    try {
      const metrics: ServiceMetrics = {
        websocket: { ...this.counters.websocket },
        http: {
          ...this.counters.http,
          averageResponseTime:
            this.counters.http.responses > 0
              ? this.counters.http.totalResponseTime / this.counters.http.responses
              : 0
        },
        tasks: { ...this.counters.tasks }
      }

      this.serviceMetrics.push(metrics)

      // 保持历史记录大小限制
      if (this.serviceMetrics.length > this.maxHistorySize) {
        this.serviceMetrics.shift()
      }

      // logger.debug('服务指标已收集', metrics)
    } catch (error) {
      logger.error('收集服务指标失败:', error)
    }
  }

  /**
   * 获取最新系统指标
   */
  getLatestSystemMetrics(): SystemMetrics | null {
    return this.systemMetrics.length > 0 ? this.systemMetrics[this.systemMetrics.length - 1] : null
  }

  /**
   * 获取最新服务指标
   */
  getLatestServiceMetrics(): ServiceMetrics | null {
    return this.serviceMetrics.length > 0
      ? this.serviceMetrics[this.serviceMetrics.length - 1]
      : null
  }

  /**
   * 获取系统指标历史
   */
  getSystemMetricsHistory(limit?: number): SystemMetrics[] {
    if (limit) {
      return this.systemMetrics.slice(-limit)
    }
    return [...this.systemMetrics]
  }

  /**
   * 获取服务指标历史
   */
  getServiceMetricsHistory(limit?: number): ServiceMetrics[] {
    if (limit) {
      return this.serviceMetrics.slice(-limit)
    }
    return [...this.serviceMetrics]
  }

  /**
   * 增加WebSocket连接数
   */
  incrementWebSocketConnections(): void {
    this.counters.websocket.connections++
  }

  /**
   * 减少WebSocket连接数
   */
  decrementWebSocketConnections(): void {
    this.counters.websocket.connections = Math.max(0, this.counters.websocket.connections - 1)
  }

  /**
   * 增加WebSocket接收消息数
   */
  incrementWebSocketMessagesReceived(): void {
    this.counters.websocket.messagesReceived++
  }

  /**
   * 增加WebSocket发送消息数
   */
  incrementWebSocketMessagesSent(): void {
    this.counters.websocket.messagesSent++
  }

  /**
   * 增加WebSocket错误数
   */
  incrementWebSocketErrors(): void {
    this.counters.websocket.errors++
  }

  /**
   * 增加HTTP请求数
   */
  incrementHttpRequests(): void {
    this.counters.http.requests++
  }

  /**
   * 增加HTTP响应数并记录响应时间
   */
  incrementHttpResponses(responseTime: number): void {
    this.counters.http.responses++
    this.counters.http.totalResponseTime += responseTime
  }

  /**
   * 增加HTTP错误数
   */
  incrementHttpErrors(): void {
    this.counters.http.errors++
  }

  /**
   * 更新任务统计
   */
  updateTaskMetrics(total: number, running: number, completed: number, failed: number): void {
    this.counters.tasks.total = total
    this.counters.tasks.running = running
    this.counters.tasks.completed = completed
    this.counters.tasks.failed = failed
  }

  /**
   * 获取所有指标摘要
   */
  getMetricsSummary(): {
    system: SystemMetrics | null
    service: ServiceMetrics | null
    collection: {
      isRunning: boolean
      historySize: number
      maxHistorySize: number
    }
  } {
    return {
      system: this.getLatestSystemMetrics(),
      service: this.getLatestServiceMetrics(),
      collection: {
        isRunning: this.isCollecting,
        historySize: this.systemMetrics.length,
        maxHistorySize: this.maxHistorySize
      }
    }
  }

  /**
   * 清空指标历史
   */
  clearHistory(): void {
    this.systemMetrics = []
    this.serviceMetrics = []
    logger.info('指标历史已清空')
  }

  /**
   * 重置计数器
   */
  resetCounters(): void {
    this.counters = {
      websocket: {
        connections: 0,
        messagesReceived: 0,
        messagesSent: 0,
        errors: 0
      },
      http: {
        requests: 0,
        responses: 0,
        errors: 0,
        totalResponseTime: 0
      },
      tasks: {
        total: 0,
        running: 0,
        completed: 0,
        failed: 0
      }
    }
    logger.info('指标计数器已重置')
  }

  /**
   * 导出指标数据
   */
  exportMetrics(): {
    systemMetrics: SystemMetrics[]
    serviceMetrics: ServiceMetrics[]
    exportTime: number
  } {
    return {
      systemMetrics: [...this.systemMetrics],
      serviceMetrics: [...this.serviceMetrics],
      exportTime: Date.now()
    }
  }
}

// 创建全局指标收集器实例
//
// 这里刻意不传 collectInterval：传了构造函数就会立刻起定时器，而这个单例
// 在模块加载时就被创建，等于绕过 ServiceManager 自己启动了一遍——既让
// enableMetrics: false 这个开关形同虚设，又会在随后的 start() 里撞出一条
// 「指标收集已在运行中」的警告。启停统一由 ServiceManager 负责，
// 它调用的 startCollection() 默认就是每分钟一次。
export const metricsCollector = new MetricsCollector({
  maxHistorySize: 1000
})
