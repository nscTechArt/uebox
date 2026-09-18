/** @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import {
  DEFAULT_HOST_PORT,
  clientConfigSnippet,
  hostUrl,
  readHostSettings,
  rotateHostToken,
  writeHostSettings
} from './hostStore'

const file = (): string => join(userData, 'mcp-server.json')

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'ua-mcp-host-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('对外 MCP server 的持久化配置', () => {
  /**
   * 默认**开**。
   *
   * 原来是默认关、要用户去设置里显式开一次。那条默认挡住的主要是误装误用，
   * 代价却是随包发的命令行开箱不可用 —— 而用户完全想不到要去「MCP 设置」里
   * 开一个叫「对外暴露虚幻引擎能力」的开关才能敲 uebox。
   *
   * 另外三条安全属性一条没动：只监听回环、强制 token、**默认只暴露只读工具**。
   */
  it('没配过时默认：自动启动、只读、默认端口', async () => {
    const settings = await readHostSettings()
    expect(settings.enabled).toBe(true)
    expect(settings.includeMutating).toBe(false)
    expect(settings.port).toBe(DEFAULT_HOST_PORT)
  })

  describe('「默认开」对老配置的迁移', () => {
    /**
     * 麻烦在于：首次读取会把 `enabled: false` 落盘（为了持久化 token 顺手写的），
     * 所以磁盘上的 false **分不出**「用户明确关过」和「他从来没做过选择」。
     */
    it('老文件里的 false 不算用户的选择，按新默认开', async () => {
      writeFileSync(file(), '{"enabled":false,"port":17861,"token":"abc"}', 'utf8')
      expect((await readHostSettings()).enabled).toBe(true)
    })

    it('迁移过一次之后，用户关掉就是真关掉', async () => {
      writeFileSync(file(), '{"enabled":false,"port":17861,"token":"abc"}', 'utf8')
      await readHostSettings() // 迁移，落下标记
      await writeHostSettings({ ...(await readHostSettings()), enabled: false })

      expect((await readHostSettings()).enabled).toBe(false)
    })

    /** 标记必须落盘，否则每次启动都把用户关掉的服务又打开一遍 */
    it('迁移标记会落盘，不会每次启动重来', async () => {
      writeFileSync(file(), '{"enabled":false,"port":17861,"token":"abc"}', 'utf8')
      await readHostSettings()

      expect(JSON.parse(readFileSync(file(), 'utf8')).defaultOnApplied).toBe(true)
    })
  })

  /**
   * 这条是整个持久化的存在理由。
   *
   * 第一版每次启动都新生成 token，用户粘进 Claude Code 的配置隔天就失效。
   * token 必须首次生成后一直不变。
   */
  it('token 只生成一次，之后每次读都是同一把', async () => {
    const first = await readHostSettings()
    expect(first.token.length).toBeGreaterThanOrEqual(32)

    const second = await readHostSettings()
    expect(second.token).toBe(first.token)
  })

  it('首次生成的 token 当场落盘 —— 不落盘的话每次读都会换一把', async () => {
    const settings = await readHostSettings()
    expect(JSON.parse(readFileSync(file(), 'utf8')).token).toBe(settings.token)
  })

  it('端口和开关能存下来', async () => {
    const base = await readHostSettings()
    await writeHostSettings({ ...base, enabled: true, port: 18999, includeMutating: true })

    const back = await readHostSettings()
    expect(back).toMatchObject({ enabled: true, port: 18999, includeMutating: true })
    expect(back.token).toBe(base.token)
  })

  // 和 mcp.json 一样是用户可手改的文件，一个字段写坏不该让服务起不来
  it.each([
    ['不是 JSON', 'not json at all'],
    ['不是对象', '"just a string"'],
    ['端口写成了字符串', '{"port":"abc"}'],
    ['端口超出范围', '{"port":99999}'],
    ['端口是 0', '{"port":0}']
  ])('%s 时回落到默认端口而不是崩掉', async (_label, content) => {
    writeFileSync(file(), content, 'utf8')
    const settings = await readHostSettings()
    expect(settings.port).toBe(DEFAULT_HOST_PORT)
    expect(settings.token.length).toBeGreaterThanOrEqual(32)
  })

  it('enabled / includeMutating 只认 true —— "true" 字符串不算', async () => {
    // 带上迁移标记，否则 enabled 会走「老配置按默认开」那条路，测不到类型判断
    writeFileSync(file(), '{"defaultOnApplied":true,"enabled":"true","includeMutating":1}', 'utf8')
    const settings = await readHostSettings()
    expect(settings.enabled).toBe(false)
    expect(settings.includeMutating).toBe(false)
  })

  it('重置令牌会换一把新的并存盘，其余设置保持不变', async () => {
    const base = await readHostSettings()
    await writeHostSettings({ ...base, enabled: true, port: 18888 })

    const rotated = await rotateHostToken()
    expect(rotated.token).not.toBe(base.token)
    expect(rotated).toMatchObject({ enabled: true, port: 18888 })
    expect((await readHostSettings()).token).toBe(rotated.token)
  })
})

describe('客户端配置片段', () => {
  it('地址和 status() 报的一致 —— 两处不一样用户会以为自己抄错了', async () => {
    const settings = { ...(await readHostSettings()), port: 17861 }
    expect(hostUrl(settings)).toBe('http://127.0.0.1:17861/')
  })

  /**
   * 形状必须能被 Claude Code / Cursor / Cline 直接吃下去：
   * 顶层 mcpServers、http 类型、Authorization 头。
   */
  it('生成的是能直接粘贴的 mcpServers 配置', async () => {
    const settings = { ...(await readHostSettings()), port: 17861, token: 'abc123' }
    const parsed = JSON.parse(clientConfigSnippet(settings))

    expect(parsed.mcpServers['unreal-box']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:17861/',
      headers: { Authorization: 'Bearer abc123' }
    })
  })

  it('端口改了片段跟着改', async () => {
    const settings = { ...(await readHostSettings()), port: 20000 }
    expect(clientConfigSnippet(settings)).toContain('http://127.0.0.1:20000/')
  })
})
