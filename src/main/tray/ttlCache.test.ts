/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import { createTtlCache } from './ttlCache'

/**
 * 缓存要守住的几条：TTL 内不重复加载、TTL 外重新加载、
 * 失败的调用不缓存（下次重试）、invalidate 让已知变更不等 TTL
 * 且在途的那趟不许把旧世界写回来。并发共用一趟加载是顺手给的保证。
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createTtlCache', () => {
  it('TTL 内第二次调用不重跑 loader', async () => {
    let now = 1000
    const cache = createTtlCache<string>({ ttlMs: 10_000, now: () => now })
    const loader = vi.fn(async () => 'v')

    expect(await cache.get(loader)).toBe('v')
    now += 5_000
    expect(await cache.get(loader)).toBe('v')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('过了 TTL 重新加载', async () => {
    let now = 1000
    const cache = createTtlCache<number>({ ttlMs: 10_000, now: () => now })
    let n = 0
    const loader = vi.fn(async () => ++n)

    expect(await cache.get(loader)).toBe(1)
    now += 10_001
    expect(await cache.get(loader)).toBe(2)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('loader 抛错不缓存，下次重试', async () => {
    const cache = createTtlCache<string>({ ttlMs: 10_000 })
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValue('ok')

    await expect(cache.get(loader)).rejects.toThrow('disk gone')
    expect(await cache.get(loader)).toBe('ok')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('并发调用共用同一趟加载', async () => {
    const cache = createTtlCache<string>({ ttlMs: 10_000 })
    const loader = vi.fn(async () => 'v')

    const [a, b] = await Promise.all([cache.get(loader), cache.get(loader)])
    expect(a).toBe('v')
    expect(b).toBe('v')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('invalidate 后 TTL 内也重新加载', async () => {
    const now = 1000
    const cache = createTtlCache<number>({ ttlMs: 10_000, now: () => now })
    let n = 0
    const loader = vi.fn(async () => ++n)

    expect(await cache.get(loader)).toBe(1)
    cache.invalidate()
    expect(await cache.get(loader)).toBe(2)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('invalidate 时在途的那趟落地不写回，也不清掉新一代的在途加载', async () => {
    const cache = createTtlCache<string>({ ttlMs: 10_000 })
    const first = deferred<string>()
    const second = deferred<string>()
    const loaders = [vi.fn(() => first.promise), vi.fn(() => second.promise)]

    const staleResult = cache.get(loaders[0])
    cache.invalidate()
    const freshResult = cache.get(loaders[1])

    first.resolve('stale')
    expect(await staleResult).toBe('stale')
    const third = vi.fn(async () => 'third')
    const during = cache.get(third)
    expect(third).not.toHaveBeenCalled()

    second.resolve('fresh')
    expect(await freshResult).toBe('fresh')
    expect(await during).toBe('fresh')
    expect(await cache.get(third)).toBe('fresh')
    expect(third).not.toHaveBeenCalled()
  })
})
