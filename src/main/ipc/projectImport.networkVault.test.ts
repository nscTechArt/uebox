/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

/**
 * 局域网共享保管库（SMB）那条导入路径的门禁。
 *
 * 这条路和本地库不同：它不走 `AssetDependencyResolver`，而是自己实时解析
 * `.uasset` 找依赖、按 `originPath` 拷文件。所以「依赖找不到怎么结算」这件事
 * 在这里是**另一份代码**，本地库改好了不代表这边也好了 —— 这正是评审第 8 轮
 * 第 3 条复现出来的：库里有记录、源文件已经没了，只加了一条警告，仍报成功。
 */

let tempRoot = ''

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => tempRoot }
}))

let networkPath = ''

vi.mock('../sqliteDataBase/VaultManager', () => ({
  VaultManager: {
    getInstance: () => ({ getCurrentVault: () => ({ vaultType: 'network', networkPath }) })
  },
  VaultType: { REFERENCE: 'reference', BACKUP: 'backup', NETWORK: 'network' }
}))

vi.mock('../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))

type FakeAsset = {
  assetKey: string
  assetName: string
  folderKey: string
  softPath: string
  filePath: string
  originPath: string
  imports: string[]
  classKey: string
  engineVersion: string
}

let assets: FakeAsset[] = []

vi.mock('../sqliteDataBase/models/assetData', () => ({
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

vi.mock('../utils/fileProcessor/UnrealAssetProcessor', () => ({
  UnrealAssetProcessor: class {
    async processFile(): Promise<{ metadata: { imports: string[] } }> {
      return { metadata: { imports: [] } }
    }
  }
}))

vi.mock('../services', () => ({ serviceManager: {} }))
vi.mock('../services/project', () => ({ projectManager: {} }))
vi.mock('../services/project/archiveImport', () => ({
  extractArchiveToProjectContent: async () => ({ success: true })
}))
vi.mock('../utils/namingRulesConfig', () => ({ loadNamingRulesConfig: () => ({}) }))

const { importUAssetsBatchToProject } = await import('./projectImport')

let vaultRoot = ''
let projectDir = ''

const project = (): { projectName: string; originPath: string; EngineAssociation: string } => ({
  projectName: 'Test',
  originPath: path.join(projectDir, 'Test.uproject'),
  EngineAssociation: '5.5'
})

const asset = (name: string, dir: string, imports: string[]): FakeAsset => {
  const file = path.join(vaultRoot, dir, `${name}.uasset`)
  return {
    assetKey: `key_${name}`,
    assetName: name,
    folderKey: 'folder',
    softPath: `/Game/${dir}/${name}`,
    filePath: file,
    originPath: file,
    imports,
    classKey: 'uasset',
    engineVersion: '5.5'
  }
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-net-test-'))
  vaultRoot = path.join(tempRoot, 'Share')
  networkPath = vaultRoot
  projectDir = path.join(tempRoot, 'Proj')
  await fs.mkdir(path.join(projectDir, 'Content'), { recursive: true })
  await fs.mkdir(path.join(vaultRoot, 'Meshes'), { recursive: true })
  await fs.mkdir(path.join(vaultRoot, 'Textures'), { recursive: true })
  await fs.writeFile(path.join(projectDir, 'Test.uproject'), '{}')
  assets = []
})

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('局域网共享保管库的缺失依赖结算', () => {
  it('库里有记录、源文件已经没了 —— 算失败，不能只留一条警告', async () => {
    await fs.writeFile(path.join(vaultRoot, 'Meshes', 'SM_Chair.uasset'), 'MESH')
    // T_Wood 有资产记录，但共享盘上那个文件已经不在了
    assets = [
      asset('SM_Chair', 'Meshes', ['/Game/Textures/T_Wood']),
      asset('T_Wood', 'Textures', [])
    ]

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_Chair', assetName: 'SM_Chair' }
    ])

    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.success).toBe(false)
    expect(result.warnings.join(' | ')).toContain('T_Wood')
  })

  it('库里漏记了那条边时，网络分支解析到的依赖也要登记 —— 否则共享缺失只算第一个', async () => {
    await fs.writeFile(path.join(vaultRoot, 'Meshes', 'SM_A.uasset'), 'MESH-A')
    await fs.writeFile(path.join(vaultRoot, 'Meshes', 'SM_B.uasset'), 'MESH-B')
    // 库里说两个模型都没有依赖（漏记），T_Wood 有记录但共享盘上的文件已经没了
    assets = [
      asset('SM_A', 'Meshes', []),
      asset('SM_B', 'Meshes', []),
      asset('T_Wood', 'Textures', [])
    ]

    const result = await importUAssetsBatchToProject(
      project(),
      [
        { assetKey: 'key_SM_A', assetName: 'SM_A' },
        { assetKey: 'key_SM_B', assetName: 'SM_B' }
      ],
      {
        // 实时解析出来的边：两个模型都引用 T_Wood
        analyzePackage: async (filePath: string) => ({
          imports: {
            Imports: path.basename(filePath).startsWith('SM_')
              ? [{ objectName: '/Game/Textures/T_Wood' }]
              : []
          },
          softPackageReferences: []
        })
      }
    )

    // 第一个资产处理完 T_Wood 就进了已处理集合，第二个资产根本不会再碰它 ——
    // 网络分支不登记实时解析的边的话，SM_B 的闭包是空的，只能算成「成功 1、失败 1」
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
  })

  it('源文件都在时照常报成功', async () => {
    await fs.writeFile(path.join(vaultRoot, 'Meshes', 'SM_Chair.uasset'), 'MESH')
    await fs.writeFile(path.join(vaultRoot, 'Textures', 'T_Wood.uasset'), 'TEX')
    assets = [
      asset('SM_Chair', 'Meshes', ['/Game/Textures/T_Wood']),
      asset('T_Wood', 'Textures', [])
    ]

    const result = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_Chair', assetName: 'SM_Chair' }
    ])

    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.success).toBe(true)
  })

  it('原样再导一遍要报「已存在」，一个字节都不搬', async () => {
    // 网络库这条分支原来把 copyUnrealPackageFiles 的 skipped/conflicted 丢了
    //（只取了 parseSourcePath），于是 skippedFiles 恒为 0，收尾永远判不出「已存在」。
    // 真机验收单第 2 步的通过判据就卡在这儿
    await fs.writeFile(path.join(vaultRoot, 'Meshes', 'SM_Chair.uasset'), 'MESH')
    await fs.writeFile(path.join(vaultRoot, 'Textures', 'T_Wood.uasset'), 'TEX')
    assets = [
      asset('SM_Chair', 'Meshes', ['/Game/Textures/T_Wood']),
      asset('T_Wood', 'Textures', [])
    ]

    const first = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_Chair', assetName: 'SM_Chair' }
    ])
    expect(first.succeeded).toBe(1)
    expect(first.copied).toBeGreaterThan(0)

    const second = await importUAssetsBatchToProject(project(), [
      { assetKey: 'key_SM_Chair', assetName: 'SM_Chair' }
    ])

    expect(second.existing).toBe(1)
    expect(second.succeeded).toBe(0)
    expect(second.failed).toBe(0)
    expect(second.copied).toBe(0)
  })
})
