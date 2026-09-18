/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import { electronMock, servicesMock, targetContextMock } from '../../../testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('../../../../services', () => servicesMock())
vi.mock('../../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

vi.mock('./awaitProjectLive', async (importOriginal) => {
  const original = await importOriginal<typeof import('./awaitProjectLive')>()
  return { ...original, awaitProjectLive: vi.fn() }
})

const { getAllProjects, getAllProjectCollections, getCollectionKeysOfProject } = vi.hoisted(() => ({
  getAllProjects: vi.fn(),
  getAllProjectCollections: vi.fn(),
  getCollectionKeysOfProject: vi.fn()
}))
vi.mock('../../../../sqliteDataBase', () => ({
  getPublicDatabase: () => ({}),
  getDatabaseManager: () => ({})
}))
vi.mock('../../../../sqliteDataBase/models/project', () => ({ getAllProjects }))
vi.mock('../../../../sqliteDataBase/models/projectCollection', () => ({
  getAllProjectCollections,
  getCollectionKeysOfProject
}))

import {
  handOffToOpenedProject,
  isSameProject,
  listProjects,
  matchEngineTemplate,
  routeAssetImport
} from './projectTool'
import { awaitProjectLive } from './awaitProjectLive'
import type { EngineTemplate } from '../../../../services/project/engineTemplates'

describe('打开工程后的返回', () => {
  const loading = {
    live: false,
    retargeted: false,
    connectionSeen: false,
    probeFailed: false,
    waitedMs: 0
  }

  it('默认不等待，明确返回正在加载并要求先检查目标工程', async () => {
    vi.mocked(awaitProjectLive).mockResolvedValue(loading)
    const result = await handOffToOpenedProject('I:/Dev/New/New.uproject', {})
    expect(awaitProjectLive).toHaveBeenLastCalledWith({ projectPath: 'I:/Dev/New', timeoutMs: 0 })
    expect(result.connected).toBe(false)
    expect(result.details.join(' ')).toContain('正在加载')
    expect(result.details.join(' ')).toContain('ue_session_health')
    expect(result.details.join(' ')).not.toContain('等了 0 秒还没连上')
  })

  it('已连接但未校验时不能让模型直接继续操作', async () => {
    vi.mocked(awaitProjectLive).mockResolvedValue({
      ...loading,
      connectionSeen: true,
      retargeted: true
    })
    const result = await handOffToOpenedProject('I:/Dev/New/New.uproject', {})
    expect(result.connected).toBe(false)
    expect(result.details.join(' ')).toContain('connected=true 后再执行引擎命令')
    expect(result.details.join(' ')).not.toContain('直接接着干')
  })

  it('显式等待仍会校验并返回就绪和切换结果', async () => {
    vi.mocked(awaitProjectLive).mockResolvedValue({ ...loading, live: true, retargeted: true })
    const result = await handOffToOpenedProject('I:/Dev/New/New.uproject', { waitSeconds: 5 })
    expect(awaitProjectLive).toHaveBeenLastCalledWith({
      projectPath: 'I:/Dev/New',
      timeoutMs: 5000
    })
    expect(result.connected).toBe(true)
    expect(result.switched_target).toBe(true)
  })
})

/**
 * 模型手里的信息不一定齐：用户说「空白」，list_templates 给的是
 * `5.5/TP_BlankBP`，而模型可能只记住了 `TP_BlankBP`。三种说法都要能对上，
 * 否则它拿不准就会退回去自己拷模板 —— 那正是我们要堵的那条路。
 */
function template(
  overrides: Partial<EngineTemplate> & { version: string; name: string; display: string }
): EngineTemplate {
  return {
    key: `${overrides.version}/${overrides.name}`,
    templateName: overrides.name,
    displayName: overrides.display,
    engineVersion: overrides.version,
    engineRoot: `D:/UE_${overrides.version}`,
    dir: `D:/UE_${overrides.version}/Templates/${overrides.name}`,
    uprojectPath: `D:/UE_${overrides.version}/Templates/${overrides.name}/${overrides.name}.uproject`,
    needsCode: false,
    isBlank: false,
    sortKey: '',
    sharedContentPacks: [],
    defs: {
      isBlank: false,
      sortKey: '',
      foldersToIgnore: [],
      filesToIgnore: [],
      folderRenames: [],
      filenameReplacements: [],
      replacementsInFiles: [],
      sharedContentPacks: []
    }
  }
}

const TEMPLATES: EngineTemplate[] = [
  template({ version: '5.4', name: 'TP_BlankBP', display: '空白' }),
  template({ version: '5.5', name: 'TP_BlankBP', display: '空白' }),
  template({ version: '5.5', name: 'TP_ThirdPersonBP', display: '第三人称游戏' }),
  template({ version: '5.5', name: 'TP_Blank', display: '空白' })
]

describe('matchEngineTemplate', () => {
  it('完整 key 最准 —— list_templates 给的就是这个', () => {
    expect(matchEngineTemplate(TEMPLATES, '5.5/TP_ThirdPersonBP')?.templateName).toBe(
      'TP_ThirdPersonBP'
    )
  })

  it('目录名也认', () => {
    expect(matchEngineTemplate(TEMPLATES, 'TP_ThirdPersonBP')?.engineVersion).toBe('5.5')
  })

  it('中文显示名也认 —— 用户和模型说的往往是「空白」', () => {
    expect(matchEngineTemplate(TEMPLATES, '第三人称游戏')?.templateName).toBe('TP_ThirdPersonBP')
  })

  it('engineVersion 会真的收窄 —— 不收窄的话「空白」会命中每个引擎里的那一份', () => {
    expect(matchEngineTemplate(TEMPLATES, '空白', '5.4')?.engineVersion).toBe('5.4')
    expect(matchEngineTemplate(TEMPLATES, '空白', '5.5')?.engineVersion).toBe('5.5')
  })

  it('精确匹配优先于包含匹配 —— TP_Blank 不能把 TP_BlankBP 的请求截走', () => {
    expect(matchEngineTemplate(TEMPLATES, 'TP_Blank', '5.5')?.templateName).toBe('TP_Blank')
    expect(matchEngineTemplate(TEMPLATES, 'TP_BlankBP', '5.5')?.templateName).toBe('TP_BlankBP')
  })

  it('大小写不敏感', () => {
    expect(matchEngineTemplate(TEMPLATES, 'tp_blankbp', '5.5')?.templateName).toBe('TP_BlankBP')
  })

  it('要的版本没装就是没有，不偷偷换一个版本给它', () => {
    expect(matchEngineTemplate(TEMPLATES, '空白', '5.7')).toBeUndefined()
  })

  it('对不上就返回 undefined，让调用方去报「有哪些可选」', () => {
    expect(matchEngineTemplate(TEMPLATES, '赛博朋克')).toBeUndefined()
  })
})

/**
 * 「导入必须先打开工程」原来是函数开头一道总闸。可 .uasset 导入是纯文件拷贝，
 * 根本不碰引擎 —— 于是用户为了导 88 个动画，被逼着先等一趟编辑器启动。
 * 这里把闸拆成按资产分流：只有真的要过引擎的那条路才需要活编辑器。
 */
describe('routeAssetImport', () => {
  it('.uasset 是拷文件，工程关着照样导', () => {
    expect(routeAssetImport({ filePath: 'D:/Vault/SM_Rock.uasset', editorConnected: false })).toBe(
      'copy'
    )
  })

  it('.umap 同理', () => {
    expect(routeAssetImport({ filePath: 'D:/Vault/L_Test.umap', editorConnected: false })).toBe(
      'copy'
    )
  })

  it('库里只记了 softPath、文件名看不出后缀时，按 /Game/ 认它是 UE 原生资产', () => {
    expect(
      routeAssetImport({
        filePath: 'D:/Vault/blobs/a1b2c3',
        softPath: '/Game/Anims/A_Idle',
        editorConnected: false
      })
    ).toBe('copy')
  })

  it('外部文件要过引擎的导入 API —— 工程开着才走得通', () => {
    expect(routeAssetImport({ filePath: 'D:/Vault/Hero.fbx', editorConnected: true })).toBe(
      'engine'
    )
  })

  it('外部文件 + 工程没开 = 这一个做不了，但不该拖垮同批的 .uasset', () => {
    expect(routeAssetImport({ filePath: 'D:/Vault/Hero.fbx', editorConnected: false })).toBe(
      'needs-editor'
    )
  })
})

/**
 * 认不出「这个路径就是那个正开着的工程」的后果不是报错，而是把一个开着的工程
 * 当成关着的：外部文件导入会被误挡下来。
 */
describe('isSameProject', () => {
  it('斜杠方向、大小写、结尾斜杠都不该影响判断', () => {
    expect(isSameProject('D:\\Projects\\MyGame', 'd:/projects/mygame/')).toBe(true)
  })

  it('工程目录和 .uproject 文件指的是同一个工程 —— 插件报目录，项目库存文件', () => {
    expect(isSameProject('D:/Projects/MyGame/MyGame.uproject', 'D:/Projects/MyGame')).toBe(true)
  })

  it('不同工程就是不同工程，前缀像也不行', () => {
    expect(isSameProject('D:/Projects/MyGame', 'D:/Projects/MyGame2')).toBe(false)
  })

  it('空路径永远不算匹配 —— 否则两个「不知道」会被当成同一个工程', () => {
    expect(isSameProject('', '')).toBe(false)
    expect(isSameProject(undefined, null)).toBe(false)
  })
})

/**
 * 列工程时必须把分组和置顶一起报。
 *
 * 少了这两项，模型看到的是一张没有结构的平表：用户说「按引擎版本分个组」，
 * 它不知道哪些已经分好了，只能整库重搬一遍；`project_organize` 也没有合集名可用。
 */
describe('list_projects 的分组信息', () => {
  it('每个工程带 collections 和 pinned，另附合集清单', () => {
    getAllProjectCollections.mockReturnValue([
      { collectionKey: 'collection_55', name: 'UE 5.5', isPinned: 1 },
      { collectionKey: 'collection_empty', name: '空的', isPinned: 0 }
    ])
    getAllProjects.mockReturnValue([
      {
        projectKey: 'p-a',
        projectName: 'AlphaGame',
        EngineAssociation: '5.5',
        projectPath: 'D:/P/Alpha',
        isPinned: 1
      },
      {
        projectKey: 'p-b',
        projectName: 'BetaGame',
        EngineAssociation: '5.4',
        projectPath: 'D:/P/Beta',
        isPinned: 0
      }
    ])

    // 一个工程可以同时在多个合集里，所以成员关系单独查
    getCollectionKeysOfProject.mockImplementation((_db: unknown, key: string) =>
      key === 'p-a' ? ['collection_55'] : []
    )

    const { projects, collections } = listProjects()

    expect(projects[0]).toMatchObject({ collections: ['UE 5.5'], pinned: true })
    expect(projects[1]).toMatchObject({ collections: [], pinned: false })
    // 空合集也要报：名字已经被占了，不报的话模型会建出第二个同名合集
    expect(collections).toEqual([
      { collectionKey: 'collection_55', name: 'UE 5.5', pinned: true, projectCount: 1 },
      { collectionKey: 'collection_empty', name: '空的', pinned: false, projectCount: 0 }
    ])
  })

  it('同时在两个合集里的工程，两个都报', () => {
    getAllProjectCollections.mockReturnValue([
      { collectionKey: 'collection_55', name: 'UE 5.5', isPinned: 0 },
      { collectionKey: 'collection_teach', name: '教学用', isPinned: 0 }
    ])
    getAllProjects.mockReturnValue([
      {
        projectKey: 'p-a',
        projectName: 'AlphaGame',
        EngineAssociation: '5.5',
        projectPath: 'D:/P/Alpha',
        isPinned: 0
      }
    ])
    getCollectionKeysOfProject.mockReturnValue(['collection_55', 'collection_teach'])

    const { projects, collections } = listProjects()

    expect(projects[0].collections).toEqual(['UE 5.5', '教学用'])
    expect(collections.map((c) => c.projectCount)).toEqual([1, 1])
  })
})
