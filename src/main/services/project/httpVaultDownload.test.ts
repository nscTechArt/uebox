import { describe, expect, it } from 'vitest'
import {
  HttpDownloadPool,
  httpVaultAssetAlreadyImported,
  httpVaultRelativePath,
  httpVaultTargetPath,
  resolveHttpVaultTarget
} from './httpVaultDownload'

const posix = (p: string): string => p.replace(/\\/g, '/')

/** 记录并发峰值的假下载器 */
const makeDownloader = (
  options: { delayMs?: number; failOn?: (relPath: string) => Error | null } = {}
): {
  download: (relPath: string) => Promise<string>
  requested: string[]
  peakConcurrency: () => number
} => {
  const requested: string[] = []
  let inFlight = 0
  let peak = 0

  return {
    requested,
    peakConcurrency: () => peak,
    download: async (relPath: string) => {
      requested.push(relPath)
      inFlight++
      peak = Math.max(peak, inFlight)
      try {
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
        const failure = options.failOn?.(relPath)
        if (failure) throw failure
        return `/tmp/${relPath}`
      } finally {
        inFlight--
      }
    }
  }
}

describe('resolveHttpVaultTarget', () => {
  it('从 networkPath 拆出服务器地址和远端 vaultId', () => {
    expect(
      resolveHttpVaultTarget({
        vaultType: 'network',
        networkPath: 'http://192.168.31.210:18900/vault_1773290000'
      })
    ).toEqual({ baseUrl: 'http://192.168.31.210:18900', vaultId: 'vault_1773290000' })
  })

  it('局域网共享（SMB）不是 HTTP 库', () => {
    expect(
      resolveHttpVaultTarget({ vaultType: 'network', networkPath: '\\\\server\\share\\vault' })
    ).toBeNull()
  })

  it('本地库不是 HTTP 库', () => {
    expect(resolveHttpVaultTarget({ vaultType: 'backup', networkPath: 'D:/vault' })).toBeNull()
    expect(resolveHttpVaultTarget(null)).toBeNull()
  })

  it('缺 vaultId 时按「不是 HTTP 库」处理 —— 拼出来的地址必然 404', () => {
    expect(
      resolveHttpVaultTarget({ vaultType: 'network', networkPath: 'http://192.168.31.210:18900' })
    ).toBeNull()
  })
})

describe('httpVaultRelativePath', () => {
  it('正常记录直接用 filePath', () => {
    expect(httpVaultRelativePath({ filePath: 'Meshes/SM_Chair.uasset' })).toBe(
      'Meshes/SM_Chair.uasset'
    )
  })

  it('旧数据里的本地绝对路径退回用文件名', () => {
    expect(httpVaultRelativePath({ filePath: 'D:/vault/Meshes/SM_Chair.uasset' })).toBe(
      'SM_Chair.uasset'
    )
    expect(httpVaultRelativePath({ filePath: '/Users/dong/vault/SM_Chair.uasset' })).toBe(
      'SM_Chair.uasset'
    )
  })

  it('没有 filePath 就没有下载地址', () => {
    expect(httpVaultRelativePath({})).toBe('')
  })
})

describe('httpVaultTargetPath', () => {
  it('目录来自 softPath、文件名来自 filePath', () => {
    const target = httpVaultTargetPath('P:/Proj/Content', {
      softPath: '/Game/Meshes/Props/SM_Chair',
      filePath: 'uploads/SM_Chair.uasset'
    })
    expect(posix(String(target))).toBe('P:/Proj/Content/Meshes/Props/SM_Chair.uasset')
  })

  it('softPath 直接挂在 /Game 根下时落在 Content 根', () => {
    const target = httpVaultTargetPath('P:/Proj/Content', {
      softPath: '/Game/SM_Chair',
      filePath: 'SM_Chair.uasset'
    })
    expect(posix(String(target))).toBe('P:/Proj/Content/SM_Chair.uasset')
  })

  it('缺 softPath 或 filePath 时算不出目标路径', () => {
    expect(httpVaultTargetPath('P:/Proj/Content', { filePath: 'a.uasset' })).toBeNull()
    expect(httpVaultTargetPath('P:/Proj/Content', { softPath: '/Game/A' })).toBeNull()
  })
})

type HttpVaultAssetRefWithImports = {
  softPath?: string
  filePath?: string
  fileSize?: number
  imports?: string[]
}

describe('httpVaultAssetAlreadyImported', () => {
  const asset = { softPath: '/Game/Meshes/SM_Chair', filePath: 'uploads/SM_Chair.uasset' }

  /** 只有列出来的这些路径「存在」，size 默认给个够用的数 */
  const statOf =
    (present: Record<string, number>) =>
    async (target: string): Promise<{ size: number }> => {
      const size = present[posix(target)]
      if (size === undefined) throw new Error('ENOENT')
      return { size }
    }

  it('目标在就是已导入 —— 判断全程不碰源文件，也就不用下载', async () => {
    const checked: string[] = []
    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', asset, {
      stat: async (target) => {
        checked.push(posix(target))
        return { size: 10 }
      }
    })

    expect(exists).toBe(true)
    expect(checked).toEqual(['P:/Proj/Content/Meshes/SM_Chair.uasset'])
  })

  it('目标不在就要导入', async () => {
    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', asset, {
      stat: async () => {
        throw new Error('ENOENT')
      }
    })
    expect(exists).toBe(false)
  })

  it('算不出目标路径时不敢说「已存在」', async () => {
    const exists = await httpVaultAssetAlreadyImported(
      'P:/Proj/Content',
      {},
      {
        stat: async () => ({ size: 1 })
      }
    )
    expect(exists).toBe(false)
  })

  it('目标只写了半截（长度对不上）不算已导入', async () => {
    const exists = await httpVaultAssetAlreadyImported(
      'P:/Proj/Content',
      { ...asset, fileSize: 2048 },
      { stat: statOf({ 'P:/Proj/Content/Meshes/SM_Chair.uasset': 700 }) }
    )
    expect(exists).toBe(false)
  })

  it('记录在案的依赖缺一个就不算已导入 —— 中止后重试要补得回来', async () => {
    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', asset, {
      stat: statOf({ 'P:/Proj/Content/Meshes/SM_Chair.uasset': 10 }),
      dependencySoftPaths: ['/Game/Chars/SK_Hero']
    })
    expect(exists).toBe(false)
  })

  it('主文件和依赖都在才算已导入', async () => {
    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', asset, {
      stat: statOf({
        'P:/Proj/Content/Meshes/SM_Chair.uasset': 10,
        'P:/Proj/Content/Chars/SK_Hero.uasset': 10
      }),
      dependencySoftPaths: ['/Game/Chars/SK_Hero']
    })
    expect(exists).toBe(true)
  })

  it('依赖链走到底：模型 → 材质 → 贴图，贴图缺了就不算已导入', async () => {
    const model = {
      softPath: '/Game/Meshes/SM_Chair',
      filePath: 'uploads/SM_Chair.uasset',
      imports: ['/Game/Materials/M_Wood']
    }
    const graph: Record<string, HttpVaultAssetRefWithImports> = {
      '/Game/Materials/M_Wood': {
        softPath: '/Game/Materials/M_Wood',
        filePath: 'uploads/M_Wood.uasset',
        imports: ['/Game/Textures/T_Wood']
      },
      '/Game/Textures/T_Wood': {
        softPath: '/Game/Textures/T_Wood',
        filePath: 'uploads/T_Wood.uasset',
        imports: []
      }
    }

    // 模型和材质都在，只有贴图没导进去
    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', model, {
      stat: statOf({
        'P:/Proj/Content/Meshes/SM_Chair.uasset': 10,
        'P:/Proj/Content/Materials/M_Wood.uasset': 10
      }),
      lookupBySoftPath: (softPath) => graph[softPath] ?? null
    })

    expect(exists).toBe(false)
  })

  it('依赖链全在才算已导入', async () => {
    const model = {
      softPath: '/Game/Meshes/SM_Chair',
      filePath: 'uploads/SM_Chair.uasset',
      imports: ['/Game/Materials/M_Wood']
    }
    const graph: Record<string, HttpVaultAssetRefWithImports> = {
      '/Game/Materials/M_Wood': {
        softPath: '/Game/Materials/M_Wood',
        filePath: 'uploads/M_Wood.uasset',
        imports: ['/Game/Textures/T_Wood']
      },
      '/Game/Textures/T_Wood': {
        softPath: '/Game/Textures/T_Wood',
        filePath: 'uploads/T_Wood.uasset',
        imports: []
      }
    }

    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', model, {
      stat: statOf({
        'P:/Proj/Content/Meshes/SM_Chair.uasset': 10,
        'P:/Proj/Content/Materials/M_Wood.uasset': 10,
        'P:/Proj/Content/Textures/T_Wood.uasset': 10
      }),
      lookupBySoftPath: (softPath) => graph[softPath] ?? null
    })

    expect(exists).toBe(true)
  })

  it('依赖自己只写了半截也不算已导入', async () => {
    const graph: Record<string, HttpVaultAssetRefWithImports> = {
      '/Game/Chars/SK_Hero': {
        softPath: '/Game/Chars/SK_Hero',
        filePath: 'uploads/SK_Hero.uasset',
        fileSize: 4096,
        imports: []
      }
    }

    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', asset, {
      stat: statOf({
        'P:/Proj/Content/Meshes/SM_Chair.uasset': 10,
        'P:/Proj/Content/Chars/SK_Hero.uasset': 30
      }),
      dependencySoftPaths: ['/Game/Chars/SK_Hero'],
      lookupBySoftPath: (softPath) => graph[softPath] ?? null
    })

    expect(exists).toBe(false)
  })

  it('依赖成环也不会转不出来', async () => {
    const graph: Record<string, HttpVaultAssetRefWithImports> = {
      '/Game/A/One': {
        softPath: '/Game/A/One',
        filePath: 'u/One.uasset',
        imports: ['/Game/A/Two']
      },
      '/Game/A/Two': { softPath: '/Game/A/Two', filePath: 'u/Two.uasset', imports: ['/Game/A/One'] }
    }

    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', asset, {
      stat: statOf({
        'P:/Proj/Content/Meshes/SM_Chair.uasset': 10,
        'P:/Proj/Content/A/One.uasset': 10,
        'P:/Proj/Content/A/Two.uasset': 10
      }),
      dependencySoftPaths: ['/Game/A/One'],
      lookupBySoftPath: (softPath) => graph[softPath] ?? null
    })

    expect(exists).toBe(true)
  })

  it('依赖链大到超预算时按未导入处理，宁可多导一次', async () => {
    const graph: Record<string, HttpVaultAssetRefWithImports> = {}
    const present: Record<string, number> = { 'P:/Proj/Content/Meshes/SM_Chair.uasset': 10 }
    for (let i = 0; i < 20; i++) {
      graph[`/Game/Chain/N${i}`] = {
        softPath: `/Game/Chain/N${i}`,
        filePath: `u/N${i}.uasset`,
        imports: [`/Game/Chain/N${i + 1}`]
      }
      present[`P:/Proj/Content/Chain/N${i}.uasset`] = 10
    }

    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', asset, {
      stat: statOf(present),
      dependencySoftPaths: ['/Game/Chain/N0'],
      lookupBySoftPath: (softPath) => graph[softPath] ?? null,
      maxNodes: 3
    })

    expect(exists).toBe(false)
  })

  it('数据库漏记依赖时，以磁盘上那个包的真实依赖为准', async () => {
    // 库里说这个模型没有依赖，实际上它引用了一张贴图 —— 贴图没导进去
    const model = { softPath: '/Game/Meshes/SM_Chair', filePath: 'uploads/SM_Chair.uasset' }

    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', model, {
      stat: statOf({ 'P:/Proj/Content/Meshes/SM_Chair.uasset': 10 }),
      lookupBySoftPath: () => null,
      // 读磁盘上那个包，拿到的是真实依赖
      readImportsOfTarget: async (target) =>
        posix(target).endsWith('/Meshes/SM_Chair.uasset') ? ['/Game/Textures/T_Wood'] : []
    })

    expect(exists).toBe(false)
  })

  it('真实依赖也在了才算已导入', async () => {
    const model = { softPath: '/Game/Meshes/SM_Chair', filePath: 'uploads/SM_Chair.uasset' }

    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', model, {
      stat: statOf({
        'P:/Proj/Content/Meshes/SM_Chair.uasset': 10,
        'P:/Proj/Content/Textures/T_Wood.uasset': 10
      }),
      lookupBySoftPath: () => null,
      readImportsOfTarget: async (target) =>
        posix(target).endsWith('/Meshes/SM_Chair.uasset') ? ['/Game/Textures/T_Wood'] : []
    })

    expect(exists).toBe(true)
  })

  it('包解析不出来时不敢下「已导全」的结论', async () => {
    const model = { softPath: '/Game/Meshes/SM_Chair', filePath: 'uploads/SM_Chair.uasset' }

    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', model, {
      stat: statOf({ 'P:/Proj/Content/Meshes/SM_Chair.uasset': 10 }),
      readImportsOfTarget: async () => null
    })

    expect(exists).toBe(false)
  })

  it('依赖是 .umap 也认', async () => {
    const exists = await httpVaultAssetAlreadyImported('P:/Proj/Content', asset, {
      stat: statOf({
        'P:/Proj/Content/Meshes/SM_Chair.uasset': 10,
        'P:/Proj/Content/Levels/L_Main.umap': 10
      }),
      dependencySoftPaths: ['/Game/Levels/L_Main']
    })
    expect(exists).toBe(true)
  })
})

describe('HttpDownloadPool', () => {
  it('同一个文件只下一次 —— 几百个资产共用一张贴图', async () => {
    const net = makeDownloader()
    const pool = new HttpDownloadPool({ download: net.download, concurrency: 4 })

    expect(pool.prefetch('T_Wood.uasset')).toBe(true)
    expect(pool.prefetch('T_Wood.uasset')).toBe(false)

    const [a, b] = await Promise.all([pool.fetch('T_Wood.uasset'), pool.fetch('T_Wood.uasset')])

    expect(net.requested).toEqual(['T_Wood.uasset'])
    expect(a).toBe(b)
    expect(pool.stats.completed).toBe(1)
  })

  it('真的并发，且不超过设定的路数', async () => {
    const net = makeDownloader({ delayMs: 5 })
    const pool = new HttpDownloadPool({ download: net.download, concurrency: 3 })

    for (let i = 0; i < 12; i++) pool.prefetch(`a${i}.uasset`)
    await pool.drain()

    expect(net.requested).toHaveLength(12)
    expect(net.peakConcurrency()).toBeGreaterThan(1)
    expect(net.peakConcurrency()).toBeLessThanOrEqual(3)
  })

  it('规划开口要的文件插到队首 —— 否则它排在队尾，预取反而拖慢了它', async () => {
    const net = makeDownloader({ delayMs: 1 })
    const pool = new HttpDownloadPool({ download: net.download, concurrency: 1 })

    for (let i = 0; i < 6; i++) pool.prefetch(`a${i}.uasset`)
    // a0 已经被唯一那路 worker 领走，a5 还在队尾排着
    const localPath = await pool.fetch('a5.uasset')

    expect(localPath).toBe('/tmp/a5.uasset')
    // 插队之后它是第二个下的，而不是第六个
    expect(net.requested.indexOf('a5.uasset')).toBe(1)
    await pool.drain()
    expect(net.requested).toHaveLength(6)
  })

  it('没预取过的（依赖是边解析边发现的）当场开下', async () => {
    const net = makeDownloader()
    const pool = new HttpDownloadPool({ download: net.download, concurrency: 2 })

    expect(await pool.fetch('SK_Hero.uasset')).toBe('/tmp/SK_Hero.uasset')
    expect(net.requested).toEqual(['SK_Hero.uasset'])
  })

  it('单个文件下载失败只拒它自己，其他照下', async () => {
    const net = makeDownloader({
      failOn: (relPath) => (relPath === 'bad.uasset' ? new Error('HTTP 404') : null)
    })
    const pool = new HttpDownloadPool({ download: net.download, concurrency: 2 })

    await expect(pool.fetch('bad.uasset')).rejects.toThrow('HTTP 404')
    expect(await pool.fetch('good.uasset')).toBe('/tmp/good.uasset')
    expect(pool.stats.failed).toBe(1)
    expect(pool.stats.completed).toBe(1)
  })

  it('预取失败没人 await，也不能变成未处理的 rejection', async () => {
    const net = makeDownloader({ failOn: () => new Error('HTTP 500') })
    const pool = new HttpDownloadPool({ download: net.download, concurrency: 2 })

    pool.prefetch('bad.uasset')
    await pool.drain()
    // 事件循环再转一圈，未处理的 rejection 该炸也炸了
    await new Promise((r) => setTimeout(r, 5))

    expect(pool.stats.failed).toBe(1)
  })

  it('中止之后排着的活直接拒掉，等它的规划不会挂死', async () => {
    const net = makeDownloader({ delayMs: 5 })
    const pool = new HttpDownloadPool({ download: net.download, concurrency: 1 })

    for (let i = 0; i < 10; i++) pool.prefetch(`a${i}.uasset`)
    const waiting = pool.fetch('a9.uasset')
    pool.cancel()

    await expect(waiting).rejects.toThrow('下载已取消')
    await pool.drain()

    expect(pool.isCancelled).toBe(true)
    // 顶多是取消那一刻正在下的那个
    expect(net.requested.length).toBeLessThanOrEqual(2)
  })

  it('下完的临时文件留给调用方收尾删除', async () => {
    const net = makeDownloader()
    const pool = new HttpDownloadPool({ download: net.download, concurrency: 2 })

    pool.prefetch('a.uasset')
    pool.prefetch('b.uasset')
    await pool.drain()

    expect(pool.downloadedFiles().sort()).toEqual(['/tmp/a.uasset', '/tmp/b.uasset'])
  })
})
