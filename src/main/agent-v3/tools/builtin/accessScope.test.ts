import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 四个来源全部换成桩。真实现要读 Epic 的 manifest、查 sqlite、问 electron 的
 * userData —— 跑测试的机器上装没装引擎、导没导工程，都不该影响结论。
 */
const getAgentFileAccessScope = vi.fn<() => 'ue-only' | 'full'>()
const findUnrealEnginePaths = vi.fn()
const getAllProjects = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string =>
      name === 'userData' ? 'C:/Users/me/AppData/Roaming/unreal-box' : `C:/${name}`
  }
}))

vi.mock('../../../appSettingsManager', () => ({
  appSettingsManager: { getAgentFileAccessScope: () => getAgentFileAccessScope() }
}))

vi.mock('../../../sqliteDataBase', () => ({
  getPublicDatabase: () => ({}) as never
}))

vi.mock('../../../sqliteDataBase/models/project', () => ({
  getAllProjects: () => getAllProjects()
}))

vi.mock('../../../utils/UnrealPathManager', () => ({
  default: {
    findUnrealEnginePaths: () => findUnrealEnginePaths(),
    // scanEngines 是 findUnrealEnginePaths 的「说实话」版本；用例照旧只摆布
    // 后者，这里把结果包一层，degraded 默认 false
    scanEngines: async (): Promise<{ engines: unknown[]; degraded: boolean }> => ({
      engines: await findUnrealEnginePaths(),
      degraded: false
    })
  }
}))

import { assertInAccessScope, __testing } from './accessScope'

beforeEach(() => {
  vi.clearAllMocks()
  __testing.resetCache()
  getAgentFileAccessScope.mockReturnValue('ue-only')
  findUnrealEnginePaths.mockResolvedValue([{ rootPath: 'C:/Program Files/Epic Games/UE_5.5' }])
  getAllProjects.mockReturnValue([{ projectPath: 'I:/UnrealAgent/MyGame' }])
})

/**
 * 放开档必须是「什么都不做」。这个判定挂在每一次读文件、列目录上 ——
 * 在这一档上多扫一次引擎目录，代价是用户每次让它翻文件夹都卡几百毫秒。
 */
describe('整台电脑', () => {
  it('一律放行', async () => {
    getAgentFileAccessScope.mockReturnValue('full')
    expect(await assertInAccessScope('D:/素材/建筑/wall.fbx')).toBeUndefined()
  })

  it('不去扫引擎、也不查工程库', async () => {
    getAgentFileAccessScope.mockReturnValue('full')
    await assertInAccessScope('D:/随便什么/x.txt')
    expect(findUnrealEnginePaths).not.toHaveBeenCalled()
    expect(getAllProjects).not.toHaveBeenCalled()
  })
})

describe('仅虚幻相关（默认档）', () => {
  // 设置读不出来（配置损坏、旧版本没这个字段）时宁可窄不宜宽：
  // 窄了用户当场看到一句写明原因的拒绝，宽了他什么都看不到
  it('读设置抛错时按收窄档走', async () => {
    getAgentFileAccessScope.mockImplementation(() => {
      throw new Error('配置文件坏了')
    })
    expect(await assertInAccessScope('D:/素材/wall.fbx')).toBeDefined()
  })

  it.each([
    'I:/UnrealAgent/MyGame',
    'I:/UnrealAgent/MyGame/Content/Meshes/wall.uasset',
    'I:\\UnrealAgent\\MyGame\\Config\\DefaultEngine.ini',
    'C:/Program Files/Epic Games/UE_5.5/Engine/Plugins',
    'C:/Users/me/AppData/Roaming/unreal-box/database/vaults/system_vault_aigc/AIGC/x.png',
    'C:/Users/me/AppData/Roaming/unreal-box/skills/my-skill/SKILL.md'
  ])('放行 %s', async (p) => expect(await assertInAccessScope(p)).toBeUndefined())

  it.each([
    'D:/素材/建筑/wall.fbx',
    'C:/Users/me/Desktop/ref.png',
    'I:/UnrealAgent/AnotherGame/Content/x.uasset'
  ])('挡下 %s', async (p) => expect(await assertInAccessScope(p)).toBeDefined())

  /**
   * 前缀比对最容易出的两个事故：结尾不带 `/` 时 `MyGame` 会匹配上
   * `MyGameBackup`；不折叠 `..` 时从工程里能一路跳回盘根。
   */
  it('同前缀的邻居目录不算在范围内', async () => {
    expect(await assertInAccessScope('I:/UnrealAgent/MyGameBackup/secrets.txt')).toBeDefined()
  })

  it('用 `..` 跳出工程之后照样挡住', async () => {
    expect(await assertInAccessScope('I:/UnrealAgent/MyGame/../../secrets.txt')).toBeDefined()
  })
})

/**
 * 缓存。算一次白名单要真扫盘（Epic 的 manifest + 每个引擎几次 fs.access），
 * 而这个判定挂在每一次读文件、列目录上。
 */
describe('白名单缓存', () => {
  it('命中的路径在缓存期内只算一遍', async () => {
    await assertInAccessScope('I:/UnrealAgent/MyGame/A')
    await assertInAccessScope('I:/UnrealAgent/MyGame/B')
    await assertInAccessScope('I:/UnrealAgent/MyGame/C')

    expect(findUnrealEnginePaths).toHaveBeenCalledTimes(1)
    expect(getAllProjects).toHaveBeenCalledTimes(1)
  })

  /**
   * 缓存唯一会造成的错误是**误拒** —— 用户刚导入一个工程，缓存里还没有它，
   * 而「导完让 agent 去看一眼」正是最自然的下一步。所以真要拒绝之前
   * 必须把工程清单重查一遍。
   */
  it('拒绝之前重查工程，刚导入的工程当场就能用', async () => {
    await assertInAccessScope('I:/UnrealAgent/MyGame')
    expect(getAllProjects).toHaveBeenCalledTimes(1)

    // 用户在这期间导入了 NewGame
    getAllProjects.mockReturnValue([
      { projectPath: 'I:/UnrealAgent/MyGame' },
      { projectPath: 'I:/UnrealAgent/NewGame' }
    ])

    expect(await assertInAccessScope('I:/UnrealAgent/NewGame/Content')).toBeUndefined()
    expect(getAllProjects).toHaveBeenCalledTimes(2)
  })

  /**
   * 重查只针对便宜的那一份。引擎扫描是真扫盘，不能让模型对着一个范围外的
   * 目录连试几次就变成连着几次全盘扫描 —— 而「会话中途装了个新引擎」
   * 本来就不是常见事，不值得为它买单。
   */
  it('连续被拒时不重扫引擎，只重查工程', async () => {
    await assertInAccessScope('D:/素材/a')
    await assertInAccessScope('D:/素材/b')
    await assertInAccessScope('D:/素材/c')

    expect(findUnrealEnginePaths).toHaveBeenCalledTimes(1)
    // 三次拒绝 = 三次重查（第一次那趟走的是缓存未命中，不额外算）
    expect(getAllProjects).toHaveBeenCalledTimes(4)
  })
})

/**
 * 拒绝的话是给模型看的。说不清「现在允许哪里、怎么才能访问」的话，
 * 模型只会换一种路径写法反复重试，用户看到的是一串一样的失败。
 */
describe('拒绝时说的话', () => {
  it('列出当前允许的位置，并给出两条出路', async () => {
    const said = (await assertInAccessScope('D:/素材/wall.fbx'))!
    expect(said).toContain('D:/素材/wall.fbx')
    expect(said).toContain('I:/UnrealAgent/MyGame')
    expect(said).toContain('import_project')
    expect(said).toContain('文件访问范围')
    expect(said).toMatch(/不要换一种路径写法再试/)
  })

  /**
   * 默认收窄之后，这段话会是很多人遇到的第一次拒绝。它必须自带
   * 「怎么放开」，而且要交代清楚**这不是故障** —— 否则模型会把它当成
   * 一个技术错误，要么闷头重试，要么给用户糊一句看不懂的报错。
   */
  it('带上切换路径，并让模型自己判断要不要转达', async () => {
    const said = (await assertInAccessScope('D:/素材/wall.fbx'))!
    expect(said).toContain('设置 → AI 助手 → 隐私 → 文件访问范围')
    expect(said).toContain('整台电脑')
    expect(said).toContain('不是故障')
    expect(said).toMatch(/你自己判断/)
  })

  it('位置太多时只列前几个，并说明总数', async () => {
    getAllProjects.mockReturnValue(
      Array.from({ length: 12 }, (_, i) => ({ projectPath: `I:/Games/P${i}` }))
    )
    const said = (await assertInAccessScope('D:/x'))!
    expect(said).toContain('等 15 个位置')
    expect(said).not.toContain('I:/Games/P11')
  })
})

/**
 * 一个来源坏了不该让整份白名单塌成空的 —— 空白名单等于什么都不让碰，
 * 而用户只会看到「这个目录不在范围里」，看不出是数据库没起来。
 */
describe('某个来源取不到时', () => {
  it('数据库没起来，引擎目录照样放行', async () => {
    getAllProjects.mockImplementation(() => {
      throw new Error('公共数据库未初始化')
    })
    expect(
      await assertInAccessScope('C:/Program Files/Epic Games/UE_5.5/Engine/Build')
    ).toBeUndefined()
  })

  it('引擎扫描失败，工程照样放行', async () => {
    findUnrealEnginePaths.mockRejectedValue(new Error('扫描失败'))
    expect(await assertInAccessScope('I:/UnrealAgent/MyGame/Content')).toBeUndefined()
  })
})
