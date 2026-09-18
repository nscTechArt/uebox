import { describe, expect, it } from 'vitest'
import path from 'path'
import {
  SoftPathResolver,
  derivePackRoot,
  deriveSoftPathFromRealPath,
  type SoftPathResolverFs
} from './softPathResolver'

/** 把绝对路径拼成当前平台的样子，Windows 上是 C:\vault\...，POSIX 上是 /vault/... */
const P = (...segments: string[]): string => path.resolve(path.sep, 'vault', ...segments)

type FakeFs = {
  fs: SoftPathResolverFs
  readdirCount: () => number
  existsCount: () => number
}

/** 用一串文件路径搭一个假的目录树，省得在磁盘上摆真的 UE 工程 */
const makeFakeFs = (files: string[]): FakeFs => {
  const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const fileSet = new Set(files.map(normalize))
  const dirSet = new Set<string>()

  for (const file of fileSet) {
    let dir = file.slice(0, file.lastIndexOf('/'))
    while (dir && !dirSet.has(dir)) {
      dirSet.add(dir)
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
  }

  let readdirCount = 0
  let existsCount = 0

  return {
    readdirCount: () => readdirCount,
    existsCount: () => existsCount,
    fs: {
      exists: async (p) => {
        existsCount++
        const target = normalize(p)
        return fileSet.has(target) || dirSet.has(target)
      },
      readdir: async (p) => {
        readdirCount++
        const base = normalize(p)
        if (!dirSet.has(base)) throw new Error(`ENOENT: ${p}`)
        const children = new Map<string, boolean>()
        for (const file of fileSet) {
          if (!file.startsWith(`${base}/`)) continue
          const rest = file.slice(base.length + 1)
          const slash = rest.indexOf('/')
          if (slash === -1) children.set(rest, false)
          else children.set(rest.slice(0, slash), true)
        }
        return Array.from(children).map(([name, isDir]) => ({
          name,
          isDirectory: () => isDir,
          isFile: () => !isDir
        }))
      }
    }
  }
}

const ANIM_A = P('Pack', 'Content', 'Anims', 'A_Run.uasset')
const ANIM_B = P('Pack', 'Content', 'Anims', 'A_Walk.uasset')
const SKELETON = P('Pack', 'Content', 'Chars', 'SK_Hero.uasset')

// 第二个素材包，软路径和第一个包完全一样
const PACK2_ANIM = P('Pack2', 'Content', 'Anims', 'A_Run.uasset')
const PACK2_SKELETON = P('Pack2', 'Content', 'Chars', 'SK_Hero.uasset')

describe('SoftPathResolver', () => {
  it('向上搜索 Content Root 找到同工程内的依赖', async () => {
    const fake = makeFakeFs([ANIM_A, SKELETON])
    const resolver = new SoftPathResolver({ fs: fake.fs })

    await expect(
      resolver.resolve('/Game/Anims/A_Run', '/Game/Chars/SK_Hero', ANIM_A)
    ).resolves.toBe(SKELETON)
  })

  it('同一个包里第二次解析走缓存，不再逐级向上试探', async () => {
    const fake = makeFakeFs([ANIM_A, ANIM_B, SKELETON])
    const resolver = new SoftPathResolver({ fs: fake.fs })

    await resolver.resolve('/Game/Anims/A_Run', '/Game/Chars/SK_Hero', ANIM_A)
    const afterFirst = fake.existsCount()

    // 换一个主资产：三元组缓存命不中，但同包的软路径缓存要命中
    await expect(
      resolver.resolve('/Game/Anims/A_Walk', '/Game/Chars/SK_Hero', ANIM_B)
    ).resolves.toBe(SKELETON)
    // 只剩下那一次「缓存里的文件还在不在」的确认
    expect(fake.existsCount() - afterFirst).toBe(1)
  })

  it('跨素材包不串：两个包各有同名骨骼，各拿各的', async () => {
    const fake = makeFakeFs([ANIM_A, SKELETON, PACK2_ANIM, PACK2_SKELETON])
    const resolver = new SoftPathResolver({ fs: fake.fs })

    // 先解析 A 包，把 /Game/Chars/SK_Hero 写进缓存
    await expect(
      resolver.resolve('/Game/Anims/A_Run', '/Game/Chars/SK_Hero', ANIM_A)
    ).resolves.toBe(SKELETON)

    // 再解析 B 包的同一条软路径 —— 必须拿到 B 包自己的骨骼
    await expect(
      resolver.resolve('/Game/Anims/A_Run', '/Game/Chars/SK_Hero', PACK2_ANIM)
    ).resolves.toBe(PACK2_SKELETON)
  })

  it('跨素材包的否定缓存也分开：A 包没有不代表 B 包没有', async () => {
    const fake = makeFakeFs([ANIM_A, PACK2_ANIM, P('Pack2', 'Content', 'Chars', 'SK_Only2.uasset')])
    const resolver = new SoftPathResolver({ fs: fake.fs })

    // A 包里找不到，记下否定缓存
    const inA = await resolver.resolve('/Game/Anims/A_Run', '/Game/Chars/SK_Only2', ANIM_A)
    expect(inA).not.toBe(P('Pack2', 'Content', 'Chars', 'SK_Only2.uasset'))

    // B 包里是有的，不能被 A 包的否定缓存挡住
    await expect(
      resolver.resolve('/Game/Anims/A_Run', '/Game/Chars/SK_Only2', PACK2_ANIM)
    ).resolves.toBe(P('Pack2', 'Content', 'Chars', 'SK_Only2.uasset'))
  })

  it('找不到的依赖只扫一次盘，后面的资产不再重复递归扫描', async () => {
    const fake = makeFakeFs([ANIM_A, ANIM_B, SKELETON])
    const resolver = new SoftPathResolver({ fs: fake.fs })

    await resolver.resolve('/Game/Anims/A_Run', '/Game/Ghost/SK_Missing', ANIM_A)
    const afterFirst = fake.readdirCount()
    expect(afterFirst).toBeGreaterThan(0)

    await resolver.resolve('/Game/Anims/A_Walk', '/Game/Ghost/SK_Missing', ANIM_B)

    // 这正是文件夹批量导入卡死的根因：几百个资产各扫一遍盘
    expect(fake.readdirCount()).toBe(afterFirst)
  })

  it('关闭缓存时不做否定记忆，每次都会重新扫描', async () => {
    const fake = makeFakeFs([ANIM_A, ANIM_B, SKELETON])
    const resolver = new SoftPathResolver({ fs: fake.fs, enableCache: false })

    await resolver.resolve('/Game/Anims/A_Run', '/Game/Ghost/SK_Missing', ANIM_A)
    const afterFirst = fake.readdirCount()

    await resolver.resolve('/Game/Anims/A_Walk', '/Game/Ghost/SK_Missing', ANIM_B)

    expect(fake.readdirCount()).toBeGreaterThan(afterFirst)
  })

  it('扫描预算是整个解析器共用的，不是每个依赖各给一份', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      P('Pack', 'Content', 'Bulk', `Dir${i}`, `Filler${i}.uasset`)
    )
    const fake = makeFakeFs([ANIM_A, ...many])
    const resolver = new SoftPathResolver({ fs: fake.fs, maxScanEntries: 10 })

    // 三个互不相同的缺失依赖：预算共用的话，第二、第三个基本没得扫
    for (const missing of ['/Game/Ghost/A', '/Game/Ghost/B', '/Game/Ghost/C']) {
      await resolver.resolve('/Game/Anims/A_Run', missing, ANIM_A)
    }

    expect(resolver.remainingScanBudget).toBe(0)
  })

  it('扫描期间收到中止就立刻收手', async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      P('Pack', 'Content', 'Bulk', `Dir${i}`, `Filler${i}.uasset`)
    )
    const fake = makeFakeFs([ANIM_A, ...many])
    let cancelled = false
    const resolver = new SoftPathResolver({
      fs: fake.fs,
      isCancelled: () => cancelled
    })

    cancelled = true
    await resolver.resolve('/Game/Anims/A_Run', '/Game/Ghost/SK_Missing', ANIM_A)

    // 中止时一个目录都不该继续翻
    expect(fake.readdirCount()).toBeLessThanOrEqual(1)
  })

  it('清空缓存后否定记忆也一起失效', async () => {
    const fake = makeFakeFs([ANIM_A, ANIM_B])
    const resolver = new SoftPathResolver({ fs: fake.fs })

    await resolver.resolve('/Game/Anims/A_Run', '/Game/Ghost/SK_Missing', ANIM_A)
    const afterFirst = fake.readdirCount()
    resolver.clear()
    await resolver.resolve('/Game/Anims/A_Walk', '/Game/Ghost/SK_Missing', ANIM_B)

    expect(fake.readdirCount()).toBeGreaterThan(afterFirst)
  })

  it('主软路径与子软路径相同时直接返回主路径', async () => {
    const fake = makeFakeFs([ANIM_A])
    const resolver = new SoftPathResolver({ fs: fake.fs })

    await expect(resolver.resolve('/Game/Anims/A_Run', '/Game/Anims/A_Run', ANIM_A)).resolves.toBe(
      ANIM_A
    )
    expect(fake.existsCount()).toBe(0)
  })
})

describe('derivePackRoot', () => {
  it('取最近的 Content 目录作为素材包根', () => {
    expect(derivePackRoot(ANIM_A)).toBe(P('Pack', 'Content'))
    expect(derivePackRoot(SKELETON)).toBe(P('Pack', 'Content'))
    // 两个包的根必须不同，缓存才分得开
    expect(derivePackRoot(PACK2_ANIM)).not.toBe(derivePackRoot(ANIM_A))
  })

  it('路径里没有 Content/Game 时退回资产自己的目录', () => {
    const loose = P('loose', 'SK_Hero.uasset')
    expect(derivePackRoot(loose)).toBe(P('loose'))
  })
})

describe('deriveSoftPathFromRealPath', () => {
  it('从 Content 目录反推软路径', () => {
    expect(deriveSoftPathFromRealPath(SKELETON)).toBe('/Game/Chars/SK_Hero')
  })

  it('路径里没有 Content/Game 时返回空串', () => {
    expect(deriveSoftPathFromRealPath(P('loose', 'SK_Hero.uasset'))).toBe('')
  })

  it('重音、日文、中文的文件名原样保留，不做「编码修复」', () => {
    // 拿到的是文件系统路径，Node 已经解好码；再「修」一次只会把好字符改坏
    expect(deriveSoftPathFromRealPath(P('Pack', 'Content', 'Textures', 'T_Café.uasset'))).toBe(
      '/Game/Textures/T_Café'
    )
    expect(deriveSoftPathFromRealPath(P('Pack', 'Content', 'Textures', 'T_日本語.uasset'))).toBe(
      '/Game/Textures/T_日本語'
    )
    expect(deriveSoftPathFromRealPath(P('Pack', 'Content', '贴图', 'T_木纹.uasset'))).toBe(
      '/Game/贴图/T_木纹'
    )
  })
})
