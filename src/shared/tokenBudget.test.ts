import { describe, expect, it } from 'vitest'
import {
  clampOutputTokens,
  DEFAULT_CONTEXT_WINDOW,
  estimateTokens,
  FALLBACK_MODEL_LIMITS,
  inputTokenBudget
} from './tokenBudget'

describe('estimateTokens', () => {
  it('中文一个字大约一个 token', () => {
    expect(estimateTokens('一二三四五')).toBe(5)
  })

  it('英文按三四个字符一个 token —— 这正是上一版按字符数算错得最离谱的地方', () => {
    // 40 个 ASCII 字符 ≈ 12 个 token，而按「字符数」算会当成 40
    const latin = 'a'.repeat(40)
    expect(estimateTokens(latin)).toBeLessThan(20)
    expect(estimateTokens(latin)).toBeGreaterThan(8)
  })

  it('中英混排两边都算上', () => {
    const mixed = '虚幻引擎' + 'Nanite'.repeat(10)
    // 4 个汉字 + 60 个 ASCII ≈ 4 + 18
    expect(estimateTokens(mixed)).toBeGreaterThan(18)
    expect(estimateTokens(mixed)).toBeLessThan(30)
  })

  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('同样长度的中文比英文占更多 token —— 预算必须按最坏情况留', () => {
    expect(estimateTokens('中'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)))
  })
})

describe('inputTokenBudget', () => {
  it('从窗口里扣掉输出和余量', () => {
    const budget = inputTokenBudget({ contextWindow: 100_000, maxOutputTokens: 8000 }, 8000)
    // 100000 - 8000(输出) - 10000(一成余量)
    expect(budget).toBe(82_000)
  })

  it('大窗口的模型就该能多送 —— 这是这次改造的全部意义', () => {
    const small = inputTokenBudget({ contextWindow: 8_000, maxOutputTokens: 4000 }, 4000)
    const large = inputTokenBudget({ contextWindow: 1_000_000, maxOutputTokens: 8000 }, 8000)
    expect(large).toBeGreaterThan(small * 50)
  })

  it('要写的比模型能写的还长时，按模型的上限扣', () => {
    const budget = inputTokenBudget({ contextWindow: 100_000, maxOutputTokens: 4000 }, 99_000)
    expect(budget).toBe(86_000)
  })

  it('窗口小到扣不出来时也给一个下限，不返回负数', () => {
    expect(inputTokenBudget({ contextWindow: 2000, maxOutputTokens: 4000 }, 4000)).toBe(1000)
  })
})

describe('clampOutputTokens', () => {
  it('超过模型上限就钳到上限 —— 上一版发过 max_tokens 60000，多数厂商直接 400', () => {
    expect(clampOutputTokens(60_000, { contextWindow: 128_000, maxOutputTokens: 8192 })).toBe(8192)
  })

  it('没超就原样', () => {
    expect(clampOutputTokens(1200, { contextWindow: 128_000, maxOutputTokens: 8192 })).toBe(1200)
  })

  it('至少要 1，不能是 0 或负数', () => {
    expect(clampOutputTokens(0, FALLBACK_MODEL_LIMITS)).toBe(1)
    expect(clampOutputTokens(-5, FALLBACK_MODEL_LIMITS)).toBe(1)
  })
})

describe('缺省值', () => {
  it('认不出模型时用同一份缺省值', () => {
    expect(FALLBACK_MODEL_LIMITS.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(FALLBACK_MODEL_LIMITS.maxOutputTokens).toBeGreaterThan(0)
  })

  /**
   * 手填的模型（自建端点、代理、目录里没有的新模型）走的就是这一档。
   * 钉住数值：改小回 128k 会让用户在界面上看到「x / 128000」，
   * 却查不出是谁限着 —— 这正是它被调大的原因。
   */
  it('缺省窗口 384k、单次输出 128k', () => {
    expect(FALLBACK_MODEL_LIMITS.contextWindow).toBe(384_000)
    expect(FALLBACK_MODEL_LIMITS.maxOutputTokens).toBe(128_000)
  })
})
