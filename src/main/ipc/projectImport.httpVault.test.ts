/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'

/**
 * HTTP 服务器保管库那条导入路径的门禁。
 *
 * 盯的是两件事，它们都只在「一个文件夹几百个资产」的时候才看得出来：
 * 1. 已经在工程里的资产**一个字节都不下**（查重排在下载前面）
 * 2. 要下的那些**并发下**（HTTP 一个文件一次往返，串行等于把带宽扔了）
 *
 * 所以这里不 mock 下载池，而是从 `importUAssetsBatchToProject` 整条路进去，
 * 在最外面数 http 请求 —— 只有这样才拦得住「逻辑写对了但没接上」。
 */

/** 每一次真正发出去的下载请求 */
const httpRequests: string[] = []
let downloadDelayMs = 0
let inFlightDownloads = 0
let peakDownloads = 0

const fakeHttpGet = (
  url: string,
  _options: unknown,
  callback: (res: Readable & { statusCode: number }) => void
): { on: () => void; destroy: () => void } => {
  httpRequests.push(url)
  inFlightDownloads++
  peakDownloads = Math.max(peakDownloads, inFlightDownloads)

  setTimeout(() => {
    inFlightDownloads--
    const res = Readable.from([Buffer.from('UASSET')]) as Readable & { statusCode: number }
    res.statusCode = 200
    callback(res)
  }, downloadDelayMs)

  return { on: () => {}, destroy: () => {} }
}

vi.mock('http', () => ({ get: fakeHttpGet }))
vi.mock('https', () => ({ get: fakeHttpGet }))

let tempRoot = ''

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => tempRoot }
}))

const currentVault = {
  vaultType: 'network',
  networkPath: 'http://127.0.0.1:18900/vault_remote_1'
}

vi.mock('../sqliteDataBase/VaultManager', () => ({
  VaultManager: { getInstance: () => ({ getCurrentVault: () => currentVault }) },
  VaultType: { REFERENCE: 'reference', BACKUP: 'backup', NETWORK: 'network' }
}))

vi.mock('../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))

type FakeAsset = {
  assetKey: string
  assetName: string
  folderKey: string
  softPath: string
  filePath: string
  engineVersion: string
}

let assets: FakeAsset[] = []

vi.mock('../sqliteDataBase/models/assetData', () => ({
  findAssetDataByExactName: (_db: unknown, name: string) =>
    assets.filter((a) => a.assetName === name),
  getAssetDataByKey: (_db: unknown, key: string) => assets.find((a) => a.assetKey === key) ?? null,
  getAssetDataBySoftPath: () => null,
  getAssetsByKeys: (_db: unknown, keys: string[]) =>
    assets.filter((a) => keys.includes(a.assetKey)),
  getAssetsBySoftPaths: () => [],
  searchAssetDataByName: () => []
}))

vi.mock('../utils/PathManager', () => ({
  PathManager: { getInstance: () => ({ getAbsoluteFromVault: (p: string) => p }) }
}))

vi.mock('../utils/UnrealPathManager', () => ({ default: {} }))

vi.mock('./projectEngineVersion', () => ({
  resolveProjectEngineVersion: async () => ({ displayVersion: '5.5', version: '5.5' }),
  compareAssetToResolvedProjectEngineVersion: () => ({
    comparison: 0,
    assetDisplayVersion: '5.5',
    project: { displayVersion: '5.5' }
  }),
  compareAssetToProjectEngineVersion: async () => ({
    comparison: 0,
    assetDisplayVersion: '5.5',
    project: { displayVersion: '5.5' }
  })
}))

// 实时解析二进制不是这条测试关心的事：假装每个资产都没有依赖
vi.mock('../utils/fileProcessor/UnrealAssetProcessor', () => ({
  UnrealAssetProcessor: class {
    async processFile(): Promise<{ metadata: { imports: string[] } }> {
      return { metadata: { imports: [] } }
    }
  }
}))

vi.mock('../utils/assetDependency/AssetDependencyResolver', () => ({
  AUTO_DISABLE_CIRCULAR_THRESHOLD: 50,
  AssetDependencyResolver: class {
    async resolveDependencies(): Promise<void> {
      // 网络库（含 HTTP 库）走的是另一条实时解析的路，这个解析器根本不参与
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

const { importUAssetsBatchToProject: rawBatchImport } = await import('./projectImport')

/**
 * 测试里的目标文件是假的（内容就是 'UASSET'），真解析器读不出来。
 * 这里塞一个「解析得动」的假解析器，默认没有依赖 —— 依赖相关的断言各自覆盖。
 */
let targetImports: Record<string, string[]> = {}
const importUAssetsBatchToProject = (
  project: Parameters<typeof rawBatchImport>[0],
  sources: Parameters<typeof rawBatchImport>[1],
  options: Parameters<typeof rawBatchImport>[2] = {}
): ReturnType<typeof rawBatchImport> =>
  rawBatchImport(project, sources, {
    ...options,
    analyzePackage: async (filePath: string) => ({
      imports: {
        // 下载下来的临时文件名带唯一序号前缀（`<时间戳>_<序号>_SM_A.uasset`），
        // 按后缀匹配才认得出这是哪个包
        Imports: (
          Object.entries(targetImports).find(([name]) =>
            path.basename(filePath).endsWith(name)
          )?.[1] ?? []
        ).map((objectName) => ({ objectName }))
      },
      softPackageReferences: []
    })
  })

let projectDir = ''
let contentBase = ''

const makeAsset = (name: string): FakeAsset => ({
  assetKey: `key_${name}`,
  assetName: name,
  folderKey: 'folder',
  softPath: `/Game/Meshes/${name}`,
  filePath: `uploads/${name}.uasset`,
  engineVersion: '5.5'
})

const project = (): { projectName: string; originPath: string; EngineAssociation: string } => ({
  projectName: 'Test',
  originPath: path.join(projectDir, 'Test.uproject'),
  EngineAssociation: '5.5'
})

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-import-test-'))
  projectDir = path.join(tempRoot, 'Proj')
  contentBase = path.join(projectDir, 'Content')
  await fs.mkdir(contentBase, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'Test.uproject'), '{}')

  httpRequests.length = 0
  targetImports = {}
  downloadDelayMs = 0
  inFlightDownloads = 0
  peakDownloads = 0
  assets = []
})

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('importUAssetsBatchToProject（HTTP 服务器保管库）', () => {
  it('已经导过的资产不再下载 —— 重复导入一个文件夹曾经要把整包白下一遍', async () => {
    assets = [makeAsset('SM_A'), makeAsset('SM_B'), makeAsset('SM_C')]

    // A、C 上次就导进去了，工程里已经有
    await fs.mkdir(path.join(contentBase, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(contentBase, 'Meshes', 'SM_A.uasset'), 'old')
    await fs.writeFile(path.join(contentBase, 'Meshes', 'SM_C.uasset'), 'old')

    const result = await importUAssetsBatchToProject(
      project(),
      assets.map((a) => ({ assetKey: a.assetKey, assetName: a.assetName }))
    )

    expect(result.existing).toBe(2)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)

    // 只有 B 值得下载
    expect(httpRequests).toHaveLength(1)
    expect(httpRequests[0]).toContain('SM_B.uasset')

    // 已存在的那两个原样留着，没被重下的内容覆盖
    expect(await fs.readFile(path.join(contentBase, 'Meshes', 'SM_A.uasset'), 'utf8')).toBe('old')
    expect(await fs.readFile(path.join(contentBase, 'Meshes', 'SM_B.uasset'), 'utf8')).toBe(
      'UASSET'
    )
  })

  it('整批都没导过时并发下载，不再一个一个排队等', async () => {
    downloadDelayMs = 25
    assets = Array.from({ length: 6 }, (_, i) => makeAsset(`SM_${i}`))

    const result = await importUAssetsBatchToProject(
      project(),
      assets.map((a) => ({ assetKey: a.assetKey, assetName: a.assetName }))
    )

    expect(result.succeeded).toBe(6)
    expect(httpRequests).toHaveLength(6)
    // 串行的话峰值永远是 1
    expect(peakDownloads).toBeGreaterThan(1)

    for (let i = 0; i < 6; i++) {
      expect(await fs.readFile(path.join(contentBase, 'Meshes', `SM_${i}.uasset`), 'utf8')).toBe(
        'UASSET'
      )
    }
  })

  it('同一个文件被两个资产共用时只下一次', async () => {
    const shared = makeAsset('SM_Shared')
    assets = [shared, { ...shared, assetKey: 'key_alias', softPath: '/Game/Meshes/SM_Shared' }]

    const result = await importUAssetsBatchToProject(
      project(),
      assets.map((a) => ({ assetKey: a.assetKey, assetName: a.assetName }))
    )

    expect(result.failed).toBe(0)
    expect(httpRequests).toHaveLength(1)
  })

  it('库里查不到的资产算失败，也不会为它发请求', async () => {
    assets = [makeAsset('SM_A')]

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_missing', assetName: '不在库里的资产' }
    ])

    expect(result.failed).toBe(1)
    expect(httpRequests).toHaveLength(0)
  })

  it('临时目录收尾时清干净，不把下载来的文件留在盘上', async () => {
    assets = [makeAsset('SM_A')]

    await importUAssetsBatchToProject(project(), [{ assetKey: 'key_SM_A', assetName: 'SM_A' }])

    const leftovers = (await fs.readdir(tempRoot)).filter((entry) => entry.startsWith('ue-import-'))
    expect(leftovers).toEqual([])
  })

  it('完整但没有依赖的资产不会被重新下载 —— 「解析成功且无依赖」不是「解析失败」', async () => {
    assets = [makeAsset('SM_Lonely')]
    await fs.mkdir(path.join(contentBase, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(contentBase, 'Meshes', 'SM_Lonely.uasset'), 'old')
    // 解析得动，但一个依赖都没有（真解析器会把空 imports 字段整个删掉）
    targetImports = {}

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_Lonely', assetName: 'SM_Lonely' }
    ])

    expect(result.existing).toBe(1)
    expect(httpRequests).toHaveLength(0)
  })

  it('依赖链末端是无依赖资产时，整条链照样认得出「已导全」', async () => {
    assets = [makeAsset('SM_Chair')]
    await fs.mkdir(path.join(contentBase, 'Meshes'), { recursive: true })
    await fs.mkdir(path.join(contentBase, 'Textures'), { recursive: true })
    await fs.writeFile(path.join(contentBase, 'Meshes', 'SM_Chair.uasset'), 'old')
    await fs.writeFile(path.join(contentBase, 'Textures', 'T_Wood.uasset'), 'old')
    // 模型依赖贴图，贴图自己没有依赖
    targetImports = { 'SM_Chair.uasset': ['/Game/Textures/T_Wood'] }

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_Chair', assetName: 'SM_Chair' }
    ])

    expect(result.existing).toBe(1)
    expect(httpRequests).toHaveLength(0)
  })

  it('依赖路径带重音/日文时不会被改坏 —— 缺文件必须报出来', async () => {
    assets = [makeAsset('SM_Chair')]
    await fs.mkdir(path.join(contentBase, 'Meshes'), { recursive: true })
    await fs.writeFile(path.join(contentBase, 'Meshes', 'SM_Chair.uasset'), 'old')
    // 模型引用一张带重音的贴图，而那张贴图并没有导进工程
    targetImports = { 'SM_Chair.uasset': ['/Game/Textures/T_Café'] }

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_Chair', assetName: 'SM_Chair' }
    ])

    // 路径被改坏的话，会去找 T_Caf� —— 一样找不到，但那是「碰巧」找不到。
    // 这里要的是：确实没导全，就不能报「已存在」
    expect(result.existing).toBe(0)
  })

  it('依赖路径带重音、且文件确实在，就要认得出「已导全」', async () => {
    assets = [makeAsset('SM_Chair')]
    await fs.mkdir(path.join(contentBase, 'Meshes'), { recursive: true })
    await fs.mkdir(path.join(contentBase, 'Textures'), { recursive: true })
    await fs.writeFile(path.join(contentBase, 'Meshes', 'SM_Chair.uasset'), 'old')
    // 文件名带重音，原样落在盘上
    await fs.writeFile(path.join(contentBase, 'Textures', 'T_Café.uasset'), 'old')
    targetImports = { 'SM_Chair.uasset': ['/Game/Textures/T_Café'] }

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_Chair', assetName: 'SM_Chair' }
    ])

    // 路径一旦被「编码修复」改坏，这里就会去找 T_Caf�、找不到、判成没导全 ——
    // 于是白重下一遍。这条用例守的就是这个
    expect(result.existing).toBe(1)
    expect(httpRequests).toHaveLength(0)
  })

  it('不同目录下的同名文件并发下载时不会互相覆盖', async () => {
    // 两个资产文件名一样、只有目录不同。临时文件名如果只有「毫秒 + 文件名」，
    // 同一毫秒下下来的这两个会写进同一个临时文件，两条流互相盖，最后工程里只剩一个
    downloadDelayMs = 5
    assets = [
      {
        assetKey: 'key_chars_SK',
        assetName: 'SK',
        folderKey: 'folder',
        softPath: '/Game/Chars/SK',
        filePath: 'uploads/Chars/SK.uasset',
        engineVersion: '5.5'
      },
      {
        assetKey: 'key_props_SK',
        assetName: 'SK',
        folderKey: 'folder',
        softPath: '/Game/Props/SK',
        filePath: 'uploads/Props/SK.uasset',
        engineVersion: '5.5'
      }
    ]

    const result = await importUAssetsBatchToProject(
      project(),
      assets.map((a) => ({ assetKey: a.assetKey, assetName: a.assetName }))
    )

    expect(result.failed).toBe(0)
    expect(result.filesFailed).toBe(0)
    // 两个目标各自落地，谁也没被谁盖掉
    await expect(fs.readFile(path.join(contentBase, 'Chars', 'SK.uasset'), 'utf8')).resolves.toBe(
      'UASSET'
    )
    await expect(fs.readFile(path.join(contentBase, 'Props', 'SK.uasset'), 'utf8')).resolves.toBe(
      'UASSET'
    )
  })
})
