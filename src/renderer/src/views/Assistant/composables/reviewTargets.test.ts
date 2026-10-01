import { describe, expect, it } from 'vitest'

import type { ChangeGroup } from './changeSummary'
import { AUTO_REVIEW_MAX_TARGETS, reviewTargetsFrom, shouldAutoReview } from './reviewTargets'

function group(patch: Partial<ChangeGroup>): ChangeGroup {
  return {
    key: patch.target ?? 'k',
    target: '',
    local: false,
    action: 'modified',
    kind: '',
    stepCount: 1,
    failedCount: 0,
    irreversibleCount: 0,
    steps: [],
    ...patch
  }
}

describe('reviewTargetsFrom', () => {
  it('引擎里的资产带着动作和类别送去审查', () => {
    const targets = reviewTargetsFrom([
      group({ target: '/Game/A/M_Wood', action: 'created', kind: 'material' })
    ])

    expect(targets).toEqual([{ path: '/Game/A/M_Wood', action: 'created', kind: 'material' }])
  })

  it('硬盘上的文件不送 —— 引擎答不上来，只会换回一条假的「资产不存在」', () => {
    expect(
      reviewTargetsFrom([group({ target: 'D:/proj/说明.html', local: true, kind: 'file' })])
    ).toEqual([])
  })

  it('Actor 名和取不到目标的万能调用都不送', () => {
    expect(
      reviewTargetsFrom([
        group({ target: 'Cube', kind: 'actor' }),
        group({ target: '', key: 'ue_run_python_script' })
      ])
    ).toEqual([])
  })

  it('失败的步骤照送 —— 该不该报警由引擎的实际状态说了算', () => {
    const targets = reviewTargetsFrom([
      group({ target: '/Game/A/BP_X', action: 'created', kind: 'blueprint', failedCount: 3 })
    ])

    expect(targets).toHaveLength(1)
  })
})

describe('shouldAutoReview', () => {
  const targets = (count: number): ReturnType<typeof reviewTargetsFrom> =>
    Array.from({ length: count }, (_, i) => ({
      path: `/Game/A/M_${i}`,
      action: 'modified' as const
    }))

  it('没改引擎资产就不跑 —— 引擎那边一个问题都答不上来', () => {
    expect(shouldAutoReview([])).toBe(false)
  })

  it('改动不多时自动跑', () => {
    expect(shouldAutoReview(targets(1))).toBe(true)
    expect(shouldAutoReview(targets(AUTO_REVIEW_MAX_TARGETS))).toBe(true)
  })

  it('超过上限留给用户点 —— 每个资产都要在游戏线程上 load 一遍', () => {
    expect(shouldAutoReview(targets(AUTO_REVIEW_MAX_TARGETS + 1))).toBe(false)
  })
})
