/**
 * 服务相关类型定义
 */
import type { WebSocket } from 'ws'

// 导出 AI3D 相关类型

// 消息类型枚举
export enum MessageType {
  COMMAND = 'command',
  EVENT = 'event',
  REPLY = 'reply',
  ERROR = 'error'
}

// 消息信封接口
export interface MessageEnvelope {
  id: string
  type: MessageType
  topic: string
  correlationId?: string
  payload: any
  timestamp?: number
}

// 任务状态枚举
export enum TaskState {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED'
}

// 任务状态枚举（兼容性别名）
export enum TaskStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED'
}

// 任务进度接口
export interface TaskProgress {
  percent: number
  message?: string
  details?: any
}

// 任务接口
export interface Task {
  id: string
  type: string
  state: TaskState
  status: TaskStatus
  percent: number
  progress: number
  payload: any
  metadata?: any
  priority: number
  result?: any
  error?: string
  startedAt: number
  updatedAt: number
  createdAt: number
  completedAt?: number
  params?: any
  connectionId?: string
  progressMessage?: string
}

// 连接信息接口
export interface ConnectionInfo {
  id: string
  /**
   * `ws` 的 WebSocket 实例。
   *
   * 以前是 `any`，于是 `connection.socket.close()` 这种写法编译期什么都不查 ——
   * 而心跳超时那条路径漏掉 `terminate()` 造成的半断开，正是这类写法藏得住的问题。
   */
  socket: WebSocket
  lastHeartbeat: number
  isAlive: boolean
  connectedAt?: number
}

// 服务配置接口
export interface ServiceConfig {
  http: {
    port: number
    host: string
    uploadDir: string
    maxFileSize: number
    corsOrigins: string[]
    enabled: boolean
    cors: any
    authToken?: string
  }
  websocket: {
    port: number
    heartbeatInterval: number
    heartbeatTimeout: number
  }
  ws: {
    port: number
    heartbeatInterval: number
    heartbeatTimeout: number
  }
  queue: {
    inboundCapacity: number
    outboundCapacity: number
  }
  task: {
    defaultTimeoutSec: number
    maxConcurrent: number
  }
  logging: {
    level: string
  }
  message: {
    maxBytes: number
  }
}

// 消息处理器接口
export interface IMessageHandler {
  handle(envelope: MessageEnvelope, connectionId: string): Promise<void>
}

// 消息处理器类型
export type MessageHandler = (envelope: MessageEnvelope, connectionId: string) => Promise<void>

// 路由配置接口
export interface RouteConfig {
  topic: string
  handler: MessageHandler
}

// 服务统计信息接口
export interface ServiceStats {
  wsClients: number
  inboundDepth: number
  outboundDepth: number
  tasksTotal: Record<TaskState, number>
  handlerErrors: number
  uptime: number
}

// 队列项接口
export interface QueueItem {
  message: MessageEnvelope
  connectionId?: string
  priority: number
  timestamp: number
}
