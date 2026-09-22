/**
 * @vitest-environment node
 *
 * 默认环境是 happy-dom（浏览器语义），它的 fetch 会强制 CORS，
 * 把发往 127.0.0.1 的请求当跨域拦掉。这是主进程代码（拉子进程走 stdio），
 * 必须跑在 node 环境。
 */

import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { MAX_TOOLS_PER_SERVER, McpClientManager } from './McpClientManager'

/**
 * 端到端：真的拉起一个 MCP server 子进程，走完整的 stdio 握手。
 *
 * 上面那组单测只覆盖了纯函数（名字清洗、内容块转换）。连接、listTools、
 * callTool、失败语义这些只有真跑一个 server 才能验 —— 而这几处正是
 * 最容易在「看起来对」的实现里出错的地方。
 *
 * server 实现在 `tests/fixtures/mcp/echo-server.mjs`。
 */
const SERVER = join(process.cwd(), 'tests', 'fixtures', 'mcp', 'echo-server.mjs')
const manager = new McpClientManager()

afterAll(() => manager.disconnectAll())

describe('MCP 端到端', () => {
  it('连上真实 server 并列出工具', async () => {
    await manager.connectAll({
      echo: { type: 'stdio', command: process.execPath, args: [SERVER] }
    })

    const status = manager.getStatuses().find((s) => s.id === 'echo')
    expect(status?.error).toBeUndefined()
    expect(status?.connected).toBe(true)
    expect(status?.serverName).toBe('echo-test')
    expect(status?.toolCount).toBe(2)
  }, 30_000)

  it('工具名被清洗成厂商可接受的形态', () => {
    const names = manager.getTools().map((t) => t.name)
    // server 端叫 echo.text，点号会被厂商拒
    expect(names).toContain('mcp_echo_echo_text')
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('MCP 的 inputSchema 直接当 JSON Schema 用，不经 Zod', () => {
    const tool = manager.getTools().find((t) => t.name === 'mcp_echo_echo_text')!
    const params = tool.parameters as { type?: string; required?: string[] }
    expect(params.type).toBe('object')
    expect(params.required).toEqual(['message'])
  })

  it('真的调得通，结果转成 pi 的内容块', async () => {
    const tool = manager.getTools().find((t) => t.name === 'mcp_echo_echo_text')!
    const result = await tool.execute('c1', { message: '你好' })

    expect(result.content).toEqual([{ type: 'text', text: 'echo: 你好' }])
  }, 30_000)

  // pi 只认异常。返回一个"看起来成功"的结果会让模型基于错误前提继续往下做。
  it('server 报 isError 时抛出，而不是当成功返回', async () => {
    const tool = manager.getTools().find((t) => t.name === 'mcp_echo_always_fails')!
    await expect(tool.execute('c1', {})).rejects.toThrow(/故意失败/)
  }, 30_000)

  it('第三方工具一律标 destructive —— 我们看不到它的实现', () => {
    for (const tool of manager.getTools()) {
      expect(tool.unrealBox.risk).toBe('destructive')
      expect(tool.unrealBox.namespace).toBe('mcp.echo')
    }
  })

  it('描述里标明来源，便于用户定位问题', () => {
    const tool = manager.getTools().find((t) => t.name === 'mcp_echo_echo_text')!
    expect(tool.description).toContain('MCP server "echo"')
  })

  it('起不来的 server 只记进状态，不影响其他 server', async () => {
    const isolated = new McpClientManager()
    await isolated.connectAll({
      good: { type: 'stdio', command: process.execPath, args: [SERVER] },
      bad: { type: 'stdio', command: 'this-command-does-not-exist-12345' }
    })

    const statuses = new Map(isolated.getStatuses().map((s) => [s.id, s]))
    expect(statuses.get('good')?.connected).toBe(true)
    expect(statuses.get('bad')?.connected).toBe(false)
    expect(statuses.get('bad')?.error).toBeTruthy()
    // 坏 server 不该带走好 server 的工具
    expect(isolated.getTools().length).toBe(2)

    await isolated.disconnectAll()
  }, 40_000)

  it('allowedTools 白名单能收窄暴露范围', async () => {
    const limited = new McpClientManager()
    await limited.connectAll({
      echo: {
        type: 'stdio',
        command: process.execPath,
        args: [SERVER],
        allowedTools: ['echo.text']
      }
    })

    expect(limited.getTools().map((t) => t.name)).toEqual(['mcp_echo_echo_text'])
    await limited.disconnectAll()
  }, 30_000)

  /**
   * 停用的 server 不连，但**要留一条状态**。
   *
   * 原来是完全过滤掉，于是「停用了」和「压根没配过」在下游长得一模一样：
   * 用户停用后忘了，问起来 agent 只会说「我没有这个能力」，
   * 而正确的回答是「你把它停用了」。见 promptSection.ts。
   */
  it('disabled 的 server 不连，但状态里要认得出它被停用了', async () => {
    const off = new McpClientManager()
    await off.connectAll({
      echo: { type: 'stdio', command: process.execPath, args: [SERVER], disabled: true }
    })
    expect(off.getTools()).toEqual([])
    expect(off.getStatuses()).toEqual([
      { id: 'echo', connected: false, toolCount: 0, disabled: true }
    ])
  })
})

/**
 * 会话进行中现接一台（`connect_mcp_server` 工具走的路）。
 *
 * 和 `connectAll` 的语义正相反：那边一台连不上不能拖垮其余的，所以吞异常；
 * 这边是用户刚说完「你连一下」，连不上就是这次调用的结果，必须抛回他面前。
 */
describe('现接一台 server', () => {
  it('连上之后工具立刻挂在这台 server 名下', async () => {
    const live = new McpClientManager()
    const status = await live.addServer('echo', {
      type: 'stdio',
      command: process.execPath,
      args: [SERVER]
    })

    expect(status.connected).toBe(true)
    expect(status.toolCount).toBe(2)
    expect(live.toolsOf('echo').map((t) => t.name)).toContain('mcp_echo_echo_text')
    await live.disconnectAll()
  }, 30_000)

  /**
   * 失败要抛，而且**不留状态**。
   *
   * 留下来的话系统提示词会报一台根本不存在的 server 连不上（配置还没落盘，
   * 失败时也不会落），用户拿着那个 id 去设置里找，什么都找不到。
   */
  it('连不上时抛出，并且不在状态里留下一台并不存在的 server', async () => {
    const live = new McpClientManager()
    await expect(
      live.addServer('ghost', { type: 'stdio', command: 'this-command-does-not-exist-12345' })
    ).rejects.toThrow()

    expect(live.getStatuses()).toEqual([])
    expect(live.toolsOf('ghost')).toEqual([])
  }, 40_000)

  // 覆盖反过来：那台仍然配置在盘上，抹掉状态会让它从提示词里凭空消失
  it('覆盖一台已有的 server 失败时，留一条 FAILED 而不是让它消失', async () => {
    const live = new McpClientManager()
    await live.addServer('echo', { type: 'stdio', command: process.execPath, args: [SERVER] })

    await expect(
      live.addServer('echo', { type: 'stdio', command: 'this-command-does-not-exist-12345' })
    ).rejects.toThrow()

    const status = live.getStatuses().find((s) => s.id === 'echo')
    expect(status?.connected).toBe(false)
    expect(status?.error).toBeTruthy()
    await live.disconnectAll()
  }, 40_000)
})

/**
 * `readOnlyTools`：点名把纯发现类工具降级为 `safe`。
 *
 * 默认全是 `destructive` 是对的 —— server 自报的 `readOnlyHint` 不可信。
 * 但发现类工具是个例外：模型每次动手前都要先调一遍查能力，全弹审批的话
 * 用户在真正的操作出现之前就已经点了两三次确认，很快会养成闭眼点「允许」
 * 的习惯 —— **审批门被点烦了就等于没有**。
 *
 * 关键是这必须是**点名制而不是信任制**：同一个 server 的其余工具不受影响。
 */
describe('readOnlyTools 点名降级', () => {
  const scoped = new McpClientManager()

  afterAll(() => scoped.disconnectAll())

  it('只有点名的那个降级为 safe，同 server 的其余仍是 destructive', async () => {
    await scoped.connectAll({
      echo: {
        type: 'stdio',
        command: process.execPath,
        args: [SERVER],
        readOnlyTools: ['echo.text']
      }
    })

    const byName = new Map(scoped.getTools().map((t) => [t.name, t]))
    expect(byName.get('mcp_echo_echo_text')?.unrealBox.risk).toBe('safe')
    expect(byName.get('mcp_echo_always_fails')?.unrealBox.risk).toBe('destructive')
  }, 30_000)

  it('名单按 server 端原始工具名匹配，不是清洗后的名字', async () => {
    // 用户抄的是 server 文档里的名字（`echo.text`），不是我们内部
    // 清洗出来的 `mcp_echo_echo_text`。拿错一边名单会静默失效。
    const wrong = new McpClientManager()
    await wrong.connectAll({
      echo: {
        type: 'stdio',
        command: process.execPath,
        args: [SERVER],
        readOnlyTools: ['mcp_echo_echo_text']
      }
    })

    expect(wrong.getTools().find((t) => t.name === 'mcp_echo_echo_text')?.unrealBox.risk).toBe(
      'destructive'
    )
    await wrong.disconnectAll()
  }, 30_000)
})

/**
 * 工具数上限：超量的 server 整个不接。
 *
 * 不截断 —— 截断会让模型看到一份残缺的能力表，「有些工具时灵时不灵」
 * 比「这个 server 没接上」难排查得多。
 */
describe('MAX_TOOLS_PER_SERVER', () => {
  const MANY = join(process.cwd(), 'tests', 'fixtures', 'mcp', 'many-tools-server.mjs')

  it('超过上限时拒绝接入，并给出可操作的报错', async () => {
    const flooded = new McpClientManager()
    await flooded.connectAll({
      many: { type: 'stdio', command: process.execPath, args: [MANY] }
    })

    const status = flooded.getStatuses().find((s) => s.id === 'many')
    expect(status?.connected).toBe(false)
    expect(status?.error).toContain(String(MAX_TOOLS_PER_SERVER))
    // 报错要告诉用户下一步敲什么，而不只是「太多了」
    expect(status?.error).toContain('allowedTools')
    // 一个工具都不能漏进来
    expect(flooded.getTools()).toEqual([])

    await flooded.disconnectAll()
  }, 40_000)

  it('用 allowedTools 收窄后同一个 server 就能接进来', async () => {
    const narrowed = new McpClientManager()
    await narrowed.connectAll({
      many: {
        type: 'stdio',
        command: process.execPath,
        args: [MANY],
        allowedTools: ['toolset_registry.toolsets.core.generated.GeneratedTools.tool_number_0']
      }
    })

    expect(narrowed.getStatuses().find((s) => s.id === 'many')?.connected).toBe(true)
    expect(narrowed.getTools()).toHaveLength(1)

    await narrowed.disconnectAll()
  }, 40_000)

  it('超量 server 不影响同批次的其他 server', async () => {
    const mixed = new McpClientManager()
    await mixed.connectAll({
      many: { type: 'stdio', command: process.execPath, args: [MANY] },
      echo: { type: 'stdio', command: process.execPath, args: [SERVER] }
    })

    expect(mixed.getStatuses().find((s) => s.id === 'echo')?.connected).toBe(true)
    expect(mixed.getTools()).toHaveLength(2)

    await mixed.disconnectAll()
  }, 40_000)
})

/**
 * 接一个**故意不像我们自己写的** server。
 *
 * 上面那组用的是 `echo-server.mjs` —— 我们自己写的，schema 长得就是我们
 * 习惯的样子，自然不会踩到我们的坑。真实第三方 server 不会照顾我们。
 *
 * 这里最要紧的一条是 schema 透传：`toAgentTool` 把对方的 `inputSchema`
 * 原样交给厂商。对方用了 `$ref` / `oneOf` 这类**合法但厂商不收**的写法时，
 * 厂商拒的是整个请求，于是**所有工具一起失效**，而不只是这一个不可用。
 */
describe('第三方 server 的难缠 schema', () => {
  const QUIRKY = join(process.cwd(), 'tests', 'fixtures', 'mcp', 'quirky-server.mjs')
  const quirky = new McpClientManager()

  afterAll(() => quirky.disconnectAll())

  it('连得上，六个工具一个不少', async () => {
    await quirky.connectAll({
      vendor: { type: 'stdio', command: process.execPath, args: [QUIRKY] }
    })

    const status = quirky.getStatuses().find((s) => s.id === 'vendor')
    expect(status?.error).toBeUndefined()
    expect(status?.serverName).toBe('quirky-third-party')
    expect(status?.toolCount).toBe(6)
  }, 30_000)

  it('工具名一律清洗成厂商收得下的形态', () => {
    for (const tool of quirky.getTools()) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    }
  })

  // 这条是整组里最要紧的
  it('schema 里不留 $ref / $defs / oneOf —— 留着会让整个请求被厂商拒掉', () => {
    const serialized = JSON.stringify(quirky.getTools().map((t) => t.parameters))
    expect(serialized).not.toContain('$ref')
    expect(serialized).not.toContain('$defs')
    expect(serialized).not.toContain('oneOf')
    expect(serialized).not.toContain('anyOf')
  })

  it('每个工具都有可用的 object schema', () => {
    for (const tool of quirky.getTools()) {
      expect((tool.parameters as { type?: string }).type).toBe('object')
    }
  })

  it('难缠 schema 的工具真的调得通', async () => {
    const tool = quirky.getTools().find((t) => t.name.includes('query'))
    const result = await tool!.execute('c1', { table: 'assets' })
    expect(JSON.stringify(result.content)).toContain('queried assets')
  }, 30_000)

  it('server 报 isError 时抛异常，不当成功返回', async () => {
    const tool = quirky.getTools().find((t) => t.name.includes('notify'))
    await expect(tool!.execute('c2', {})).rejects.toThrow(/not implemented/)
  }, 30_000)
})
