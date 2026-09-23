import { describe, expect, it } from 'vitest'

import { isDeniedButton, PROGRESS_BUTTON_PATTERN, rulePolicy } from './policy'
import type { DecisionPoint } from './types'

function uiPoint(
  labels: string[],
  mode: 'explore' | 'goal' = 'explore',
  tried: string[] = []
): DecisionPoint {
  return {
    kind: 'ui',
    state: { mode, tried },
    options: labels.map((label, index) => ({
      id: `b${index}`,
      label,
      features: { enabled: true, denied: isDeniedButton(label) }
    }))
  }
}

describe('按钮拦截名单', () => {
  it.each([
    '删除存档',
    '重置进度',
    '退出游戏',
    '购买',
    'Delete Save',
    'Quit',
    'Buy Now',
    'Log out',
    'Reset'
  ])('拦：%s', (text) => expect(isDeniedButton(text)).toBe(true))

  // 英文词必须按整词匹配：不然 Replay 里的 pay、Display 里的 play 会误伤
  it.each(['Replay', 'Display', 'Clearance', 'Start Game', '开始游戏', 'Settings'])(
    '不拦：%s',
    (text) => expect(isDeniedButton(text)).toBe(false)
  )

  it('「推进」按词边界匹配，Display 不算 play', () => {
    expect(PROGRESS_BUTTON_PATTERN.test('Display')).toBe(false)
    expect(PROGRESS_BUTTON_PATTERN.test('Play')).toBe(true)
    expect(PROGRESS_BUTTON_PATTERN.test('继续游戏')).toBe(true)
  })
})

describe('rulePolicy —— ui', () => {
  it('优先点像「开始」的，拦截名单里的一律不点', () => {
    const choice = rulePolicy.choose(uiPoint(['删除存档', '设置', '开始游戏']))
    expect(choice).toMatchObject({ optionId: 'b2' })
  })

  it('探索模式没有「开始」就挨个点没点过的', () => {
    expect(rulePolicy.choose(uiPoint(['设置', '图鉴'], 'explore', ['b0']))).toMatchObject({
      optionId: 'b1'
    })
  })

  it('目标模式没有「开始」不乱点', () => {
    expect(rulePolicy.choose(uiPoint(['设置', '图鉴'], 'goal'))).toMatchObject({ optionId: null })
  })

  it('全是危险按钮：一个都不选，并说出是哪几个', () => {
    const choice = rulePolicy.choose(uiPoint(['退出', '删除存档']))
    expect(choice.optionId).toBeNull()
    expect(choice.reason).toMatch(/删除存档/)
  })
})

describe('rulePolicy —— waypoint / unstick', () => {
  it('去新鲜度最高的点，并列时取更近的', () => {
    const choice = rulePolicy.choose({
      kind: 'waypoint',
      state: { mode: 'explore' },
      options: [
        { id: 'p0', label: 'a', features: { novelty: 500, distance: 900 } },
        { id: 'p1', label: 'b', features: { novelty: 1200, distance: 2000 } },
        { id: 'p2', label: 'c', features: { novelty: 1200, distance: 1500 } }
      ]
    })
    expect(choice.optionId).toBe('p2')
  })

  it('脱困按固定顺序，没有跳跃就跳过「跳一下」，都试过就放弃', () => {
    const point = (tried: string[], canJump: boolean): DecisionPoint => ({
      kind: 'unstick',
      state: { mode: 'goal' },
      options: ['jump_forward', 'strafe_left', 'strafe_right', 'back_off', 'replan'].map((id) => ({
        id,
        label: id,
        features: { tried: tried.includes(id), available: id === 'jump_forward' ? canJump : true }
      }))
    })
    expect(rulePolicy.choose(point([], true)).optionId).toBe('jump_forward')
    expect(rulePolicy.choose(point([], false)).optionId).toBe('strafe_left')
    expect(
      rulePolicy.choose(
        point(['jump_forward', 'strafe_left', 'strafe_right', 'back_off', 'replan'], true)
      ).optionId
    ).toBeNull()
  })
})
