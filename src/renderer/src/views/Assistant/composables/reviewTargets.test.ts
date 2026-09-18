import { describe, expect, it } from 'vitest'

import type { ChangeGroup } from './changeSummary'
import { reviewTargetsFrom } from './reviewTargets'

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
