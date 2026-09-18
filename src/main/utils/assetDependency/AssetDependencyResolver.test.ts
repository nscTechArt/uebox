import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

// 真实的处理器会一路 import 到 electron 和原生 sqlite，这里只要它认得 .uasset 就够了
vi.mock('../fileProcessor/UnrealAssetProcessor', () => ({
  UnrealAssetProcessor: class {
    async processFile(filePath: string): Promise<{ metadata: Record<string, unknown> }> {
      const name = path.basename(filePath, path.extname(filePath))
      return {
        metadata: { imports: [], classKey: 'uasset', name, softPath: `/Game/Chars/${name}` }
      }
    }
  }
}))

const { AssetDependencyResolver } = await import('./AssetDependencyResolver')
type AssetDependencyInfo = import('./AssetDependencyResolver').AssetDependencyInfo

describe('AssetDependencyResolver 的跨次调用状态', () => {
  let root = ''
  let animRun = ''
  let animWalk = ''
  let skeleton = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ue-dep-'))
    const anims = path.join(root, 'Content', 'Anims')
    const chars = path.join(root, 'Content', 'Chars')
    await mkdir(anims, { recursive: true })
    await mkdir(chars, { recursive: true })

    animRun = path.join(anims, 'A_Run.uasset')
    animWalk = path.join(anims, 'A_Walk.uasset')
    skeleton = path.join(chars, 'SK_Hero.uasset')
    await Promise.all([writeFile(animRun, 'x'), writeFile(animWalk, 'x'), writeFile(skeleton, 'x')])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const makeAsset = (realPath: string, softPath: string): AssetDependencyInfo => ({
    assetKey: path.basename(realPath),
    name: path.basename(realPath, '.uasset'),
    softPath,
    realPath,
    originPath: realPath,
    imports: ['/Game/Chars/SK_Hero'],
    classKey: 'uasset'
  })

  it('默认每次调用都重新解析共享依赖', async () => {
    const found: string[] = []
    const resolver = new AssetDependencyResolver({
      onAssetFound: (asset) => {
        found.push(asset.originPath)
      }
    })

    await resolver.resolveDependencies([makeAsset(animRun, '/Game/Anims/A_Run')])
    await resolver.resolveDependencies([makeAsset(animWalk, '/Game/Anims/A_Walk')])

    // 同一副骨骼被搬了两遍
    expect(found.filter((p) => p === skeleton)).toHaveLength(2)
  })

  it('打开 persistStateAcrossRuns 后共享依赖只解析一次', async () => {
    const found: string[] = []
    const resolver = new AssetDependencyResolver({
      persistStateAcrossRuns: true,
      onAssetFound: (asset) => {
        found.push(asset.originPath)
      }
    })

    await resolver.resolveDependencies([makeAsset(animRun, '/Game/Anims/A_Run')])
    await resolver.resolveDependencies([makeAsset(animWalk, '/Game/Anims/A_Walk')])

    expect(found.filter((p) => p === skeleton)).toHaveLength(1)
    // 两个主资产本身照样各自交付一次，不能被去重吃掉
    expect(found).toContain(animRun)
    expect(found).toContain(animWalk)
  })

  it('批量再大也要解析依赖，不许按数量整批跳过', async () => {
    // 这里曾经有一条「初始资产超过 200 个就跳过递归解析」的保护。它跟
    // localBackupSession「硬引用缺失就判整组失败」是矛盾的：按素材包分别导入时
    // 跨包引用是常态，跳过解析等于让几百个文件直接导不进去。
    const many: AssetDependencyInfo[] = []
    for (let i = 0; i < 250; i++) {
      const file = path.join(root, 'Content', 'Anims', `A_Bulk_${i}.uasset`)
      await writeFile(file, 'x')
      many.push(makeAsset(file, `/Game/Anims/A_Bulk_${i}`))
    }

    const found: string[] = []
    const resolver = new AssetDependencyResolver({
      onAssetFound: (asset) => {
        found.push(asset.originPath)
      }
    })
    await resolver.resolveDependencies(many)

    expect(found).toContain(skeleton)
  })

  it('clearCache 之后重新解析', async () => {
    const found: string[] = []
    const resolver = new AssetDependencyResolver({
      persistStateAcrossRuns: true,
      onAssetFound: (asset) => {
        found.push(asset.originPath)
      }
    })

    await resolver.resolveDependencies([makeAsset(animRun, '/Game/Anims/A_Run')])
    resolver.clearCache()
    await resolver.resolveDependencies([makeAsset(animWalk, '/Game/Anims/A_Walk')])

    expect(found.filter((p) => p === skeleton)).toHaveLength(2)
  })
})
