import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'agent-v3-mcp-'))
vi.mock('electron', () => ({ app: { getPath: (): string => root } }))

import { normalizeServer, readMcpSettings, upsertMcpServer, writeMcpSettings } from './store'

afterAll(() => rmSync(root, { recursive: true, force: true }))

const CONFIG_PATH = join(root, 'mcp.json')

function writeRaw(text: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(CONFIG_PATH, text, 'utf8')
}

beforeEach(() => rmSync(CONFIG_PATH, { force: true }))

describe('normalizeServer', () => {
  it('识别 stdio 形态', () => {
    expect(normalizeServer('fs', { command: 'npx', args: ['-y', 'server-fs'] })).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server-fs']
    })
  })

  // Claude Desktop 的配置里 type 常常省略，只有 url
  it('有 url 就按 http 处理，即使没写 type', () => {
    expect(normalizeServer('remote', { url: 'https://example.com/mcp' })).toEqual({
      type: 'http',
      url: 'https://example.com/mcp'
    })
  })

  it('带 headers 的 http 配置', () => {
    const out = normalizeServer('remote', {
      type: 'http',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer t' }
    })
    expect(out).toMatchObject({ headers: { Authorization: 'Bearer t' } })
  })

  it('既没 command 也没 url 时丢弃', () => {
    expect(normalizeServer('bad', { args: ['x'] })).toBeNull()
  })

  it('声明 http 却没 url 时丢弃', () => {
    expect(normalizeServer('bad', { type: 'http' })).toBeNull()
  })

  it('保留 disabled 与 allowedTools', () => {
    const out = normalizeServer('x', {
      command: 'a',
      disabled: true,
      allowedTools: ['t1', 't2']
    })
    expect(out).toMatchObject({ disabled: true, allowedTools: ['t1', 't2'] })
  })

  it('忽略类型不对的字段而不是整条丢掉', () => {
    // 用户手改配置写错类型很常见，不该因此读不出整份配置
    const out = normalizeServer('x', { command: 'a', args: 'not-an-array', env: 42 })
    expect(out).toEqual({ type: 'stdio', command: 'a' })
  })

  it('非对象直接丢弃', () => {
    expect(normalizeServer('x', 'nope')).toBeNull()
    expect(normalizeServer('x', null)).toBeNull()
  })
})

describe('readMcpSettings', () => {
  it('文件不存在时返回空配置', async () => {
    expect(await readMcpSettings()).toEqual({ version: 1, mcpServers: {} })
  })

  it('JSON 坏了不抛，按空配置继续', async () => {
    // 这个文件用户可以直接编辑，写坏不该让 AI 功能整个用不了
    writeRaw('{ 这不是 JSON')
    expect(await readMcpSettings()).toEqual({ version: 1, mcpServers: {} })
  })

  it('读得出 Claude Desktop 格式的配置', async () => {
    writeRaw(
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
          remote: { url: 'https://example.com/mcp' }
        }
      })
    )
    const settings = await readMcpSettings()
    expect(Object.keys(settings.mcpServers).sort()).toEqual(['filesystem', 'remote'])
  })

  // serverId 会成为工具名的一部分，非法字符会让整个请求被厂商拒掉
  it('跳过非法的 serverId，保留合法的', async () => {
    writeRaw(
      JSON.stringify({
        mcpServers: {
          'good-one': { command: 'a' },
          'bad id with spaces': { command: 'b' },
          中文名: { command: 'c' },
          ['x'.repeat(40)]: { command: 'd' }
        }
      })
    )
    expect(Object.keys((await readMcpSettings()).mcpServers)).toEqual(['good-one'])
  })

  it('一条坏配置不影响其他条', async () => {
    writeRaw(
      JSON.stringify({
        mcpServers: { ok: { command: 'a' }, broken: { nothing: true } }
      })
    )
    expect(Object.keys((await readMcpSettings()).mcpServers)).toEqual(['ok'])
  })

  it('没有 mcpServers 键时返回空配置', async () => {
    writeRaw(JSON.stringify({ somethingElse: 1 }))
    expect((await readMcpSettings()).mcpServers).toEqual({})
  })
})

describe('writeMcpSettings', () => {
  it('写进去能原样读回来', async () => {
    await writeMcpSettings({
      version: 1,
      mcpServers: { fs: { type: 'stdio', command: 'npx', args: ['-y', 'x'] } }
    })
    const back = await readMcpSettings()
    expect(back.mcpServers.fs).toMatchObject({ command: 'npx', args: ['-y', 'x'] })
  })
})

describe('upsertMcpServer', () => {
  it('记事本存出来带 BOM 的文件照样认得，已有的 server 不丢', async () => {
    writeRaw(
      String.fromCharCode(0xfeff) +
        JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } })
    )
    expect((await readMcpSettings()).mcpServers.github).toMatchObject({ command: 'gh-mcp' })

    await upsertMcpServer('fs', { type: 'stdio', command: 'npx' })

    const back = await readMcpSettings()
    expect(Object.keys(back.mcpServers).sort()).toEqual(['fs', 'github'])
  })

  it('文件坏了就不写：不能按空配置覆盖，把用户别的 server 抹掉', async () => {
    const broken = '{ "mcpServers": { "github": { "command": "gh-mcp" }, } }'
    writeRaw(broken)

    await expect(upsertMcpServer('fs', { type: 'stdio', command: 'npx' })).rejects.toThrow(
      /mcp\.json/
    )
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(broken)
  })

  it('没有文件时从空配置起一份', async () => {
    await upsertMcpServer('fs', { type: 'stdio', command: 'npx' })
    expect((await readMcpSettings()).mcpServers.fs).toMatchObject({ command: 'npx' })
  })
})
