import { describe, expect, it } from 'vitest'

import { formatExactTokenCount, formatTokenCount, formatUsageCost } from './tokenUsageFormat'

describe('formatTokenCount', () => {
  it('1000 以下原样显示 —— 「856 tokens」比「0.9k」有用', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(856)).toBe('856')
  })

  it('上万之后省掉小数位，百万写成 M', () => {
    expect(formatTokenCount(1234)).toBe('1.2k')
    expect(formatTokenCount(13_600)).toBe('14k')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
  })

  it('负数和非数字兜底成 0，不把 NaN 漏到界面上', () => {
    expect(formatTokenCount(Number.NaN)).toBe('0')
    expect(formatTokenCount(-5)).toBe('0')
  })
})

describe('formatExactTokenCount', () => {
  it('悬浮明细要能对账，用千分位完整数字', () => {
    expect(formatExactTokenCount(13_600)).toBe('13,600')
    expect(formatExactTokenCount(0)).toBe('0')
  })
})

describe('formatUsageCost', () => {
  // 厂商没给价的模型（本地模型、自带 key 的第三方）cost 恒为 0，
  // 显示「$0.00」会让人以为真花了钱又被抹零，不如整段不显示
  it('没有费用时返回空串', () => {
    expect(formatUsageCost(0)).toBe('')
    expect(formatUsageCost(Number.NaN)).toBe('')
  })

  it('几厘钱也要显示出来，小到四位小数不够就写 <$0.0001', () => {
    expect(formatUsageCost(0.0031)).toBe('$0.0031')
    expect(formatUsageCost(0.00002)).toBe('<$0.0001')
  })

  it('超过一美元时两位小数就够了', () => {
    expect(formatUsageCost(1.2345)).toBe('$1.23')
  })
})
