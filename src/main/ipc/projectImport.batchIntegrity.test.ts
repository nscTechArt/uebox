/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

/**
 * 批量导入的**正确性**门禁 —— 评审复现的那几条都在这里。
 *
 * 盯三件事，每一件都只在「拷贝是排队异步做的」之后才可能出错：
 * 1. 文件没写进去就不许报成功（评审第 1 条）
 * 2. 中止后重试要能把缺的依赖补齐（评审第 2 条）
 * 3. 什么都不用搬的时候才算「已存在」
 *
 * 走的是 `importUAssetsBatchToProject` 整条路，不 mock 拷贝队列 —— 只有这样才拦得住
 * 「逻辑写对了但没接上」。
 */

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())

let tempRoot = ''

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      ipcHandlers.set(name, handler)
  },
  app: { getPath: () => tempRoot }
}))

// 本地备份库：走的是 AssetDependencyResolver 那条路（不是网络库的实时解析分支）
vi.mock('../sqliteDataBase/VaultManager', () => ({
  VaultManager: { getInstance: () => ({ getCurrentVault: () => ({ vaultType: 'backup' }) }) },
  VaultType: { REFERENCE: 'reference', BACKUP: 'backup', NETWORK: 'network' }
}))

vi.mock('../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))

type FakeAsset = {
  assetKey: string
  assetName: string
  folderKey: string
  softPath: string
  filePath: string
  imports: string[]
  classKey: string
  engineVersion: string
}

let assets: FakeAsset[] = []
/** 资产名 → 实时解析出来的依赖。用来模拟「数据库漏记了这条边」 */
let parsedImportsOverride: Record<string, string[]> = {}

vi.mock('../sqliteDataBase/models/assetData', () => ({
  findAssetDataByExactName: (_db: unknown, name: string) =>
    assets.filter((a) => a.assetName === name),
  getAssetDataByKey: (_db: unknown, key: string) => assets.find((a) => a.assetKey === key) ?? null,
  getAssetDataBySoftPath: (_db: unknown, softPath: string) =>
    assets.find((a) => a.softPath === softPath) ?? null,
  getAssetsByKeys: (_db: unknown, keys: string[]) =>
    assets.filter((a) => keys.includes(a.assetKey)),
  getAssetsBySoftPaths: (_db: unknown, softPaths: string[]) =>
    assets.filter((a) => softPaths.includes(a.softPath)),
  searchAssetDataByName: () => []
}))

vi.mock('../utils/PathManager', () => ({
  PathManager: { getInstance: () => ({ getAbsoluteFromVault: (p: string) => p }) }
}))

vi.mock('../utils/UnrealPathManager', () => ({ default: {} }))

vi.mock('./projectEngineVersion', () => ({
  resolveProjectEngineVersion: async () => ({ displayVersion: '5.5', comparableVersion: '5.5' }),
  compareAssetToResolvedProjectEngineVersion: (version: string) => ({
    comparison: version === '5.6' ? 1 : 0,
    assetDisplayVersion: version,
    project: { displayVersion: '5.5' }
  }),
  compareAssetToProjectEngineVersion: async () => ({
    comparison: 0,
    assetDisplayVersion: '5.5',
    project: { displayVersion: '5.5' }
  })
}))

// 解析 .uasset 二进制不是这条测试关心的事，依赖关系由资产记录的 imports 给出
vi.mock('../utils/fileProcessor/UnrealAssetProcessor', () => ({
  UnrealAssetProcessor: class {
    async processFile(filePath: string): Promise<{ metadata: Record<string, unknown> }> {
      const name = path.basename(filePath, path.extname(filePath))
      const known = assets.find((a) => a.assetName === name)
      return {
        metadata: {
          imports: parsedImportsOverride[name] ?? known?.imports ?? [],
          classKey: 'uasset',
          name,
          softPath: known?.softPath ?? ''
        }
      }
    }
  }
}))

// §7 的坑：`../services` 会一路拖到 better-sqlite3 的原生绑定，vitest worker 里会段错误
vi.mock('../services', () => ({ serviceManager: {} }))
vi.mock('../services/project', () => ({ projectManager: {} }))
vi.mock('../services/project/archiveImport', () => ({
  extractArchiveToProjectContent: async () => ({ success: true })
}))
vi.mock('../utils/namingRulesConfig', () => ({ loadNamingRulesConfig: () => ({}) }))

const { importUAssetsBatchToProject, createBatchSession, importSingleUAssetToProject } =
  await import('./projectImport')

let vaultContent = ''
let projectDir = ''
let contentBase = ''

const ANIM_BYTES = 'ANIM-CONTENT'
const SKELETON_BYTES = 'SKELETON-CONTENT'

const project = (): { projectName: string; originPath: string; EngineAssociation: string } => ({
  projectName: 'Test',
  originPath: path.join(projectDir, 'Test.uproject'),
  EngineAssociation: '5.5'
})

/** 一个动画 + 它依赖的一副骨骼，都摆在保管库的 Content 树下 */
const seedVault = async (): Promise<void> => {
  await fs.mkdir(path.join(vaultContent, 'Anims'), { recursive: true })
  await fs.mkdir(path.join(vaultContent, 'Chars'), { recursive: true })
  await fs.writeFile(path.join(vaultContent, 'Anims', 'A_Run.uasset'), ANIM_BYTES)
  await fs.writeFile(path.join(vaultContent, 'Chars', 'SK_Hero.uasset'), SKELETON_BYTES)

  assets = [
    {
      assetKey: 'key_anim',
      assetName: 'A_Run',
      folderKey: 'folder',
      softPath: '/Game/Anims/A_Run',
      filePath: path.join(vaultContent, 'Anims', 'A_Run.uasset'),
      imports: ['/Game/Chars/SK_Hero'],
      classKey: 'uasset',
      engineVersion: '5.5'
    },
    {
      assetKey: 'key_skeleton',
      assetName: 'SK_Hero',
      folderKey: 'folder',
      softPath: '/Game/Chars/SK_Hero',
      filePath: path.join(vaultContent, 'Chars', 'SK_Hero.uasset'),
      imports: [],
      classKey: 'uasset',
      engineVersion: '5.5'
    }
  ]
}

const readIfExists = async (p: string): Promise<string | null> => {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-batch-test-'))
  vaultContent = path.join(tempRoot, 'Vault', 'Content')
  projectDir = path.join(tempRoot, 'Proj')
  contentBase = path.join(projectDir, 'Content')
  await fs.mkdir(contentBase, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'Test.uproject'), '{}')
  assets = []
  parsedImportsOverride = {}
})

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('importUAssetsBatchToProject 的结算口径', () => {
  it('版本预检只报告不兼容项且不写入工程，导入仍保留结构化失败原因', async () => {
    await seedVault()
    assets[0].engineVersion = '5.6'
    const sources = assets.map(({ assetKey }) => ({ assetKey }))
    const check = await ipcHandlers.get('project:checkImportCompatibility')!(
      null,
      project(),
      sources
    )
    expect(check).toEqual({
      success: true,
      data: {
        projectVersion: '5.5',
        blocked: [{ assetKey: 'key_anim', assetName: 'A_Run', version: '5.6' }]
      }
    })
    expect(await fs.readdir(contentBase)).toEqual([])
    const result = await importUAssetsBatchToProject(project(), [sources[0]])
    expect(result.report?.planErrors).toEqual([
      expect.objectContaining({ assetName: 'key_anim', code: 'engine-version' })
    ])
    expect(await fs.readdir(contentBase)).toEqual([])
  })

  /**
   * 版本闸一共有两道：渲染端的预检，和这里真正拷文件时的这一道。
   * 用户在弹窗里点了「仍然导入」只放行了前一道，后一道照样把资产退回来，
   * 表现成「强制导入还是被拦截了」。所以这个开关必须一路走到这里。
   */
  it('ignoreEngineVersion 放行高版本资产，文件真的写进工程', async () => {
    await seedVault()
    assets[0].engineVersion = '5.6'
    const result = await importUAssetsBatchToProject(
      project(),
      [{ assetKey: 'key_anim', assetName: 'A_Run' }],
      { ignoreEngineVersion: true }
    )
    expect(result.report?.planErrors ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'engine-version' })
    )
    expect(result.succeeded).toBe(1)
    expect(await fs.readdir(contentBase)).not.toEqual([])
  })

  it('不传 ignoreEngineVersion 时照常挡住，默认不许放行', async () => {
    await seedVault()
    assets[0].engineVersion = '5.6'
    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_anim', assetName: 'A_Run' }
    ])
    expect(result.report?.planErrors).toEqual([
      expect.objectContaining({ assetName: 'A_Run', code: 'engine-version' })
    ])
    expect(await fs.readdir(contentBase)).toEqual([])
  })

  it('文件没写进工程就不许报成功', async () => {
    await seedVault()

    // 把目标目录的位置占成一个普通文件：建目录必然失败，于是拷贝一定写不进去
    await fs.writeFile(path.join(contentBase, 'Anims'), 'not a directory')
    await fs.writeFile(path.join(contentBase, 'Chars'), 'not a directory')

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_anim', assetName: 'A_Run' }
    ])

    expect(result.copied).toBe(0)
    expect(result.filesFailed).toBeGreaterThan(0)
    // 这就是评审复现的那一条：以前这里是「成功 1、失败 0」
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.success).toBe(false)
    expect(result.warnings.join('\n')).toContain('A_Run')
  })

  it('中止后重试要把缺的依赖补齐，而不是判「已存在」直接跳过', async () => {
    await seedVault()

    // 模拟上次被中止的状态：主资产写进去了，依赖还没
    await fs.mkdir(path.join(contentBase, 'Anims'), { recursive: true })
    await fs.writeFile(path.join(contentBase, 'Anims', 'A_Run.uasset'), ANIM_BYTES)
    expect(await readIfExists(path.join(contentBase, 'Chars', 'SK_Hero.uasset'))).toBeNull()

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_anim', assetName: 'A_Run' }
    ])

    // 依赖必须补上
    expect(await readIfExists(path.join(contentBase, 'Chars', 'SK_Hero.uasset'))).toBe(
      SKELETON_BYTES
    )
    // 已经在的主资产不该被重搬一遍
    expect(result.copied).toBe(1)
    expect(result.existing).toBe(0)
    expect(result.succeeded).toBe(1)
    expect(result.success).toBe(true)
  })

  it('主资产和依赖都在了才算「已存在」，且一个字节都不搬', async () => {
    await seedVault()

    await fs.mkdir(path.join(contentBase, 'Anims'), { recursive: true })
    await fs.mkdir(path.join(contentBase, 'Chars'), { recursive: true })
    await fs.writeFile(path.join(contentBase, 'Anims', 'A_Run.uasset'), ANIM_BYTES)
    await fs.writeFile(path.join(contentBase, 'Chars', 'SK_Hero.uasset'), SKELETON_BYTES)

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_anim', assetName: 'A_Run' }
    ])

    expect(result.existing).toBe(1)
    expect(result.copied).toBe(0)
    expect(result.filesFailed).toBe(0)
    expect(result.success).toBe(true)
  })

  it('目标文件长度对不上（上次写了一半）时会重写，不当成已存在', async () => {
    await seedVault()

    await fs.mkdir(path.join(contentBase, 'Anims'), { recursive: true })
    // 半截文件：存在，但长度和源对不上
    await fs.writeFile(path.join(contentBase, 'Anims', 'A_Run.uasset'), 'ANIM')

    await importUAssetsBatchToProject(project(), [{ assetKey: 'key_anim', assetName: 'A_Run' }])

    expect(await readIfExists(path.join(contentBase, 'Anims', 'A_Run.uasset'))).toBe(ANIM_BYTES)
  })

  it('共享依赖挂了，所有用到它的资产都要算失败', async () => {
    await seedVault()
    // 第二个动画，和第一个共用同一副骨骼
    assets.push({
      assetKey: 'key_anim2',
      assetName: 'A_Walk',
      folderKey: 'folder',
      softPath: '/Game/Anims/A_Walk',
      filePath: path.join(vaultContent, 'Anims', 'A_Walk.uasset'),
      imports: ['/Game/Chars/SK_Hero'],
      classKey: 'uasset',
      engineVersion: '5.5'
    })
    await fs.writeFile(path.join(vaultContent, 'Anims', 'A_Walk.uasset'), ANIM_BYTES)

    // 只让骨骼那个目录写不进去，两个动画本身都能写
    await fs.writeFile(path.join(contentBase, 'Chars'), 'not a directory')

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_anim', assetName: 'A_Run' },
      { assetKey: 'key_anim2', assetName: 'A_Walk' }
    ])

    expect(result.filesFailed).toBe(1)
    // 骨骼只排了一次队，但两个动画都因此不完整 —— 以前这里是「成功 1、失败 1」
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.success).toBe(false)
  })

  it('共享依赖的分片（.ubulk）挂了，用到它的资产也全算失败', async () => {
    await seedVault()
    // 给骨骼加一个分片，并让它写不进去
    await fs.writeFile(path.join(vaultContent, 'Chars', 'SK_Hero.ubulk'), 'BULK-DATA')

    assets.push({
      assetKey: 'key_anim2',
      assetName: 'A_Walk',
      folderKey: 'folder',
      softPath: '/Game/Anims/A_Walk',
      filePath: path.join(vaultContent, 'Anims', 'A_Walk.uasset'),
      imports: ['/Game/Chars/SK_Hero'],
      classKey: 'uasset',
      engineVersion: '5.5'
    })
    await fs.writeFile(path.join(vaultContent, 'Anims', 'A_Walk.uasset'), ANIM_BYTES)

    // 骨骼那一整个包都写不进去（.uasset 和 .ubulk 都在 Chars 下）
    await fs.writeFile(path.join(contentBase, 'Chars'), 'not a directory')

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_anim', assetName: 'A_Run' },
      { assetKey: 'key_anim2', assetName: 'A_Walk' }
    ])

    expect(result.filesFailed).toBeGreaterThan(0)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
  })

  it('间接依赖（模型 → 材质 → 贴图）挂了，两个模型都算失败', async () => {
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.mkdir(path.join(vaultContent, 'Materials'), { recursive: true })
    await fs.mkdir(path.join(vaultContent, 'Textures'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_A.uasset'), 'MESH-A')
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_B.uasset'), 'MESH-B')
    await fs.writeFile(path.join(vaultContent, 'Materials', 'M_Wood.uasset'), 'MATERIAL')
    await fs.writeFile(path.join(vaultContent, 'Textures', 'T_Wood.uasset'), 'TEXTURE')

    const mk = (name: string, dir: string, imports: string[]): FakeAsset => ({
      assetKey: `key_${name}`,
      assetName: name,
      folderKey: 'folder',
      softPath: `/Game/${dir}/${name}`,
      filePath: path.join(vaultContent, dir, `${name}.uasset`),
      imports,
      classKey: 'uasset',
      engineVersion: '5.5'
    })
    assets = [
      mk('SM_A', 'Meshes', ['/Game/Materials/M_Wood']),
      mk('SM_B', 'Meshes', ['/Game/Materials/M_Wood']),
      mk('M_Wood', 'Materials', ['/Game/Textures/T_Wood']),
      mk('T_Wood', 'Textures', [])
    ]

    // 只有贴图写不进去 —— 它是两个模型的**间接**依赖
    await fs.writeFile(path.join(contentBase, 'Textures'), 'not a directory')

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_A', assetName: 'SM_A' },
      { assetKey: 'key_SM_B', assetName: 'SM_B' }
    ])

    expect(result.filesFailed).toBe(1)
    // 贴图只排了一次队，但两个模型都因此不完整
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
  })

  it('依赖多到走不完闭包时，有文件失败就不许算成功', async () => {
    // 主资产依赖一批同级资产，其中一个写不进去。
    // 闭包上限调小到走不完这批 —— 走不完就等于「没查过」，不能当成「查过没事」。
    const FANOUT = 6
    await fs.mkdir(path.join(vaultContent, 'Deps'), { recursive: true })
    await fs.mkdir(path.join(vaultContent, 'Doomed'), { recursive: true })
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_Main.uasset'), 'MAIN')
    await fs.writeFile(path.join(vaultContent, 'Doomed', 'D.uasset'), 'DOOMED')

    const deps: string[] = []
    assets = []
    for (let i = 0; i < FANOUT; i++) {
      await fs.writeFile(path.join(vaultContent, 'Deps', `N${i}.uasset`), `NODE-${i}`)
      deps.push(`/Game/Deps/N${i}`)
      assets.push({
        assetKey: `key_N${i}`,
        assetName: `N${i}`,
        folderKey: 'folder',
        softPath: `/Game/Deps/N${i}`,
        filePath: path.join(vaultContent, 'Deps', `N${i}.uasset`),
        imports: [],
        classKey: 'uasset',
        engineVersion: '5.5'
      })
    }
    assets.push(
      {
        assetKey: 'key_main',
        assetName: 'SM_Main',
        folderKey: 'folder',
        softPath: '/Game/Meshes/SM_Main',
        filePath: path.join(vaultContent, 'Meshes', 'SM_Main.uasset'),
        // 排在最后那个依赖恰好是写不进去的，闭包走不到它
        imports: [...deps, '/Game/Doomed/D'],
        classKey: 'uasset',
        engineVersion: '5.5'
      },
      {
        assetKey: 'key_D',
        assetName: 'D',
        folderKey: 'folder',
        softPath: '/Game/Doomed/D',
        filePath: path.join(vaultContent, 'Doomed', 'D.uasset'),
        imports: [],
        classKey: 'uasset',
        engineVersion: '5.5'
      }
    )
    await fs.writeFile(path.join(contentBase, 'Doomed'), 'not a directory')

    const result = await importUAssetsBatchToProject(
      project(),
      [{ assetKey: 'key_main', assetName: 'SM_Main' }],
      { maxClosureNodes: 3 }
    )

    expect(result.filesFailed).toBeGreaterThan(0)
    // 闭包没走完 = 无法确认导全了，不能当作成功结算
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.warnings.join('\n')).toContain('未能确认')
  })

  it('依赖在保管库里根本不存在时，算这个资产失败并报出来', async () => {
    // 模型引用一张贴图，但保管库里没有这个文件（数据库里也没有记录）
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_Chair.uasset'), 'MESH')
    assets = [
      {
        assetKey: 'key_chair',
        assetName: 'SM_Chair',
        folderKey: 'folder',
        softPath: '/Game/Meshes/SM_Chair',
        filePath: path.join(vaultContent, 'Meshes', 'SM_Chair.uasset'),
        imports: ['/Game/Textures/T_Café'],
        classKey: 'uasset',
        engineVersion: '5.5'
      }
    ]

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_chair', assetName: 'SM_Chair' }
    ])

    // 主文件确实拷过去了，但依赖缺着 —— 这个资产在工程里用不了，不能报成功
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.success).toBe(false)
    // 用户得看得见缺的是什么
    expect(result.warnings.join(' | ')).toContain('T_Café')
  })

  it('没给要导什么时如实报失败，不能算成「没什么要导的，成功」', async () => {
    const result = await importSingleUAssetToProject(project(), null)

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('未找到主资产')
  })

  it('单个资产导入同样要报出缺失依赖，不能只有批量入口管', async () => {
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_Chair.uasset'), 'MESH')
    assets = [
      {
        assetKey: 'key_chair',
        assetName: 'SM_Chair',
        folderKey: 'folder',
        softPath: '/Game/Meshes/SM_Chair',
        filePath: path.join(vaultContent, 'Meshes', 'SM_Chair.uasset'),
        imports: ['/Game/Textures/T_Café'],
        classKey: 'uasset',
        engineVersion: '5.5'
      }
    ]

    const result = await importSingleUAssetToProject(project(), { assetKey: 'key_chair' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('依赖不完整')
    expect((result.warnings ?? []).join(' | ')).toContain('T_Café')
  })

  it('缺依赖的资产原样重试，仍然算失败 —— 不能变成「已存在」', async () => {
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_Chair.uasset'), 'MESH')
    assets = [
      {
        assetKey: 'key_chair',
        assetName: 'SM_Chair',
        folderKey: 'folder',
        softPath: '/Game/Meshes/SM_Chair',
        filePath: path.join(vaultContent, 'Meshes', 'SM_Chair.uasset'),
        imports: ['/Game/Textures/T_Missing'],
        classKey: 'uasset',
        engineVersion: '5.5'
      }
    ]

    const first = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_chair', assetName: 'SM_Chair' }
    ])
    expect(first.failed).toBe(1)

    // 原样再导一遍：主文件已经在了、能拷的都拷完了，但依赖还是缺的
    const second = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_chair', assetName: 'SM_Chair' }
    ])

    expect(second.existing).toBe(0)
    expect(second.succeeded).toBe(0)
    expect(second.failed).toBe(1)
    expect(second.success).toBe(false)

    // 单资产入口同样不能变成「已存在」
    const single = await importSingleUAssetToProject(project(), { assetKey: 'key_chair' })
    expect(single.alreadyExists).toBeFalsy()
    expect(single.success).toBe(false)
  })

  it('两个资产共用同一个缺失依赖时，两个都算失败', async () => {
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_A.uasset'), 'MESH-A')
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_B.uasset'), 'MESH-B')
    const mk = (name: string): FakeAsset => ({
      assetKey: `key_${name}`,
      assetName: name,
      folderKey: 'folder',
      softPath: `/Game/Meshes/${name}`,
      filePath: path.join(vaultContent, 'Meshes', `${name}.uasset`),
      imports: ['/Game/Textures/T_Missing'],
      classKey: 'uasset',
      engineVersion: '5.5'
    })
    assets = [mk('SM_A'), mk('SM_B')]

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_A', assetName: 'SM_A' },
      { assetKey: 'key_SM_B', assetName: 'SM_B' }
    ])

    // 共享依赖只在第一个资产那一轮被解析到 —— 以前这里是「成功 1、失败 1」
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.success).toBe(false)
  })

  it('整批原样重试时，共享缺失依赖仍要算到所有资产头上', async () => {
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_A.uasset'), 'MESH-A')
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_B.uasset'), 'MESH-B')
    const mk = (name: string): FakeAsset => ({
      assetKey: `key_${name}`,
      assetName: name,
      folderKey: 'folder',
      softPath: `/Game/Meshes/${name}`,
      filePath: path.join(vaultContent, 'Meshes', `${name}.uasset`),
      imports: ['/Game/Textures/T_Missing'],
      classKey: 'uasset',
      engineVersion: '5.5'
    })
    assets = [mk('SM_A'), mk('SM_B')]
    const batch = [
      { assetKey: 'key_SM_A', assetName: 'SM_A' },
      { assetKey: 'key_SM_B', assetName: 'SM_B' }
    ]

    const first = await importUAssetsBatchToProject(project(), batch)
    expect(first.failed).toBe(2)

    // 原样整批重试：两个主文件都已经在了，第二个资产什么都不用搬 ——
    // 以前这里会变成「已存在 1、失败 1」
    const second = await importUAssetsBatchToProject(project(), batch)

    expect(second.existing).toBe(0)
    expect(second.succeeded).toBe(0)
    expect(second.failed).toBe(2)
    expect(second.success).toBe(false)
  })

  it('数据库漏记依赖时，共享缺失也要算到所有资产头上', async () => {
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.mkdir(path.join(vaultContent, 'Materials'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_A.uasset'), 'MESH-A')
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_B.uasset'), 'MESH-B')
    await fs.writeFile(path.join(vaultContent, 'Materials', 'M_Wood.uasset'), 'MATERIAL')

    const mk = (name: string, dir: string, imports: string[]): FakeAsset => ({
      assetKey: `key_${name}`,
      assetName: name,
      folderKey: 'folder',
      softPath: `/Game/${dir}/${name}`,
      filePath: path.join(vaultContent, dir, `${name}.uasset`),
      imports,
      classKey: 'uasset',
      engineVersion: '5.5'
    })
    assets = [
      mk('SM_A', 'Meshes', ['/Game/Materials/M_Wood']),
      mk('SM_B', 'Meshes', ['/Game/Materials/M_Wood']),
      // 库里记的是「材质没有依赖」，实际它引用了一张缺失的贴图
      mk('M_Wood', 'Materials', [])
    ]
    parsedImportsOverride = { M_Wood: ['/Game/Textures/T_Missing'] }

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_A', assetName: 'SM_A' },
      { assetKey: 'key_SM_B', assetName: 'SM_B' }
    ])

    // 归属只走数据库的话，这条边根本不存在，SM_B 会被算成功
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
  })

  it('把材质也一起选上时，数据库旧记录不能覆盖实时解析出来的依赖', async () => {
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.mkdir(path.join(vaultContent, 'Materials'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_A.uasset'), 'MESH-A')
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_B.uasset'), 'MESH-B')
    await fs.writeFile(path.join(vaultContent, 'Materials', 'M_Wood.uasset'), 'MATERIAL')

    const mk = (name: string, dir: string, imports: string[]): FakeAsset => ({
      assetKey: `key_${name}`,
      assetName: name,
      folderKey: 'folder',
      softPath: `/Game/${dir}/${name}`,
      filePath: path.join(vaultContent, dir, `${name}.uasset`),
      imports,
      classKey: 'uasset',
      engineVersion: '5.5'
    })
    assets = [
      mk('SM_A', 'Meshes', ['/Game/Materials/M_Wood']),
      mk('SM_B', 'Meshes', ['/Game/Materials/M_Wood']),
      // 库里记的是「材质没有依赖」，实际它引用了一张缺失的贴图
      mk('M_Wood', 'Materials', [])
    ]
    parsedImportsOverride = { M_Wood: ['/Game/Textures/T_Missing'] }

    // 关键：材质**也在这一批里**。轮到它时它是「初始资产」，
    // imports 取自数据库（空），覆盖式写入会把前面解析出来的边抹掉
    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_A', assetName: 'SM_A' },
      { assetKey: 'key_SM_B', assetName: 'SM_B' },
      { assetKey: 'key_M_Wood', assetName: 'M_Wood' }
    ])

    expect(result.succeeded).toBe(0)
    expect(result.existing).toBe(0)
    expect(result.failed).toBe(3)
  })

  it('依赖检查超限时，只有「缺文件」也要触发保守失败', async () => {
    await fs.mkdir(path.join(vaultContent, 'Meshes'), { recursive: true })
    await fs.mkdir(path.join(vaultContent, 'Deps'), { recursive: true })
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_A.uasset'), 'MESH-A')
    await fs.writeFile(path.join(vaultContent, 'Meshes', 'SM_B.uasset'), 'MESH-B')

    const deps: string[] = []
    assets = []
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(vaultContent, 'Deps', `N${i}.uasset`), `N${i}`)
      deps.push(`/Game/Deps/N${i}`)
      assets.push({
        assetKey: `key_N${i}`,
        assetName: `N${i}`,
        folderKey: 'folder',
        softPath: `/Game/Deps/N${i}`,
        filePath: path.join(vaultContent, 'Deps', `N${i}.uasset`),
        imports: [],
        classKey: 'uasset',
        engineVersion: '5.5'
      })
    }
    for (const name of ['SM_A', 'SM_B']) {
      assets.push({
        assetKey: `key_${name}`,
        assetName: name,
        folderKey: 'folder',
        softPath: `/Game/Meshes/${name}`,
        filePath: path.join(vaultContent, 'Meshes', `${name}.uasset`),
        // 缺失的那个排在最后，闭包上限走不到它
        imports: [...deps, '/Game/Textures/T_Missing'],
        classKey: 'uasset',
        engineVersion: '5.5'
      })
    }

    const result = await importUAssetsBatchToProject(
      project(),
      [
        { assetKey: 'key_SM_A', assetName: 'SM_A' },
        { assetKey: 'key_SM_B', assetName: 'SM_B' }
      ],
      { maxClosureNodes: 3 }
    )

    // 一个字节都没拷失败，全靠「依赖找不到」触发 —— 以前这条保护只看拷贝失败
    expect(result.filesFailed).toBe(0)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
  })

  it('依赖齐全时照常报成功，不会被误判成不完整', async () => {
    await seedVault()

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_anim', assetName: 'A_Run' }
    ])

    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.success).toBe(true)
  })

  it('两个素材包写到同一个目标时报冲突，哪怕先到的那个已经写完了', async () => {
    await seedVault()

    // 另一个包里也有一个 /Game/Chars/SK_Hero，内容不同但**长度一样**
    const pack2 = path.join(tempRoot, 'Vault2', 'Content')
    await fs.mkdir(path.join(pack2, 'Chars'), { recursive: true })
    const otherBytes = 'SKELETON-2NDPACK'
    expect(otherBytes).toHaveLength(SKELETON_BYTES.length)
    await fs.writeFile(path.join(pack2, 'Chars', 'SK_Hero.uasset'), otherBytes)

    assets.push({
      assetKey: 'key_skeleton2',
      assetName: 'SK_Hero',
      folderKey: 'folder2',
      softPath: '/Game/Chars/SK_Hero',
      filePath: path.join(pack2, 'Chars', 'SK_Hero.uasset'),
      imports: [],
      classKey: 'uasset',
      engineVersion: '5.5'
    })

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_skeleton', assetName: 'SK_Hero' },
      { assetKey: 'key_skeleton2', assetName: 'SK_Hero(包二)' }
    ])

    // 先到的那个写进去了，第二个长度一样会被「已存在」挡掉 ——
    // 但这不是「已经导过了」，是两个包撞了，必须报出来
    expect(await readIfExists(path.join(contentBase, 'Chars', 'SK_Hero.uasset'))).toBe(
      SKELETON_BYTES
    )
    expect(result.warnings.join('\n')).toContain('目标路径冲突')

    // 冲突不降级任何一个资产（谁也说不清该算谁的），所以 failed 是 0 ——
    // 但整批**不许**因此报成功：那正是「界面一片绿、工程里装着别人的字节」。
    // 界面据 success 决定要不要弹「查看详情」，这条断言是那条链路的地基
    expect(result.success).toBe(false)
    expect(result.report.conflicts).toHaveLength(1)
    expect(result.report.conflicts[0].name).toBe('SK_Hero.uasset')
  })
})

describe('导入会话的取消状态', () => {
  it('会话被中止时，依赖解析器立刻看得见', () => {
    const session = createBatchSession({
      contentBase,
      projectEngine: { displayVersion: '5.5', comparableVersion: '5.5' } as never,
      assetCount: 1,
      assetsByKey: new Map(),
      httpTempDir: tempRoot,
      vaultType: 'backup'
    })

    // 解析器里那套「扫描中途收手」的机制全靠这根线；接不上的话从外面完全看不出来
    expect(session.resolver.cancelled).toBe(false)
    session.cancelled = true
    expect(session.resolver.cancelled).toBe(true)
  })
})
