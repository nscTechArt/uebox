import { describe, expect, it } from 'vitest'
import { summarizeToolSearchUsage } from './tool-search-usage.mjs'

describe('工具搜索测试用量口径', () => {
  it('累计输入只加未缓存 input；缓存量与两种命中率各自独立', () => {
    const result = summarizeToolSearchUsage([
      { input: 100, output: 10, cacheRead: 0, cacheWrite: 20 },
      { input: 50, output: 15, cacheRead: 200, cacheWrite: 0 }
    ])
    expect(result.tokens).toEqual({ input: 150, output: 25, cacheRead: 200, cacheWrite: 20 })
    expect(result.cache).toEqual({
      measuredResponses: 2,
      hitResponses: 1,
      missResponses: 1,
      unmeasuredResponses: 0,
      responseHitRate: 0.5,
      readTokenShare: 200 / 370
    })
    expect(result.perResponse.map((turn) => turn.cacheHit)).toEqual([false, true])
  })

  it('中止产生的全零记录和缺失读数不假算成未命中，也不把未知量默认为零', () => {
    const result = summarizeToolSearchUsage([
      { input: 10, output: 1, cacheRead: 20, cacheWrite: 0 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      { input: 5, output: 1 }
    ])
    expect(result.tokens).toEqual({ input: 15, output: 2, cacheRead: null, cacheWrite: null })
    expect(result.cache).toMatchObject({
      measuredResponses: 1,
      hitResponses: 1,
      unmeasuredResponses: 2,
      responseHitRate: 1,
      readTokenShare: null
    })
    expect(summarizeToolSearchUsage().cache.responseHitRate).toBeNull()
  })
})
