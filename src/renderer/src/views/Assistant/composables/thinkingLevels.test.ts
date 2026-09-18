import { describe, expect, it } from 'vitest'
import {
  THINKING_LADDER,
  buildThinkingOptions,
  resolveEffectiveLevel,
  thinkingDisplayLabel,
  type ModelThinkingSupport
} from './thinkingLevels'

/**
 * 档位是各家模型自己声明的，不是我们定的。这组测试守的就是「界面只列当前
 * 模型真有的档位」和「列不出来的那档要说清楚实际用了哪档」——
 * 两件事任何一件错了，用户看到的都是「这个开关时灵时不灵」。
 */

const describeLevel = (level: AgentV3ThinkingLevel): string => `${level}-说明`

function support(
  levels: AgentV3ThinkingLevel[],
  levelMap: Record<string, string | null> = {}
): ModelThinkingSupport {
  return { levels, levelMap, modelId: 'm1' }
}

describe('buildThinkingOptions', () => {
  it('只列当前模型支持的档位', () => {
    // 真实案例：这个模型的梯子里没有 minimal / low / medium
    const options = buildThinkingOptions(support(['off', 'high', 'max']), describeLevel)

    expect(options.map((opt) => opt.value)).toEqual(['auto', 'off', 'high', 'max'])
  })

  it('另一个模型是另一套档位', () => {
    const options = buildThinkingOptions(
      support(['off', 'minimal', 'low', 'medium', 'high']),
      describeLevel
    )

    expect(options.map((opt) => opt.value)).toEqual([
      'auto',
      'off',
      'minimal',
      'low',
      'medium',
      'high'
    ])
  })

  /** auto 是「不指定」，与模型支持哪些档位无关，任何时候都得在 */
  it('auto 永远在最前，哪怕模型一档都不支持', () => {
    const options = buildThinkingOptions(support([]), describeLevel)

    expect(options.map((opt) => opt.value)).toEqual(['auto'])
  })

  /** 空下拉比列多了更难理解 —— 用户会以为功能坏了 */
  it('还没问到清单时列全集', () => {
    const options = buildThinkingOptions(null, describeLevel)

    expect(options.map((opt) => opt.value)).toEqual([...THINKING_LADDER])
  })

  /**
   * 档位名**不做本地化包装**：显示的就是模型声明的那个词。
   * 之前那版把它翻成「快速思考」「深度思考」，结果是用户在厂商文档里
   * 看到的 xhigh 在界面上找不着。
   */
  it('档位名就是档位原名，不翻译', () => {
    const options = buildThinkingOptions(support(['off', 'high', 'max']), describeLevel)

    expect(options.map((opt) => opt.label)).toEqual(['auto', 'off', 'high', 'max'])
    expect(options.map((opt) => opt.desc)).toEqual([
      'auto-说明',
      'off-说明',
      'high-说明',
      'max-说明'
    ])
  })

  it('厂商给档位起了别名就显示别名，原名放进 original', () => {
    const options = buildThinkingOptions(support(['high'], { high: 'think-harder' }), describeLevel)
    const high = options.find((opt) => opt.value === 'high')!

    expect(high.label).toBe('think-harder')
    expect(high.original).toBe('high')
  })

  it('别名与原名一样时不显示两遍', () => {
    const options = buildThinkingOptions(support(['high'], { high: 'high' }), describeLevel)
    const high = options.find((opt) => opt.value === 'high')!

    expect(high.label).toBe('high')
    expect(high.original).toBeUndefined()
  })
})

describe('thinkingDisplayLabel', () => {
  it('触发器上显示档位原名', () => {
    expect(thinkingDisplayLabel('high', support(['high']))).toBe('high')
    expect(thinkingDisplayLabel('auto', support(['high']))).toBe('auto')
  })

  it('厂商有别名就显示别名', () => {
    expect(thinkingDisplayLabel('high', support(['high'], { high: 'think-harder' }))).toBe(
      'think-harder'
    )
  })

  // levelMap 里写 null 表示这一档不可用，不能把 null 当成显示名
  it('别名为空时回落到原名', () => {
    expect(thinkingDisplayLabel('high', support(['high'], { high: null }))).toBe('high')
  })
})

describe('resolveEffectiveLevel', () => {
  it('模型支持就原样用', () => {
    expect(resolveEffectiveLevel('high', support(['off', 'high', 'max']))).toBe('high')
  })

  /**
   * 与内核的 clampThinkingLevel 同一套规则：先往上找更强的。
   * 用户存的是「我要更用力想」，夹到更弱的一档等于把意图反过来了。
   */
  it('不支持时优先往上夹到更强的一档', () => {
    expect(resolveEffectiveLevel('medium', support(['off', 'high', 'max']))).toBe('high')
  })

  it('上面没有了才往下夹', () => {
    expect(resolveEffectiveLevel('max', support(['off', 'low']))).toBe('low')
  })

  it('auto 不受影响 —— 它本来就是「不指定」', () => {
    expect(resolveEffectiveLevel('auto', support(['high']))).toBe('auto')
  })

  it('一档都不支持时退回 auto', () => {
    expect(resolveEffectiveLevel('high', support([]))).toBe('auto')
  })

  /**
   * 换模型**不改用户存的值**：他选的是意图，换个模型意图不变。
   * 这里只是算「这次实际用哪档」，换回去还是原来那档。
   */
  it('清单还没到时按用户选的算，不提前夹', () => {
    expect(resolveEffectiveLevel('max', null)).toBe('max')
  })
})
