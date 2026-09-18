import { describe, expect, it } from 'vitest'

import { BLOCKED_ASSETS_LIST_LIMIT, summarizeBlockedAssets } from './blockedAssetsSummary'

const blocked = (count: number, version = '5.2'): Array<{ assetName: string; version: string }> =>
  Array.from({ length: count }, (_, index) => ({ assetName: `Asset_${index + 1}`, version }))

describe('版本冲突弹窗的点名上限', () => {
  it('几个就全列出来，不加尾巴', () => {
    expect(summarizeBlockedAssets(blocked(3))).toEqual({
      listed: 'Asset_1 (UE 5.2)、Asset_2 (UE 5.2)、Asset_3 (UE 5.2)',
      rest: 0
    })
  })

  it('刚好到上限也不加尾巴', () => {
    const summary = summarizeBlockedAssets(blocked(BLOCKED_ASSETS_LIST_LIMIT))
    expect(summary.rest).toBe(0)
    expect(summary.listed.split('、')).toHaveLength(BLOCKED_ASSETS_LIST_LIMIT)
  })

  it('104 项只点名前 5 个，剩下的只报个数 —— 全铺出来会把弹窗撑到满屏', () => {
    const summary = summarizeBlockedAssets(blocked(104))
    expect(summary.listed.split('、')).toHaveLength(BLOCKED_ASSETS_LIST_LIMIT)
    expect(summary.listed).not.toContain('Asset_6')
    expect(summary.rest).toBe(104 - BLOCKED_ASSETS_LIST_LIMIT)
  })

  it('一个都没有时是空串，不是「等 0 项」', () => {
    expect(summarizeBlockedAssets([])).toEqual({ listed: '', rest: 0 })
  })

  it('上限可以调小，负数按 0 处理', () => {
    expect(summarizeBlockedAssets(blocked(4), 2).rest).toBe(2)
    expect(summarizeBlockedAssets(blocked(4), -1)).toEqual({ listed: '', rest: 4 })
  })
})
