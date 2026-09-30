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
    projectPath: string | undefined,
    /** 像真盒子那样发一条进度（调用方没要进度时什么都不做） */
    progress: (message: string) => Promise<void>
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

    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = options.tools.find((t) => t.name === request.params.name)
      if (!tool) {
        return {
          content: [{ type: 'text', text: `工具 ${request.params.name} 不存在` }],
          isError: true,
          _meta: { unrealBox: { errorCode: 'TOOL_UNAVAILABLE' } }
        }
      }

      const meta = request.params._meta?.unrealBox as { projectPath?: string } | undefined
      const token = request.params._meta?.progressToken
      let sent = 0
      const progress = async (message: string): Promise<void> => {
        if (token === undefined) return
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: ++sent, message }
        })
      }
      return (await tool.handle(
        (request.params.arguments ?? {}) as Record<string, unknown>,
        meta?.projectPath,
        progress
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
