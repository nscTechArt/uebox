/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { formatPlan, planRetime, type PlanInput, type PlanSection } from './retimePlan'

const sec = (
  over: Partial<PlanSection> & Pick<PlanSection, 'id' | 'start' | 'end'>
): PlanSection => ({
  track: 'Track',
  kind: 'other',
  ...over
})

/**
 * 一条典型的三镜头母序列：
 *   shot A [0, 100)  shot B [100, 250)  shot C [250, 400)
 * 相机切轨与之一一对应。
 */
const master = (): PlanInput => ({
  playback: { start: 0, end: 400 },
  sections: [
    sec({ id: 'shotA', track: 'Shots', kind: 'shot', start: 0, end: 100 }),
    sec({ id: 'shotB', track: 'Shots', kind: 'shot', start: 100, end: 250 }),
    sec({ id: 'shotC', track: 'Shots', kind: 'shot', start: 250, end: 400 }),
    sec({ id: 'cutA', track: 'CameraCuts', kind: 'camera_cut', start: 0, end: 100 }),
    sec({ id: 'cutB', track: 'CameraCuts', kind: 'camera_cut', start: 100, end: 250 }),
    sec({ id: 'cutC', track: 'CameraCuts', kind: 'camera_cut', start: 250, end: 400 })
  ]
})

const after = (plan: ReturnType<typeof planRetime>, id: string): [number, number] | undefined => {
  const c = plan.changes.find((x) => x.id === id)
  return c ? [c.after.start, c.after.end] : undefined
}

describe('shift_after：插入 / 删除时间', () => {
  it('支点之后的段整体平移，之前的不动', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 250, delta: 60 })

    expect(after(plan, 'shotA')).toBeUndefined() // 完全在支点前，不动
    expect(after(plan, 'shotC')).toEqual([310, 460])
    expect(after(plan, 'cutC')).toEqual([310, 460])
  })

  it('相机切轨和 shot 一起动 —— 只动一边就是黑帧', () => {
    // 这是「不完整的工具等于负资产」的核心场景
    const plan = planRetime(master(), { type: 'shift_after', pivot: 100, delta: 30 })
    expect(after(plan, 'shotB')).toEqual(after(plan, 'cutB'))
    expect(after(plan, 'shotC')).toEqual(after(plan, 'cutC'))
  })

  it('支点落在段中间时只动末端，等于就地拉长', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 150, delta: 20 })
    expect(after(plan, 'shotB')).toEqual([100, 270])
    // 后面的整体平移
    expect(after(plan, 'shotC')).toEqual([270, 420])
  })

  it('平移之后段与段仍然首尾相接，不留空隙', () => {
    // 空隙就是黑帧。闭开区间下前一段的 end 就是后一段的 start
    const plan = planRetime(master(), { type: 'shift_after', pivot: 100, delta: 40 })
    const b = after(plan, 'cutB')!
    const c = after(plan, 'cutC')!
    expect(b[1]).toBe(c[0])
  })

  it('播放范围跟着变', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 0, delta: 50 })
    expect(plan.playback.after).toEqual({ start: 0, end: 450 })
  })

  it('删时间也走同一条路', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 250, delta: -50 })
    expect(after(plan, 'shotC')).toEqual([200, 350])
    expect(plan.playback.after.end).toBe(350)
  })

  it('删太多导致段长变成非正数时拦下来，不产出坏计划', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 150, delta: -200 })
    expect(plan.problems.length).toBeGreaterThan(0)
    expect(plan.problems[0]).toContain('非正数')
  })

  it('delta 为 0 时明确说没改动，而不是返回一个空计划让人以为成功了', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 100, delta: 0 })
    expect(plan.problems[0]).toContain('没有任何改动')
    expect(plan.changes).toEqual([])
  })
})

describe('set_duration：改一个镜头的时长，下游顺延', () => {
  it('目标段变长，后面的全部顺延', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 200,
      mode: 'extend'
    })

    expect(after(plan, 'shotB')).toEqual([100, 300])
    expect(after(plan, 'shotC')).toEqual([300, 450])
    expect(plan.playback.after.end).toBe(450)
  })

  // 回归：原来下游判据是 `s.start < target.end`，把与目标同跨度的平行段
  // （正是对应的 Camera Cuts）整个跳过 —— shot 拉长了、切轨没拉，中间就是黑帧。
  // 上一版测试只断言 shotB / shotC，正好漏掉这个洞。
  it('与目标同跨度的相机切轨要跟着拉长，否则就是黑帧', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 200,
      mode: 'extend'
    })

    expect(after(plan, 'cutB')).toEqual([100, 300])
    expect(after(plan, 'shotB')).toEqual([100, 300])
  })

  it('改完之后相机切轨仍然首尾相接，不留空隙', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 200,
      mode: 'extend'
    })
    const cuts = ['cutA', 'cutB', 'cutC'].map((id) => {
      const c = plan.changes.find((x) => x.id === id)
      const src = master().sections.find((s) => s.id === id)!
      return c ? [c.after.start, c.after.end] : [src.start, src.end]
    })
    expect(cuts[0][1]).toBe(cuts[1][0])
    expect(cuts[1][1]).toBe(cuts[2][0])
  })

  it('目标段之前的不受影响', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 200,
      mode: 'extend'
    })
    expect(after(plan, 'shotA')).toBeUndefined()
  })

  it('extend 模式不缩放关键帧 —— 速度感不变，多出的时间加在末尾', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 300,
      mode: 'extend'
    })
    expect(plan.changes.find((c) => c.id === 'shotB')?.keyScale).toBeUndefined()
  })

  it('scale 模式给出关键帧的伸缩比例 —— 同样的动作用更长时间演完', () => {
    // 150 帧 → 300 帧，关键帧要按 2× 拉开
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 300,
      mode: 'scale'
    })
    expect(plan.changes.find((c) => c.id === 'shotB')?.keyScale).toBeCloseTo(2)
  })

  it('缩短同样能算', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 50,
      mode: 'extend'
    })
    expect(after(plan, 'shotB')).toEqual([100, 150])
    expect(after(plan, 'shotC')).toEqual([150, 300])
  })

  it('找不到段时说清楚下一步怎么做', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'nope',
      duration: 100,
      mode: 'extend'
    })
    expect(plan.problems[0]).toContain('sequence_describe')
  })

  it('时长非正数直接拒绝', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 0,
      mode: 'extend'
    })
    expect(plan.problems[0]).toContain('必须是正数')
  })

  it('时长没变时明说，不产出空计划', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 150,
      mode: 'extend'
    })
    expect(plan.problems[0]).toContain('已经是 150 帧')
  })
})

describe('子序列内部范围必须跟着改', () => {
  const withSub = (): PlanInput => ({
    playback: { start: 0, end: 200 },
    sections: [
      sec({
        id: 'shotA',
        track: 'Shots',
        kind: 'shot',
        start: 0,
        end: 100,
        subSequence: { path: '/Game/shot0010', innerStart: 0, innerEnd: 100 }
      })
    ]
  })

  it('父层段长变了就要同步子序列，否则截尾或留白', () => {
    const plan = planRetime(withSub(), {
      type: 'set_duration',
      sectionId: 'shotA',
      duration: 160,
      mode: 'extend'
    })

    expect(plan.subSequences).toEqual([
      { path: '/Game/shot0010', before: [0, 100], after: [0, 160] }
    ])
  })

  it('只是平移、段长没变时不动子序列内部范围', () => {
    // 平移不改变时长，子序列内部不需要动 —— 多改是制造噪音
    const plan = planRetime(withSub(), { type: 'shift_after', pivot: 0, delta: 30 })
    expect(after(plan, 'shotA')).toEqual([30, 130])
    expect(plan.subSequences).toEqual([])
  })
})

describe('计划文本', () => {
  it('有问题时只说问题，不列改动', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 100, delta: 0 })
    const text = formatPlan(plan)
    expect(text).toContain('没法执行')
    expect(text).not.toContain('会改动')
  })

  it('列出每个段的改前改后，用闭开区间写', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 250, delta: 60 })
    const text = formatPlan(plan)
    expect(text).toContain('[250, 400) → [310, 460)')
  })

  it('相机切轨排在最前 —— 它错了就是黑帧', () => {
    const plan = planRetime(master(), { type: 'shift_after', pivot: 100, delta: 30 })
    const text = formatPlan(plan)
    expect(text.indexOf('camera_cut')).toBeLessThan(text.indexOf('[shot]'))
  })

  it('scale 模式要把关键帧伸缩比例写出来', () => {
    const plan = planRetime(master(), {
      type: 'set_duration',
      sectionId: 'shotB',
      duration: 300,
      mode: 'scale'
    })
    expect(formatPlan(plan)).toContain('关键帧按 2.000× 拉伸')
  })

  it('子序列改动要单独列，并解释不改的后果', () => {
    const input: PlanInput = {
      playback: { start: 0, end: 100 },
      sections: [
        sec({
          id: 'shotA',
          track: 'Shots',
          kind: 'shot',
          start: 0,
          end: 100,
          subSequence: { path: '/Game/shot0010', innerStart: 0, innerEnd: 100 }
        })
      ]
    }
    const text = formatPlan(
      planRetime(input, {
        type: 'set_duration',
        sectionId: 'shotA',
        duration: 160,
        mode: 'extend'
      })
    )
    expect(text).toContain('/Game/shot0010')
    expect(text).toContain('丢结尾')
  })
})
