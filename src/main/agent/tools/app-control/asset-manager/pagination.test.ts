import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchAssetsByCriteria = vi.fn()
const countAssetsByCriteria = vi.fn()

vi.mock('../../../../sqliteDataBase/models/assetSearch', () => ({
  searchAssetsByCriteria: (...args: unknown[]) => searchAssetsByCriteria(...args),
  countAssetsByCriteria: (...args: unknown[]) => countAssetsByCriteria(...args)
}))

// 索引那一路在这里不参与：这个文件测的是分页算术，不是召回。
// 走 LIKE 分支（indexReady: true 但没有 ftsMatch）就够了。
vi.mock('../../../../sqliteDataBase/models/assetSearchIndex', () => ({
  resolveKeywordCriteria: (_db: unknown, query?: string) =>
    query && query !== '*' ? { keyword: query, indexReady: true } : { indexReady: true }
}))
vi.mock('../../../../sqliteDataBase/services/assetSearchIndexService', () => ({
  ensureAssetSearchIndexWarm: () => {}
}))
vi.mock('../../../../sqliteDataBase/services/assetSemanticService', () => ({
  semanticRecall: async () => []
}))

vi.mock('../../../../sqliteDataBase', () => ({
  getPublicDatabase: () => ({ prepare: () => ({ all: () => [] }) }),
  getVaultDatabase: () => ({})
}))

import { searchAssets } from './AssetSearcher'

/** 造 n 个够用的假资产行 */
function rows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    assetName: `SM_Thing_${i}`,
    assetType: 'StaticMesh',
    assetKey: `key-${i}`,
    folderKey: 'folder-1'
  }))
}

/**
 * 总数走 COUNT(*)，取页走 SELECT —— 两个不同的函数。
 *
 * 原来总数是「把 limit 去掉再 SELECT 一遍然后数数组长度」，于是这里要按
 * 调用顺序喂两次返回值。几十万条的库上那种数法会把整张表读进内存，
 * 已经换成 countAssetsByCriteria。
 */
function stubSearch(total: number, pageSize: number): void {
  searchAssetsByCriteria.mockReset()
  countAssetsByCriteria.mockReset()
  countAssetsByCriteria.mockReturnValue(total)
  searchAssetsByCriteria.mockReturnValue(rows(pageSize))
}

/** 取「这一页」那次调用传进去的 criteria */
function pageCriteria(): Record<string, unknown> {
  return searchAssetsByCriteria.mock.calls[0][1] as Record<string, unknown>
}

/**
 * 素材库搜索的分页。
 *
 * 原来这里写死 `limit: 50` 且**不对外暴露**，外面再套一层「压到 4096 token」
 * 的裁剪 —— 那是 Router 时代的口径。后果不是省了 token，是调用方拿到
 * 「还有 N 个没给你」之后无路可走：没有翻页参数，只能换个更窄的关键词重搜，
 * 赌下一次的前 50 个里有它要的。库里超过 50 个资产，「我素材库里有什么」
 * 就永远答不全。
 */
describe('searchAssets 的分页', () => {
  beforeEach(() => {
    searchAssetsByCriteria.mockReset()
    countAssetsByCriteria.mockReset()
  })

  it('缺省取 100 个，从头开始', async () => {
    stubSearch(20, 20)
    await searchAssets({ query: 'chair' })

    expect(pageCriteria().limit).toBe(100)
    expect(pageCriteria().offset).toBe(0)
  })

  it('limit / offset 透传到查询', async () => {
    stubSearch(500, 25)
    await searchAssets({ query: 'chair', limit: 25, offset: 75 })

    expect(pageCriteria().limit).toBe(25)
    expect(pageCriteria().offset).toBe(75)
  })

  it('limit 夹在 1..500，胡填不会把整个库拖出来', async () => {
    stubSearch(10, 10)
    await searchAssets({ query: 'x', limit: 999999 })
    expect(pageCriteria().limit).toBe(500)

    stubSearch(10, 10)
    await searchAssets({ query: 'x', limit: 0 })
    expect(pageCriteria().limit).toBe(100)

    stubSearch(10, 10)
    await searchAssets({ query: 'x', limit: -5 })
    expect(pageCriteria().limit).toBe(100)
  })

  /**
   * 关键的一条：后面还有东西时，返回里必须**带上怎么拿**。
   * 原来这里只说「请使用更精确的搜索条件」，那句话没法照着做。
   */
  it('还有下一页时给出 nextOffset', async () => {
    stubSearch(230, 100)
    const result = await searchAssets({})

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.count).toBe(230) // 总数
    expect(result.returnedCount).toBe(100) // 这一页
    expect(result.hasMore).toBe(true)
    expect(result.nextOffset).toBe(100)
    expect(result.message).toContain('offset=100')
  })

  it('翻到最后一页时不再说还有', async () => {
    stubSearch(230, 30)
    const result = await searchAssets({ offset: 200 })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.hasMore).toBeUndefined()
    expect(result.nextOffset).toBeUndefined()
  })

  it('一页装得下时既不标 hasMore 也不催换关键词', async () => {
    stubSearch(8, 8)
    const result = await searchAssets({})

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.hasMore).toBeUndefined()
    expect(result.message ?? '').not.toContain('更精确')
  })

  /** 结果不再被按 token 裁一刀：给多少条由 limit 说了算 */
  it('一整页 100 条原样返回，不做 token 裁剪', async () => {
    stubSearch(100, 100)
    const result = await searchAssets({})

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.assets).toHaveLength(100)
    expect(result).not.toHaveProperty('compressed')
  })
})
