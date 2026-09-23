import { describe, expect, it, vi } from 'vitest'

import {
  createFlatJudgeBrain,
  createJudgeBrain,
  dirForBearing,
  offerActions,
  perceive,
  ruleBrain,
  type AskJudgeRaw,
  type ControllerTick
} from './controller'
import { playInFakeWorld, type WorldConfig } from './fakeWorld'
import { rulePolicy } from './policy'
import type { Sensors } from './types'

function sensors(overrides: Partial<Sensors> = {}): Sensors {
  return {
    heading_yaw: 0,
    jump_height: 125,
    step_height: 45,
    capsule_radius: 42,
    capsule_height: 192,
    rays: [0, 45, 90, 135, 180, -135, -90, -45].map((angle) => ({ angle, drop: 0 })),
    nearby: [],
    ...overrides
  }
}

describe('perceive —— 数字落成类别', () => {
  it('方位角落进八个方向，±180 都算正后方', () => {
    expect(dirForBearing(0)).toBe('front')
    expect(dirForBearing(-40)).toBe('front_left')
    expect(dirForBearing(95)).toBe('right')
    expect(dirForBearing(179)).toBe('back')
    expect(dirForBearing(-179)).toBe('back')
  })

  it('低处撞、跳高处不撞 = 能跳过去；两处都撞 = 墙；前方没地 = 悬崖', () => {
    const view = perceive(
      sensors({
        rays: [
          { angle: 0, low: 80, hit: 'Crate' },
          { angle: 90, low: 60, jump: 60, hit: 'Wall_A' },
          { angle: -90, drop: -1 }
        ]
      }),
      { x: 0, y: 0, z: 100 },
      () => 0
    )
    const byDir = Object.fromEntries(view.directions.map((d) => [d.dir, d]))
    expect(byDir.front).toMatchObject({
      path: 'blocked',
      obstacle: 'jumpable',
      blocked_by: 'Crate'
    })
    expect(byDir.right).toMatchObject({ path: 'blocked', obstacle: 'wall' })
    expect(byDir.left).toMatchObject({ path: 'open', ground: 'cliff' })
  })
})

describe('offerActions —— 坏行为靠改提供的选项来修', () => {
  const base = {
    pressable: [{ name: 'IA_Interact', value_type: 'Boolean' }],
    canJump: true,
    cooling: new Set<string>()
  }

  it('撞墙的方向不提供走，悬崖不提供走，矮障碍提供跳', () => {
    const view = perceive(
      sensors({
        rays: [
          { angle: 0, low: 80, hit: 'Crate' },
          { angle: 90, low: 60, jump: 60 },
          { angle: -90, drop: -1 }
        ]
      }),
      { x: 0, y: 0, z: 100 },
      () => 0
    )
    const ids = offerActions({ ...base, ...view }).map((o) => o.id)
    expect(ids).not.toContain('move:front')
    expect(ids).toContain('jump:front')
    expect(ids).not.toContain('move:right')
    expect(ids).not.toContain('jump:right')
    expect(ids).not.toContain('move:left')
    expect(ids).toContain('move:back')
  })

  it('界面挡着时只提供点按钮，危险按钮不提供', () => {
    const offered = offerActions({
      ...base,
      directions: [],
      nearby: [],
      blockingButtons: [
        { id: 'W/a', owner: 'W', text: '出发', enabled: true },
        { id: 'W/b', owner: 'W', text: '删除存档', enabled: true }
      ]
    })
    expect(offered.map((o) => o.id)).toEqual(['click:W/a'])
  })

  it('冷却中的动作不提供；什么都不能做时才提供等待', () => {
    const view = perceive(
      sensors({
        rays: [0, 45, 90, 135, 180, -135, -90, -45].map((angle) => ({ angle, low: 50, jump: 50 }))
      }),
      { x: 0, y: 0, z: 100 },
      () => 0
    )
    const offered = offerActions({ ...view, pressable: [], canJump: false, cooling: new Set() })
    expect(offered.map((o) => o.id)).toEqual(['wait'])
  })
})

function tick(partial: Partial<ControllerTick>): ControllerTick {
  return {
    objective: '',
    state: {},
    offered: [],
    nearby: [],
    directions: [],
    history: [],
    ...partial
  }
}

describe('ruleBrain', () => {
  it('目标里点了名的东西（英文名）会走过去', async () => {
    const view = perceive(
      sensors({
        nearby: [
          {
            name: 'BP_Chest',
            class: 'BP_Chest_C',
            distance: 900,
            bearing: 30,
            dz: 0,
            visible: true,
            location: { x: 1, y: 1, z: 1 }
          }
        ]
      }),
      { x: 0, y: 0, z: 100 },
      () => 0
    )
    const offered = offerActions({ ...view, pressable: [], canJump: false, cooling: new Set() })
    const decision = await ruleBrain.decide(tick({ objective: 'open the chest', offered, ...view }))
    expect(decision.actionId).toBe('goto:BP_Chest')
  })
})

describe('createJudgeBrain', () => {
  it('平铺版：一次调用同时问动作、完成与否、进展三件事，并采纳选择', async () => {
    const ask = vi.fn<AskJudgeRaw>(async () => ({
      answers: {
        action: { type: 'choice', choice: 'move:back', probabilities: {}, confidence: 0.3 },
        done: { type: 'noul', noul: 0.1 },
        progress: { type: 'score', score: 1, probabilities: {}, confidence: 0.5 }
      }
    }))
    const offered = offerActions({
      ...perceive(sensors(), { x: 0, y: 0, z: 0 }, () => 0),
      pressable: [],
      canJump: false,
      cooling: new Set()
    })
    const decision = await createFlatJudgeBrain(ask).decide(tick({ offered }))
    expect(Object.keys(vi.mocked(ask).mock.calls[0][1])).toEqual(['action', 'done', 'progress'])
    // confidence 0.3 也采纳：选项表已经保证合法，不拿 confidence 卡动作
    expect(decision).toMatchObject({
      actionId: 'move:back',
      source: 'judge',
      done: 0.1,
      progress: 1
    })
  })

  it('调用失败或回了表外的动作就退回规则', async () => {
    const offered = offerActions({
      ...perceive(sensors(), { x: 0, y: 0, z: 0 }, () => 0),
      pressable: [],
      canJump: false,
      cooling: new Set()
    })
    const failed = await createJudgeBrain(async () => null).decide(tick({ offered }))
    expect(failed.source).toBe('rule')
    const bogus = await createJudgeBrain(async () => ({
      answers: { action: { type: 'choice', choice: 'fly', confidence: 1 } }
    })).decide(tick({ offered }))
    expect(bogus.source).toBe('rule')
  })
})

describe('createJudgeBrain（拆开问）', () => {
  const lever = {
    name: 'BP_Lever',
    class: 'BP_Lever_C',
    distance: 120,
    bearing: 0,
    dz: 0,
    visible: true,
    location: { x: 100, y: 0, z: 0 }
  }
  const exit = { ...lever, name: 'BP_Exit', class: 'BP_Exit_C', distance: 2300, bearing: 150 }

  function setup(): ControllerTick {
    const view = perceive(sensors({ nearby: [lever, exit] }), { x: 0, y: 0, z: 0 }, () => 0)
    const offered = offerActions({
      ...view,
      pressable: [{ name: 'IA_Interact', value_type: 'Boolean' }],
      canJump: false,
      cooling: new Set()
    })
    return tick({ offered, ...view })
  }

  it('挨着的就是下一个目标、而且该交互 → 按', async () => {
    const ask = vi.fn<AskJudgeRaw>(async () => ({
      answers: {
        next_target: { type: 'choice', choice: 'BP_Lever', confidence: 0.8 },
        use_now: { type: 'noul', noul: 0.9 }
      }
    }))
    const decision = await createJudgeBrain(ask).decide(setup())
    expect(decision.actionId).toBe('press:IA_Interact')
    // 挨着东西时才问 use_now；只有一个输入就不问 press_which
    const asked = Object.keys(vi.mocked(ask).mock.calls[0][1])
    expect(asked).toEqual(expect.arrayContaining(['next_target', 'use_now', 'explore_dir', 'done']))
    expect(asked).not.toContain('press_which')
  })

  it('下一个目标在远处 → 走过去，而不是被「往前走」吸走', async () => {
    const decision = await createJudgeBrain(async () => ({
      answers: {
        next_target: { type: 'choice', choice: 'BP_Exit', confidence: 0.6 },
        use_now: { type: 'noul', noul: 0.1 },
        explore_dir: { type: 'choice', choice: 'move:front', confidence: 0.9 }
      }
    })).decide(setup())
    expect(decision.actionId).toBe('goto:BP_Exit')
  })

  it('说要探索就用 explore_dir；移动选项里写着那个方向有什么', async () => {
    const t = setup()
    const decision = await createJudgeBrain(async () => ({
      answers: {
        next_target: { type: 'choice', choice: '__explore__', confidence: 0.6 },
        explore_dir: { type: 'choice', choice: 'move:back_right', confidence: 0.5 }
      }
    })).decide(t)
    expect(decision.actionId).toBe('move:back_right')
    expect(t.offered.find((o) => o.id === 'move:back_right')?.description).toMatch(/BP_Exit/)
  })
})

describe('objective 模式 —— 假世界整局', () => {
  const world: WorldConfig = {
    items: [
      {
        name: 'BP_Chest',
        class: 'BP_Chest_C',
        location: { x: 1200, y: 400, z: 100 },
        kind: 'chest'
      },
      {
        name: 'BP_Barrel',
        class: 'BP_Barrel_C',
        location: { x: -600, y: 300, z: 100 },
        kind: 'decor'
      }
    ]
  }

  it('规则基线：英文目标点了名，走过去按交互，until_log 断言达成', async () => {
    const { result, trace } = await playInFakeWorld(
      world,
      {
        mode: 'objective',
        objective: 'Open the chest',
        brain: ruleBrain,
        goal: { untilLog: 'Chest opened' },
        durationSeconds: 30
      },
      rulePolicy
    )
    expect(result.outcome).toBe('goal_reached')
    expect(result.controller?.ticks).toBeGreaterThan(0)
    const ticks = trace.records.filter((r) => r.type === 'tick')
    expect(ticks[0]).toHaveProperty('state')
    expect(ticks[0]).toHaveProperty('offered')
  })

  it('判定模型说「完成了」要连续两步 ≥ 0.9 才停，而且报成判断不是断言', async () => {
    const ask: AskJudgeRaw = async () => ({
      answers: {
        action: { type: 'choice', choice: 'move:front', confidence: 0.9 },
        done: { type: 'noul', noul: 0.95 }
      }
    })
    const { result } = await playInFakeWorld(
      world,
      {
        mode: 'objective',
        objective: '随便走走',
        brain: createFlatJudgeBrain(ask),
        durationSeconds: 20
      },
      rulePolicy
    )
    expect(result.outcome).toBe('objective_done')
    // 中间沿探索方向自动走的两步不问判定模型，只数它真正回答的那两次
    expect(result.controller?.judgeDecisions).toBe(2)
    expect(result.outcomeNote).toMatch(/不是断言/)
  })
})
