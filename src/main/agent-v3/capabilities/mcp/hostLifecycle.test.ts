/**
 * @vitest-environment node
 *
 * 开 → 关 → 再开的完整往返，走的是界面真正调的那三个函数
 * （`startMcpServer` / `disableMcpServer` / `mcpServerStatus`）。
 *
 * 用户报的「开关只能开不能关」就发生在这条链上。单测 `McpServerHost`
 * 只覆盖了类本身；能不能关掉，取决于这一层有没有把状态和持久化摆平。
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

import { defineTool, type UnrealAgentTool } from '../../tools/defineTool'
import { z } from 'zod'
import {
  autoStartMcpServer,
  disableMcpServer,
  mcpServerStatus,
  readHostSettings,
  saveMcpServerConfig,
  startMcpServer,
  stopMcpServer,
  writeHostSettings
} from './index'

const TOOLS = [
  defineTool({
    name: 'ue_get_actor',
    namespace: 'ue.actor',
    risk: 'safe',
    description: '测试工具',
    input: z.object({}),
    execute: async () => ({ text: 'ok' })
  }) as unknown as UnrealAgentTool<never>
]

const settingsFile = (): string => join(userData, 'mcp-server.json')
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(settingsFile(), 'utf8'))

/** 让每个用例用不同端口，避免上一个用例的 TIME_WAIT 影响下一个 */
let portSeq = 0
const nextPort = (): number => 19700 + portSeq++

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'ua-mcp-life-'))
})

afterEach(async () => {
  await stopMcpServer()
  rmSync(userData, { recursive: true, force: true })
})

describe('对外服务的开关往返', () => {
  it('开起来之后状态和磁盘都说「开着」', async () => {
    const port = nextPort()
    const status = await startMcpServer(TOOLS, { port })

    expect(status.running).toBe(true)
    expect(status.url).toBe(`http://127.0.0.1:${port}/`)
    expect(mcpServerStatus().running).toBe(true)
    expect(onDisk()).toMatchObject({ enabled: true, port })
  })

  /**
   * 用户报的：开关只能开不能关。
   *
   * 关掉之后三处都得改过来 —— 运行状态、`mcpServerStatus()`（界面刷新时读它）、
   * 磁盘上的 enabled（否则下次开机又自己起来，看着还是关不掉）。
   */
  it('关得掉，而且三处状态一致', async () => {
    await startMcpServer(TOOLS, { port: nextPort() })

    const status = await disableMcpServer()
    expect(status.running).toBe(false)
    expect(mcpServerStatus().running).toBe(false)
    expect(onDisk()).toMatchObject({ enabled: false })
  })

  /**
   * 真正卡住的地方：外部客户端挂着一条 SSE 长连接时，
   * `server.close()` 的回调永远不来。实测等 4 秒也不来。
   * 界面上就表现为点了关闭没反应、开关弹回「开」。
   */
  it('有外部客户端连着时也关得掉，不会卡住', async () => {
    const started = await startMcpServer(TOOLS, { port: nextPort() })

    const client = new Client({ name: 'external', version: '1' }, { capabilities: {} })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(started.url!), {
        requestInit: { headers: { Authorization: `Bearer ${started.token}` } }
      })
    )
    expect((await client.listTools()).tools).toHaveLength(1)

    const t0 = Date.now()
    const status = await disableMcpServer()

    expect(status.running).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2000)
    await client.close().catch(() => undefined)
  }, 20_000)

  it('关掉再开还能起来，端口没被自己占住', async () => {
    const port = nextPort()
    await startMcpServer(TOOLS, { port })
    await disableMcpServer()

    const again = await startMcpServer(TOOLS, { port })
    expect(again.running).toBe(true)
    expect(again.error).toBeUndefined()
  }, 20_000)

  // 关掉之后就不该再自己起来，否则用户永远关不干净
  it('关掉之后开机自启不再拉起它', async () => {
    await startMcpServer(TOOLS, { port: nextPort() })
    await disableMcpServer()

    await autoStartMcpServer(() => TOOLS)
    expect(mcpServerStatus().running).toBe(false)
  })
})

describe('配置的持久化', () => {
  /**
   * 用户报的「配置没有持久化」。
   *
   * 端口和「开放写操作工具」原来只有 `startMcpServer` 会写盘：
   * 用户在设置里改完不点开启就切走，下次回来全变回默认值。
   */
  it('只改配置不启动服务，也要落盘', async () => {
    await saveMcpServerConfig({ port: 18888, includeMutating: true })

    expect(onDisk()).toMatchObject({ port: 18888, includeMutating: true })
    // 没启动就是没启动，saveConfig 不该顺手把服务拉起来。
    //
    // 只断言 `running`：`enabled` 现在默认是 true（它表达的是「下次开机要不要
    // 自动拉起」，不是「此刻在不在跑」），拿它判断有没有被启动会验错东西。
    expect(mcpServerStatus().running).toBe(false)
  })

  it('存配置不会把令牌换掉 —— 换了外部客户端就连不上了', async () => {
    const before = (await readHostSettings()).token
    await saveMcpServerConfig({ port: 18889 })

    expect((await readHostSettings()).token).toBe(before)
  })

  it('存过的端口，下次启动就按它来', async () => {
    const port = nextPort()
    await saveMcpServerConfig({ port })

    const status = await startMcpServer(TOOLS, {})
    expect(status.url).toBe(`http://127.0.0.1:${port}/`)
  })

  it('存过的暴露范围，下次启动就按它来', async () => {
    await saveMcpServerConfig({ includeMutating: true })
    await startMcpServer(TOOLS, { port: nextPort() })

    expect(onDisk().includeMutating).toBe(true)
  })

  // 上次开着就自动起来，这是「配一次就行」的前提
  it('上次是开着的，开机自启会把它拉起来', async () => {
    const port = nextPort()
    const base = await readHostSettings()
    await writeHostSettings({ ...base, enabled: true, port })

    await autoStartMcpServer(() => TOOLS)
    expect(mcpServerStatus().running).toBe(true)
    expect(mcpServerStatus().url).toBe(`http://127.0.0.1:${port}/`)
  }, 20_000)
})
