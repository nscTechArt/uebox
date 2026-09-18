import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * UnrealPathManager 真扫的是这台机器（Epic Launcher 的 dat 文件、注册表、
 * PowerShell 进程表），测试里必须换成桩：跑测试的机器上有没有引擎、
 * 装的是哪几个版本，都不该影响结论。
 *
 * 只留两个真读磁盘的方法（`getUNTLinkInstallPaths` 拼路径、
 * `checkPluginVersionAtPath` 读 .uplugin），插件状态那三态就是靠它们分出来的。
 */
const findUnrealEnginePaths = vi.fn()
const getRunningProjects = vi.fn()
const resolveEngineVersionFromGUID = vi.fn()

vi.mock('../../../utils/UnrealPathManager', () => ({
  default: {
    findUnrealEnginePaths: () => findUnrealEnginePaths(),
    // scanEngines 是 findUnrealEnginePaths 的「说实话」版本；用例照旧只摆布
    // 后者，这里把结果包一层，degraded 默认 false
    scanEngines: async (): Promise<{ engines: unknown[]; degraded: boolean }> => ({
      engines: await findUnrealEnginePaths(),
      degraded: false
    }),
    loadUALinkConfig: (): { bundledVersion: string } => ({ bundledVersion: '1.2.0' }),
    getUNTLinkInstallPaths: (root: string): string[] => [
      join(root, 'Marketplace', 'UnrealAgentLink'),
      join(root, 'Engine', 'Plugins', 'UnrealAgentLink')
    ],
    checkPluginVersionAtPath: async (dir: string, required: string): Promise<boolean> => {
      const { readFile } = await import('fs/promises')
      const info = JSON.parse(await readFile(join(dir, 'UnrealAgentLink.uplugin'), 'utf8')) as {
        VersionName?: string
      }
      return (info.VersionName ?? '0') >= required
    },
    isSourceBuildGUID: (value: string): boolean => /^\{[A-Fa-f0-9-]+\}$/.test(value),
    resolveEngineVersionFromGUID: (guid: string) => resolveEngineVersionFromGUID(guid)
  }
}))

vi.mock('../../../utils/UnrealProcessDetector', () => ({
  default: { getRunningProjects: () => getRunningProjects() }
}))

import { formatInventory, readEngineInventory } from './engines'

let root = ''

/** 造一个引擎目录，可选地在里面放一份指定版本的插件 */
async function makeEngine(version: string, pluginVersion?: string): Promise<string> {
  const enginePath = join(root, `UE_${version}`)
  await mkdir(enginePath, { recursive: true })

  if (pluginVersion) {
    const pluginDir = join(enginePath, 'Engine', 'Plugins', 'UnrealAgentLink')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'UnrealAgentLink.uplugin'),
      JSON.stringify({ VersionName: pluginVersion }),
      'utf8'
    )
  }

  return enginePath
}

function engineRecord(version: string, rootPath: string): Record<string, string> {
  return {
    name: `UE_${version}`,
    version,
    appVersion: version,
    rootPath,
    pluginPath: join(rootPath, 'Engine', 'Plugins'),
    enginePath: join(rootPath, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe')
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ua-engines-'))
  findUnrealEnginePaths.mockResolvedValue([])
  getRunningProjects.mockResolvedValue([])
  resolveEngineVersionFromGUID.mockResolvedValue(null)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('readEngineInventory', () => {
  /**
   * 这就是这个工具存在的理由：界面上列着九个引擎，而模型自己去 reg query
   * 只翻得到其中两个。清单必须来自盒子扫出来的那一份。
   */
  it('引擎清单来自盒子的扫描结果，不是模型自己去翻注册表', async () => {
    findUnrealEnginePaths.mockResolvedValue([
      engineRecord('5.7', await makeEngine('5.7')),
      engineRecord('5.5', await makeEngine('5.5')),
      engineRecord('4.27', await makeEngine('4.27'))
    ])

    const inventory = await readEngineInventory()

    expect(inventory.engines.map((e) => e.version)).toEqual(['5.7', '5.5', '4.27'])
  })

  it('插件装了且版本够，报 ok', async () => {
    findUnrealEnginePaths.mockResolvedValue([engineRecord('5.5', await makeEngine('5.5', '1.2.0'))])

    const [engine] = (await readEngineInventory()).engines

    expect(engine.agentLink).toBe('ok')
    expect(engine.agentLinkPath).toContain('UnrealAgentLink')
  })

  // 引擎里留着一份旧插件，和工程里那份新的可能打架 —— 排查时要能看见版本差
  it('插件版本比盒子自带的旧，报 outdated', async () => {
    findUnrealEnginePaths.mockResolvedValue([engineRecord('5.5', await makeEngine('5.5', '1.0.0'))])

    expect((await readEngineInventory()).engines[0].agentLink).toBe('outdated')
  })

  it('插件没装，报 missing', async () => {
    findUnrealEnginePaths.mockResolvedValue([engineRecord('5.5', await makeEngine('5.5'))])

    const [engine] = (await readEngineInventory()).engines
    expect(engine.agentLink).toBe('missing')
    expect(engine.agentLinkPath).toBeUndefined()
  })
})

describe('正在运行的编辑器', () => {
  it('版本号形式的 EngineAssociation 直接对上装好的引擎', async () => {
    const enginePath = await makeEngine('5.5')
    findUnrealEnginePaths.mockResolvedValue([engineRecord('5.5', enginePath)])
    getRunningProjects.mockResolvedValue([
      {
        pid: 22188,
        processName: 'UnrealEditor.exe',
        projectPath: 'I:/Dev/UALinkDev55/UALinkDev55.uproject',
        projectName: 'UALinkDev55',
        projectDir: 'I:/Dev/UALinkDev55',
        engineVersion: '5.5'
      }
    ])

    const [proc] = (await readEngineInventory()).running

    expect(proc.engineVersion).toBe('5.5')
    expect(proc.engineRootPath).toBe(enginePath)
  })

  /**
   * 自编译引擎在 .uproject 里写的是一串 GUID，光看工程文件什么都看不出来。
   * 盒子本来就有那段注册表解析，这里必须走它 —— 否则模型只会转述一串 GUID。
   */
  it('自编译引擎的 GUID 查注册表还原成版本号', async () => {
    resolveEngineVersionFromGUID.mockResolvedValue({
      version: '5.4',
      engineRootPath: 'D:/UnrealEngine'
    })
    getRunningProjects.mockResolvedValue([
      {
        pid: 4242,
        processName: 'UnrealEditor.exe',
        projectPath: 'D:/Src/MyGame/MyGame.uproject',
        projectName: 'MyGame',
        projectDir: 'D:/Src/MyGame',
        engineVersion: '{5A1B2C3D-0000-0000-0000-000000000000}'
      }
    ])

    const [proc] = (await readEngineInventory()).running

    expect(resolveEngineVersionFromGUID).toHaveBeenCalledWith(
      '{5A1B2C3D-0000-0000-0000-000000000000}'
    )
    expect(proc.engineVersion).toBe('5.4')
    expect(proc.engineRootPath).toBe('D:/UnrealEngine')
  })

  // 解析不出来时不能瞎猜一个引擎顶上，否则模型会拿错的路径去装插件
  it('GUID 查不到就留空，不拿别的引擎顶上', async () => {
    findUnrealEnginePaths.mockResolvedValue([engineRecord('5.5', await makeEngine('5.5'))])
    getRunningProjects.mockResolvedValue([
      {
        pid: 7,
        processName: 'UnrealEditor.exe',
        projectPath: 'D:/Src/MyGame/MyGame.uproject',
        projectName: 'MyGame',
        projectDir: 'D:/Src/MyGame',
        engineVersion: '{DEADBEEF-0000-0000-0000-000000000000}'
      }
    ])

    const [proc] = (await readEngineInventory()).running

    expect(proc.engineVersion).toBeUndefined()
    expect(proc.engineRootPath).toBeUndefined()
    expect(proc.engineAssociation).toBe('{DEADBEEF-0000-0000-0000-000000000000}')
  })
})

describe('formatInventory', () => {
  const oneEngine = (
    agentLink: 'ok' | 'outdated' | 'missing'
  ): Parameters<typeof formatInventory>[0] => ({
    bundledPluginVersion: '1.2.0',
    scanDegraded: false,
    engines: [
      {
        version: '5.5',
        name: 'UE_5.5',
        rootPath: 'I:/UE_5.5',
        editorExecutable: 'I:/UE_5.5/Engine/Binaries/Win64/UnrealEditor.exe',
        agentLink
      }
    ],
    running: []
  })

  it('每个引擎一行，带路径和插件状态', () => {
    const text = formatInventory(oneEngine('missing'))

    expect(text).toContain('装好的虚幻引擎（1 个）')
    expect(text).toContain('UE 5.5 — I:/UE_5.5')
    expect(text).toContain('引擎里没有 UnrealAgentLink')
  })

  /**
   * 插件那一列说的是**引擎目录**里有没有，而盒子现在走项目级安装：打开工程时把
   * 插件装进「工程/Plugins」，并把引擎里那份删掉（设置页还有个「清理引擎残留」
   * 按钮做同样的事）。所以一排 missing 是设计好的样子，不是故障。
   *
   * 第一版把 missing 写成「这个引擎开的工程连不上盒子」—— 真机上九个引擎八个
   * missing，模型据此把「打开工程」当成了要先解决插件的引擎决策。
   */
  it('不把「引擎里没插件」说成连不上 —— 那是项目级安装后的常态', () => {
    const text = formatInventory(oneEngine('missing'))

    expect(text).not.toContain('连不上盒子')
    expect(text).toContain('工程/Plugins')
    expect(text).toContain('不代表工程连不上')
  })

  /**
   * 一个引擎都没扫到时，模型接下来最容易做的事是 find_local_files 扫盘找
   * UnrealEditor.exe —— 几分钟起步，中途用户按停止也停不下来。
   * 所以这句劝阻必须在文本里，不能只写在工具描述里。
   */
  it('一个引擎都没有时，明说别去扫盘', () => {
    const text = formatInventory({
      bundledPluginVersion: '1.2.0',
      scanDegraded: false,
      engines: [],
      running: []
    })

    expect(text).toContain('没扫到任何虚幻引擎')
    expect(text).toContain('不要扫盘')
  })

  it('引擎版本解析不出来时说「查不到」，而不是留白让模型自己填', () => {
    const text = formatInventory({
      bundledPluginVersion: '1.2.0',
      scanDegraded: false,
      engines: [],
      running: [
        {
          pid: 7,
          projectName: 'MyGame',
          projectPath: 'D:/Src/MyGame/MyGame.uproject',
          engineAssociation: '{DEADBEEF-0000-0000-0000-000000000000}'
        }
      ]
    })

    expect(text).toContain('引擎未知')
    expect(text).toContain('{DEADBEEF-0000-0000-0000-000000000000}')
  })
})
