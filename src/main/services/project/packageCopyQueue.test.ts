import { describe, expect, it, vi } from 'vitest'
import { PackageCopyQueue, copyFileWithRetry, type PackageCopyQueueFs } from './packageCopyQueue'

type Recorder = {
  fs: PackageCopyQueueFs
  copies: string[]
  mkdirs: string[]
  /** 任一时刻同时在拷的文件数的峰值 */
  peakConcurrency: () => number
}

const makeFs = (
  options: { delayMs?: number; failOn?: (target: string) => Error | null } = {}
): Recorder => {
  const copies: string[] = []
  const mkdirs: string[] = []
  let inFlight = 0
  let peak = 0

  const recorder: Recorder = {
    copies,
    mkdirs,
    peakConcurrency: () => peak,
    fs: {
      stat: async () => ({ size: 0 }),
      mkdir: async (dir) => {
        mkdirs.push(dir)
      },
      copyFile: async (source, target) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
          const failure = options.failOn?.(target)
          if (failure) throw failure
          copies.push(`${source}=>${target}`)
        } finally {
          inFlight--
        }
      }
    }
  }
  return recorder
}

const errnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('copyFileWithRetry', () => {
  it('文件被占用时退避重试，最后成功', async () => {
    let attempts = 0
    const fs: PackageCopyQueueFs = {
      stat: async () => ({ size: 0 }),
      mkdir: async () => {},
      copyFile: async () => {
        attempts++
        if (attempts < 3) throw errnoError('EBUSY')
      }
    }

    await copyFileWithRetry('a', 'b', { fs, retryDelayMs: () => 0 })

    expect(attempts).toBe(3)
  })

  it('不是「被占用」类的错误不重试，直接抛', async () => {
    let attempts = 0
    const fs: PackageCopyQueueFs = {
      stat: async () => ({ size: 0 }),
      mkdir: async () => {},
      copyFile: async () => {
        attempts++
        throw errnoError('ENOENT')
      }
    }

    await expect(copyFileWithRetry('a', 'b', { fs, retryDelayMs: () => 0 })).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  it('重试次数用完仍然失败就抛出去', async () => {
    const fs: PackageCopyQueueFs = {
      stat: async () => ({ size: 0 }),
      mkdir: async () => {},
      copyFile: async () => {
        throw errnoError('EBUSY')
      }
    }

    await expect(
      copyFileWithRetry('a', 'b', { fs, maxRetries: 2, retryDelayMs: () => 0 })
    ).rejects.toThrow()
  })
})

describe('PackageCopyQueue', () => {
  it('同一个目标只拷一次 —— 并发下两个 writer 写同一个文件就是数据损坏', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 4 })

    expect(
      queue.enqueue({ source: 'A/SK.uasset', target: 'T/SK.uasset', assetKey: 'a', size: 10 })
    ).toBe(true)
    // 另一个动画也依赖同一副骨骼
    expect(
      queue.enqueue({ source: 'A/SK.uasset', target: 'T/SK.uasset', assetKey: 'b', size: 10 })
    ).toBe(false)

    await queue.drain()

    expect(rec.copies).toEqual(['A/SK.uasset=>T/SK.uasset'])
    expect(queue.stats.copied).toBe(1)
    expect(queue.stats.bytesCopied).toBe(10)
  })

  it('真的并发，且不超过设定的路数', async () => {
    const rec = makeFs({ delayMs: 5 })
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 3 })

    for (let i = 0; i < 12; i++) {
      queue.enqueue({ source: `s${i}`, target: `t${i}`, assetKey: '', size: 1 })
    }
    await queue.drain()

    expect(rec.copies).toHaveLength(12)
    expect(rec.peakConcurrency()).toBeGreaterThan(1)
    expect(rec.peakConcurrency()).toBeLessThanOrEqual(3)
  })

  it('同一个目录只 mkdir 一次', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 1 })

    for (const ext of ['.uasset', '.uexp', '.ubulk']) {
      queue.enqueue({
        source: `src/Pack/SK${ext}`,
        target: `dst/Content/Chars/SK${ext}`,
        assetKey: '',
        size: 1
      })
    }
    await queue.drain()

    expect(rec.mkdirs).toHaveLength(1)
  })

  it('单个文件失败不影响其他文件，失败记录能拿到', async () => {
    const rec = makeFs({ failOn: (target) => (target === 't1' ? new Error('磁盘满了') : null) })
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 2, maxRetries: 0 })

    queue.enqueue({ source: 's0', target: 't0', assetKey: '', size: 1 })
    queue.enqueue({ source: 's1', target: 't1', assetKey: '', size: 1 })
    queue.enqueue({ source: 's2', target: 't2', assetKey: '', size: 1 })
    await queue.drain()

    expect(queue.stats.copied).toBe(2)
    expect(queue.stats.failed).toBe(1)
    expect(queue.getFailures()).toHaveLength(1)
    expect(queue.getFailures()[0].target).toBe('t1')
  })

  it('中止之后不再开新文件，也不再收新活', async () => {
    const rec = makeFs({ delayMs: 5 })
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 1 })

    for (let i = 0; i < 20; i++) {
      queue.enqueue({ source: `s${i}`, target: `t${i}`, assetKey: '', size: 1 })
    }
    queue.cancel()

    expect(queue.enqueue({ source: 'sx', target: 'tx', assetKey: '', size: 1 })).toBe(false)
    await queue.drain()

    expect(queue.isCancelled).toBe(true)
    // 顶多是取消那一刻正在拷的那个
    expect(rec.copies.length).toBeLessThanOrEqual(1)
  })

  it('每拷完一个文件回报一次进度，带字节数', async () => {
    const rec = makeFs()
    const onProgress = vi.fn()
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 1, onProgress })

    queue.enqueue({ source: 's0', target: 't0', assetKey: '', size: 100 })
    queue.enqueue({ source: 's1', target: 't1', assetKey: '', size: 200 })
    await queue.drain()

    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(queue.stats.bytesTotal).toBe(300)
    expect(queue.stats.bytesCopied).toBe(300)
  })

  it('drain 会等到规划途中追加的活也做完', async () => {
    const rec = makeFs({ delayMs: 2 })
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 2 })

    queue.enqueue({ source: 's0', target: 't0', assetKey: '', size: 1 })
    // 模拟「规划还在跑，边算边入队」
    setTimeout(() => {
      queue.enqueue({ source: 's1', target: 't1', assetKey: '', size: 1 })
    }, 1)

    await new Promise((r) => setTimeout(r, 10))
    await queue.drain()

    expect(rec.copies).toHaveLength(2)
  })

  it('两个不同来源要写同一个目标时，报出冲突而不是静默丢掉', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 2 })

    // 两个素材包里各有一个 /Game/Chars/SK_Hero，算出来的目标路径一模一样
    queue.enqueue({ source: 'PackA/SK.uasset', target: 'T/SK.uasset', assetKey: 'a', size: 1 })
    queue.enqueue({ source: 'PackB/SK.uasset', target: 'T/SK.uasset', assetKey: 'b', size: 1 })
    await queue.drain()

    expect(rec.copies).toEqual(['PackA/SK.uasset=>T/SK.uasset'])
    const conflicts = queue.getConflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].keptSource).toBe('PackA/SK.uasset')
    expect(conflicts[0].rejectedSource).toBe('PackB/SK.uasset')
  })

  it('认领过的目标不许被第二个来源覆盖 —— 警告说保留 A，文件里就得是 A', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 2 })

    // A 先认领，但因为「目标已经在了」没有入队（调用方跳过了拷贝）
    expect(queue.claimTarget('PackA/SK.uasset', 'T/SK.uasset')).toBe(true)

    // B 后来要写同一个位置：认领不到，也不许入队
    expect(queue.claimTarget('PackB/SK.uasset', 'T/SK.uasset')).toBe(false)
    expect(
      queue.enqueue({ source: 'PackB/SK.uasset', target: 'T/SK.uasset', assetKey: 'b', size: 9 })
    ).toBe(false)
    await queue.drain()

    expect(rec.copies).toEqual([])
    expect(queue.getConflicts()[0].keptSource).toBe('PackA/SK.uasset')
  })

  it('只有大小写不同的目标算同一个文件（Windows / macOS）', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({
      fs: rec.fs,
      concurrency: 2,
      caseInsensitiveTargets: true
    })

    // Chars/Shared.uasset 和 chars/shared.uasset 在 Windows 上是同一个文件
    expect(queue.claimTarget('PackA/S.uasset', 'T/Chars/Shared.uasset')).toBe(true)
    expect(queue.claimTarget('PackB/S.uasset', 'T/chars/shared.uasset')).toBe(false)
    expect(
      queue.enqueue({
        source: 'PackB/S.uasset',
        target: 'T/chars/shared.uasset',
        assetKey: 'b',
        size: 1
      })
    ).toBe(false)
    await queue.drain()

    expect(rec.copies).toEqual([])
    expect(queue.getConflicts()).toHaveLength(1)
  })

  it('区分大小写的文件系统上，大小写不同就是两个文件', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({
      fs: rec.fs,
      concurrency: 2,
      caseInsensitiveTargets: false
    })

    expect(queue.claimTarget('PackA/S.uasset', 'T/Chars/Shared.uasset')).toBe(true)
    expect(queue.claimTarget('PackB/S.uasset', 'T/chars/shared.uasset')).toBe(true)
    expect(queue.getConflicts()).toEqual([])
  })

  it('反斜杠和正斜杠写法也算同一个目标', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({
      fs: rec.fs,
      concurrency: 2,
      caseInsensitiveTargets: true
    })

    expect(queue.claimTarget('PackA/S.uasset', String.raw`T\Chars\Shared.uasset`)).toBe(true)
    expect(queue.claimTarget('PackB/S.uasset', 'T/Chars/Shared.uasset')).toBe(false)
  })

  it('认领者自己后续入队不受影响', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 2 })

    expect(queue.claimTarget('PackA/SK.uasset', 'T/SK.uasset')).toBe(true)
    expect(
      queue.enqueue({ source: 'PackA/SK.uasset', target: 'T/SK.uasset', assetKey: 'a', size: 1 })
    ).toBe(true)
    await queue.drain()

    expect(rec.copies).toEqual(['PackA/SK.uasset=>T/SK.uasset'])
    expect(queue.getConflicts()).toEqual([])
  })

  it('同一个来源重复入队只是去重，不算冲突', async () => {
    const rec = makeFs()
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 2 })

    queue.enqueue({ source: 'PackA/SK.uasset', target: 'T/SK.uasset', assetKey: 'a', size: 1 })
    queue.enqueue({ source: 'PackA/SK.uasset', target: 'T/SK.uasset', assetKey: 'b', size: 1 })
    await queue.drain()

    expect(queue.getConflicts()).toEqual([])
  })

  it('worker 正好收尾时入队的活不会被漏掉', async () => {
    const rec = makeFs()
    // 并发 1 最容易撞上「worker 已退出循环、但还没从 workers 里摘掉」那个缝
    const queue = new PackageCopyQueue({ fs: rec.fs, concurrency: 1 })

    queue.enqueue({ source: 's0', target: 't0', assetKey: '', size: 1 })
    // 让第一个 worker 跑起来并把队列吃空，再在它收尾的窗口里补一个
    await Promise.resolve()
    await Promise.resolve()
    queue.enqueue({ source: 's1', target: 't1', assetKey: '', size: 1 })

    await queue.drain()

    expect(rec.copies.sort()).toEqual(['s0=>t0', 's1=>t1'])
    expect(queue.stats.copied).toBe(2)
  })
})
