/** @vitest-environment node */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'agent-v3-plugins-'))
vi.mock('electron', () => ({
  app: { getPath: (): string => root, getAppPath: (): string => root, isPackaged: false }
}))

import {
  enabledPluginMcpServers,
  enabledPluginSkillDirs,
  installFromDirectory,
  listPlugins,
  readPluginMcpServers,
  setPluginDisabled,
  uninstallPlugin
} from './registry'
import { parseManifest } from './types'

const PLUGINS = join(root, 'plugins')

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(PLUGINS, { recursive: true, force: true })
  rmSync(join(root, 'disabled-plugins.json'), { force: true })
})

/** 直接在 plugins 目录里造一个插件（跳过 install 流程） */
function makePlugin(
  id: string,
  manifest: Record<string, unknown> | string,
  extras: { skills?: boolean; mcp?: Record<string, unknown> } = {}
): string {
  const dir = join(PLUGINS, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    'utf8'
  )
  if (extras.skills) {
    const skillDir = join(dir, 'skills', 'demo-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 插件带来的技能\n---\n\n正文',
      'utf8'
    )
  }
  if (extras.mcp) {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: extras.mcp }), 'utf8')
  }
  return dir
}

const OK_MANIFEST = { id: 'demo', name: '示例插件', version: '1.0.0' }

describe('parseManifest', () => {
  it('接受合法清单', () => {
    const out = parseManifest({ ...OK_MANIFEST, permissions: ['ue:read'] })
    expect(out).toEqual({ manifest: { ...OK_MANIFEST, permissions: ['ue:read'] } })
  })

  it.each([
    ['缺 id', { name: 'x', version: '1' }],
    ['缺 name', { id: 'x', version: '1' }],
    ['缺 version', { id: 'x', name: 'x' }],
    ['不是对象', 'nope']
  ])('拒绝：%s', (_label, raw) => {
    expect(parseManifest(raw)).toHaveProperty('error')
  })

  // id 会成为目录名和 MCP serverId 前缀，两头都要求安全字符
  it.each(['../evil', 'has space', '中文', 'a'.repeat(49)])('拒绝非法 id：%s', (id) => {
    expect(parseManifest({ id, name: 'x', version: '1' })).toHaveProperty('error')
  })

  // 老版本盒子装新插件应当降级运行，而不是装不上
  it('忽略不认识的权限而不是整个拒绝', () => {
    const out = parseManifest({
      ...OK_MANIFEST,
      permissions: ['ue:read', 'future:capability']
    })
    expect(out).toEqual({ manifest: { ...OK_MANIFEST, permissions: ['ue:read'] } })
  })
})

describe('listPlugins', () => {
  it('目录不存在时返回空数组', async () => {
    expect(await listPlugins()).toEqual([])
  })

  it('列出合法插件及其内容', async () => {
    makePlugin('demo', OK_MANIFEST, { skills: true, mcp: { srv: { command: 'node' } } })

    const [plugin] = await listPlugins()
    expect(plugin.manifest.name).toBe('示例插件')
    expect(plugin.hasSkills).toBe(true)
    expect(plugin.mcpServerCount).toBe(1)
    expect(plugin.disabled).toBe(false)
    expect(plugin.error).toBeUndefined()
  })

  // 装了个写坏的插件，不该导致其他插件也用不了
  it('坏插件只标记自己，不影响其余', async () => {
    makePlugin('good', { id: 'good', name: 'G', version: '1' })
    makePlugin('broken', '{ 这不是 JSON')

    const plugins = await listPlugins()
    expect(plugins).toHaveLength(2)
    expect(plugins.find((p) => p.manifest.id === 'good')?.error).toBeUndefined()
    expect(plugins.find((p) => p.manifest.id === 'broken')?.error).toContain('plugin.json')
  })

  // 目录名与 id 不一致会让停用列表、MCP 前缀全都对不上
  it('目录名与清单 id 不一致时报错', async () => {
    makePlugin('dirname', { id: 'different', name: 'X', version: '1' })

    const [plugin] = await listPlugins()
    expect(plugin.error).toContain('不一致')
  })

  it('跳过 id 非法的目录', async () => {
    mkdirSync(join(PLUGINS, 'bad name'), { recursive: true })
    writeFileSync(join(PLUGINS, 'bad name', 'plugin.json'), JSON.stringify(OK_MANIFEST), 'utf8')

    expect(await listPlugins()).toEqual([])
  })
})

describe('启停', () => {
  it('停用后不再贡献 skill 和 MCP server', async () => {
    makePlugin('demo', OK_MANIFEST, { skills: true, mcp: { srv: { command: 'node' } } })

    expect(await enabledPluginSkillDirs()).toHaveLength(1)
    expect(Object.keys(await enabledPluginMcpServers())).toHaveLength(1)

    await setPluginDisabled('demo', true)

    expect(await enabledPluginSkillDirs()).toEqual([])
    expect(await enabledPluginMcpServers()).toEqual({})
    expect((await listPlugins())[0].disabled).toBe(true)
  })

  it('重新启用后恢复', async () => {
    makePlugin('demo', OK_MANIFEST, { skills: true })
    await setPluginDisabled('demo', true)
    await setPluginDisabled('demo', false)

    expect(await enabledPluginSkillDirs()).toHaveLength(1)
  })

  it('坏插件不贡献任何东西', async () => {
    makePlugin('broken', '{ 坏的', { skills: true })
    expect(await enabledPluginSkillDirs()).toEqual([])
  })
})

describe('MCP server 合并', () => {
  // 两个插件都叫 server 时不能互相覆盖，用户也要能看出是谁带来的
  it('serverId 带插件 id 前缀', async () => {
    const dir = makePlugin(
      'myplugin',
      { id: 'myplugin', name: 'X', version: '1' },
      {
        mcp: { server: { command: 'node', args: ['x.js'] } }
      }
    )

    const servers = await readPluginMcpServers(dir, 'myplugin')
    expect(Object.keys(servers)).toEqual(['myplugin_server'])
  })

  it('两个插件的同名 server 不互相覆盖', async () => {
    makePlugin('a', { id: 'a', name: 'A', version: '1' }, { mcp: { server: { command: 'x' } } })
    makePlugin('b', { id: 'b', name: 'B', version: '1' }, { mcp: { server: { command: 'y' } } })

    expect(Object.keys(await enabledPluginMcpServers()).sort()).toEqual(['a_server', 'b_server'])
  })

  // 插件自带的脚本通常用相对路径
  it('stdio 的 cwd 默认指向插件目录', async () => {
    const dir = makePlugin(
      'p',
      { id: 'p', name: 'P', version: '1' },
      {
        mcp: { s: { command: 'node', args: ['./server.js'] } }
      }
    )

    const servers = await readPluginMcpServers(dir, 'p')
    expect(servers.p_s).toMatchObject({ cwd: dir })
  })

  it('已指定 cwd 时不覆盖', async () => {
    const dir = makePlugin(
      'p',
      { id: 'p', name: 'P', version: '1' },
      {
        mcp: { s: { command: 'node', cwd: 'D:/elsewhere' } }
      }
    )

    expect((await readPluginMcpServers(dir, 'p')).p_s).toMatchObject({ cwd: 'D:/elsewhere' })
  })
})

describe('安装 / 卸载', () => {
  it('从目录安装并能读回', async () => {
    const source = join(root, 'source-plugin')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'plugin.json'), JSON.stringify(OK_MANIFEST), 'utf8')

    const result = await installFromDirectory(source)
    expect(result.success).toBe(true)
    expect((await listPlugins())[0].manifest.id).toBe('demo')
  })

  it('源目录没有 plugin.json 时拒绝', async () => {
    const source = join(root, 'not-a-plugin')
    mkdirSync(source, { recursive: true })

    const result = await installFromDirectory(source)
    expect(result).toMatchObject({ success: false })
  })

  // 安装脚本是供应链攻击最常见的入口，插件不允许有
  it('安装只拷贝文件，不执行插件里的任何代码', async () => {
    const source = join(root, 'evil-plugin')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'plugin.json'), JSON.stringify(OK_MANIFEST), 'utf8')
    // 就算插件带了这些常见的安装钩子文件，也不该被执行
    writeFileSync(join(source, 'install.js'), 'process.exit(1)', 'utf8')
    writeFileSync(join(source, 'postinstall.sh'), 'exit 1', 'utf8')

    const result = await installFromDirectory(source)
    expect(result.success).toBe(true)
  })

  it('卸载后目录消失', async () => {
    makePlugin('demo', OK_MANIFEST)
    expect(await listPlugins()).toHaveLength(1)

    expect(await uninstallPlugin('demo')).toEqual({ success: true })
    expect(await listPlugins()).toEqual([])
  })

  // 真机上踩到过：插件自带的 MCP server 是子进程，cwd 指向插件目录，
  // Windows 上进程活着就锁住目录，直接删会拿到 EBUSY。
  // 修法在 IPC 层（先 shutdownMcp 再删），这里锁住「目录被占用时不静默成功」。
  it('目录被占用时如实返回失败而不是假装删掉了', async () => {
    makePlugin('busy', { id: 'busy', name: 'B', version: '1' })

    const originalRm = fsPromises.rm
    const spy = vi
      .spyOn(fsPromises, 'rm')
      .mockRejectedValueOnce(
        Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      )

    const result = await uninstallPlugin('busy')
    expect(result.success).toBe(false)
    expect(result.error).toContain('EBUSY')

    spy.mockRestore()
    expect(fsPromises.rm).toBe(originalRm)
  })

  it('卸载时拒绝非法 id —— 防路径穿越', async () => {
    expect(await uninstallPlugin('../../etc')).toMatchObject({ success: false })
  })
})
