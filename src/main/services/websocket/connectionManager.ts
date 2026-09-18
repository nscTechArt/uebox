/**
 * WebSocket连接管理器
 */
import { v4 as uuidv4 } from 'uuid'
import type { WebSocket } from 'ws'
import { ConnectionInfo } from '../types'
import { logger } from '../logger'
import { config } from '../config'

export class ConnectionManager {
  private connections = new Map<string, ConnectionInfo>()
  private heartbeatTimer?: NodeJS.Timeout
  private onHeartbeatTimeoutCallback?: (connectionId: string) => void

  /**
   * 心跳检查不在构造时启动。
   *
   * 原来是构造时启一次，`stop()` 里 clearInterval —— 而 `ConnectionManager`
   * 的生命周期比服务器长（`WebSocketService` 只在构造时 new 一次）。
   * 于是「停服再起服」之后心跳检查永久消失：连接超时不再被发现，
   * 掉线的工程会一直挂在列表里。改成跟着 start/stop 走。
   */
  start(): void {
    this.startHeartbeatCheck()
  }

  /**
   * 设置心跳超时回调
   * @param callback 当检测到心跳超时时调用的回调函数
   */
  setOnHeartbeatTimeout(callback: (connectionId: string) => void): void {
    this.onHeartbeatTimeoutCallback = callback
  }

  /**
   * 添加连接
   */
  addConnection(socket: WebSocket): string {
    const connectionId = uuidv4()
    const connectionInfo: ConnectionInfo = {
      id: connectionId,
      socket,
      lastHeartbeat: Date.now(),
      isAlive: true,
      connectedAt: Date.now()
    }

    this.connections.set(connectionId, connectionInfo)
    logger.info(`WebSocket连接已建立: ${connectionId}`)

    return connectionId
  }

  /**
   * 移除连接，并**真正关掉底层 socket**。
   *
   * 原来这里只从 Map 里 delete。心跳超时走的就是这条路，于是产生半断开：
   * 盒子这边认为连接没了，socket 却还开着、监听器还挂着。对面如果其实活着
   * （只是卡了一会儿），它会继续往这个 socket 发消息 —— 消息照样进
   * `handleMessage`，但连接已经不在池子里，回包发不出去，而插件那侧
   * 因为 socket 没断也不会触发重连。表现就是「盒子说没连，UE 说连着」。
   *
   * `terminate()` 而不是 `close()`：走到这一步说明对面已经没响应了，
   * 等一个永远不会来的 close 握手没有意义。
   *
   * @returns 这个连接此前是否存在（用于让断线流程幂等）
   */
  removeConnection(connectionId: string): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      return false
    }

    this.connections.delete(connectionId)

    try {
      connection.socket.removeAllListeners()
      connection.socket.terminate()
    } catch (error) {
      logger.warn(`关闭 socket 失败 ${connectionId}:`, error)
    }

    logger.info(`WebSocket连接已断开: ${connectionId}`)
    return true
  }

  /**
   * 获取连接
   */
  getConnection(connectionId: string): ConnectionInfo | undefined {
    return this.connections.get(connectionId)
  }

  /**
   * 获取所有连接
   */
  getAllConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values())
  }

  /**
   * 获取连接数量
   */
  getConnectionCount(): number {
    return this.connections.size
  }

  /**
   * 更新心跳时间
   */
  updateHeartbeat(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (connection) {
      connection.lastHeartbeat = Date.now()
      connection.isAlive = true
    }
  }

  /**
   * 向指定连接发送消息
   */
  sendToConnection(connectionId: string, message: string): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection || !connection.isAlive) {
      return false
    }

    try {
      connection.socket.send(message)
      return true
    } catch (error) {
      logger.error(`发送消息失败 ${connectionId}:`, error)
      this.markConnectionDead(connectionId)
      return false
    }
  }

  /**
   * 广播消息到所有连接
   */
  broadcast(message: string): number {
    let successCount = 0

    this.connections.forEach((connection, connectionId) => {
      if (connection.isAlive) {
        try {
          connection.socket.send(message)
          successCount++
        } catch (error) {
          logger.error(`广播消息失败 ${connectionId}:`, error)
          this.markConnectionDead(connectionId)
        }
      }
    })

    return successCount
  }

  /**
   * 标记连接为死亡状态
   */
  private markConnectionDead(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (connection) {
      connection.isAlive = false
      logger.warn(`连接标记为死亡状态: ${connectionId}`)
    }
  }

  /**
   * 启动心跳检查
   */
  private startHeartbeatCheck(): void {
    if (this.heartbeatTimer) {
      return
    }
    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeats()
    }, config.ws.heartbeatInterval)
  }

  /**
   * 检查心跳并发送 ping 帧
   * 服务端主动发送 WebSocket 协议层的 ping 帧，客户端会自动回复 pong
   */
  private checkHeartbeats(): void {
    const now = Date.now()
    const timeout = config.ws.heartbeatTimeout
    const deadConnections: string[] = []

    this.connections.forEach((connection, connectionId) => {
      // 检查是否超时
      if (now - connection.lastHeartbeat > timeout) {
        deadConnections.push(connectionId)
        this.markConnectionDead(connectionId)
      } else if (connection.isAlive) {
        // 向存活的连接发送 ping 帧
        try {
          connection.socket.ping()
        } catch (error) {
          logger.warn(`发送 ping 失败 ${connectionId}:`, error)
          this.markConnectionDead(connectionId)
          deadConnections.push(connectionId)
        }
      }
    })

    // 清理死亡连接。
    //
    // 统一交给外部那一条断线流程（WebSocketService.handleDisconnect），
    // 它会按顺序做：拒绝该连接的待处理请求 → 删项目 → 移除连接 → 发事件。
    // 这里自己 removeConnection 的话就会跳过「拒绝待处理请求」那一步，
    // 那些 Promise 只能等超时。
    for (const connectionId of deadConnections) {
      if (this.onHeartbeatTimeoutCallback) {
        this.onHeartbeatTimeoutCallback(connectionId)
      } else {
        // 没挂回调时至少别把连接漏在池子里
        this.removeConnection(connectionId)
      }
    }

    if (deadConnections.length > 0) {
      logger.warn(`清理了 ${deadConnections.length} 个超时连接`)
    }
  }

  /**
   * 停止心跳检查
   */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }

    // 关闭所有连接。走 removeConnection 而不是自己 close ——
    // 摘监听器这一步别漏，否则关闭过程本身还会再触发一轮 close 回调。
    for (const connectionId of Array.from(this.connections.keys())) {
      this.removeConnection(connectionId)
    }

    logger.info('连接管理器已停止')
  }
}
