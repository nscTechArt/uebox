/**
 * @vitest-environment node
 *
 * 用**真实的工具注册表**跑一遍对外暴露的完整链路。
 *
 * `McpServerHost.test.ts` 用的是几个手写的假工具，验的是协议层：token、
 * 白名单、isError 翻译。那些都对，但它证明不了**真的能投入使用** ——
 * 盒子里那七十多个工具是从 V2 适配来的，schema 五花八门，只要有一个
 * inputSchema 不合 MCP 规范，外部客户端 `listTools` 就整个失败，
 * 用户看到的是「连上了但一个工具都没有」。
 *
 * 所以这里连一个真的 MCP 客户端上去，列一遍真实工具。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { electronMock, servicesMock, targetContextMock } from '../../testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('../../../services', () => servicesMock())
vi.mock('../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

vi.mock('../../../appSettingsManager', () => ({
  appSettingsManager: { getSettings: () => ({ agentDisabledTools: [] }) }
}))
vi.mock('../../../services/project/projectManager', () => ({
  projectManager: { getInteractiveProjects: () => [] }
}))
vi.mock('../../tools/builtin/localShell', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isShellAvailable: async () => true
}))
vi.mock('./index', () => ({
  ensureConnected: async () => ({ getTools: () => [], getStatuses: () => [] })
}))

import { buildAllTools } from '../../tools/registry'
import { setupMcpSession } from './hostSession'
import { McpServerHost } from './McpServerHost'

const hosts: McpServerHost[] = []
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
})

async function listRealTools(
  options: Parameters<McpServerHost['start']>[1] = {}
): Promise<string[]> {
  const host = new McpServerHost()
  hosts.push(host)
  const status = await host.start(buildAllTools() as never, options)
  expect(status.running).toBe(true)

  const client = new Client({ name: 'external', version: '1.0.0' }, { capabilities: {} })
  clients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(status.url!), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}` } }
    })
  )

  return (await client.listTools()).tools.map((t) => t.name)
}

describe('外部客户端看到的是真实工具', () => {
  /**
   * 这一条是「能不能用」的底线。
   *
   * listTools 会把每个工具的 inputSchema 过一遍 MCP 的校验；只要有一个
   * 工具的 schema 不合规，整个请求失败 —— 不是那一个工具消失，是全部消失。
   */
  it('真实注册表能被外部客户端完整列出来', async () => {
    const names = await listRealTools()
    expect(names.length).toBeGreaterThan(10)
    // 只读工具里最典型的两个
    expect(names).toContain('search_assets')
    expect(names).toContain('ue_content_search')
  }, 60_000)

  it('默认不暴露任何写操作工具', async () => {
    const names = await listRealTools()
    const risky = buildAllTools()
      .filter((t) => t.unrealBox.risk !== 'safe')
      .map((t) => t.name)

    expect(risky.length).toBeGreaterThan(0)
    expect(names.filter((n) => risky.includes(n))).toEqual([])
  }, 60_000)

  it('勾了 includeMutating 才多出写操作工具', async () => {
    const readOnly = await listRealTools()
    const all = await listRealTools({ includeMutating: true })
    expect(all.length).toBeGreaterThan(readOnly.length)
    expect(all).toContain('project_manage')
  }, 60_000)

  /**
   * 开了写操作就和盒子助手手上一样全：本地文件、shell、接第三方 MCP 都在。
   * 审批交给客户端，按工具注解拦 —— 这条挂了说明又有人在对外那一层砍了一刀，
   * 两边工具对不上，Codex 和盒子的效果就没法比。
   */
  it('开了写操作后本地文件、shell、接第三方 MCP 都对外', async () => {
    const names = await listRealTools({ includeMutating: true })
    for (const name of [
      'run_shell_command',
      'write_local_file',
      'edit_local_file',
      'read_local_file',
      'inspect_uasset_file',
      'connect_mcp_server'
    ]) {
      expect(names).toContain(name)
    }
  }, 60_000)

  /**
   * 按会话装配走的是盒子助手那条路（`resolveAgentTools`），比注册表多出
   * 技能、task、浏览器这些现造的工具。它们的 schema 同样要过 MCP 的校验。
   */
  it('按会话装配的完整工具池能被外部客户端列出来，并带着盒子的系统提示', async () => {
    const host = new McpServerHost()
    hosts.push(host)
    const status = await host.start(setupMcpSession, { includeMutating: true })
    expect(status.running).toBe(true)

    const client = new Client({ name: 'external', version: '1.0.0' }, { capabilities: {} })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(status.url!), {
        requestInit: { headers: { Authorization: `Bearer ${status.token}` } }
      })
    )

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('task')
    expect(names).toContain('browser_open')
    expect(names).toContain('run_shell_command')
    // 没声明 elicitation 的客户端不给 ask_user —— 给了只会挂在那儿等
    expect(names).not.toContain('ask_user')
    expect(client.getInstructions()).toContain('You are the AI assistant inside Unreal Box')
  }, 60_000)
})
