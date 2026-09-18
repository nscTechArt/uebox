/**
 * 消息路由器 —— UE → 盒子 方向的入站分发。
 */
import { MessageEnvelope, MessageHandler, RouteConfig } from '../types'
import { logger } from '../logger'

export class MessageRouter {
  private routes = new Map<string, MessageHandler>()
  private middlewares: Array<
    (message: MessageEnvelope, next: () => Promise<void>) => Promise<void>
  > = []

  /**
   * 注册路由
   *
   * 通配符路由已移除：唯一的使用者是 `plugin.*`，随那组死路由一起删了。
   * 它每来一条消息都要为每个通配符 `new RegExp` 一次，而且让「哪些
   * topic 可达」变成一件需要跑一遍正则才知道的事。要模糊匹配就显式登记。
   */
  register(topic: string, handler: MessageHandler): void {
    if (topic.includes('*')) {
      throw new Error(`路由不支持通配符，请逐条登记：${topic}`)
    }
    this.routes.set(topic, handler)
    logger.debug(`注册路由: ${topic}`)
  }

  /**
   * 批量注册路由
   */
  registerRoutes(routes: RouteConfig[]): void {
    for (const route of routes) {
      this.register(route.topic, route.handler)
    }
  }

  /**
   * 注销路由
   */
  unregister(topic: string): boolean {
    return this.routes.delete(topic)
  }

  /**
   * 添加中间件
   */
  use(middleware: (message: MessageEnvelope, next: () => Promise<void>) => Promise<void>): void {
    this.middlewares.push(middleware)
    logger.debug('添加中间件')
  }

  /**
   * 路由消息
   */
  async route(message: MessageEnvelope, connectionId: string): Promise<void> {
    try {
      // 心跳消息不需要路由处理，静默跳过
      if (message.topic === 'system.heartbeat') {
        return
      }

      // 注册表即允许列表：没登记的一律丢弃。
      // warn 而不是 debug —— 正常情况下插件不会发这个，发了要么是版本不匹配，
      // 要么是有别的东西连上了这个端口，两种都想知道。
      const handler = this.routes.get(message.topic)
      if (!handler) {
        logger.warn(`入站消息没有对应处理器，已丢弃: ${message.topic} (${connectionId})`)
        return
      }

      // 执行中间件链
      await this.executeMiddlewares(message, async () => {
        await handler(message, connectionId)
      })
    } catch (error) {
      logger.error(`路由消息失败 ${message.topic}:`, error)
      throw error
    }
  }

  /**
   * 执行中间件链
   */
  private async executeMiddlewares(
    message: MessageEnvelope,
    finalHandler: () => Promise<void>
  ): Promise<void> {
    let index = 0

    const next = async (): Promise<void> => {
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++]
        await middleware(message, next)
      } else {
        await finalHandler()
      }
    }

    await next()
  }

  /**
   * 获取路由统计
   */
  getStats(): { exactRoutes: number; middlewares: number; routes: string[] } {
    return {
      exactRoutes: this.routes.size,
      middlewares: this.middlewares.length,
      routes: Array.from(this.routes.keys())
    }
  }

  /**
   * 清空所有路由
   */
  clear(): void {
    this.routes.clear()
    this.middlewares = []
    logger.info('路由器已清空')
  }
}
