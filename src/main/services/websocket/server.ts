/**
 * WebSocket 服务端
 * 根据 UnrealAgent WebSocket Server 开发规格说明书 (V1.0) 实现
 */
import { WebSocketServer, WebSocket } from 'ws'
import { ConnectionManager } from './connectionManager'
import { RequestStateManager } from './requestStateManager'
import { logger } from '../logger'
import { config } from '../config'
import { projectManager } from '../project'
import { MessageEnvelope, MessageType } from '../types'
import {
  ServerState,
  IWebSocketService,
  IMessageEnvelope,
  EventListener,
  WebSocketServiceStatus,
  WebSocketErrorCode,
  WebSocketServiceError,
  PROTOCOL_VERSION,
  DEFAULT_CONFIG
} from './types'

/**
 * 入站消息的去处。实际接的是 `MessageRouter.route`。
 *
 * 这里曾经隔着一整个 `MessageGateway` + `MessageQueue`：入站消息先进一个
 * 4096 容量的队列，再由一个每 10ms 醒一次的 setTimeout 循环取出来交给路由器。
 * 那套东西 530 行，服务的是**四种**消息（project.info / project.closed /
 * content.import_folder / content.import_assets），而且那个定时器空转
 * 一秒 100 次、永不停止。
 *
 * 本地插件直连、消息量以「用户点一下菜单」为单位，队列和限流都没有对象。
 * 直接调用。真需要背压时再说 —— 到那时也该是 per-connection 的，
 * 而不是一个全局队列。
 */
type InboundHandler = (message: MessageEnvelope, connectionId: string) => Promise<void>

/**
 * WebSocket 服务类
 * 实现与 Unreal Engine 实例的通讯
 */
/** 同一条连接连续这么多次请求超时，就当它死了（见 `trackLiveness`） */
const ZOMBIE_TIMEOUT_STREAK = 3
/** 探活等多久。只读的项目信息，活着的编辑器一两秒内就答 */
const PROBE_TIMEOUT_MS = 8_000

export class WebSocketService implements IWebSocketService {
  private server?: WebSocketServer
  private connectionManager: ConnectionManager
  private requestStateManager: RequestStateManager
  private onInbound: InboundHandler
  private eventListeners: EventListener[] = []
  private serverState: ServerState = ServerState.Idle
  private currentPort: number = DEFAULT_CONFIG.port
  private startedAt?: number
  /**
   * 起不来的原因，一句用户能照着做的话。
   *
   * 起不来**不再是致命错误**（见 `services/index.ts` 的说明），所以这个原因必须
   * 留在状态里 —— 否则应用照常开着、引擎却永远连不上，而没有任何地方说得出为什么。
   */
  private startError?: string

  constructor(onInbound: InboundHandler) {
    this.connectionManager = new ConnectionManager()
    this.requestStateManager = new RequestStateManager()
    this.onInbound = onInbound

    // 心跳超时走的是和正常断开完全相同的那条流程。
    //
    // 以前这个回调只删项目，连接的清理和「拒绝待处理请求」都各自零散地做，
    // 结果就是超时断开和正常断开的善后不一致。
    this.connectionManager.setOnHeartbeatTimeout((connectionId: string) => {
      logger.warn(`[WebSocketService] 连接心跳超时: ${connectionId}`)
      this.handleDisconnect(connectionId)
    })
  }

  /**
   * 启动 WebSocket 服务器
   * @param port 端口号
   */
  async startServer(port?: number): Promise<void> {
    if (this.serverState === ServerState.Listening) {
      logger.warn('[WebSocketService] 服务器已在运行')
      return
    }

    const targetPort = port ?? config.ws.port ?? DEFAULT_CONFIG.port
    this.currentPort = targetPort

    try {
      await this.createServer(targetPort)
      this.connectionManager.start()
      this.serverState = ServerState.Listening
      this.startedAt = Date.now()
      // 起来了就把上一次的失败原因擦掉。不擦的话 `getStatus()` 会一直带着它，
      // 用户关掉占用端口的程序、重启桥接之后，界面上的横幅仍然说连不上
      this.startError = undefined
      logger.info(`[WebSocketService] 服务器已启动，监听端口: ${targetPort}`)
      this.broadcastStatus()
    } catch (error: unknown) {
      this.serverState = ServerState.Error
      const err = error as NodeJS.ErrnoException
      this.startError = describeListenError(err, targetPort)
      this.broadcastStatus()
      if (err.code === 'EADDRINUSE') {
        throw new WebSocketServiceError(WebSocketErrorCode.E_ADDRINUSE, this.startError)
      }
      throw error
    }
  }

  /**
   * 把桥接状态推给界面。
   *
   * 渲染层原来只在挂载时问一次 `ws:status`，于是两个方向都坏：用户修好端口冲突
   * 重启桥接后横幅还挂着；运行中桥接被停掉或重启失败则根本不提示 —— 回到
   * 「应用一切正常、UE 永远连不上」那个症状。状态会变，就得推。
   *
   * 动态 import `appWindows`：这个文件在服务启动路径上，不该把 electron 的
   * 窗口模块拉进它的静态依赖图。
   */
  private broadcastStatus(): void {
    const status = this.getStatus()
    void import('../../appWindows')
      .then(({ sendToAppWindows }) => sendToAppWindows('ws:status-changed', status))
      .catch((err) => logger.warn('[WebSocketService] 推送状态失败:', err))
  }

  /**
   * 创建 WebSocket 服务器
   */
  private createServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({
        host: '127.0.0.1',
        port,
        // 协议层的硬上限。留一倍余量给应用层的 config.message.maxBytes ——
        // 应用层超限能定位到具体请求并回一个像样的错误，协议层超限只能断连，
        // 所以正常情况下应该是应用层先拦下。这一层是兜底，防的是恶意超大帧
        // 把主进程的内存吃光。
        maxPayload: config.message.maxBytes * 2,
        verifyClient: (info, done) => {
          // 浏览器 WebSocket 不受 CORS 约束，外部网页可以直接连接回环端口。
          // 不能简单拒绝所有 Origin：UE 的 libwebsockets 会发送这个回环 Origin；
          // 部分原生客户端则不发送 Origin。只放行这两种已知握手，拒绝网页来源。
          // 这只是浏览器攻击面的门槛，本机进程仍能伪造；完整认证需要令牌握手。
          const origin = info.origin ?? info.req.headers.origin
          if (!origin || origin === 'http://127.0.0.1') {
            done(true)
            return
          }

          logger.warn(`[WebSocketService] 拒绝非回环网页来源的连接: ${origin}`)
          done(false, 403, 'Forbidden')
        }
      })

      this.server.on('listening', () => {
        // 端口传 0 时由系统分配，`targetPort` 只是「我们要求的」而不是
        // 「实际监听的」。回填真实端口，否则 getStatus() 会报 0。
        const address = this.server?.address()
        if (address && typeof address === 'object') {
          this.currentPort = address.port
        }
        resolve()
      })

      this.server.on('error', (error) => {
        reject(error)
      })

      this.server.on('connection', (socket: WebSocket) => {
        this.handleConnection(socket)
      })
    })
  }

  /**
   * 停止 WebSocket 服务器
   */
  async stopServer(): Promise<void> {
    if (this.serverState !== ServerState.Listening) {
      return
    }

    try {
      // 停服也要走**正常那条断线流程**，一个连接一个连接地走。
      //
      // 以前是直接 `connectionManager.stop()`，那条路只摘连接、不碰
      // projectManager —— 于是停服之后每个工程都以 `isConnected: true` 留在
      // 列表里，界面和 Agent 一直看到「已连接」，直到整个应用重开。日志上的
      // 形状很好认：只有「WebSocket连接已断开」，后面没有跟着「工程已删除」。
      //
      // 退出应用时无所谓，但 `ws:stop` 这个 IPC 和 `serviceManager.restart()`
      // 是运行期就能走到的，那时候这个残留就是实打实的「状态永远在线」。
      for (const connection of this.connectionManager.getAllConnections()) {
        this.handleDisconnect(connection.id)
      }

      // 清理请求状态管理器
      this.requestStateManager.cleanup()

      // 停止连接管理器（上面那轮之后通常已经空了，这里负责停心跳定时器
      // 和兜底清理任何漏网的连接）
      this.connectionManager.stop()

      // 关闭服务器
      if (this.server) {
        await new Promise<void>((resolve, reject) => {
          this.server!.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      }

      this.serverState = ServerState.Idle
      this.startedAt = undefined
      logger.info('[WebSocketService] 服务器已停止')
      this.broadcastStatus()
    } catch (error) {
      this.serverState = ServerState.Error
      logger.error('[WebSocketService] 停止服务器失败:', error)
      this.broadcastStatus()
      throw error
    }
  }

  /**
   * 获取服务状态
   */
  getServerState(): ServerState {
    return this.serverState
  }

  /**
   * 获取详细服务状态
   */
  getStatus(): WebSocketServiceStatus {
    return {
      state: this.serverState,
      port: this.currentPort,
      startedAt: this.startedAt,
      ...(this.startError ? { startError: this.startError } : {})
    }
  }

  /**
   * 发送单向通知（不等待回复）
   */
  emitEvent(method: string, payload: unknown, clientId?: string): void {
    const envelope: IMessageEnvelope = {
      ver: PROTOCOL_VERSION,
      type: 'evt',
      method,
      payload,
      time: Date.now()
    }

    const messageText = JSON.stringify(envelope)

    if (clientId) {
      const success = this.connectionManager.sendToConnection(clientId, messageText)
      if (!success) {
        logger.warn(`[WebSocketService] 发送事件失败，连接不存在: ${clientId}`)
      }
    } else {
      this.connectionManager.broadcast(messageText)
    }
  }

  /**
   * 发送请求并等待结果（RPC 模式）
   *
   * ## `signal` 是给「用户按了停止」用的
   *
   * agent 的一个工具往往要连发好几条 RPC。不接这个信号的话，用户停下之后
   * 剩下那几条照样会发到引擎去 —— 而且每一条都得等满自己的超时，界面上
   * 那个停止按钮就一直转着。接了之后：已经中止的直接不发，发出去还没回来的
   * 当场从暂存池里作废，后面的步骤自然也不会再发。
   *
   * **作废的只是这一侧的等待**，引擎那边已经在做的事撤不回来 —— 所以错误
   * 码是 `E_ABORTED`（结局不明），不是「没执行」。
   */
  async callRequest<T>(
    method: string,
    payload: unknown,
    clientId?: string,
    timeout?: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      throw new WebSocketServiceError(WebSocketErrorCode.E_ABORTED, `已停止，${method} 没有发出去`)
    }

    // 先把目标连接定下来，再登记 pending。
    //
    // 原来的顺序是反的：不指定 clientId 时以 `clientId=undefined` 登记，
    // 然后才去挑 `connections[0]` 发出去。于是这个请求在暂存池里没有归属，
    // 对面断开时 `rejectByClient()` 匹配不到它，调用方只能等到超时
    // ——「引擎已经关了」这件事明明是立刻可知的。
    const targetId = clientId ?? this.pickDefaultConnectionId()
    if (!targetId) {
      throw new WebSocketServiceError(WebSocketErrorCode.E_CLIENT_NOT_FOUND, '没有可用的客户端连接')
    }

    const conn = this.connectionManager.getConnection(targetId)
    if (!conn || !conn.isAlive) {
      /*
       * 连接 id 只进日志，不进 message。
       *
       * 这个错一路回到模型，模型再转述给用户 —— 原来那句「客户端不存在或已断开:
       * 3f2a8c1e-…」里，用户唯一读得懂的部分是「已断开」，那串 uuid 纯属噪声，
       * 还让整句话读起来像是他哪里配错了。排查时要的是日志，不是聊天记录。
       */
      console.warn(`[WS] ${method} 的目标连接已失效: ${targetId}`)
      throw new WebSocketServiceError(
        WebSocketErrorCode.E_CLIENT_NOT_FOUND,
        // 面向用户那句：不出现工具名。这个错也经 `ws:call` 回到渲染层，
        // 任何一处改成 message.error(res.error) 就会把工具名弹给用户
        '这条引擎连接已经断开了（编辑器关了或重启过）。',
        // 给模型的下一步，由 agent 侧拼接
        '用 ue_session_health 看看现在是什么状态，再决定是等插件重连还是让用户打开工程。'
      )
    }

    // 创建请求
    const { promise, messageId } = this.requestStateManager.createRequest<T>(
      method,
      targetId,
      timeout
    )

    // 构建请求消息 (JSON-RPC 风格，使用 params)
    const envelope: IMessageEnvelope = {
      ver: PROTOCOL_VERSION,
      type: 'req',
      id: messageId,
      method,
      params: payload,
      time: Date.now()
    }

    const messageText = JSON.stringify(envelope)

    // 发送请求
    const success = this.connectionManager.sendToConnection(targetId, messageText)
    if (!success) {
      this.requestStateManager.rejectRequest(
        messageId,
        new WebSocketServiceError(WebSocketErrorCode.E_CONNECTION_CLOSED, '发送失败')
      )
    }

    const tracked = this.trackLiveness(promise, targetId, method)
    if (!signal) return tracked

    const onAbort = (): void => {
      this.requestStateManager.rejectRequest(
        messageId,
        new WebSocketServiceError(
          WebSocketErrorCode.E_ABORTED,
          `已停止，不再等 ${method} 的结果（引擎那边可能已经做完了）`
        )
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // 监听器必须摘干净。信号活得比这条请求久（一整轮对话共用一个），
    // 攒着不摘的话一轮里几十次调用就是几十个死监听器挂在同一个信号上。
    return tracked.finally(() => signal.removeEventListener('abort', onAbort))
  }

  /** 每条连接连续超时了几次。任何一次正常回包就清零 */
  private readonly timeoutStreaks = new Map<string, number>()

  /**
   * 僵尸连接：socket 还开着、心跳也还回，但请求一条都不答。
   *
   * 2026-09-26 真机反馈：编辑器崩在引擎自己的断言里，崩溃处理还没走完，进程和
   * socket 都挂着 —— 心跳由网络线程答，照样通过；可游戏线程已经死了，每一条请求
   * 都超时。盒子一直当它连着：健康检查报 connected、`open_project` 说「本来就开着」
   * 不肯重开，全队停摆二十分钟。
   *
   * 所以按「答不答话」而不是「socket 在不在」判活：同一条连接连续
   * `ZOMBIE_TIMEOUT_STREAK` 次请求超时、中间一次都没答上，就把它当死了断掉。
   * 断开之后：编辑器真死了，看护会重开工程（工作室模式）；只是卡了一阵的话，
   * 插件缓过来会自己重连。两种结局都比一直抱着一条死连接强。
   */
  private trackLiveness<T>(promise: Promise<T>, connectionId: string, method: string): Promise<T> {
    return promise.then(
      (value) => {
        this.timeoutStreaks.delete(connectionId)
        return value
      },
      (error: unknown) => {
        if (error instanceof WebSocketServiceError && error.code === WebSocketErrorCode.E_TIMEOUT) {
          const streak = (this.timeoutStreaks.get(connectionId) ?? 0) + 1
          this.timeoutStreaks.set(connectionId, streak)
          // 还有别的请求在路上（比如一次长导入正占着游戏线程）：短请求超时是因为它忙，
          // 不是因为它死了。这时候断开会把那次长操作的回包也一起丢掉
          const busy = this.requestStateManager.pendingCount(connectionId) > 0
          if (streak >= ZOMBIE_TIMEOUT_STREAK && !busy) {
            logger.warn(
              `[WebSocketService] 连接连续 ${streak} 次请求超时（最后一次 ${method}），按僵尸连接断开: ${connectionId}`
            )
            this.timeoutStreaks.delete(connectionId)
            this.handleDisconnect(connectionId)
          }
        }
        throw error
      }
    )
  }

  /**
   * 这条连接此刻答不答话：发一条只读命令，限时等回包。
   * 健康检查、`open_project` 判断「连着」之前用它，别再只看 socket 在不在。
   */
  async probeConnection(
    connectionId: string,
    timeoutMs = PROBE_TIMEOUT_MS
  ): Promise<'alive' | 'busy' | 'dead'> {
    // 有请求在路上就是忙，不去插队探它（探不通也说明不了死没死）
    if (this.requestStateManager.pendingCount(connectionId) > 0) return 'busy'
    try {
      await this.callRequest('system.get_project_info', {}, connectionId, timeoutMs)
      return 'alive'
    } catch {
      return 'dead'
    }
  }

  /** 把一条确认不答话的连接断掉，走和正常断开同一条善后流程 */
  dropConnection(connectionId: string, reason: string): void {
    logger.warn(`[WebSocketService] 断开不答话的连接（${reason}）: ${connectionId}`)
    this.timeoutStreaks.delete(connectionId)
    this.handleDisconnect(connectionId)
  }

  /**
   * 没有指定目标时用哪个连接。
   *
   * 只有**恰好一个**存活连接时才回退，多个连接时返回 undefined 让调用方失败。
   *
   * 以前这里是「取第一个」。多开 UE 时那等于把指令随机发给其中一个工程 ——
   * 而且是静默的：用户看到的是「命令执行成功了，但我的场景没变」。
   * 猜错工程的代价（改错别人的关卡）远高于报一个错，所以宁可不猜。
   */
  private pickDefaultConnectionId(): string | undefined {
    const alive = this.connectionManager.getAllConnections().filter((conn) => conn.isAlive)
    if (alive.length === 1) return alive[0].id
    if (alive.length > 1) {
      logger.warn(
        `[WebSocketService] 有 ${alive.length} 个已连接工程但未指定目标，拒绝猜测。调用方应传 clientId。`
      )
    }
    return undefined
  }

  /**
   * 订阅来自 UE 的消息
   */
  onEvent(
    method: string,
    callback: (payload: unknown, clientId?: string, eventMethod?: string) => void
  ): () => void {
    const listener: EventListener = { method, callback }
    this.eventListeners.push(listener)

    // 返回取消订阅函数
    return () => {
      const index = this.eventListeners.indexOf(listener)
      if (index > -1) {
        this.eventListeners.splice(index, 1)
      }
    }
  }

  /**
   * 处理新连接
   */
  private handleConnection(socket: WebSocket): void {
    const connectionId = this.connectionManager.addConnection(socket)

    // 这里**不广播** ws:status。界面要的是「哪些工程连着」，那是
    // `ws:projects-changed` 的事，而且它在 project.info 到了之后才发 ——
    // 套接字刚开还没自报家门时就说「多了一个工程」，等于替一个还没确认
    // 是不是编辑器的连接打包票。

    // 设置消息处理
    socket.on('message', (data: Buffer) => {
      this.handleMessage(connectionId, data)
    })

    // 设置关闭处理
    socket.on('close', () => {
      this.handleDisconnect(connectionId)
    })

    // 设置错误处理
    socket.on('error', (error: Error) => {
      logger.error(`[WebSocketService] 连接错误 ${connectionId}:`, error)
      this.handleDisconnect(connectionId)
    })

    // 设置 pong 处理
    socket.on('pong', () => {
      this.connectionManager.updateHeartbeat(connectionId)
    })

    // 发送欢迎消息
    const welcome: IMessageEnvelope = {
      ver: PROTOCOL_VERSION,
      type: 'evt',
      method: 'system.connected',
      payload: { connectionId },
      time: Date.now()
    }
    socket.send(JSON.stringify(welcome))

    // 本地也要广播一次。`ipc/websocket.ts` 订阅了 `system.connected` 用来
    // 通知渲染进程「有工程连上了」，但以前这个事件只发给了 UE，从没在本地
    // 触发过 —— 于是界面只能收到断开、收不到连接。
    this.emitToListeners('system.connected', { connectionId }, connectionId)
  }

  /**
   * 处理收到的消息
   */
  private handleMessage(connectionId: string, data: Buffer): void {
    try {
      this.connectionManager.updateHeartbeat(connectionId)

      // 解析消息
      const messageText = data.toString('utf8')
      let envelope: IMessageEnvelope

      try {
        envelope = JSON.parse(messageText)
      } catch {
        logger.warn('[WebSocketService] 收到非 JSON 消息，已忽略')
        return
      }

      // 超大响应必须**先解析再拒绝**，不能直接 return。
      //
      // 原来这里是「太大就 return」，于是调用方那个 Promise 谁也不去动它，
      // 只能等超时（有的工具 60 秒），日志里只有一行 warn，
      // 上层看到的是「虚幻引擎没反应」而不是「响应太大」。
      // 先解析出 id，就能把失败精确地还给那一个请求。
      if (data.length > config.message.maxBytes) {
        const limit = config.message.maxBytes
        const detail = `响应过大：${envelope.method ?? '未知方法'} 返回 ${data.length} 字节，超过上限 ${limit} 字节。请用 limit / 分页参数缩小范围。`
        logger.warn(`[WebSocketService] ${detail}`)
        if (envelope.type === 'res' && envelope.id) {
          this.requestStateManager.rejectRequest(
            envelope.id,
            new WebSocketServiceError(WebSocketErrorCode.E_MESSAGE_TOO_LARGE, detail)
          )
        }
        return
      }

      // 跳过心跳消息的日志打印（心跳消息太频繁，会产生大量日志噪音）
      //
      // 非心跳消息也只在 info 上留一行摘要：整包原文往控制台倒会淹掉别的东西 ——
      // 光一条 project.info 就是六十多行 JSON。原文降到 debug，
      // 需要看的时候 UA_LOG_LEVEL=debug 打开。
      //
      // 原文用 `logger.debug(text, arg)` 而不是模板字符串拼进去：模板字符串
      // 是**先算完再传参**的，日志级别是 info 时那份拼好的副本直接被丢掉。
      // 512KB 的包等于每条白白多分配 512KB。
      if (envelope.method !== 'system.heartbeat') {
        logger.info(
          `[WebSocketService] 收到消息 (${connectionId}): ${envelope.method} · ${data.length} bytes`
        )
        logger.debug(`[WebSocketService] 消息原文 (${connectionId}):`, messageText)
      }

      // 根据类型分流
      this.routeMessage(envelope, connectionId)
    } catch (error) {
      logger.error('[WebSocketService] 处理消息失败:', error)
    }
  }

  /**
   * 消息路由
   */
  private routeMessage(envelope: IMessageEnvelope, connectionId: string): void {
    switch (envelope.type) {
      case 'res':
        // 响应消息 -> 移交请求状态管理器
        // JSON-RPC 风格：响应数据在 result 字段
        if (envelope.id) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rawEnvelope = envelope as any
          // 优先使用 result（JSON-RPC 风格），兼容旧的 data 和 payload 字段
          const code: number | undefined =
            typeof rawEnvelope.code === 'number' ? (rawEnvelope.code as number) : undefined
          const baseData = rawEnvelope.result ?? rawEnvelope.data ?? envelope.payload

          // 统一注入 RPC 元信息，并将错误响应标准化为可被工具/Agent直接消费的结构
          // - 始终附带 __rpc.code
          // - 当 code>=400 时：补齐 ok=false / success=false / error 字段（若不存在）
          let normalized: unknown = baseData
          if (baseData && typeof baseData === 'object') {
            const obj = baseData as Record<string, unknown>
            const rpcMeta = (obj.__rpc as Record<string, unknown> | undefined) || {}
            if (code !== undefined) rpcMeta.code = code
            obj.__rpc = rpcMeta

            if (code !== undefined && code >= 400) {
              if (obj.ok === undefined) obj.ok = false
              if (obj.success === undefined) obj.success = false
              if (obj.error === undefined && typeof obj.message === 'string') {
                obj.error = obj.message
              }
              // 保底带上 code（避免上层丢失 envelope.code）
              if (obj.code === undefined) obj.code = code
            } else if (code !== undefined) {
              // 非错误响应也保留 code，便于上层埋点/诊断
              if (obj.code === undefined) obj.code = code
            }
            normalized = obj
          } else {
            normalized = { __rpc: { code: code ?? null }, data: baseData }
          }

          // 不要写成 `logger.debug(\`...${JSON.stringify(normalized)}\`)`：
          // 那样每收到一个响应就会把整个响应**再序列化一遍**，而日志级别不是
          // debug 时结果直接丢掉。交给 logger 惰性格式化。
          logger.debug('[WebSocketService] 提取的响应数据:', normalized)
          this.requestStateManager.resolveRequest(envelope.id, normalized)
        }
        break

      case 'evt':
        // 心跳消息只用于更新连接状态，不需要路由处理
        if (envelope.method === 'system.heartbeat') {
          // 心跳消息已经通过 updateHeartbeat 更新了连接状态，直接跳过
          return
        }

        // 事件消息 -> 触发监听器
        this.emitToListeners(envelope.method || '', envelope.payload, connectionId)
        // 同时路由到业务处理器（如 content.import_folder）
        this.dispatchInbound(
          {
            id: envelope.id || `evt_${Date.now()}`,
            type: MessageType.EVENT,
            topic: envelope.method || '',
            payload: envelope.payload ?? {},
            timestamp: envelope.time
          },
          connectionId
        )
        break

      case 'req':
        // 请求消息 -> 路由到业务处理器
        this.dispatchInbound(
          {
            id: envelope.id || '',
            type: MessageType.COMMAND,
            topic: envelope.method || '',
            payload: envelope.payload ?? {},
            timestamp: envelope.time
          },
          connectionId
        )
        break

      default:
        logger.warn(`[WebSocketService] 未知消息类型: ${envelope.type}`)
    }
  }

  /**
   * 把入站消息交给路由器。
   *
   * `routeMessage` 是同步的（socket 的 message 回调），而路由是异步的 ——
   * 这里不 await，但**必须**接住 rejection：漏掉的话一个处理器抛异常就是
   * 一条 unhandledRejection，在 Electron 主进程里足以整个崩掉。
   */
  private dispatchInbound(message: MessageEnvelope, connectionId: string): void {
    this.onInbound(message, connectionId).catch((error) => {
      logger.error(`[WebSocketService] 处理入站消息失败 ${message.topic}:`, error)
    })
  }

  /**
   * 给业务处理器回包用。
   *
   * 注意这里发的是**线上格式**（ver/type/method/id/payload），不是内部的
   * `MessageEnvelope`。以前回包走网关，网关直接把内部格式 JSON 出去，
   * 而插件只认 `type`/`method`/`id` —— 那些回包插件根本解析不了。
   */
  sendToClient(connectionId: string, envelope: IMessageEnvelope): boolean {
    return this.connectionManager.sendToConnection(connectionId, JSON.stringify(envelope))
  }

  /**
   * 触发事件监听器
   */
  private emitToListeners(method: string, payload: unknown, clientId?: string): void {
    for (const listener of this.eventListeners) {
      if (listener.method === method || listener.method === '*') {
        try {
          listener.callback(payload, clientId, method)
        } catch (error) {
          logger.error(`[WebSocketService] 事件监听器错误:`, error)
        }
      }
    }
  }

  /**
   * 处理断开连接
   * 注意：如果是心跳超时导致的断开，项目已经在心跳超时回调中被删除了
   */
  private handleDisconnect(connectionId: string): void {
    // 幂等：同一个连接可能从多条路走到这里 —— socket 的 close、socket 的 error、
    // 心跳超时回调。以前每条路各做各的（心跳那条还漏了「拒绝待处理请求」），
    // 现在全部汇到这一个函数，靠连接是否还在池子里来去重。
    if (!this.connectionManager.getConnection(connectionId)) {
      return
    }

    // 顺序有讲究：先把连接从池子里摘掉（同时关掉 socket），
    // 这样后续步骤里任何「往这个连接发东西」的尝试都会明确失败而不是石沉大海。
    this.connectionManager.removeConnection(connectionId)

    // 拒绝该客户端的待处理请求 —— 引擎已经没了，让这些 Promise 立刻失败，
    // 而不是各自等满自己的超时。
    this.requestStateManager.rejectByClient(connectionId)

    if (projectManager.hasProject(connectionId)) {
      projectManager.deleteProject(connectionId)
    }

    // 触发断开事件
    this.emitToListeners('system.disconnected', { connectionId }, connectionId)

    // 同 handleConnection：不广播 ws:status。上面 deleteProject 已经发过
    // `ws:projects-changed` 了。而且停服是一个连接一个连接地走到这里的，
    // 那时 serverState 还是 listening —— 每摘一个就播一次的话，界面会连着
    // 渲染出「运行中 · 2」「运行中 · 1」「运行中 · 0」，全是正在被拆掉的状态。
  }

  // ==================== 兼容现有代码的方法 ====================

  /**
   * 启动服务（兼容旧接口）
   */
  async start(): Promise<void> {
    return this.startServer()
  }

  /**
   * 停止服务（兼容旧接口）
   */
  async stop(): Promise<void> {
    return this.stopServer()
  }

  /**
   * 获取连接管理器
   */
  getConnectionManager(): ConnectionManager {
    return this.connectionManager
  }

  /**
   * 获取请求状态管理器
   */
  getRequestStateManager(): RequestStateManager {
    return this.requestStateManager
  }

  /**
   * 服务是否正在运行
   */
  isServerRunning(): boolean {
    return this.serverState === ServerState.Listening
  }

  /**
   * 获取连接数量
   */
  getConnectionCount(): number {
    return this.connectionManager.getConnectionCount()
  }
}

/**
 * 把 Node 的 listen 错误翻译成用户能照着做的一句话。
 *
 * 抄的是 `agent-v3/capabilities/mcp/McpServerHost.ts` 的 `describeListenError()`
 * —— 那边早就这么做了，而这边一直只抛一句「端口 X 已被占用」。区别在于：
 * 那句话没告诉用户**为什么**会被占用、以及**该怎么办**，而这两件事恰恰是他
 * 唯一需要知道的。
 *
 * 端口固定（17860）意味着 EADDRINUSE 不是罕见事故：开了两个盒子、
 * 或者别的程序先占了这个号，都会走到这里。
 */
export function describeListenError(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === 'EADDRINUSE') {
    return (
      `端口 ${port} 已被占用，虚幻引擎桥接服务没能启动。` +
      '可能是已经开着一个虚幻盒子，或者别的程序占用了这个端口。' +
      '关掉占用它的程序后重启盒子即可 —— 在此之前，连接引擎相关的功能都用不了。'
    )
  }
  if (error.code === 'EACCES') {
    return `没有权限监听端口 ${port}，虚幻引擎桥接服务没能启动。`
  }
  return `虚幻引擎桥接服务启动失败：${error.message}`
}
