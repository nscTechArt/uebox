/** @vitest-environment node */
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyEpicMcpSetup,
  autoStartEnabledIn,
  editorUserIniPath,
  inspectEpicMcpSetup,
  missingPluginsIn,
  REQUIRED_UPROJECT_PLUGINS,
  withAutoStartEnabled
} from './epicSetup'
import type { DiscoverableProject } from './epicToolsets'

const SECTION = '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]'

describe('missingPluginsIn', () => {
  it('空项目缺全部', () => {
    expect(missingPluginsIn({})).toEqual([...REQUIRED_UPROJECT_PLUGINS])
    expect(missingPluginsIn({ Plugins: [] })).toEqual([...REQUIRED_UPROJECT_PLUGINS])
  })

  it('两条都启用了就不缺', () => {
    const data = {
      Plugins: REQUIRED_UPROJECT_PLUGINS.map((Name) => ({ Name, Enabled: true }))
    }
    expect(missingPluginsIn(data)).toEqual([])
  })

  it('写了但 Enabled 是 false 的算缺', () => {
    // 用户手动关过，我们要能识别出来并重新启用
    const data = {
      Plugins: [
        { Name: 'ModelContextProtocol', Enabled: false },
        { Name: 'AllToolsets', Enabled: true }
      ]
    }
    expect(missingPluginsIn(data)).toEqual(['ModelContextProtocol'])
  })

  it('缺 Enabled 字段的也算缺 —— 不能假设省略等于 true', () => {
    expect(missingPluginsIn({ Plugins: [{ Name: 'AllToolsets' }] })).toContain('AllToolsets')
  })

  it('只写两条，传递依赖交给 UE 解析', () => {
    // ModelContextProtocol → ToolsetRegistry → PythonScriptPlugin 等，
    // 全写进去用户之后想关时要在一堆条目里找
    expect(REQUIRED_UPROJECT_PLUGINS).toEqual(['ModelContextProtocol', 'AllToolsets'])
  })
})

describe('autoStartEnabledIn', () => {
  it('空文本是关的', () => {
    expect(autoStartEnabledIn('')).toBe(false)
  })

  it('段内为 True 才算开', () => {
    expect(autoStartEnabledIn(`${SECTION}\nbAutoStartServer=True\n`)).toBe(true)
    expect(autoStartEnabledIn(`${SECTION}\nbAutoStartServer=False\n`)).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(autoStartEnabledIn(`${SECTION}\nbAutoStartServer=true\n`)).toBe(true)
  })

  it('别的段里的同名键不算', () => {
    const ini = `[/Script/Other.Settings]\nbAutoStartServer=True\n\n${SECTION}\n`
    expect(autoStartEnabledIn(ini)).toBe(false)
  })
})

describe('withAutoStartEnabled', () => {
  it('段不存在时补一整段', () => {
    const out = withAutoStartEnabled('[/Script/Other.Settings]\nFoo=1\n')
    expect(autoStartEnabledIn(out)).toBe(true)
    // 原有内容不能丢
    expect(out).toContain('Foo=1')
  })

  it('空文件也能写', () => {
    expect(autoStartEnabledIn(withAutoStartEnabled(''))).toBe(true)
  })

  it('段在键不在时在段内追加', () => {
    const out = withAutoStartEnabled(`${SECTION}\nServerPortNumber=8123\n`)
    expect(autoStartEnabledIn(out)).toBe(true)
    expect(out).toContain('ServerPortNumber=8123')
  })

  it('键已存在时改值而不是再追加一行', () => {
    // 重复键 UE 读的是最后一个，但这种文件极难排查，不该由我们制造
    const out = withAutoStartEnabled(`${SECTION}\nbAutoStartServer=False\n`)
    expect(autoStartEnabledIn(out)).toBe(true)
    expect(out.match(/bAutoStartServer/g)).toHaveLength(1)
  })

  it('不越界写到后面的段里去', () => {
    const ini = `${SECTION}\nServerPortNumber=8123\n\n[/Script/Other.Settings]\nFoo=1\n`
    const out = withAutoStartEnabled(ini)
    const mineAt = out.indexOf('bAutoStartServer')
    const nextSectionAt = out.indexOf('[/Script/Other.Settings]')
    expect(mineAt).toBeGreaterThan(-1)
    expect(mineAt).toBeLessThan(nextSectionAt)
  })

  it('已经开着时改完还是开着（幂等）', () => {
    const once = withAutoStartEnabled(`${SECTION}\nbAutoStartServer=True\n`)
    expect(autoStartEnabledIn(withAutoStartEnabled(once))).toBe(true)
  })
})

describe('applyEpicMcpSetup / inspectEpicMcpSetup', () => {
  let dir: string
  let uprojectPath: string

  const project = (over: Partial<DiscoverableProject> = {}): DiscoverableProject => ({
    projectName: 'MyGame',
    projectPath: dir,
    engineVersion: '5.8.0',
    enabledPlugins: [],
    isConnected: true,
    ...over
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'epic-setup-'))
    uprojectPath = join(dir, 'MyGame.uproject')
    await fs.writeFile(
      uprojectPath,
      JSON.stringify({ FileVersion: 3, EngineAssociation: '5.8', Plugins: [] }, null, '\t'),
      'utf8'
    )
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('写进两条插件并开自动启动', async () => {
    const result = await applyEpicMcpSetup(project(), uprojectPath)

    expect(result.success).toBe(true)
    expect(result.addedPlugins).toEqual([...REQUIRED_UPROJECT_PLUGINS])
    expect(result.wroteAutoStart).toBe(true)
    // 刚写完 .uproject，当前编辑器进程一定没加载这些模块
    expect(result.needsRestart).toBe(true)

    const data = JSON.parse(await fs.readFile(uprojectPath, 'utf8'))
    expect(missingPluginsIn(data)).toEqual([])
    expect(autoStartEnabledIn(await fs.readFile(editorUserIniPath(dir), 'utf8'))).toBe(true)
  })

  it('.uproject 用 Tab 缩进 —— 和 UE 自己写的一致，否则版本控制里是全量改动', async () => {
    await applyEpicMcpSetup(project(), uprojectPath)
    expect(await fs.readFile(uprojectPath, 'utf8')).toContain('\n\t"Plugins"')
  })

  it('不动 .uproject 里原有的其他字段和插件', async () => {
    await fs.writeFile(
      uprojectPath,
      JSON.stringify(
        {
          FileVersion: 3,
          EngineAssociation: '5.8',
          Description: '别动我',
          Plugins: [{ Name: 'UnrealAgentLink', Enabled: true }]
        },
        null,
        '\t'
      ),
      'utf8'
    )

    await applyEpicMcpSetup(project(), uprojectPath)

    const data = JSON.parse(await fs.readFile(uprojectPath, 'utf8'))
    expect(data.Description).toBe('别动我')
    expect(data.Plugins.some((p: { Name: string }) => p.Name === 'UnrealAgentLink')).toBe(true)
  })

  it('重复执行不会写出两条一样的插件', async () => {
    await applyEpicMcpSetup(project(), uprojectPath)
    const second = await applyEpicMcpSetup(project(), uprojectPath)

    expect(second.addedPlugins).toEqual([])
    const data = JSON.parse(await fs.readFile(uprojectPath, 'utf8'))
    const names = data.Plugins.map((p: { Name: string }) => p.Name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('引擎低于 5.8 直接拒绝，并说清楚要什么版本', async () => {
    const result = await applyEpicMcpSetup(project({ engineVersion: '5.7.2' }), uprojectPath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('5.8')
    // 拒绝就不能动文件
    const data = JSON.parse(await fs.readFile(uprojectPath, 'utf8'))
    expect(data.Plugins).toEqual([])
  })

  it('插件已加载时不再要求重启', async () => {
    const loaded = project({ enabledPlugins: [...REQUIRED_UPROJECT_PLUGINS] })
    await fs.writeFile(
      uprojectPath,
      JSON.stringify(
        { Plugins: REQUIRED_UPROJECT_PLUGINS.map((Name) => ({ Name, Enabled: true })) },
        null,
        '\t'
      ),
      'utf8'
    )

    const result = await applyEpicMcpSetup(loaded, uprojectPath)
    expect(result.needsRestart).toBe(false)
  })

  it('.uproject 读不出来时报错，不静默成功', async () => {
    await fs.writeFile(uprojectPath, '{ 这不是 JSON', 'utf8')
    const result = await applyEpicMcpSetup(project(), uprojectPath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('.uproject')
  })

  describe('inspect', () => {
    it('全新项目是 needs-plugins', async () => {
      const status = await inspectEpicMcpSetup(project(), uprojectPath, false)
      expect(status.state).toBe('needs-plugins')
      expect(status.missingPlugins).toEqual([...REQUIRED_UPROJECT_PLUGINS])
    })

    it('引擎低于 5.8 是 unsupported', async () => {
      const status = await inspectEpicMcpSetup(
        project({ engineVersion: '5.5' }),
        uprojectPath,
        false
      )
      expect(status.state).toBe('unsupported')
    })

    it('服务通了就是 ready，不管 .uproject 里写了什么', async () => {
      // 用户可能在引擎级别开的插件，.uproject 里看不到 —— 服务通着就是能用
      const status = await inspectEpicMcpSetup(project(), uprojectPath, true)
      expect(status.state).toBe('ready')
    })

    it('写好插件但编辑器没加载 → needs-restart', async () => {
      await applyEpicMcpSetup(project(), uprojectPath)
      const status = await inspectEpicMcpSetup(project(), uprojectPath, false)
      expect(status.state).toBe('needs-restart')
    })

    it('插件加载了但服务没起 → needs-start（不用重启）', async () => {
      await applyEpicMcpSetup(project(), uprojectPath)
      const loaded = project({ enabledPlugins: [...REQUIRED_UPROJECT_PLUGINS] })
      const status = await inspectEpicMcpSetup(loaded, uprojectPath, false)
      expect(status.state).toBe('needs-start')
    })

    it('带上服务地址供界面显示', async () => {
      const status = await inspectEpicMcpSetup(project(), uprojectPath, false)
      expect(status.url).toBe('http://127.0.0.1:8000/mcp')
    })
  })
})
