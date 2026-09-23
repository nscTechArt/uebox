import { describe, expect, it, vi } from 'vitest'

import {
  createJudgeNavigator,
  maneuversFor,
  moveCaps,
  offerNavSteps,
  perceive,
  relationToTarget,
  type AskJudgeRaw,
  type DirectionView
} from './controller'
import type { SensorRay, Sensors } from './types'

function sensors(front: Partial<SensorRay>, extra: Partial<Sensors> = {}): Sensors {
  return {
    heading_yaw: 0,
    jump_height: 125,
    step_height: 45,
    capsule_radius: 42,
    capsule_height: 192,
    max_speed: 500,
    jump_z: 700,
    gravity: 1715,
    jump_max_count: 1,
    rays: [{ angle: 0, drop: 0, ...front }],
    nearby: [],
    ...extra
  }
}

function frontView(s: Sensors): DirectionView {
  return perceive(s, { x: 0, y: 0, z: 0 }, () => 0).directions.find((d) => d.dir === 'front')!
}

describe('组合动作 —— 物理条件满足才提供', () => {
  it('助跑跳：沟对面 3 米有地，跑速 × 滞空够得着 → 提供；7 米就不提供', () => {
    const near = sensors({ drop: -1, landing: 300, landing_dz: 0 })
    const ids = maneuversFor(frontView(near), moveCaps(near, true)).map((o) => o.id)
    expect(ids).toContain('run_jump:front')

    const far = sensors({ drop: -1, landing: 700, landing_dz: 0 })
    expect(maneuversFor(frontView(far), moveCaps(far, true)).map((o) => o.id)).not.toContain(
      'run_jump:front'
    )
  })

  it('障碍顶高低于跳跃高度 → 原地跳上；介于一跳和两跳之间 → 二段跳（角色允许时）', () => {
    const low = sensors({ low: 80, jump: 80, obstacle_top: 90 })
    expect(maneuversFor(frontView(low), moveCaps(low, true)).map((o) => o.id)).toEqual([
      'jump:front'
    ])

    const mid = sensors({ low: 80, jump: 80, obstacle_top: 180 }, { jump_max_count: 2 })
    expect(maneuversFor(frontView(mid), moveCaps(mid, true)).map((o) => o.id)).toEqual([
      'double_jump:front'
    ])

    const midSingle = sensors({ low: 80, jump: 80, obstacle_top: 180 })
    expect(maneuversFor(frontView(midSingle), moveCaps(midSingle, true))).toEqual([])
  })

  it('下面探得到地、落差在安全范围 → 可以主动跳下；没有地（-1）永远不提供', () => {
    const ledge = sensors({ drop: 500 })
    expect(maneuversFor(frontView(ledge), moveCaps(ledge, true)).map((o) => o.id)).toContain(
      'drop_down:front'
    )
    const abyss = sensors({ drop: -1 })
    expect(maneuversFor(frontView(abyss), moveCaps(abyss, true))).toEqual([])
  })

  it('老插件没有能力参数：不提供助跑跳', () => {
    const old = sensors({ drop: -1, landing: 300 }, { max_speed: undefined, jump_z: undefined })
    expect(maneuversFor(frontView(old), moveCaps(old, true))).toEqual([])
  })
})

describe('局部导航', () => {
  it('每个方向和目标的关系落成类别', () => {
    expect(relationToTarget(0, 10)).toBe('straight toward the target')
    expect(relationToTarget(45, 0)).toBe('roughly toward the target')
    expect(relationToTarget(-90, 0)).toBe('sideways to the target')
    expect(relationToTarget(180, 0)).toBe('directly away from the target')
  })

  it('悬崖方向不给走；判定模型选表外的步子时退回「最朝向目标」', async () => {
    const s: Sensors = {
      ...sensors({ low: 60, jump: 60 }),
      rays: [
        { angle: 0, low: 60, jump: 60, hit: 'Wall' },
        { angle: 45, drop: 0 },
        { angle: -45, drop: -1 }
      ]
    }
    const view = perceive(s, { x: 0, y: 0, z: 0 }, () => 0)
    const offered = offerNavSteps(view.directions, 0, true, moveCaps(s, true))
    const ids = offered.map((o) => o.id)
    expect(ids).toContain('move:front_right')
    expect(ids).not.toContain('move:front_left')
    expect(ids).not.toContain('move:front')

    const ask = vi.fn<AskJudgeRaw>(async () => ({
      answers: { step: { type: 'choice', choice: 'move:front', confidence: 0.9 } }
    }))
    const decision = await createJudgeNavigator(ask).decide({
      target: { name: 'BP_Key', where: 'front', meters: 20 },
      bearing: 0,
      directions: view.directions,
      offered,
      steps: []
    })
    expect(decision.source).toBe('rule')
    expect(decision.actionId).toBe('move:front_right')
  })
})
