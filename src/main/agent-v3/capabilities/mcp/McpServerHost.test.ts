/**
 * @vitest-environment node
 *
 * 默认环境是 happy-dom（浏览器语义），它的 fetch 会强制 CORS，
 * 把发往 127.0.0.1 的请求当跨域拦掉。这是主进程代码（HTTP server 与真实 fetch），
 * 必须跑在 node 环境。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** 已连接工程表。目标绑定那几条用例靠改它来摆布现场 */
const projects: Array<{ connectionId: string; projectPath: string; isConnected: boolean }> = []

vi.mock('../../../services/project/projectManager', () => ({
  projectManager: {
    getProject: (id: string) => projects.find((p) => p.connectionId === id),
    getAllProjects: () => projects,
    getInteractiveProjects: () => projects.filter((p) => p.isConnected)
  }
}))

import { getTargetConnectionId } from '../../core/projectTargetContext'
import { defineTool, type ToolRisk, type UnrealAgentTool } from '../../tools/defineTool'
import { CLI_CONTRACT_VERSION } from './externalTarget'
import { McpServerHost, selectExposedTools } from './McpServerHost'

function fakeTool(
  name: string,
  namespace: string,
  risk: ToolRisk,
  run: () => Promise<string> = async () => `${name} ok`,
  details?: unknown
): UnrealAgentTool<never> {
  return defineTool({
    name,
    namespace,
    risk,
    description: `测试工具 ${name}`,
    input: z.object({ value: z.string().optional() }),
    execute: async () => ({ text: await run(), ...(details ? { details } : {}) })
  }) as unknown as UnrealAgentTool<never>
}

const TOOLS: UnrealAgentTool<never>[] = [
  // 带 details：公共结果（structuredContent）那几条用例靠它
  fakeTool('ue_get_actor', 'ue.actor', 'safe', undefined, {
    success: true,
    count: 1,
    total_found: 137,
    actors: [{ name: 'Cube_1', path: '/Game/L1:Cube_1', class: 'StaticMeshActor' }],
    message: '找到 1 个 Actor'
  }),
  fakeTool('ue_destroy_actor', 'ue.actor', 'destructive'),
  fakeTool('material_describe', 'ue.material', 'safe'),
  fakeTool('material_create', 'ue.material', 'mutating'),
  fakeTool('task', 'core', 'safe'),
  fakeTool('mcp_other_thing', 'mcp.other', 'destructive'),
  fakeTool('run_shell_command', 'local.shell', 'destructive'),
  fakeTool('write_local_file', 'local', 'destructive'),
  fakeTool('read_local_file', 'local', 'safe'),
  fakeTool('boom', 'ue.system', 'safe', async () => {
    throw new Error('工具内部炸了')
  }),
  // 报出自己看到的目标连接。绑定到底生没生效，只有工具自己说了算
  fakeTool('ue_session_health', 'ue.system', 'safe', async () => `目标=${getTargetConnectionId()}`)
]

describe('selectExposedTools', () => {
  // 把「删资产」「跑任意 Python」直接开给外部客户端不该是默认行为
  it('默认只暴露只读工具', () => {
    const names = selectExposedTools(TOOLS, {}).map((t) => t.name)
    expect(names).toContain('ue_get_actor')
    expect(names).toContain('material_describe')
    expect(names).not.toContain('ue_destroy_actor')
    expect(names).not.toContain('material_create')
  })

  it('includeMutating 才放开写操作', () => {
    const names = selectExposedTools(TOOLS, { includeMutating: true }).map((t) => t.name)
    expect(names).toContain('material_create')
    expect(names).toContain('ue_destroy_actor')
  })

  // A→盒子→B 的转发链会让权限来源无法追踪
  it('不转发从别的 MCP server 接进来的工具', () => {
    const names = selectExposedTools(TOOLS, { includeMutating: true }).map((t) => t.name)
    expect(names).not.toContain('mcp_other_thing')
  })

  it('core 命名空间不对外 —— 那是内部编排用的', () => {
    const names = selectExposedTools(TOOLS, { includeMutating: true }).map((t) => t.name)
    expect(names).not.toContain('task')
  })

  /**
   * MCP 这一头没有审批门（`McpServerHost` 直接调 `tool.execute`），
   * 所以暴露 shell 等于把任意命令执行权交给任何拿到 token 的进程。
   * 而界面上承诺的是「操作你的引擎项目」，不是「操作你的电脑」。
   */
  it('本地文件与 shell 一律不对外，includeMutating 也不放行', () => {
    const names = selectExposedTools(TOOLS, { includeMutating: true }).map((t) => t.name)
    expect(names).not.toContain('run_shell_command')
    expect(names).not.toContain('write_local_file')
    // 只读的也不给：外部客户端本来就自带读文件的能力，转发只是多一条路径
    expect(names).not.toContain('read_local_file')
  })

  it('命名空间白名单能进一步收窄', () => {
    const names = selectExposedTools(TOOLS, { namespaces: ['ue.material'] }).map((t) => t.name)
    expect(names).toEqual(['material_describe'])
  })
})

describe('McpServerHost 端到端', () => {
  const hosts: McpServerHost[] = []
  const clients: Client[] = []

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
    await Promise.all(hosts.splice(0).map((h) => h.stop()))
  })

  /**
   * fetch 规范里的「禁用端口」，undici 照着实现了。
   *
   * 服务端用 `port: 0` 让系统随手给一个端口，本机的动态端口区间是五位数打头的
   * 一万上下 —— 于是偶尔会分到 10080，而客户端一 fetch 就抛 `bad port`，
   * 和被测代码毫无关系。这类偶发红灯不修的话，最后是整条门禁没人信。
   *
   * 完整清单见 https://fetch.spec.whatwg.org/#port-blocking，
   * 这里只列可能落在动态端口区间里的那几个。
   */
  const FETCH_BLOCKED_PORTS = new Set([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])

  async function startHost(
    options: Parameters<McpServerHost['start']>[1] = {}
  ): Promise<{ host: McpServerHost; url: string; token: string }> {
    // 端口是调用方指定的就照办；系统随机分的才允许重摇
    const mayRetry = !options.port

    for (let attempt = 0; ; attempt++) {
      const host = new McpServerHost()
      hosts.push(host)
      const status = await host.start(TOOLS, options)
      expect(status.error).toBeUndefined()
      expect(status.running).toBe(true)

      const port = Number(new URL(status.url!).port)
      // 10 次都摇到禁用端口是不可能事件，真发生了就让它红，别无限转
      if (!mayRetry || !FETCH_BLOCKED_PORTS.has(port) || attempt >= 10) {
        return { host, url: status.url!, token: status.token! }
      }
      await host.stop()
    }
  }

  async function connect(url: string, token?: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {})
      })
    )
    return client
  }

  it('只绑 127.0.0.1 —— 绑 0.0.0.0 等于把引擎开放给局域网', async () => {
    const { url } = await startHost()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  }, 30_000)

  it('外部客户端能列出被暴露的工具', async () => {
    const { url, token } = await startHost()
    const client = await connect(url, token)

    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      'boom',
      'material_describe',
      'ue_get_actor',
      'ue_session_health'
    ])
  }, 30_000)

  it('工具的 JSON Schema 原样透出，不经 Zod 往返', async () => {
    const { url, token } = await startHost()
    const client = await connect(url, token)

    const listed = await client.listTools()
    const tool = listed.tools.find((t) => t.name === 'ue_get_actor')!
    expect(tool.inputSchema.type).toBe('object')
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['value'])
  }, 30_000)

  it('外部客户端能真的调通工具', async () => {
    const { url, token } = await startHost()
    const client = await connect(url, token)

    const result = await client.callTool({ name: 'ue_get_actor', arguments: {} })
    expect(result.content).toEqual([{ type: 'text', text: 'ue_get_actor ok' }])
  }, 30_000)

  // 我们的工具用抛异常表示失败，MCP 协议用 isError —— 这里要翻译
  it('工具抛异常时转成 MCP 的 isError，而不是让请求整个失败', async () => {
    const { url, token } = await startHost()
    const client = await connect(url, token)

    const result = await client.callTool({ name: 'boom', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('工具内部炸了')
  }, 30_000)

  it('调用未暴露的工具被拒 —— 不能绕过白名单', async () => {
    const { url, token } = await startHost()
    const client = await connect(url, token)

    const result = await client.callTool({ name: 'ue_destroy_actor', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('不存在或未暴露')
  }, 30_000)

  it('没有 token 连不上', async () => {
    const { url } = await startHost()
    await expect(connect(url)).rejects.toThrow()
  }, 30_000)

  it('token 不对连不上', async () => {
    const { url } = await startHost()
    await expect(connect(url, 'wrong-token')).rejects.toThrow()
  }, 30_000)

  it('每次启动的 token 都不同', async () => {
    const a = await startHost()
    const b = await startHost()
    expect(a.token).not.toBe(b.token)
    expect(a.token.length).toBeGreaterThanOrEqual(32)
  }, 30_000)

  /**
   * 宿主层传持久化的那把 token 进来。
   *
   * 外部客户端的 MCP 配置写在它们自己的磁盘上，是长期配置 ——
   * 凭据每次重启都变的话，那份配置隔天就废了。
   */
  it('传了 token 就用传进来的那把，并且真的能用它连上', async () => {
    const fixed = 'fixed-token-for-test-0123456789abcdef'
    const { url, token } = await startHost({ token: fixed })
    expect(token).toBe(fixed)

    const client = await connect(url, fixed)
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
  }, 30_000)

  /**
   * 端口固定之后 EADDRINUSE 从「几乎不可能」变成「常见」。
   * 原样把 Node 的错误抛给界面，用户不知道该干什么。
   */
  it('端口被占用时给出能照做的说明，而不是原始的 EADDRINUSE', async () => {
    const first = new McpServerHost()
    hosts.push(first)
    const taken = await first.start(TOOLS, {})
    const port = Number(new URL(taken.url!).port)

    const second = new McpServerHost()
    hosts.push(second)
    const status = await second.start(TOOLS, { port })

    expect(status.running).toBe(false)
    expect(status.error).toContain(String(port))
    expect(status.error).toContain('占用')
    expect(status.error).not.toContain('EADDRINUSE')
  }, 30_000)

  it('起失败后状态是干净的，可以换个端口重来', async () => {
    const first = new McpServerHost()
    hosts.push(first)
    const port = Number(new URL((await first.start(TOOLS, {})).url!).port)

    const second = new McpServerHost()
    hosts.push(second)
    await second.start(TOOLS, { port })
    expect(second.status()).toMatchObject({ running: false, exposedTools: 0 })
    expect(second.status().token).toBeUndefined()

    // 换成系统分配的端口应该能起来
    const retry = await second.start(TOOLS, { port: 0 })
    expect(retry.running).toBe(true)
    expect(retry.error).toBeUndefined()
  }, 30_000)

  it('stop 之后端口释放，状态归零', async () => {
    const { host } = await startHost()
    await host.stop()

    const status = host.status()
    expect(status.running).toBe(false)
    expect(status.exposedTools).toBe(0)
    expect(status.token).toBeUndefined()
  }, 30_000)

  /**
   * 用户报的「开关只能开不能关」。
   *
   * MCP 的 Streamable HTTP 是长连接：客户端连上后挂着一条 SSE 流不放。
   * `server.close(cb)` 的回调要等**所有连接断开**才触发 —— 于是
   * `stop()` 的 await 永远不返回，界面的 hostBusy 卡住，开关弹回「开」。
   * 应用退出时同样卡在 `will-quit` 里。
   *
   * 复现过：有一个客户端连着，close 的回调 4 秒不来，再等也不会来。
   */
  it('有外部客户端连着时也能停下来，不会挂住', async () => {
    const { host, url, token } = await startHost()
    await connect(url, token)

    const started = Date.now()
    await host.stop()
    const elapsed = Date.now() - started

    expect(host.status().running).toBe(false)
    // 主动踢连接之后是毫秒级；真挂住的话这里会跑满 3 秒的兜底超时
    expect(elapsed).toBeLessThan(2000)
  }, 30_000)

  it('停下之后同一个端口能立刻重新用起来', async () => {
    // 走 startHost 而不是自己 new —— 这个用例要真的 fetch，得拿一个 fetch 不禁用的端口
    const { host, url, token } = await startHost()
    const port = Number(new URL(url).port)

    const client = new Client({ name: 'holder', version: '1.0.0' }, { capabilities: {} })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    )

    await host.stop()
    const again = await host.start(TOOLS, { port })
    expect(again.running).toBe(true)
    expect(again.error).toBeUndefined()
  }, 30_000)
})

describe('McpServerHost 默认关闭', () => {
  it('没调 start 时不监听任何端口', () => {
    const host = new McpServerHost()
    expect(host.status()).toMatchObject({ running: false, exposedTools: 0 })
    expect(host.status().url).toBeUndefined()
  })
})

/**
 * 多客户端。
 *
 * 改动之前这里是**一个** Server 配**一个** Transport，所有客户端共用。
 * 有状态模式下一个 transport 只认一次初始化：SDK 对第二个 `initialize`
 * 直接回 400 `Server already initialized`。
 *
 * 也就是说「开着 Claude Code 的时候再跑一条 CLI 命令」不是会互相干扰，
 * 而是**后来的那个根本连不上** —— 而这正是 CLI 每条命令都要做的第一件事。
 */
describe('McpServerHost 多客户端', () => {
  const hosts: McpServerHost[] = []
  const clients: Client[] = []

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
    await Promise.all(hosts.splice(0).map((h) => h.stop()))
  })

  async function startHost(): Promise<{ host: McpServerHost; url: string; token: string }> {
    const host = new McpServerHost()
    hosts.push(host)
    const status = await host.start(TOOLS, {})
    expect(status.running).toBe(true)
    return { host, url: status.url!, token: status.token! }
  }

  async function connect(url: string, token: string, name = 'test'): Promise<Client> {
    const client = new Client({ name, version: '1.0.0' }, { capabilities: {} })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    )
    return client
  }

  it('两个客户端能同时连上，各自都能列工具、调工具', async () => {
    const { url, token } = await startHost()

    const a = await connect(url, token, 'client-a')
    const b = await connect(url, token, 'client-b')

    const [listA, listB] = await Promise.all([a.listTools(), b.listTools()])
    expect(listA.tools.length).toBeGreaterThan(0)
    expect(listB.tools.length).toBe(listA.tools.length)

    const [callA, callB] = await Promise.all([
      a.callTool({ name: 'material_describe', arguments: {} }),
      b.callTool({ name: 'material_describe', arguments: {} })
    ])
    expect(JSON.stringify(callA.content)).toContain('material_describe ok')
    expect(JSON.stringify(callB.content)).toContain('material_describe ok')
  }, 30_000)

  it('两个客户端的会话 id 不同 —— 会话是真的分开的', async () => {
    const { url, token } = await startHost()
    const a = await connect(url, token, 'client-a')
    const b = await connect(url, token, 'client-b')

    // transport 上的 session id 是服务端发回来的
    const idA = (a.transport as StreamableHTTPClientTransport).sessionId
    const idB = (b.transport as StreamableHTTPClientTransport).sessionId
    expect(idA).toBeTruthy()
    expect(idA).not.toBe(idB)
  }, 30_000)

  it('一方退出不影响另一方', async () => {
    const { url, token } = await startHost()
    const a = await connect(url, token, 'client-a')
    const b = await connect(url, token, 'client-b')

    await a.close()

    const result = await b.callTool({ name: 'material_describe', arguments: {} })
    expect(JSON.stringify(result.content)).toContain('material_describe ok')
  }, 30_000)

  /**
   * CLI 是一条命令一个进程。首版通过标准里写着「连续启动 10 次全部能完成」，
   * 这条就是它在服务端这一侧的对应物。
   */
  it('连续 10 次连上-调用-退出都能完成', async () => {
    const { url, token } = await startHost()

    for (let i = 0; i < 10; i++) {
      const client = new Client({ name: `cli-${i}`, version: '1.0.0' }, { capabilities: {} })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }
        })
      )
      const result = await client.callTool({ name: 'material_describe', arguments: {} })
      expect(JSON.stringify(result.content)).toContain('material_describe ok')
      await client.close()
    }
  }, 60_000)

  it('未知的会话 id 回 404，让客户端重新初始化', async () => {
    const { url, token } = await startHost()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': 'not-a-real-session'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })

    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).toContain('重新初始化')
  }, 30_000)

  it('没有会话 id 的非初始化请求被挡下，而不是当成新会话', async () => {
    const { url, token } = await startHost()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })

    expect(response.status).toBe(400)
  }, 30_000)

  /** 认证要挡在会话之前 —— 拿不到 token 的进程不该能造出一条会话 */
  it('token 不对时连初始化都进不来', async () => {
    const { host, url } = await startHost()

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' }
        }
      })
    })

    expect(response.status).toBe(401)
    // 服务本身还是好的
    expect(host.status().running).toBe(true)
  }, 30_000)

  it('停服务会把所有会话一起结束掉', async () => {
    const { host, url, token } = await startHost()
    const client = await connect(url, token)
    await client.listTools()

    await host.stop()

    await expect(client.listTools()).rejects.toThrow()
  }, 30_000)
})

/**
 * 契约声明与工具元数据。
 *
 * 外部客户端必须先读能力声明，才知道这个盒子认不认「显式指定工程」那套约定。
 * 旧盒子没有这一段 —— 客户端据此报 INCOMPATIBLE_SERVER，
 * 而不是把 `--project` 发出去然后被静默忽略。
 */
describe('McpServerHost 契约声明', () => {
  const hosts: McpServerHost[] = []
  const clients: Client[] = []

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
    await Promise.all(hosts.splice(0).map((h) => h.stop()))
  })

  async function connected(): Promise<Client> {
    const host = new McpServerHost()
    hosts.push(host)
    const status = await host.start(TOOLS, {})
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(status.url!), {
        requestInit: { headers: { Authorization: `Bearer ${status.token!}` } }
      })
    )
    return client
  }

  it('初始化响应里声明 unrealBox 能力', async () => {
    const client = await connected()

    expect(client.getServerCapabilities()?.experimental?.unrealBox).toEqual({
      cliContractVersion: CLI_CONTRACT_VERSION,
      projectTargeting: true,
      publicResults: true
    })
  }, 30_000)

  it('工具清单带命名空间、风险和是否需要指定工程', async () => {
    const client = await connected()
    const listed = await client.listTools()

    const actor = listed.tools.find((t) => t.name === 'ue_get_actor')!
    expect(actor._meta?.unrealBox).toMatchObject({
      namespace: 'ue.actor',
      risk: 'safe',
      projectScoped: true
    })
  }, 30_000)

  /**
   * `ue_session_health` 的进程检测在盒子这一侧做，不走引擎 RPC ——
   * 标成 projectScoped 会让调用方在「引擎没连上」时不敢调它，
   * 而那正是最需要它的时候。
   */
  it('不依赖引擎连接的 ue.* 工具不标 projectScoped', async () => {
    const client = await connected()
    const listed = await client.listTools()

    const health = listed.tools.find((t) => t.name === 'ue_session_health')!
    expect(health._meta?.unrealBox).toMatchObject({ projectScoped: false })
  }, 30_000)
})

/**
 * 目标工程绑定。
 *
 * 改动之前，外部调用**根本没有绑定** —— 调用 handler 直接 `tool.execute()`。
 * 于是每一次都掉进 `pickDefaultConnectionId()` 的「恰好一个连接才回退」：
 * 同时开两个工程时，现有客户端一条引擎命令都发不出去。
 */
describe('McpServerHost 目标工程', () => {
  const hosts: McpServerHost[] = []
  const clients: Client[] = []

  beforeEach(() => {
    projects.length = 0
  })

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
    await Promise.all(hosts.splice(0).map((h) => h.stop()))
    projects.length = 0
  })

  async function connected(): Promise<Client> {
    const host = new McpServerHost()
    hosts.push(host)
    const status = await host.start(TOOLS, {})
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(status.url!), {
        requestInit: { headers: { Authorization: `Bearer ${status.token!}` } }
      })
    )
    return client
  }

  /** 工具报出它自己看到的 connectionId —— 绑定生没生效只有它说了算 */
  async function callWithTarget(
    client: Client,
    unrealBox: Record<string, unknown> | undefined
  ): ReturnType<Client['callTool']> {
    return client.callTool({
      name: 'ue_session_health',
      arguments: {},
      ...(unrealBox ? { _meta: { unrealBox } } : {})
    })
  }

  it('指定工程路径后，工具看到的是那个工程的连接', async () => {
    projects.push({ connectionId: 'conn-a', projectPath: 'D:/Games/Demo', isConnected: true })
    projects.push({ connectionId: 'conn-b', projectPath: 'D:/Games/Other', isConnected: true })
    const client = await connected()

    const result = await callWithTarget(client, {
      cliContractVersion: CLI_CONTRACT_VERSION,
      projectPath: 'D:/Games/Other'
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('目标=conn-b')
  }, 30_000)

  /**
   * 这条是整件事的重点。
   *
   * 两个工程都在线时，不指定目标的调用**拿不到任何连接**（`pickDefaultConnectionId`
   * 拒绝猜）；指定之后才能干活。改动之前根本没有「指定」这个动作。
   */
  it('两个工程同时在线时，不指定就没有目标，指定了才有', async () => {
    projects.push({ connectionId: 'conn-a', projectPath: 'D:/Games/Demo', isConnected: true })
    projects.push({ connectionId: 'conn-b', projectPath: 'D:/Games/Other', isConnected: true })
    const client = await connected()

    const blind = await callWithTarget(client, undefined)
    expect(JSON.stringify(blind.content)).toContain('目标=undefined')

    const aimed = await callWithTarget(client, { projectPath: 'D:/Games/Demo' })
    expect(JSON.stringify(aimed.content)).toContain('目标=conn-a')
  }, 30_000)

  it('点名的工程没连上时报 PROJECT_NOT_CONNECTED，不改发给在线的那个', async () => {
    projects.push({ connectionId: 'conn-b', projectPath: 'D:/Games/Other', isConnected: true })
    const client = await connected()

    const result = await callWithTarget(client, { projectPath: 'D:/Games/Demo' })

    expect(result.isError).toBe(true)
    expect(result._meta?.unrealBox).toMatchObject({ errorCode: 'PROJECT_NOT_CONNECTED' })
    // 绝不能悄悄发给 conn-b
    expect(JSON.stringify(result.content)).not.toContain('目标=conn-b')
  }, 30_000)

  it('同一路径多条连接时报 PROJECT_AMBIGUOUS，不猜', async () => {
    projects.push({ connectionId: 'conn-1', projectPath: 'D:/Games/Demo', isConnected: true })
    projects.push({ connectionId: 'conn-2', projectPath: 'D:/Games/Demo', isConnected: true })
    const client = await connected()

    const result = await callWithTarget(client, { projectPath: 'D:/Games/Demo' })

    expect(result.isError).toBe(true)
    expect(result._meta?.unrealBox).toMatchObject({ errorCode: 'PROJECT_AMBIGUOUS' })
  }, 30_000)

  it('契约版本对不上时报 INVALID_ARGUMENT，工具不会被执行', async () => {
    projects.push({ connectionId: 'conn-a', projectPath: 'D:/Games/Demo', isConnected: true })
    const client = await connected()

    const result = await callWithTarget(client, {
      cliContractVersion: 99,
      projectPath: 'D:/Games/Demo'
    })

    expect(result.isError).toBe(true)
    expect(result._meta?.unrealBox).toMatchObject({ errorCode: 'INVALID_ARGUMENT' })
    expect(JSON.stringify(result.content)).not.toContain('目标=')
  }, 30_000)

  /** 旧客户端不发 `_meta.unrealBox`，行为必须与改动之前一模一样 */
  it('不带元数据的调用照常执行，不被强绑目标', async () => {
    projects.push({ connectionId: 'conn-a', projectPath: 'D:/Games/Demo', isConnected: true })
    const client = await connected()

    const result = await callWithTarget(client, undefined)

    expect(result.isError).toBeFalsy()
    // 没进上下文，所以工具读到的是 undefined，由 WebSocket 那层做单连接回退
    expect(JSON.stringify(result.content)).toContain('目标=undefined')
  }, 30_000)

  it('工具执行失败仍然是 isError，不会被包装成成功', async () => {
    const client = await connected()

    const result = await client.callTool({ name: 'boom', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result._meta?.unrealBox).toMatchObject({ errorCode: 'TOOL_FAILED' })
    expect(JSON.stringify(result.content)).toContain('工具内部炸了')
  }, 30_000)
})

/**
 * 公共结果。
 *
 * `details` 从来没发给过 MCP 客户端。这一段确认它现在以固定形状发出去了，
 * 而且**文本块一个字没动** —— 旧客户端读的是文本，不能因为加了结构化视图
 * 就变了样。
 */
describe('McpServerHost 公共结果', () => {
  const hosts: McpServerHost[] = []
  const clients: Client[] = []

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
    await Promise.all(hosts.splice(0).map((h) => h.stop()))
  })

  async function connected(): Promise<Client> {
    const host = new McpServerHost()
    hosts.push(host)
    const status = await host.start(TOOLS, {})
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(status.url!), {
        requestInit: { headers: { Authorization: `Bearer ${status.token!}` } }
      })
    )
    return client
  }

  it('有 serializer 的工具带上 structuredContent，且计数字段齐全', async () => {
    const client = await connected()

    const result = await client.callTool({ name: 'ue_get_actor', arguments: {} })

    expect(result.structuredContent).toMatchObject({
      returnedCount: 1,
      totalCount: 137,
      truncated: true,
      units: { location: 'cm', rotation: 'deg', scale: 'multiplier', bounds: 'cm' }
    })
  }, 30_000)

  it('文本块保持原样 —— 旧客户端看到的东西不变', async () => {
    const client = await connected()

    const result = await client.callTool({ name: 'ue_get_actor', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'ue_get_actor ok' }])
  }, 30_000)

  it('没有 serializer 的工具不返回 structuredContent', async () => {
    const client = await connected()

    const result = await client.callTool({ name: 'material_describe', arguments: {} })

    expect(result.structuredContent).toBeUndefined()
  }, 30_000)
})
