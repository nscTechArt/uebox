/**
 * 端到端测试用的假盒子。
 *
 * **不进发布产物**：`tsconfig.json` 的 exclude 把它和 `*.test.ts` 一起排掉了。
 * 它只被测试 import，`bin` 的依赖链上没有它 —— 让测试脚手架跟着 CLI 发出去，
 * 等于在用户机器上多放一个能起 HTTP 服务的模块。
 *
 * 它复刻的是真盒子对外的那一层协议形状：会话隔离、Bearer 校验、
 * `capabilities.experimental.unrealBox`、工具清单里的 `_meta.unrealBox`、
 * 以及 `structuredContent`。**不复刻业务逻辑** —— 那些由主仓库自己的测试盯着。
 *
 * 有了它，CLI 的退出码、信封形状、工程解析、旧盒子提示这些才能真的跑一遍，
 * 而不是靠打桩假装跑过。
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { randomUUID } from 'node:crypto'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

export interface FakeTool {
  name: string
  description?: string
  meta?: {
    namespace: string
    risk: string
    projectScoped?: boolean
    requiresExplicitApproval?: boolean
  }
  /**
   * 收到调用时回什么。拿得到这次的目标工程路径。
   *
   * 允许返回 Promise —— 有些用例要的正是「这一步慢到超时」（比如写成功之后
   * 回读超时），同步返回没法造出那个场景。
   */
  handle: (
    args: Record<string, unknown>,
    projectPath: string | undefined
  ) => ToolReply | Promise<ToolReply>
}

export interface ToolReply {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

export interface FakeBoxOptions {
  token: string
  tools: FakeTool[]
  /** false 表示扮演旧盒子：不声明 unrealBox 能力 */
  declareContract?: boolean
  contractVersion?: number
}

export interface FakeBox {
  url: string
  close(): Promise<void>
}

export async function startFakeBox(options: FakeBoxOptions): Promise<FakeBox> {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const servers: Server[] = []

  const build = (): Server => {
    const experimental =
      options.declareContract === false
        ? {}
        : {
            experimental: {
              unrealBox: {
                cliContractVersion: options.contractVersion ?? 1,
                projectTargeting: true,
                publicResults: true
              }
            }
          }

    const mcp = new Server(
      { name: 'fake-unreal-box', version: '1.0.0' },
      { capabilities: { tools: {}, ...experimental } }
    )

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? `假工具 ${tool.name}`,
        inputSchema: { type: 'object' as const, properties: {} },
        ...(tool.meta
          ? {
              _meta: {
                unrealBox: {
                  namespace: tool.meta.namespace,
                  risk: tool.meta.risk,
                  projectScoped: tool.meta.projectScoped === true,
                  requiresExplicitApproval: tool.meta.requiresExplicitApproval === true
                }
              }
            }
          : {})
      }))
    }))

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = options.tools.find((t) => t.name === request.params.name)
      if (!tool) {
        return {
          content: [{ type: 'text', text: `工具 ${request.params.name} 不存在` }],
          isError: true,
          _meta: { unrealBox: { errorCode: 'TOOL_UNAVAILABLE' } }
        }
      }

      const meta = request.params._meta?.unrealBox as { projectPath?: string } | undefined
      return (await tool.handle(
        (request.params.arguments ?? {}) as Record<string, unknown>,
        meta?.projectPath
      )) as never
    })

    servers.push(mcp)
    return mcp
  }

  const http = createServer((req, res) => {
    void route(req, res)
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    const raw = req.headers['mcp-session-id']
    const sessionId = (Array.isArray(raw) ? raw[0] : raw)?.trim()

    if (sessionId) {
      const existing = sessions.get(sessionId)
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001 }, id: null }))
        return
      }
      await existing.handleRequest(req, res)
      return
    }

    const body = await readBody(req)
    if (!isInitializeRequest(body)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000 }, id: null }))
      return
    }

    // 显式标注类型：回调里要引用 transport 自己，不标的话 TS 推不出来
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport)
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
      }
    })
    await build().connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const port = await listen(http)

  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      http.closeAllConnections()
      await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)))
      await Promise.all(servers.map((s) => s.close().catch(() => undefined)))
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }
}

// ── 有状态的假关卡 ──────────────────────────────────────────────────────────

export interface FakeActor {
  name: string
  class?: string
  location?: Record<string, number>
  rotation?: Record<string, number>
  scale?: Record<string, number>
}

export interface FakeLevelOptions {
  /** 一开始关卡里有谁 */
  actors?: FakeActor[]
  /**
   * 让写工具「口头成功但什么都不做」。
   *
   * 这是回读那道关卡唯一能被真正验证的方式：没有它，测试里工具说成功、
   * 状态也确实变了，回读永远通过，那道关卡等于没测过。
   */
  sabotage?: boolean
  /**
   * 让 `ue_get_actor` 卡住这么多毫秒。
   *
   * 用来造「写成功了、但随后的回读超时」那条路径 —— 它和「请求没发出去就
   * 超时」结局不同，提示措辞也不该一样。
   */
  readbackDelayMs?: number
}

export interface FakeLevel {
  tools: FakeTool[]
  /** 当前关卡内容，断言用 */
  actors: Map<string, FakeActor>
}

/**
 * 一个会记住状态的假关卡：生成/变换/删除真的改这份 Map，`ue_get_actor` 从它读。
 *
 * 有状态是必须的 —— 写命令的整条链路是「调用 → 回读 → 判定」，用一个每次
 * 返回固定值的桩去测，回读那一步就是摆设。
 */
export function fakeLevel(options: FakeLevelOptions = {}): FakeLevel {
  const actors = new Map<string, FakeActor>()
  for (const actor of options.actors ?? []) actors.set(actor.name, { ...actor })

  const ok = (
    details: Record<string, unknown>
  ): { content: Array<Record<string, unknown>>; structuredContent: Record<string, unknown> } => ({
    content: [{ type: 'text', text: '好了' }],
    structuredContent: details
  })

  const names = (args: Record<string, unknown>): string[] => {
    const targets = args.targets as { names?: unknown } | undefined
    return Array.isArray(targets?.names) ? (targets.names as string[]) : []
  }

  const serialize = (actor: FakeActor): Record<string, unknown> => ({
    name: actor.name,
    path: `/Game/Maps/Main.Main:PersistentLevel.${actor.name}`,
    class: actor.class ?? 'StaticMeshActor',
    transform: {
      location: actor.location ?? { x: 0, y: 0, z: 0 },
      rotation: actor.rotation ?? { pitch: 0, yaw: 0, roll: 0 },
      scale: actor.scale ?? { x: 1, y: 1, z: 1 }
    }
  })

  const tools: FakeTool[] = [
    {
      name: 'ue_get_actor',
      meta: { namespace: 'ue.actor', risk: 'safe', projectScoped: true },
      handle: async (args) => {
        if (options.readbackDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.readbackDelayMs))
        }
        const wanted = names(args)
        const found =
          wanted.length > 0
            ? wanted.flatMap((name) => (actors.has(name) ? [actors.get(name)!] : []))
            : [...actors.values()]
        return ok({
          actors: found.map(serialize),
          returnedCount: found.length,
          totalCount: found.length,
          truncated: false
        })
      }
    },
    {
      name: 'ue_spawn_actor',
      meta: { namespace: 'ue.actor', risk: 'mutating', projectScoped: true },
      handle: (args) => {
        const wanted = String(args.name ?? '')
        if (options.sabotage) return ok({ spawned: wanted })

        // 引擎在重名时会退让到 name_1（UAL_ActorCommands.cpp:168-176），
        // 假关卡照抄这条行为 —— 生成命令的整个准入论证都建立在它之上
        let actual = wanted
        for (let suffix = 1; actors.has(actual); suffix++) actual = `${wanted}_${suffix}`

        const transform = (args.transform ?? {}) as Record<string, Record<string, number>>
        actors.set(actual, {
          name: actual,
          class: String(args.asset_id ?? 'StaticMeshActor'),
          ...(transform.location ? { location: transform.location } : {}),
          ...(transform.rotation ? { rotation: transform.rotation } : {}),
          ...(transform.scale ? { scale: transform.scale } : {})
        })
        return ok({ spawned: actual })
      }
    },
    {
      name: 'ue_set_transform',
      meta: { namespace: 'ue.actor', risk: 'mutating', projectScoped: true },
      handle: (args) => {
        if (options.sabotage) return ok({ count: 1 })

        const set = ((args.operation as Record<string, unknown>)?.set ?? {}) as Record<
          string,
          Record<string, number>
        >
        let count = 0
        for (const name of names(args)) {
          const actor = actors.get(name)
          if (!actor) continue
          // 只覆盖请求里给了的分量，其余保持原值 —— 引擎就是这么做的，
          // 而 CLI 的比对逻辑正是按这条写的
          for (const key of ['location', 'rotation', 'scale'] as const) {
            if (!set[key]) continue
            actor[key] = { ...(actor[key] ?? {}), ...set[key] }
          }
          count++
        }
        return ok({ count })
      }
    },
    {
      name: 'ue_destroy_actor',
      meta: { namespace: 'ue.actor', risk: 'destructive', projectScoped: true },
      handle: (args) => {
        if (options.sabotage) return ok({ count: 1 })
        let count = 0
        for (const name of names(args)) if (actors.delete(name)) count++
        return ok({ count })
      }
    }
  ]

  return { tools, actors }
}

/**
 * agent 撤销栈的假实现。
 *
 * 复刻的是**语义**而不是引擎：撤一步 = 栈少一条、返回那条的标题和受影响的包。
 * 有了它，`actors undo` 的前后比对才是真在比，而不是对着桩点头。
 */
export function fakeUndoStack(titles: string[] = []): { tools: FakeTool[]; stack: string[] } {
  const stack = [...titles]

  const ok = (details: Record<string, unknown>): ToolReply => ({
    content: [{ type: 'text', text: '好了' }],
    structuredContent: details
  })

  const tools: FakeTool[] = [
    {
      name: 'ue_undo_history',
      meta: { namespace: 'ue.editor', risk: 'safe', projectScoped: true },
      handle: () =>
        ok({
          undoable: stack.length,
          redoable: 0,
          // 栈顶是最后做的那一步
          entries: stack
            .slice()
            .reverse()
            .map((title, index) => ({
              step: index + 1,
              title,
              context: 'agent',
              packages: [`/Game/Maps/Main`]
            }))
        })
    },
    {
      name: 'ue_undo',
      meta: { namespace: 'ue.editor', risk: 'destructive', projectScoped: true },
      handle: () => {
        const undone = stack.pop()
        return ok({
          action: 'undo',
          stepsApplied: undone ? 1 : 0,
          stepTitles: undone ? [undone] : [],
          remaining: stack.length,
          redoable: undone ? 1 : 0,
          affectedPackages: undone ? ['/Game/Maps/Main'] : []
        })
      }
    }
  ]

  return { tools, stack }
}

/**
 * 造一张头部合法的 PNG。
 *
 * 像素数据不重要 —— 核验只读前 24 个字节（签名 + IHDR 的宽高）。
 * 放在这里而不是某个 `.test.ts` 里：从一个测试文件 import 另一个测试文件，
 * 会把那边的 describe 一并注册进来，跑起来的用例数会莫名其妙地变。
 */
export function fakePng(width: number, height: number, tail = 64): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8) // IHDR 块长度
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return Buffer.concat([header, Buffer.alloc(tail)])
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 端口交给系统分配，但避开 fetch 规范里的禁用端口。
 *
 * undici 对那几个端口直接抛 `bad port`，和被测代码毫无关系 ——
 * 这类偶发红灯不处理的话，最后是整条门禁没人信。
 */
const FETCH_BLOCKED_PORTS = new Set([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])

async function listen(http: HttpServer): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve) => {
      http.listen(0, '127.0.0.1', () => {
        const address = http.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    if (!FETCH_BLOCKED_PORTS.has(port)) return port
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
  throw new Error('连续 10 次都分到了 fetch 禁用端口，这不该发生')
}
