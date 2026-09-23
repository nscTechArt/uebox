import { describe, expect, it } from 'vitest'

import type { AutoplayResult } from './runner'
import { summarizeAutoplay } from './summary'

function baseResult(overrides: Partial<AutoplayResult> = {}): AutoplayResult {
  return {
    outcome: 'explored',
    outcomeNote: '探索到时间用完',
    steps: 40,
    decisions: 5,
    move: { kind: 'action', name: 'IA_Move', axis: 'y', offset: 0 },
    calibrationNotes: [],
    cellsVisited: 12,
    distanceTravelled: 4800,
    findings: [],
    sweep: [],
    uiClicks: [],
    uiDenied: [],
    inputWarnings: [],
    logsDropped: false,
    ...overrides
  }
}

describe('summarizeAutoplay', () => {
  it('探索跑完没发现问题：也必须说「只能说明没崩」，并点明动作层绕开了键位', () => {
    const text = summarizeAutoplay(baseResult(), null)
    expect(text).toMatch(/只能说明这段时间里没崩/)
    expect(text).toMatch(/绕开了键位映射/)
  })

  it('错误排在卡住前面，并带上出事前的最后一个动作', () => {
    const text = summarizeAutoplay(
      baseResult({
        findings: [
          { kind: 'stuck', at: { x: 1, y: 2, z: 3 }, detail: '原地不动' },
          { kind: 'error_after_action', t: 3.2, after: '按动作 IA_Fire', detail: 'Accessed None' }
        ]
      }),
      null
    )
    expect(text.indexOf('运行时错误')).toBeLessThan(text.indexOf('卡住'))
    expect(text).toMatch(/上一步：按动作 IA_Fire/)
  })

  it('没观察到效果的输入单独列出，并说明不等于坏了', () => {
    const text = summarizeAutoplay(
      baseResult({
        sweep: [{ action: 'IA_Emote', value_type: 'Boolean', effects: [], errors: [] }]
      }),
      null
    )
    expect(text).toMatch(/没观察到效果：IA_Emote/)
    expect(text).toMatch(/不等于坏了/)
  })

  it('点过按钮就要说没走命中测试，拦下的按钮要列出来', () => {
    const text = summarizeAutoplay(
      baseResult({
        uiClicks: [{ id: 'a', text: '开始游戏', reason: 'r' }],
        uiDenied: ['删除存档']
      }),
      null
    )
    expect(text).toMatch(/没走屏幕命中测试/)
    expect(text).toMatch(/「删除存档」/)
  })

  it('目标达成时不说「只能说明没崩」，并带上 trace 路径', () => {
    const text = summarizeAutoplay(
      baseResult({
        outcome: 'goal_reached',
        outcomeNote: '目标达成',
        goal: { reached: true, reachedTarget: true, targetLabel: 'BP_Door', logSeen: true }
      }),
      { ok: true, elapsed_seconds: 7.5, error_count: 0, print_strings: ['DoorOpened'] },
      'C:/trace.jsonl'
    )
    expect(text).toMatch(/^✅ 目标达成/)
    expect(text).toMatch(/走到了「BP_Door」/)
    expect(text).not.toMatch(/只能说明/)
    expect(text).toMatch(/决策记录：C:\/trace\.jsonl/)
  })
})
