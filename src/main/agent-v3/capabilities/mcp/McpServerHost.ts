/**
 * 把虚幻盒子的 UE 工具反向暴露成一个 MCP server。
 *
 * 外部的 Claude Code / Cursor / Cline 连上之后，就能直接操作虚幻引擎 ——
 * 市面上没有别的 MCP server 有这个能力。
 *
 * ## 实现选择
 *
 * 用低层 `Server` + `setRequestHandler`，不用高层 `McpServer.tool()`：
 * 后者要 Zod schema，而我们的工具（含适配来的 V2 工具、MCP 转发来的工具）
 * 带的已经是 JSON Schema。低层 API 可以原样返回，不用反向转一次 Zod。
 *
 * ## 安全
 *
 * 这个 server 能删资产、跑任意 Python、改项目配置。所以：
 *
 *   - **默认关闭**，用户在设置里显式开启
 *   - **只监听 127.0.0.1** —— 绑 0.0.0.0 等于把引擎控制权开放给局域网
 *   - **强制 token**，随机生成，握手时校验
 *   - **按命名空间白名单**收窄暴露范围，默认只给只读工具
 *
 * 社区版不得引入任何远程上报（AGENTS.md §1）—— 这个 server 全程本地回环，
 * 不联网、不上报。
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'http'
import { randomBytes, randomUUID } from 'crypto'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

import { runWithTargetConnectionId } from '../../core/projectTargetContext'
import type { UnrealAgentTool } from '../../tools/defineTool'
import { OFFLINE_UE_TOOLS } from '../../tools/toolNames'
import {
  EngineNotFoundError,
  EngineTimeoutError,
  ENGINE_NOT_FOUND_CODE,
  ENGINE_TIMEOUT_CODE
} from '../../tools/engineErrors'
import { ExternalTargetError, resolveExternalTarget, UNREAL_BOX_CAPABILITY } from './externalTarget'
import { toStructuredContent } from './publicResult'

/** 关闭时最多等多久。踢掉连接之后正常是毫秒级，这只是兜底 */
const CLOSE_TIMEOUT_MS = 3000

/**
 * 一个会话闲置多久之后回收。
 *
 * CLI 是一条命令一个进程：连上、调用、退出。它**应该**在退出前发 DELETE 主动
 * 结束会话，但进程被 kill、网络中途断掉时那条 DELETE 不会发出来。没有这道
 * 兜底的话，每一次异常退出都在盒子里留一个 Server + Transport 直到应用关闭。
 *
 * 挂着 SSE 流的客户端不受影响：那条 GET 请求在流关闭之前一直算「在飞」，
 * 见 `handleWithSession` 的 `inFlight`。
 */
const SESSION_IDLE_TIMEOUT_MS = 5 * 60_000

/** 空闲扫描间隔 */
const SESSION_SWEEP_INTERVAL_MS = 30_000

/**
 * 同时存在的会话数上限。
 *
 * 不设上限的话，一个握手失败就重连的客户端能在几分钟内造出几百个
 * Server + Transport。这是长驻的本机服务，不能被一个写坏的脚本挤住。
 * 正常用法（几个编辑器客户端 + 偶尔一条 CLI 命令）离这个数很远。
 */
const MAX_SESSIONS = 32

/** 只有 initialize 请求的 body 需要我们自己读，那种 body 只有几百字节 */
const MAX_INIT_BODY_BYTES = 1 << 20

/** 一条 MCP 会话：一个 Server 配一个 Transport，互不共用 */
interface Session {
  server: Server
  transport: StreamableHTTPServerTransport
  /** 最后一次请求结束的时刻，空闲回收看它 */
  lastActiveAt: number
  /** 正在处理中的请求数。>0 时绝不回收 —— 长请求不是空闲 */
  inFlight: number
}

export interface McpServerHostOptions {
  /** 0 表示让系统分配空闲端口 */
  port?: number
  /**
   * 暴露哪些命名空间。
   *
   * 默认只给只读工具 —— 把「删资产」「跑任意 Python」直接开给外部客户端
   * 不该是默认行为，得用户明确选。
   */
  namespaces?: string[]
  /** 是否连非只读工具一起暴露。默认 false */
  includeMutating?: boolean
  /**
   * 固定 token。不传就每次随机生成。
   *
   * 宿主层会传持久化的那把（见 hostStore.ts）—— 外部客户端的配置写在磁盘上，
   * 凭据每次重启都变的话那份配置就废了。
   */
  token?: string
}

export interface McpServerHostStatus {
  running: boolean
  url?: string
  token?: string
  exposedTools: number
  error?: string
}

export class McpServerHost {
  private http?: HttpServer
  private token?: string
  private port?: number
  private exposed: UnrealAgentTool<never>[] = []
  private lastError?: string
  /** 按 MCP session id 索引。每个 initialize 请求造一条 */
  private sessions = new Map<string, Session>()
  private sweeper?: NodeJS.Timeout

  /**
   * 起服务。
   *
   * @param allTools 注册表里的全部工具，由调用方提供 —— 这个类不自己去 build，
   *                 否则会把工具树的依赖拉进来，也不方便测试。
   */
  async start(
    allTools: UnrealAgentTool<never>[],
    options: McpServerHostOptions = {}
  ): Promise<McpServerHostStatus> {
    await this.stop()

    this.exposed = selectExposedTools(allTools, options)
    this.token = options.token || randomBytes(24).toString('hex')

    this.http = createServer((req, res) => {
      void this.route(req, res)
    })

    const wanted = options.port ?? 0

    return new Promise<McpServerHostStatus>((resolve) => {
      this.http!.on('error', (error) => {
        this.lastError = describeListenError(error, wanted)
        // 起失败就把这个半死的 server 丢掉。留着的话 `status().running`
        // 靠 `listening` 判断虽然仍是 false，但下一次 start 会先 stop 它，
        // 在一个从未 listen 过的 server 上 close 只是徒增噪音。
        this.http = undefined
        this.port = undefined
        this.token = undefined
        this.exposed = []
        resolve(this.status())
      })
      // 只绑回环。绑 0.0.0.0 等于把引擎控制权开放给整个局域网。
      this.http!.listen(wanted, '127.0.0.1', () => {
        const address = this.http!.address()
        this.port = typeof address === 'object' && address ? address.port : undefined
        this.lastError = undefined
        // unref：这只是个兜底清理，不该拖着 Node 进程不让它退出
        this.sweeper = setInterval(() => this.sweepIdleSessions(), SESSION_SWEEP_INTERVAL_MS)
        this.sweeper.unref?.()
        console.log(
          `[AgentV3][MCP-Server] 已启动 http://127.0.0.1:${this.port}/，` +
            `暴露 ${this.exposed.length} 个工具`
        )
        resolve(this.status())
      })
    })
  }

  /**
   * 双重校验：来源必须是回环，且 token 正确。
   *
   * 只查 token 不够 —— 万一以后有人把 host 改成 0.0.0.0，token 会在
   * 局域网里被嗅到。只查回环也不够：本机其他程序也能连。
   */
  private isAuthorized(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress ?? ''
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!isLoopback) return false

    const header = req.headers.authorization ?? ''
    return header === `Bearer ${this.token}`
  }

  // ── 会话路由 ──────────────────────────────────────────────────────────────
  //
  // ## 为什么必须一个客户端一条会话
  //
  // 之前这里是**一个** Server 配**一个** Transport，所有客户端共用。有状态模式下
  // 一个 transport 只认一次初始化：SDK 的 `webStandardStreamableHttp.js` 对第二个
  // `initialize` 直接回 400 `Invalid Request: Server already initialized`。
  //
  // 也就是说「开着 Claude Code 的时候再跑一条 CLI 命令」不是会互相干扰，
  // 而是**后来的那个根本连不上**。反过来也一样：CLI 连着的时候用户在
  // Cursor 里连不上盒子。
  //
  // 所以按 MCP 的标准做法：每个 initialize 造一对新的 Server + Transport，
  // 之后按 `Mcp-Session-Id` 头路由。工具清单是共享的只读快照，不复制。

  /**
   * 一个 HTTP 请求进来该给谁。
   *
   * 认证在最前面，且对**所有**路径生效 —— 包括还没有会话的 initialize。
   */
  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    const sessionId = headerValue(req, 'mcp-session-id')

    if (sessionId) {
      const session = this.sessions.get(sessionId)
      if (!session) {
        // 404 是协议约定的「这个会话不在了」，客户端据此重新初始化。
        // 服务重启过、或者会话被空闲回收了，都会走到这里。
        jsonRpcError(res, 404, -32001, `会话 ${sessionId} 不存在或已结束，请重新初始化。`)
        return
      }
      await this.handleWithSession(session, req, res)
      return
    }

    // 没有会话 id：只可能是一次新的 initialize。
    if (req.method !== 'POST') {
      jsonRpcError(res, 400, -32000, '缺少 Mcp-Session-Id 请求头。')
      return
    }

    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      jsonRpcError(res, 400, -32700, (error as Error).message)
      return
    }

    if (!isInitializeRequest(body)) {
      jsonRpcError(res, 400, -32000, '缺少 Mcp-Session-Id 请求头（只有初始化请求可以不带）。')
      return
    }

    // 先扫一遍空闲会话再判上限：绝大多数「满了」其实是一堆早就该回收的残留
    this.sweepIdleSessions()
    if (this.sessions.size >= MAX_SESSIONS) {
      jsonRpcError(
        res,
        503,
        -32000,
        `会话数已达上限 ${MAX_SESSIONS}。请关掉不再使用的 MCP 客户端后重试。`
      )
      return
    }

    const session = await this.createSession()
    // body 已经被我们读掉了，必须原样交给 transport —— 它自己再读一次
    // 会拿到一个空流，然后报「请求体为空」
    await this.handleWithSession(session, req, res, body)
  }

  /** 造一条新会话：一个 Server、一个 Transport，注册进表里 */
  private async createSession(): Promise<Session> {
    // 先把壳造出来，再往里填 —— 下面两个回调都要引用这条会话本身，
    // 而它们最早也要等到 `handleRequest` 才会被调到（那时字段已经填完了）。
    const session = {} as Session

    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // session id 是在 handleRequest 里现生成的，注册进表要等到那一刻
      onsessioninitialized: (id) => {
        this.sessions.set(id, session)
      },
      // 客户端发 DELETE 主动结束
      onsessionclosed: (id) => {
        this.sessions.delete(id)
      }
    })

    session.server = this.buildServer()
    await session.server.connect(session.transport)

    // 传输层因为任何原因关掉（网络断、close()）都要把表清干净，
    // 否则那个 id 会一直占着上限里的一格
    session.transport.onclose = () => {
      const id = session.transport.sessionId
      if (id) this.sessions.delete(id)
    }

    session.lastActiveAt = Date.now()
    session.inFlight = 0
    return session
  }

  /**
   * 交给某条会话处理，并维护它的活跃计数。
   *
   * `inFlight` 存在的唯一理由：SSE 那条 GET 请求在流关闭之前一直不返回，
   * 一次长工具调用也可能跑好几十秒。**这两种都不是空闲**，按空闲回收会
   * 在用户等结果的时候把他的会话掐掉。
   */
  private async handleWithSession(
    session: Session,
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown
  ): Promise<void> {
    session.inFlight++
    session.lastActiveAt = Date.now()
    try {
      await session.transport.handleRequest(req, res, parsedBody)
    } catch (error) {
      console.warn('[AgentV3][MCP-Server] 处理请求失败:', (error as Error).message)
      if (!res.headersSent) jsonRpcError(res, 500, -32603, (error as Error).message)
    } finally {
      session.inFlight--
      session.lastActiveAt = Date.now()
    }
  }

  /** 回收闲置会话。在飞的请求一律跳过 */
  private sweepIdleSessions(): void {
    const now = Date.now()
    for (const [id, session] of [...this.sessions]) {
      if (session.inFlight > 0) continue
      if (now - session.lastActiveAt < SESSION_IDLE_TIMEOUT_MS) continue
      this.sessions.delete(id)
      void session.transport.close().catch(() => undefined)
      void session.server.close().catch(() => undefined)
    }
  }

  // ── MCP 协议实现 ──────────────────────────────────────────────────────────

  /** 每条会话一个 Server 实例。工具清单是共享的只读快照，不复制 */
  private buildServer(): Server {
    const mcp = new Server(
      { name: 'unreal-box', version: '1.0.0' },
      {
        capabilities: {
          tools: {},
          // 契约声明。外部客户端先读它，才知道这个盒子认不认 `_meta.unrealBox`
          // 那套显式指定工程的约定 —— 旧盒子没有这一段，客户端据此报
          // INCOMPATIBLE_SERVER，而不是把 --project 发出去然后被静默忽略。
          experimental: { unrealBox: { ...UNREAL_BOX_CAPABILITY } }
        }
      }
    )

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.exposed.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // 工具带的已经是 JSON Schema，原样给出去
        inputSchema: tool.parameters as { type: 'object' },
        _meta: { unrealBox: describeToolMeta(tool) }
      }))
    }))

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request))
    return mcp
  }

  /**
   * 调一个工具。
   *
   * 三件事按顺序：找工具 → 定目标工程 → 在目标上下文里执行。
   */
  private async callTool(request: {
    params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> }
  }): Promise<CallToolOutcome> {
    const tool = this.exposed.find((t) => t.name === request.params.name)
    if (!tool) {
      return failure(`工具 ${request.params.name} 不存在或未暴露`, 'TOOL_UNAVAILABLE')
    }

    let target: ReturnType<typeof resolveExternalTarget>
    try {
      target = resolveExternalTarget(request.params._meta?.unrealBox)
    } catch (error) {
      if (error instanceof ExternalTargetError) {
        return failure([error.message, error.hint].filter(Boolean).join(' '), error.code)
      }
      throw error
    }

    const args = (request.params.arguments ?? {}) as never
    const callId = `mcp-${randomUUID()}`

    try {
      // 没指定目标就**不进上下文**，保持与改动之前完全一致的行为：
      // 旧的第三方客户端（Claude Code / Cursor）不发这个字段，
      // 它们的调用照旧落到「恰好一个连接才回退」那条路上。
      const result = target
        ? await runWithTargetConnectionId(target, () => tool.execute(callId, args))
        : await tool.execute(callId, args)

      const structured = toStructuredContent(tool.name, result.details)
      return {
        content: result.content as never[],
        ...(structured ? { structuredContent: structured } : {})
      }
    } catch (error) {
      // 等引擎超时和「引擎明确说没做成」是两回事：超时那条路上操作**可能已经
      // 生效了**，调用方按「失败」重试就会做第二遍（生成 Actor 尤其致命）。
      // 所以单独给一个码，让外部客户端能把它读成「结局不明」。
      // 类型判定不是字符串匹配 —— 见 tools/engineErrors.ts
      if (error instanceof EngineTimeoutError) {
        return failure(error.message, ENGINE_TIMEOUT_CODE)
      }

      // 「按这个条件没查到」也要单独给码：查询结果为空不是故障，
      // 而 CLI 的写操作回读正是靠它判断「删掉了」「还没生成」
      if (error instanceof EngineNotFoundError) {
        return failure(error.message, ENGINE_NOT_FOUND_CODE)
      }

      // 我们的工具用抛异常表示失败；MCP 协议用 isError 字段，这里做翻译。
      // 错误信息原样透出 —— 不按中文字符串猜错误类别，那是另一种编造。
      return failure((error as Error).message, 'TOOL_FAILED')
    }
  }

  /**
   * 停服务。
   *
   * ## 为什么不能只调 `close()`
   *
   * `server.close(cb)` 的回调要等**所有连接都断开**才触发。而 MCP 的
   * Streamable HTTP 是长连接：外部客户端（Claude Code / Cursor）连上之后
   * 会一直挂着一条 SSE 流不放。于是 `close()` 的回调永远不来 ——
   *
   *   - 界面上：点「关闭」之后 `hostBusy` 永远为 true，开关卡在开着的状态，
   *     用户报的就是「只能开不能关」
   *   - 退出应用时：`will-quit` 里 await 这个 stop，应用关不掉
   *
   * 实测（有一个客户端连着）：4 秒等不到回调，而且再等也不会来。
   *
   * 所以先 `closeAllConnections()` 主动踢掉在连的客户端。这是对的行为 ——
   * 用户点的就是「停止服务」，本来就该断开。再加一道超时兜底：
   * 万一某个 socket 卡住，也不能把界面或退出流程一起拖死。
   */
  async stop(): Promise<void> {
    const http = this.http
    // 先把字段清掉再等关闭：状态要立刻反映「已停」，
    // 否则等待期间界面还以为在跑
    this.http = undefined
    this.port = undefined
    this.token = undefined
    this.exposed = []

    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }

    // 会话先关。停服务 / 重置令牌就该让所有会话失效，
    // 下一条命令重新初始化 —— 留着的会话拿的还是旧 token 的授权。
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(
      sessions.map(async (session) => {
        await session.transport.close().catch(() => undefined)
        await session.server.close().catch(() => undefined)
      })
    )

    if (!http) return

    http.closeAllConnections()

    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      new Promise<void>((resolve) => http.close(() => resolve())),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn('[AgentV3][MCP-Server] 关闭超时，端口可能稍后才释放')
          resolve()
        }, CLOSE_TIMEOUT_MS)
      })
    ])
    if (timer) clearTimeout(timer)
  }

  status(): McpServerHostStatus {
    return {
      running: Boolean(this.http?.listening),
      ...(this.port ? { url: `http://127.0.0.1:${this.port}/` } : {}),
      ...(this.token ? { token: this.token } : {}),
      exposedTools: this.exposed.length,
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }
}

/** `tools/call` 的返回形状。`_meta.unrealBox.errorCode` 给机器看，文本给人看 */
interface CallToolOutcome {
  content: never[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

/**
 * 一次失败的工具调用。
 *
 * 错误码走 `_meta` 而不是塞进文本里：让调用方去匹配中文字符串，是那种今天能跑、
 * 改一个标点就静默失效的接口。旧客户端读不懂 `_meta` 也没关系，它们看文本。
 */
function failure(message: string, code: string): CallToolOutcome {
  return {
    content: [{ type: 'text' as const, text: message }] as never[],
    isError: true,
    _meta: { unrealBox: { errorCode: code } }
  }
}

/**
 * 清单里随每个工具带出去的描述性元数据。
 *
 * 用途是**发现和说明**，不是权限：外部调用方据此知道「这个工具要不要指定
 * 工程」「它会不会改东西」。真正的范围检查仍然在服务端每次调用时做
 * （`selectExposedTools` 决定了 `this.exposed` 里有什么）。
 */
function describeToolMeta(tool: UnrealAgentTool<never>): Record<string, unknown> {
  const namespace = tool.unrealBox.namespace
  return {
    namespace,
    risk: tool.unrealBox.risk,
    // 要不要带工程路径。ue.* 里有两个例外，它们不依赖引擎连接
    // （见 tools/toolNames.ts 的 OFFLINE_UE_TOOLS）
    projectScoped: namespace.startsWith('ue.') && !OFFLINE_UE_TOOLS.has(tool.name),
    requiresExplicitApproval: tool.unrealBox.requiresExplicitApproval === true
  }
}

/** 大小写不敏感地取一个请求头 */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.trim() || undefined
}

/**
 * 读并解析请求体。
 *
 * **只在没有会话 id 的 POST 上用**，也就是初始化请求 —— 那种 body 只有几百
 * 字节。有会话的请求一律直接交给 transport 自己读，不在这里多缓冲一份。
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_INIT_BODY_BYTES) {
      throw new Error(`初始化请求体超过 ${MAX_INIT_BODY_BYTES} 字节。`)
    }
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) throw new Error('请求体为空。')

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`请求体不是合法 JSON：${(error as Error).message}`)
  }
}

/** 按 JSON-RPC 的错误形状回一条。客户端能读懂，人也能读懂 */
function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

/**
 * 把 Node 的 listen 错误翻译成用户能照着做的一句话。
 *
 * 端口固定之后 EADDRINUSE 从「几乎不可能」变成「常见」—— 开着两个盒子、
 * 或者别的程序先占了 17861。原样把 `listen EADDRINUSE: address already in
 * use 127.0.0.1:17861` 抛给界面，用户不知道该干什么。
 */
function describeListenError(error: Error, port: number): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    return `端口 ${port} 已被占用（可能已经开了一个盒子，或别的程序在用）。换一个端口再试。`
  }
  if (code === 'EACCES') {
    return `没有权限使用端口 ${port}。换一个大于 1024 的端口。`
  }
  return error.message
}

/**
 * 挑出要暴露的工具。
 *
 * 默认只给只读的 —— 把「删除资产」「执行任意 Python」直接开放给外部客户端，
 * 一个配错的 agent 就能把用户项目搞坏。要开放写权限必须显式声明。
 */
export function selectExposedTools(
  allTools: UnrealAgentTool<never>[],
  options: McpServerHostOptions
): UnrealAgentTool<never>[] {
  let tools = allTools

  // 不转发从别的 MCP server 接进来的工具：那会形成 A→盒子→B 的转发链，
  // 权限来源变得无法追踪，出问题也说不清是谁调的。
  tools = tools.filter((tool) => !tool.unrealBox.namespace.startsWith('mcp.'))

  // core 命名空间（task / load_skill）是盒子内部编排用的，对外没有意义
  tools = tools.filter((tool) => tool.unrealBox.namespace !== 'core')

  // 本地文件与 shell 一律不对外，勾了 includeMutating 也不行。
  //
  // 两个理由，任一成立都足够：
  //
  //   1. **没有审批门**。盒子内部调 `run_shell_command` 会走 approval 弹窗；
  //      MCP 这一头是 `tool.execute()` 直接调用，没有任何拦截。也就是说
  //      勾上「同时开放写操作工具」等于把这台机器的任意命令执行权
  //      交给任何拿到 token 的进程 —— 而界面上写的是「这个服务能操作你的
  //      引擎项目」，两者不是一个量级。
  //   2. **没有价值**。会连上来的客户端（Claude Code、Cursor、Cline）
  //      本来就自带读写文件和跑命令的能力，转发我们这一份只是多一条
  //      追不到源头的路径。
  //
  // 这个服务的卖点是**虚幻引擎**能力，不是通用的机器控制。
  tools = tools.filter(
    (tool) => tool.unrealBox.namespace !== 'local' && !tool.unrealBox.namespace.startsWith('local.')
  )

  if (options.namespaces?.length) {
    const allowed = new Set(options.namespaces)
    tools = tools.filter((tool) => allowed.has(tool.unrealBox.namespace))
  }

  if (!options.includeMutating) {
    tools = tools.filter((tool) => tool.unrealBox.risk === 'safe')
  }

  return tools
}
