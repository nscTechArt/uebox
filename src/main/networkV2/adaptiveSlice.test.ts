import { describe, expect, it } from 'vitest'
import { AdaptiveSliceSizer } from './adaptiveSlice'

describe('AdaptiveSliceSizer', () => {
  it('上一片超时就按比例缩小，把写 + 提交压回目标时长', () => {
    const sizer = new AdaptiveSliceSizer(40, 10, 2000, 200)
    sizer.record(200, 200) // 200 行花了 200 ms
    expect(sizer.size).toBe(40)
  })

  it('上一片很快就放大，但一次最多翻一倍', () => {
    const sizer = new AdaptiveSliceSizer(40, 10, 2000, 100)
    sizer.record(100, 1)
    expect(sizer.size).toBe(200)
  })

  it('不低于下限、不高于上限', () => {
    const slow = new AdaptiveSliceSizer(40, 10, 2000, 100)
    slow.record(100, 100_000)
    expect(slow.size).toBe(10)
    const fast = new AdaptiveSliceSizer(40, 10, 300, 200)
    fast.record(200, 1)
    expect(fast.size).toBe(300)
  })

  it('没写行或者没耗时的记录不算', () => {
    const sizer = new AdaptiveSliceSizer(40, 10, 2000, 200)
    sizer.record(0, 50)
    sizer.record(10, 0)
    expect(sizer.size).toBe(200)
  })
})
