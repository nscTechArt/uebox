import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  discoverEpicMcpServers,
  epicServerId,
  EPIC_MCP_DEFAULT_PORT,
  EPIC_MCP_PLUGIN_NAME,
  EPIC_MCP_READ_ONLY_TOOLS,
  isEpicServerId,
  isLoopbackUrl,
  parseEpicMcpIni,
  readEpicMcpSettings,
  supportsOfficialMcp,
  type DiscoverableProject
} from './epicToolsets'

describe('supportsOfficialMcp', () => {
  it('5.8 起才有', () => {
    expect(supportsOfficialMcp('5.8.0')).toBe(true)
    expect(supportsOfficialMcp('5.8')).toBe(true)
    expect(supportsOfficialMcp('5.9.1')).toBe(true)
    expect(supportsOfficialMcp('6.0.0')).toBe(true)
  })

  it('5.7 及更早没有', () => {
    expect(supportsOfficialMcp('5.7.2')).toBe(false)
    expect(supportsOfficialMcp('5.5')).toBe(false)
    expect(supportsOfficialMcp('4.27')).toBe(false)
  })

  it('认不出的版本号当作没有', () => {
    // 插件在拿不到版本时会填 'Unknown'，那时候宁可不连
    expect(supportsOfficialMcp('Unknown')).toBe(false)
    expect(supportsOfficialMcp('')).toBe(false)
  })

  it('两位数次版本按数值比而不是按字典序', () => {
    // '5.10' 字典序小于 '5.8'，按字符串比会误判成不支持
    expect(supportsOfficialMcp('5.10.0')).toBe(true)
  })
})

describe('parseEpicMcpIni', () => {
  it('没有目标段时给默认值', () => {
    expect(parseEpicMcpIni('[/Script/Engine.Engine]\nFoo=1\n')).toEqual({
      port: EPIC_MCP_DEFAULT_PORT,
      urlPath: '/mcp'
    })
  })

  it('读出段内的端口与路径', () => {
    const ini = [
      '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]',
      'ServerPortNumber=9123',
      'ServerUrlPath=/unreal',
      'bAutoStartServer=True'
    ].join('\n')

    expect(parseEpicMcpIni(ini)).toEqual({ port: 9123, urlPath: '/unreal' })
  })

  it('只认目标段内的同名键', () => {
    // 别的段里出现 ServerPortNumber 是常事，读串了会连到毫不相干的端口
    const ini = [
      '[/Script/SomethingElse.OtherSettings]',
      'ServerPortNumber=7777',
      '',
      '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]',
      'ServerPortNumber=8123'
    ].join('\n')

    expect(parseEpicMcpIni(ini).port).toBe(8123)
  })

  it('目标段结束后不再吸收后面的键', () => {
    const ini = [
      '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]',
      'ServerPortNumber=8123',
      '',
      '[/Script/SomethingElse.OtherSettings]',
      'ServerPortNumber=7777'
    ].join('\n')

    expect(parseEpicMcpIni(ini).port).toBe(8123)
  })

  it('端口非法时留默认值', () => {
    for (const bad of ['0', '-1', '70000', 'abc', '']) {
      const ini = [
        '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]',
        `ServerPortNumber=${bad}`
      ].join('\n')
      expect(parseEpicMcpIni(ini).port).toBe(EPIC_MCP_DEFAULT_PORT)
    }
  })

  it('路径缺前导斜杠时补上', () => {
    const ini = [
      '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]',
      'ServerUrlPath=mcp'
    ].join('\n')
    expect(parseEpicMcpIni(ini).urlPath).toBe('/mcp')
  })

  it('CRLF 行尾也能读', () => {
    const ini =
      '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]\r\nServerPortNumber=8500\r\n'
    expect(parseEpicMcpIni(ini).port).toBe(8500)
  })
})

describe('isLoopbackUrl', () => {
  it('只认回环', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8000/mcp')).toBe(true)
    expect(isLoopbackUrl('http://localhost:8000/mcp')).toBe(true)
  })

  it('外网地址一律拒绝', () => {
    // Epic 的 server 没有鉴权，接一个非本机地址等于帮着把引擎控制面代理出去
    expect(isLoopbackUrl('http://10.0.0.5:8000/mcp')).toBe(false)
    expect(isLoopbackUrl('http://evil.example.com/mcp')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })
})

describe('epicServerId / isEpicServerId', () => {
  it('单项目用裸前缀', () => {
    expect(epicServerId('MyGame', true)).toBe('ue-official')
  })

  it('多项目时带项目名，且是合法 serverId', () => {
    const id = epicServerId('我的 项目/Alpha', false)
    expect(id.startsWith('ue-official-')).toBe(true)
    expect(id).toMatch(/^[a-zA-Z0-9_-]{1,32}$/)
  })

  it('项目名全是非法字符时退回裸前缀不会产生尾随连字符', () => {
    expect(epicServerId('', false)).toBe('ue-official')
  })

  it('认得出自动发现的 id，也不会误伤别人', () => {
    expect(isEpicServerId('ue-official')).toBe(true)
    expect(isEpicServerId('ue-official-MyGame')).toBe(true)
    expect(isEpicServerId('filesystem')).toBe(false)
    expect(isEpicServerId('ue-officially-mine')).toBe(false)
  })
})

describe('readEpicMcpSettings', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'epic-mcp-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('没有 ini 时返回默认值', async () => {
    // UE 只在用户改过设置后才落盘，没这个文件恰恰说明用的就是默认配置
    await expect(readEpicMcpSettings(dir)).resolves.toEqual({ port: 8000, urlPath: '/mcp' })
  })

  it('读 WindowsEditor 下的 ini', async () => {
    const configDir = join(dir, 'Saved', 'Config', 'WindowsEditor')
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(
      join(configDir, 'EditorPerProjectUserSettings.ini'),
      '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]\nServerPortNumber=8321\n',
      'utf8'
    )

    await expect(readEpicMcpSettings(dir)).resolves.toEqual({ port: 8321, urlPath: '/mcp' })
  })
})

describe('discoverEpicMcpServers', () => {
  const base: DiscoverableProject = {
    projectName: 'MyGame',
    projectPath: 'C:/nonexistent/MyGame',
    engineVersion: '5.8.0',
    enabledPlugins: [EPIC_MCP_PLUGIN_NAME],
    isConnected: true
  }

  it('符合条件的项目产出一条回环 http 配置', async () => {
    const servers = await discoverEpicMcpServers([base])

    expect(Object.keys(servers)).toEqual(['ue-official'])
    expect(servers['ue-official']).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:8000/mcp',
      readOnlyTools: EPIC_MCP_READ_ONLY_TOOLS
    })
  })

  it('只降级发现类工具，call_tool 不在名单里', async () => {
    // call_tool 是真正干活的那个，它必须继续走审批门
    const servers = await discoverEpicMcpServers([base])
    const readOnly = (servers['ue-official'] as { readOnlyTools: string[] }).readOnlyTools
    expect(readOnly).toContain('list_toolsets')
    expect(readOnly).toContain('describe_toolset')
    expect(readOnly).not.toContain('call_tool')
  })

  it('引擎低于 5.8 的跳过', async () => {
    await expect(discoverEpicMcpServers([{ ...base, engineVersion: '5.7.2' }])).resolves.toEqual({})
  })

  it('没在 .uproject 里启用插件的跳过', async () => {
    // 不加这道门，所有 5.8 用户都会多出一条连不上的 server，
    // 它会进设置页也会进系统提示词，对没开插件的人纯属噪音
    await expect(discoverEpicMcpServers([{ ...base, enabledPlugins: [] }])).resolves.toEqual({})
  })

  it('已断开的项目跳过', async () => {
    await expect(discoverEpicMcpServers([{ ...base, isConnected: false }])).resolves.toEqual({})
  })

  it('没有项目路径的跳过', async () => {
    await expect(discoverEpicMcpServers([{ ...base, projectPath: '' }])).resolves.toEqual({})
  })

  it('多个项目指向同一个 URL 时只留一条', async () => {
    // Epic 的 server 在编辑器进程内，两个编辑器抢同一个端口只有一个能起来
    const servers = await discoverEpicMcpServers([
      base,
      { ...base, projectName: 'OtherGame', projectPath: 'C:/nonexistent/OtherGame' }
    ])

    expect(Object.keys(servers)).toHaveLength(1)
  })

  it('空列表返回空对象', async () => {
    await expect(discoverEpicMcpServers([])).resolves.toEqual({})
  })
})
