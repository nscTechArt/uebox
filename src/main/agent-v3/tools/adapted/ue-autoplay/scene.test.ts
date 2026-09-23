import { describe, expect, it } from 'vitest'

import { playInFakeWorld } from './fakeWorld'
import { rulePolicy } from './policy'
import { actorHints, diffScenes, sceneToNearby } from './scene'
import { ruleBrain } from './controller'
import type { SceneActor, SceneSnapshot } from './types'

function actor(overrides: Partial<SceneActor>): SceneActor {
  return {
    name: 'BP_Thing',
    class: 'BP_Thing_C',
    parents: ['Actor'],
    location: { x: 0, y: 0, z: 0 },
    extent: { x: 50, y: 50, z: 50 },
    distance: 500,
    bearing: 0,
    dz: 0,
    ...overrides
  }
}

function snapshot(actors: SceneActor[], pawnVars: Record<string, unknown> = {}): SceneSnapshot {
  return {
    ok: true,
    level: 'L',
    has_navmesh: true,
    heading_yaw: 0,
    total_relevant: actors.length,
    player: { pawn_vars: pawnVars },
    actors
  }
}

describe('actorHints —— 名字没意义时，语义在蓝图里', () => {
  it('父类、接口、事件名、有意义的组件名都进提示；默认组件名不进', () => {
    const hints = actorHints(
      actor({
        name: 'BP_Prop_07',
        parents: ['BP_LockedDoor_C', 'Actor'],
        interfaces: ['BPI_Interactable_C'],
        events: ['Unlock', 'OpenDoor'],
        components: ['StaticMeshComponent:StaticMeshComponent0', 'BoxComponent:InteractionBox']
      })
    )
    expect(hints.join(' | ')).toMatch(/kind of BP_LockedDoor/)
    expect(hints.join(' | ')).toMatch(/implements BPI_Interactable/)
    expect(hints.join(' | ')).toMatch(/has events Unlock, OpenDoor/)
    expect(hints.join(' | ')).toMatch(/parts InteractionBox/)
    expect(hints.join(' | ')).not.toMatch(/StaticMeshComponent0/)
  })

  it('走不到的对象标出来', () => {
    const [view] = sceneToNearby(snapshot([actor({ nav: 'partial' })]))
    expect(view.path).toBe('partial')
  })
})

describe('diffScenes —— 这一步之后世界变了什么', () => {
  it('对象没了、变量变了、玩家变量变了都报出来', () => {
    const before = snapshot(
      [
        actor({ name: 'BP_Key', distance: 150 }),
        actor({ name: 'BP_Door', vars: { bLocked: true }, distance: 900 })
      ],
      { HasKey: false }
    )
    const after = snapshot([actor({ name: 'BP_Door', vars: { bLocked: false }, distance: 900 })], {
      HasKey: true
    })
    expect(diffScenes(before, after)).toEqual([
      'BP_Key disappeared',
      'BP_Door.bLocked: true → false',
      'player.HasKey: false → true'
    ])
  })

  it('远处的对象进出名单不算变化（名单按距离截断，走动时边界会挪）', () => {
    const before = snapshot([actor({ name: 'FarThing', distance: 4000 })])
    const after = snapshot([actor({ name: 'OtherFar', distance: 4200 })])
    expect(diffScenes(before, after)).toEqual([])
  })
})

describe('objective 模式 + 整关场景', () => {
  it('老插件没有 pie.scene：退回射线感知，照样能跑，并记一句说明', async () => {
    const { result } = await playInFakeWorld(
      {
        scene: false,
        items: [
          {
            name: 'BP_Chest',
            class: 'BP_Chest_C',
            location: { x: 1200, y: 400, z: 100 },
            kind: 'chest'
          }
        ]
      },
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
    expect(result.calibrationNotes.join()).toMatch(/pie\.scene/)
  })

  it('交互之后的世界变化写进历史：箱子的 bOpened 变了', async () => {
    const { trace } = await playInFakeWorld(
      {
        items: [
          {
            name: 'BP_Chest',
            class: 'BP_Chest_C',
            location: { x: 1200, y: 400, z: 100 },
            kind: 'chest'
          }
        ]
      },
      {
        mode: 'objective',
        objective: 'Open the chest',
        brain: ruleBrain,
        goal: { untilLog: 'Chest opened' },
        durationSeconds: 30
      },
      rulePolicy
    )
    const outcomes = trace.records.filter((r) => r.type === 'tick').map((r) => String(r.outcome))
    expect(outcomes.some((o) => /BP_Chest\.bOpened: false → true/.test(o))).toBe(true)
  })
})
