/**
 * WebSocket 服务类型定义
 * 根据 UnrealAgent WebSocket Server 开发规格说明书 (V1.0) 定义
 */

/**
 * 服务状态枚举
 * 表示 WebSocket 服务端的运行状态
 */
export enum ServerState {
  /** 空闲状态，服务未启动 */
  Idle = 'idle',
  /** 监听状态，服务正在运行 */
  Listening = 'listening',
  /** 错误状态，服务遇到异常 */
  Error = 'error'
}

/**
 * 消息类型枚举
 * 用于协议分拣
 */
export type MessageEnvelopeType = 'req' | 'res' | 'evt'

/**
 * 基础消息信封
 * 符合规格说明书的消息格式要求 (JSON-RPC 风格)
 */
export interface IMessageEnvelope {
  /** 协议版本 */
  ver: string
  /** 消息类型：请求/响应/事件 */
  type: MessageEnvelopeType
  /** 消息唯一标识 */
  id?: string
  /** 方法名称 */
  method?: string
  /** 消息载荷（兼容旧格式） */
  payload?: unknown
  /** 请求参数（JSON-RPC 风格，用于 req 类型） */
  params?: unknown
  /** 时间戳（毫秒） */
  time: number
}

/**
 * 请求消息
 */
export interface IRequestMessage extends IMessageEnvelope {
  type: 'req'
  id: string
  method: string
}

/**
 * 响应消息
 */
export interface IResponseMessage extends IMessageEnvelope {
  type: 'res'
  id: string
  /** 是否成功 */
  success?: boolean
  /** 错误信息 */
  error?: string
}

/**
 * 事件消息
 */
export interface IEventMessage extends IMessageEnvelope {
  type: 'evt'
  method: string
}

/**
 * 暂存请求项
 * 用于请求状态管理器追踪待处理的请求
 */
export interface PendingRequest<T = unknown> {
  /** 请求ID */
  id: string
  /** 请求方法名 */
  method: string
  /** Promise resolve 回调 */
  resolve: (value: T) => void
  /** Promise reject 回调 */
  reject: (reason: Error) => void
  /** 超时计时器 */
  timer: NodeJS.Timeout
  /** 创建时间戳 */
  createdAt: number
  /** 目标客户端ID（可选） */
  clientId?: string
}

/**
 * 事件监听器
 */
export interface EventListener {
  /** 监听的方法名 */
  method: string
  /**
   * 回调函数。
   *
   * `method` 是第三个参数而不是第一个，纯粹是为了不改动已有调用点的前两个参数。
   * 订阅 `'*'` 的消费者必须靠它才知道收到的是什么事件 —— 以前转发给渲染进程时
   * 只带了 payload 和 clientId，界面拿到一个匿名对象，什么也做不了。
   */
  callback: (payload: unknown, clientId?: string, method?: string) => void
}

/**
 * WebSocket 服务接口
 * 规格说明书要求的服务能力接口
 */
export interface IWebSocketService {
  /**
   * 启动服务
   * @param port 端口号
   */
  startServer(port: number): Promise<void>

  /**
   * 停止服务
   */
  stopServer(): Promise<void>

  /**
   * 获取服务状态
   */
  getServerState(): ServerState

  /**
   * 发送单向通知（不等待回复）
   * @param method 方法名
   * @param payload 消息载荷
   * @param clientId 目标客户端ID，不指定则广播
   */
  emitEvent(method: string, payload: unknown, clientId?: string): void

  /**
   * 发送请求并等待结果（RPC 模式）
   * @param method 方法名
   * @param payload 请求载荷
   * @param clientId 目标客户端ID
   * @param timeout 超时时间（毫秒）
   * @param signal 中止信号。已中止就不发；发出后中止则当场作废这条请求
   */
  callRequest<T>(
    method: string,
    payload: unknown,
    clientId?: string,
    timeout?: number,
    signal?: AbortSignal
  ): Promise<T>

  /**
   * 订阅来自 UE 的消息
   * @param method 订阅的方法名
   * @param callback 回调函数
   * @returns 取消订阅的函数
   */
  onEvent(
    method: string,
    callback: (payload: unknown, clientId?: string, eventMethod?: string) => void
  ): () => void
}

/**
 * 服务状态信息
 */
export interface WebSocketServiceStatus {
  /** 服务状态 */
  state: ServerState
  /** 监听端口 */
  port: number
  /** 启动时间 */
  startedAt?: number
  /**
   * 启动失败的原因，一句用户能照着做的话。
   *
   * 服务起不来不再让整个应用退出（见 `services/index.ts`），所以原因必须
   * 有地方可查 —— 否则表现是「盒子开着，引擎永远连不上，谁也说不出为什么」。
   */
  startError?: string
}

/**
 * WebSocket 错误码
 */
export enum WebSocketErrorCode {
  /** 端口被占用 */
  E_ADDRINUSE = 'E_ADDRINUSE',
  /** 连接已断开 */
  E_CONNECTION_CLOSED = 'E_CONNECTION_CLOSED',
  /** 请求超时 */
  E_TIMEOUT = 'E_TIMEOUT',
  /** 无效消息格式 */
  E_INVALID_MESSAGE = 'E_INVALID_MESSAGE',
  /** 客户端未找到 */
  E_CLIENT_NOT_FOUND = 'E_CLIENT_NOT_FOUND',
  /** 响应体积超过 config.message.maxBytes */
  E_MESSAGE_TOO_LARGE = 'E_MESSAGE_TOO_LARGE',
  /**
   * 调用方不等了（用户按了停止）。
   *
   * 和 `E_TIMEOUT` 分开：超时是「引擎没在规定时间内答话」，这个是
   * 「我们主动不等了」。两者的**共同点**是引擎那边可能已经做完了，所以
   * 都不能当成「没做」；分开是因为给用户的话不一样，一个要去看引擎卡没卡，
   * 一个是他自己刚点的。
   */
  E_ABORTED = 'E_ABORTED'
}

/**
 * WebSocket 服务异常
 */
export class WebSocketServiceError extends Error {
  constructor(
    public code: WebSocketErrorCode,
    message: string,
    /**
     * 给模型的下一步建议，**不给用户看**。
     *
     * 这个错误有两个去向：agent 工具（终点是模型）和 `ws:call` IPC（终点是界面）。
     * 合成一句的话，写给模型的「用 ue_session_health 看看」就会弹给一个根本
     * 看不见这个工具的用户 —— 正是「写给 AI 的话给了用户」那类问题。
     * 所以 `message` 只放面向用户那句，这一句由 agent 侧自己拼上去。
     *
     * 同一条处理见 `services/agentBrowser/extract.ts` 的 `WebReadResult.agentHint`。
     */
    public agentHint?: string
  ) {
    super(message)
    this.name = 'WebSocketServiceError'
  }
}

/**
 * 协议版本
 */
export const PROTOCOL_VERSION = '1.0'

/**
 * 默认配置
 */
export const DEFAULT_CONFIG = {
  /** 默认端口 */
  port: 17860,
  /** 默认超时时间（毫秒） */
  timeout: 5000,
  /** 心跳间隔（毫秒） */
  heartbeatInterval: 15000,
  /** 心跳超时（毫秒） */
  heartbeatTimeout: 45000
}
