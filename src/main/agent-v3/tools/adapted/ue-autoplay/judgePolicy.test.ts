import { describe, expect, it, vi } from 'vitest'

import { createJudgePolicy, type AskJudge } from './judgePolicy'
import { isDeniedButton } from './policy'
import type { DecisionPoint } from './types'

function menu(labels: string[]): DecisionPoint {
  return {
    kind: 'ui',
    state: { mode: 'goal', tried: [] },
    options: labels.map((label) => ({
      id: `W/${label}`,
      label,
      features: { enabled: true, denied: isDeniedButton(label) }
    }))
  }
}

function answering(choice: string, confidence: number): AskJudge {
  return vi.fn<AskJudge>(async () => ({
    answers: {
      pick: { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence }
    }
  }))
}

describe('createJudgePolicy', () => {
  it('危险按钮根本不进选项表 —— 判定器只能在安全集合里挑', async () => {
    const ask = answering('W/出发', 0.9)
    await createJudgePolicy({ ask }).choose(menu(['出发', '删除存档', '商店']))
    const criteria = vi.mocked(ask).mock.calls[0][1].pick.criteria
    expect(Object.keys(criteria)).toEqual(['W/出发', 'W/商店', '__none__'])
  })

  it('笃定时采纳：规则关键词表里没有的「出发」也选得出来', async () => {
    const choice = await createJudgePolicy({ ask: answering('W/出发', 0.89) }).choose(
      menu(['出发', '图鉴', '商店'])
    )
    expect(choice.optionId).toBe('W/出发')
  })

  it('不够笃定就回落到规则，而不是照单全收', async () => {
    const choice = await createJudgePolicy({ ask: answering('W/取消', 0.37) }).choose(
      menu(['确定', '取消'])
    )
    expect(choice.optionId).toBe('W/确定')
    expect(choice.reason).toMatch(/不够笃定/)
  })

  it('判定器失败（null）回落到规则', async () => {
    const choice = await createJudgePolicy({ ask: async () => null }).choose(
      menu(['开始游戏', '设置'])
    )
    expect(choice.optionId).toBe('W/开始游戏')
  })

  it('判定器说「一个都不该点」就不点', async () => {
    const choice = await createJudgePolicy({ ask: answering('__none__', 0.99) }).choose(
      menu(['画面', '音频'])
    )
    expect(choice.optionId).toBeNull()
  })

  it('回了表外的选项（比如被拦下的那个）不照做', async () => {
    const choice = await createJudgePolicy({ ask: answering('W/删除存档', 0.95) }).choose(
      menu(['删除存档', '开始游戏', '设置'])
    )
    expect(choice.optionId).toBe('W/开始游戏')
  })

  it('默认只管按钮：路点和脱困不花调用，直接走规则', async () => {
    const ask = answering('p0', 0.99)
    const policy = createJudgePolicy({ ask })
    const choice = await policy.choose({
      kind: 'waypoint',
      state: { mode: 'explore' },
      options: [
        { id: 'p0', label: 'a', features: { novelty: 10 } },
        { id: 'p1', label: 'b', features: { novelty: 900 } }
      ]
    })
    expect(ask).not.toHaveBeenCalled()
    expect(choice.optionId).toBe('p1')
  })
})
