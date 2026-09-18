/**
 * 请求状态管理器
 * 核心功能：解决 WebSocket 异步通讯中的 Request-Response 匹配问题
 *
 * 工作流程：
 * 1. 发送请求时：生成唯一 MessageID，创建 Promise 存入暂存池，设置超时计时器
 * 2. 收到响应时：根据 id 从暂存池取出对应 Promise，执行 resolve/reject
 * 3. 超时时：执行 reject('Timeout') 并清理暂存池
 */

import { v4 as uuidv4 } from 'uuid'
import { PendingRequest, WebSocketErrorCode, WebSocketServiceError, DEFAULT_CONFIG } from './types'
import { logger } from '../logger'

/**
 * 请求状态管理器类
 * 管理所有正在等待响应的请求
 */
export class RequestStateManager {
  /** 待处理请求暂存池 */
  private pendingRequests = new Map<string, PendingRequest>()

  /** 默认超时时间（毫秒） */
  private defaultTimeout: number

  constructor(defaultTimeout: number = DEFAULT_CONFIG.timeout) {
    this.defaultTimeout = defaultTimeout
  }

  /**
   * 创建一个新的请求
   * @param method 请求方法名
   * @param clientId 目标客户端ID（可选）
   * @param timeout 超时时间（毫秒）
   * @returns 包含 Promise 和 messageId 的对象
   */
  createRequest<T>(
    method: string,
    clientId?: string,
    timeout?: number
  ): { promise: Promise<T>; messageId: string } {
    const messageId = uuidv4()
    const timeoutMs = timeout ?? this.defaultTimeout

    // 创建 Deferred Promise
    let resolveFunc!: (value: T) => void
    let rejectFunc!: (reason: Error) => void

    const promise = new Promise<T>((resolve, reject) => {
      resolveFunc = resolve
      rejectFunc = reject
    })

    // 设置超时计时器
    const timer = setTimeout(() => {
      this.handleTimeout(messageId)
    }, timeoutMs)

    // 创建待处理请求项
    const pendingRequest: PendingRequest<T> = {
      id: messageId,
      method,
      resolve: resolveFunc,
      reject: rejectFunc,
      timer,
      createdAt: Date.now(),
      clientId
    }

    // 存入暂存池
    this.pendingRequests.set(messageId, pendingRequest as PendingRequest)

    logger.debug(`[RequestStateManager] 创建请求: ${messageId} (${method})`)

    return { promise, messageId }
  }

  /**
   * 处理响应消息
   * 根据消息ID匹配请求并 resolve
   * @param messageId 消息ID
   * @param data 响应数据
   * @returns 是否成功匹配到请求
   */
  resolveRequest(messageId: string, data: unknown): boolean {
    const pending = this.pendingRequests.get(messageId)
    if (!pending) {
      logger.warn(`[RequestStateManager] 未找到匹配的请求: ${messageId}`)
      return false
    }

    // 清除超时计时器
    clearTimeout(pending.timer)

    // 从暂存池移除
    this.pendingRequests.delete(messageId)

    // 执行 resolve
    pending.resolve(data)

    logger.debug(`[RequestStateManager] 请求已完成: ${messageId} (${pending.method})`)
    return true
  }

  /**
   * 处理错误响应
   * 根据消息ID匹配请求并 reject
   * @param messageId 消息ID
   * @param error 错误信息
   * @returns 是否成功匹配到请求
   */
  rejectRequest(messageId: string, error: string | Error): boolean {
    const pending = this.pendingRequests.get(messageId)
    if (!pending) {
      logger.warn(`[RequestStateManager] 未找到匹配的请求: ${messageId}`)
      return false
    }

    // 清除超时计时器
    clearTimeout(pending.timer)

    // 从暂存池移除
    this.pendingRequests.delete(messageId)

    // 执行 reject
    const errorObj = typeof error === 'string' ? new Error(error) : error
    pending.reject(errorObj)

    logger.debug(
      `[RequestStateManager] 请求失败: ${messageId} (${pending.method}) - ${errorObj.message}`
    )
    return true
  }

  /**
   * 处理请求超时
   * @param messageId 消息ID
   */
  private handleTimeout(messageId: string): void {
    const pending = this.pendingRequests.get(messageId)
    if (!pending) {
      return
    }

    // 从暂存池移除
    this.pendingRequests.delete(messageId)

    // 创建超时错误
    const error = new WebSocketServiceError(
      WebSocketErrorCode.E_TIMEOUT,
      `请求超时: ${pending.method} (${messageId})`
    )

    // 执行 reject
    pending.reject(error)

    logger.warn(`[RequestStateManager] 请求超时: ${messageId} (${pending.method})`)
  }

  /**
   * 当客户端断开连接时，拒绝该客户端的所有待处理请求
   * @param clientId 客户端ID
   */
  rejectByClient(clientId: string): void {
    const toReject: string[] = []

    this.pendingRequests.forEach((pending, id) => {
      if (pending.clientId === clientId) {
        toReject.push(id)
      }
    })

    for (const id of toReject) {
      const pending = this.pendingRequests.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(id)
        pending.reject(
          new WebSocketServiceError(
            WebSocketErrorCode.E_CONNECTION_CLOSED,
            // 这句是给模型看的，所以把「接下来该干什么」直接写进去。
            //
            // 一条请求执行到一半连接没了，最常见的原因就是这条请求把编辑器
            // 搞崩了。原来只说「客户端已断开连接」，模型的合理反应是等重连、
            // 然后**原样重试** —— 2026-09-02 真机上就这么连崩两次编辑器。
            `引擎在执行 ${pending.method} 的过程中断开了连接（编辑器崩溃、被关掉，或插件停了）。` +
              `这条命令可能只做了一半。先确认引擎状态并检查参数，不要用同样的参数直接重试 ——` +
              `如果是它把编辑器弄崩的，重试就是再崩一次。(${clientId})`
          )
        )
      }
    }

    if (toReject.length > 0) {
      logger.info(
        `[RequestStateManager] 已拒绝客户端 ${clientId} 的 ${toReject.length} 个待处理请求`
      )
    }
  }

  /**
   * 检查请求是否存在
   * @param messageId 消息ID
   */
  hasPending(messageId: string): boolean {
    return this.pendingRequests.has(messageId)
  }

  /**
   * 清理所有待处理请求
   * 在服务关闭时调用
   */
  cleanup(): void {
    const count = this.pendingRequests.size
    if (count === 0) {
      return
    }

    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(
        new WebSocketServiceError(WebSocketErrorCode.E_CONNECTION_CLOSED, '服务已关闭')
      )
    })

    this.pendingRequests.clear()
    logger.info(`[RequestStateManager] 已清理 ${count} 个待处理请求`)
  }
}
