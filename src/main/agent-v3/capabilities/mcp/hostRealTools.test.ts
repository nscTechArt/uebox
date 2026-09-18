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

import { buildAllTools } from '../../tools/registry'
import { McpServerHost, selectExposedTools } from './McpServerHost'

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
   * 危险的东西**永远**不对外，勾了 includeMutating 也不行。
   *
   * MCP 这一头没有审批门 —— `McpServerHost` 是 `tool.execute()` 直接调用，
   * 盒子内部那套 approval 弹窗完全不参与。所以 `run_shell_command` 一旦暴露，
   * 等于把任意命令执行权交给任何拿到 token 的进程。
   *
   * 这条如果挂了，说明有人给对外暴露加了新的命名空间又忘了想这件事。
   */
  it('本地文件与 shell 工具在任何配置下都不对外', async () => {
    const exposed = selectExposedTools(buildAllTools() as never, { includeMutating: true }).map(
      (t) => t.name
    )
    for (const name of ['run_shell_command', 'write_local_file', 'edit_local_file']) {
      expect(exposed).not.toContain(name)
    }
    expect(exposed).not.toContain('task')
    expect(exposed).not.toContain('load_skill')

    // 走一遍真实协议，确认过滤发生在 listTools 之前而不是只在这个纯函数里
    expect(await listRealTools({ includeMutating: true })).not.toContain('run_shell_command')
  }, 60_000)
})
