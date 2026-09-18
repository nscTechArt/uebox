/**
 * 健康检查模块
 */
import { promises as fs } from 'fs'
import path from 'path'
import { app } from 'electron'
import { logger } from '../logger'
import { config } from '../config'

export interface HealthCheckResult {
  name: string
  status: 'healthy' | 'unhealthy' | 'degraded'
  message?: string
  details?: any
  timestamp: number
  responseTime: number
}

export interface HealthChecker {
  name: string
  check(): Promise<HealthCheckResult>
}

export class HealthCheckService {
  private checkers: Map<string, HealthChecker> = new Map()
  private lastResults: Map<string, HealthCheckResult> = new Map()
  private checkInterval: NodeJS.Timeout | null = null
  private isRunning: boolean = false

  constructor() {
    this.registerDefaultCheckers()
  }

  /**
   * 注册健康检查器
   */
  registerChecker(checker: HealthChecker): void {
    this.checkers.set(checker.name, checker)
    logger.debug(`健康检查器已注册: ${checker.name}`)
  }

  /**
   * 注销健康检查器
   */
  unregisterChecker(name: string): void {
    this.checkers.delete(name)
    this.lastResults.delete(name)
    logger.debug(`健康检查器已注销: ${name}`)
  }

  /**
   * 开始定期健康检查
   */
  startPeriodicCheck(interval: number = 30000): void {
    if (this.isRunning) {
      logger.warn('健康检查已在运行中')
      return
    }

    this.isRunning = true
    this.checkInterval = setInterval(async () => {
      await this.checkAll()
    }, interval)

    logger.info(`定期健康检查已启动，间隔: ${interval}ms`)
  }

  /**
   * 停止定期健康检查
   */
  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }

    this.isRunning = false
    logger.info('定期健康检查已停止')
  }

  /**
   * 执行所有健康检查
   */
  async checkAll(): Promise<Map<string, HealthCheckResult>> {
    const results = new Map<string, HealthCheckResult>()

    const checkPromises = Array.from(this.checkers.entries()).map(async ([name, checker]) => {
      try {
        const result = await checker.check()
        results.set(name, result)
        this.lastResults.set(name, result)

        if (result.status !== 'healthy') {
          logger.warn(`健康检查异常: ${name} - ${result.status} - ${result.message}`)
        }
      } catch (error) {
        const errorResult: HealthCheckResult = {
          name,
          status: 'unhealthy',
          message: error instanceof Error ? error.message : '检查失败',
          timestamp: Date.now(),
          responseTime: 0
        }

        results.set(name, errorResult)
        this.lastResults.set(name, errorResult)
        logger.error(`健康检查失败: ${name}`, error)
      }
    })

    await Promise.all(checkPromises)
    return results
  }

  /**
   * 执行单个健康检查
   */
  async checkOne(name: string): Promise<HealthCheckResult | null> {
    const checker = this.checkers.get(name)
    if (!checker) {
      logger.warn(`健康检查器不存在: ${name}`)
      return null
    }

    try {
      const result = await checker.check()
      this.lastResults.set(name, result)
      return result
    } catch (error) {
      const errorResult: HealthCheckResult = {
        name,
        status: 'unhealthy',
        message: error instanceof Error ? error.message : '检查失败',
        timestamp: Date.now(),
        responseTime: 0
      }

      this.lastResults.set(name, errorResult)
      logger.error(`健康检查失败: ${name}`, error)
      return errorResult
    }
  }

  /**
   * 获取最后的检查结果
   */
  getLastResults(): Map<string, HealthCheckResult> {
    return new Map(this.lastResults)
  }

  /**
   * 获取单个检查器的最后结果
   */
  getLastResult(name: string): HealthCheckResult | null {
    return this.lastResults.get(name) || null
  }

  /**
   * 获取整体健康状态
   */
  getOverallHealth(): {
    status: 'healthy' | 'unhealthy' | 'degraded'
    checks: HealthCheckResult[]
    summary: {
      total: number
      healthy: number
      unhealthy: number
      degraded: number
    }
  } {
    const checks = Array.from(this.lastResults.values())

    const summary = {
      total: checks.length,
      healthy: checks.filter((c) => c.status === 'healthy').length,
      unhealthy: checks.filter((c) => c.status === 'unhealthy').length,
      degraded: checks.filter((c) => c.status === 'degraded').length
    }

    let overallStatus: 'healthy' | 'unhealthy' | 'degraded' = 'healthy'

    if (summary.unhealthy > 0) {
      overallStatus = 'unhealthy'
    } else if (summary.degraded > 0) {
      overallStatus = 'degraded'
    }

    return {
      status: overallStatus,
      checks,
      summary
    }
  }

  /**
   * 注册默认健康检查器
   */
  private registerDefaultCheckers(): void {
    // 内存使用检查
    this.registerChecker({
      name: 'memory',
      async check(): Promise<HealthCheckResult> {
        const start = Date.now()
        const memoryUsage = process.memoryUsage()
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024
        const heapTotalMB = memoryUsage.heapTotal / 1024 / 1024
        const usagePercentage = (heapUsedMB / heapTotalMB) * 100

        let status: 'healthy' | 'unhealthy' | 'degraded' = 'healthy'
        let message = `内存使用: ${heapUsedMB.toFixed(2)}MB / ${heapTotalMB.toFixed(2)}MB (${usagePercentage.toFixed(1)}%)`

        // 调整阈值：对于Electron应用，内存使用阈值应该更合理
        // Electron应用通常会使用50-200MB内存，这是正常的
        // 只有当内存使用超过500MB时才认为有问题
        const absoluteThresholdMB = 500 // 绝对阈值：500MB
        if (heapUsedMB > absoluteThresholdMB) {
          status = 'unhealthy'
          message += ' - 内存使用过高'
        } else if (heapUsedMB > absoluteThresholdMB * 0.8) {
          status = 'degraded'
          message += ' - 内存使用较高'
        }

        return {
          name: 'memory',
          status,
          message,
          details: {
            heapUsed: heapUsedMB,
            heapTotal: heapTotalMB,
            usagePercentage,
            external: memoryUsage.external / 1024 / 1024
          },
          timestamp: Date.now(),
          responseTime: Date.now() - start
        }
      }
    })

    // 进程运行时间检查
    this.registerChecker({
      name: 'uptime',
      async check(): Promise<HealthCheckResult> {
        const start = Date.now()
        const uptime = process.uptime()
        const uptimeHours = uptime / 3600

        return {
          name: 'uptime',
          status: 'healthy',
          message: `运行时间: ${uptimeHours.toFixed(2)} 小时`,
          details: {
            uptime,
            uptimeHours,
            startTime: Date.now() - uptime * 1000
          },
          timestamp: Date.now(),
          responseTime: Date.now() - start
        }
      }
    })

    // 文件系统检查
    this.registerChecker({
      name: 'filesystem',
      async check(): Promise<HealthCheckResult> {
        const start = Date.now()

        try {
          // 使用用户数据目录，确保路径正确
          const userDataPath = app.getPath('userData')
          const logsDir = path.join(userDataPath, 'logs')
          const uploadsDir = path.join(userDataPath, 'uploads')

          // 确保目录存在，如果不存在则创建
          await fs.mkdir(logsDir, { recursive: true })
          await fs.mkdir(uploadsDir, { recursive: true })

          return {
            name: 'filesystem',
            status: 'healthy',
            message: '文件系统访问正常',
            details: {
              logsDir,
              uploadsDir
            },
            timestamp: Date.now(),
            responseTime: Date.now() - start
          }
        } catch (error) {
          return {
            name: 'filesystem',
            status: 'unhealthy',
            message: '文件系统访问异常',
            details: {
              error: error instanceof Error ? error.message : '未知错误'
            },
            timestamp: Date.now(),
            responseTime: Date.now() - start
          }
        }
      }
    })

    // 配置检查
    this.registerChecker({
      name: 'config',
      async check(): Promise<HealthCheckResult> {
        const start = Date.now()

        try {
          const configValid =
            config && config.websocket && config.http && config.logging && config.task

          if (!configValid) {
            return {
              name: 'config',
              status: 'unhealthy',
              message: '配置不完整',
              timestamp: Date.now(),
              responseTime: Date.now() - start
            }
          }

          return {
            name: 'config',
            status: 'healthy',
            message: '配置正常',
            details: {
              websocketPort: config.websocket.port,
              httpPort: config.http.port,
              logLevel: config.logging.level
            },
            timestamp: Date.now(),
            responseTime: Date.now() - start
          }
        } catch (error) {
          return {
            name: 'config',
            status: 'unhealthy',
            message: '配置检查失败',
            details: {
              error: error instanceof Error ? error.message : '未知错误'
            },
            timestamp: Date.now(),
            responseTime: Date.now() - start
          }
        }
      }
    })
  }
}

// 创建全局健康检查服务实例
export const healthCheckService = new HealthCheckService()
