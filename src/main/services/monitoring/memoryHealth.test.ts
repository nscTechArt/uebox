import { describe, expect, it } from 'vitest'
import { evaluateMemory, isSteadilyGrowing, TREND_WINDOW } from './memoryHealth'

const ramp = (from: number, step: number, n = TREND_WINDOW): number[] =>
  Array.from({ length: n }, (_, i) => from + i * step)

describe('evaluateMemory', () => {
  it('400MB 平稳运行不报警（Agent 正常负载）', () => {
    const samples = Array(TREND_WINDOW).fill(407)
    expect(evaluateMemory(407, samples).status).toBe('healthy')
  })

  it('绝对阈值：800 以上偏高，1500 以上过高', () => {
    expect(evaluateMemory(900, []).status).toBe('degraded')
    expect(evaluateMemory(1600, []).status).toBe('unhealthy')
  })

  it('窗口内持续上涨且没回落，报偏高', () => {
    const samples = ramp(300, 20)
    const r = evaluateMemory(samples[samples.length - 1], samples)
    expect(r.status).toBe('degraded')
    expect(r.reason).toContain('持续上涨')
  })
})

describe('isSteadilyGrowing', () => {
  it('样本不满一个窗口不判定', () => {
    expect(isSteadilyGrowing(ramp(300, 50, TREND_WINDOW - 1))).toBe(false)
  })

  it('中间有一次明显回落（GC 回收）就不算', () => {
    const samples = ramp(300, 20)
    samples[5] = samples[4] - 50
    expect(isSteadilyGrowing(samples)).toBe(false)
  })

  it('小幅抖动不打断上涨', () => {
    const samples = ramp(300, 20)
    samples[5] = samples[4] - 5
    expect(isSteadilyGrowing(samples)).toBe(true)
  })

  it('一直涨但总涨幅太小不算', () => {
    expect(isSteadilyGrowing(ramp(300, 5))).toBe(false)
  })
})
