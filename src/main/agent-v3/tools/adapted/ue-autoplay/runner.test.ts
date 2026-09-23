import { describe, expect, it } from 'vitest'

import { playInFakeWorld, type FakeWorld, type WorldConfig } from './fakeWorld'
import { rulePolicy } from './policy'
import type { AutoplayOptions, AutoplayResult } from './runner'
import type { MemoryTrace } from './trace'
import type { ButtonInfo } from './types'

function play(
  config: WorldConfig,
  options: Partial<AutoplayOptions> = {}
): Promise<{ result: AutoplayResult; world: FakeWorld; trace: MemoryTrace }> {
  return playInFakeWorld(config, options, rulePolicy)
}
describe('runAutoplay —— 校准', () => {
  it('在一堆 Axis2D 里找到真正推角色的那个，跳过看起来是视角的', async () => {
    const { result } = await play({}, { durationSeconds: 8 })
    expect(result.move).toMatchObject({ kind: 'action', name: 'IA_Move', axis: 'y' })
    expect(Math.abs(result.move!.offset)).toBeLessThan(1)
    expect(result.jump).toEqual({ kind: 'action', name: 'IA_Jump' })
  })

  it('前进在 x 轴上的工程（Swizzle 配置不同）：量出偏角，照样走得到目标', async () => {
    const { result } = await play(
      { forwardAxis: 'x', actors: { Goal: { x: 0, y: 1200, z: 100 } } },
      { mode: 'goal', goal: { reach: { actor: 'Goal' } }, durationSeconds: 20 }
    )
    // 推 y 轴时角色往右走 —— 记成「y 轴、偏 90°」，走路时把视角反向拧 90° 补回来
    expect(result.move).toMatchObject({ name: 'IA_Move', axis: 'y' })
    expect(Math.abs(Math.abs(result.move!.offset) - 90)).toBeLessThan(1)
    expect(result.outcome).toBe('goal_reached')
  })

  it('一直没有 pawn 就如实报「没有可操作的角色」，不硬找', async () => {
    const { result } = await play({ noPawn: true }, { durationSeconds: 30 })
    expect(result.outcome).toBe('no_pawn')
  })
})

describe('runAutoplay —— 探索', () => {
  it('按遍输入：报错的那个被点名，报错归到它头上', async () => {
    const { result } = await play({}, { durationSeconds: 15 })
    const broken = result.sweep.find((entry) => entry.action === 'IA_Broken')
    expect(broken?.errors[0]).toMatch(/Accessed None/)
    const error = result.findings.find((f) => f.kind === 'error_after_action')
    expect(error?.after).toBe('按动作 IA_Broken')
    // 离门很远时按交互没有任何反应 —— 记成「没观察到效果」，不是错误
    expect(result.sweep.find((entry) => entry.action === 'IA_Interact')?.effects).toEqual([])
    expect(result.outcome).toBe('explored')
  })

  it('探索会走出去，并且覆盖不止一个格子', async () => {
    const { result } = await play({ navmesh: true }, { durationSeconds: 20 })
    expect(result.cellsVisited).toBeGreaterThan(3)
    expect(result.distanceTravelled).toBeGreaterThan(1000)
  })

  it('有落差探测：走到坑边停下，记「边缘没护栏」，不掉下去', async () => {
    const { result } = await play(
      { pit: { minX: -1600, maxX: -1300, minY: -300, maxY: 300 }, killZ: -1000, navmesh: true },
      { durationSeconds: 20 }
    )
    expect(result.findings.some((f) => f.kind === 'edge_avoided')).toBe(true)
    expect(result.findings.some((f) => f.kind === 'fell_out')).toBe(false)
  })

  it('老插件没有落差探测时掉进坑里：记下掉出世界的位置，以及之后的重生', async () => {
    const { result } = await play(
      {
        pit: { minX: -1600, maxX: -1300, minY: -300, maxY: 300 },
        killZ: -1000,
        navmesh: true,
        sensors: false
      },
      { durationSeconds: 20 }
    )
    expect(result.findings.some((f) => f.kind === 'fell_out')).toBe(true)
    expect(result.findings.some((f) => f.kind === 'respawned')).toBe(true)
  })

  it('游戏中途自己停了：收尾成 session_ended，不当成异常', async () => {
    const { result } = await play({ endAtMs: 6000 }, { durationSeconds: 30 })
    expect(result.outcome).toBe('session_ended')
  })
})

describe('runAutoplay —— 界面', () => {
  const menu: ButtonInfo[] = [
    { id: 'WBP_Menu_C_0/Btn_Settings', owner: 'WBP_Menu_C_0', text: 'Settings', enabled: true },
    { id: 'WBP_Menu_C_0/Btn_Delete', owner: 'WBP_Menu_C_0', text: 'Delete Save', enabled: true },
    { id: 'WBP_Menu_C_0/Btn_Start', owner: 'WBP_Menu_C_0', text: 'Start Game', enabled: true }
  ]

  it('开局是主菜单：点「开始」，删存档那个碰都不碰', async () => {
    const { result, world } = await play({ menu }, { durationSeconds: 8 })
    expect(world.clicked[0]).toBe('WBP_Menu_C_0/Btn_Start')
    expect(world.clicked).not.toContain('WBP_Menu_C_0/Btn_Delete')
    expect(result.uiDenied).toContain('Delete Save')
    expect(result.move?.name).toBe('IA_Move')
  })

  it('能点的只剩危险按钮：停下并报「卡在界面上」，不硬点', async () => {
    const { result, world } = await play(
      {
        menu: [
          { id: 'W/Btn_Quit', owner: 'W', text: '退出游戏', enabled: true },
          { id: 'W/Btn_Reset', owner: 'W', text: '重置进度', enabled: true }
        ]
      },
      { mode: 'goal', goal: { untilLog: 'x' }, durationSeconds: 10 }
    )
    expect(world.clicked).toEqual([])
    expect(result.outcome).toBe('blocked_by_ui')
    expect(result.findings.find((f) => f.kind === 'blocked_by_ui')?.detail).toMatch(/退出游戏/)
  })

  it('扫描时按出了暂停菜单：点「Resume」回到游戏再接着扫', async () => {
    const { result, world } = await play(
      {
        actions: [
          { name: 'IA_Move', value_type: 'Axis2D' },
          { name: 'IA_Pause', value_type: 'Boolean' },
          { name: 'IA_Broken', value_type: 'Boolean' }
        ]
      },
      { durationSeconds: 12 }
    )
    expect(world.clicked).toContain('WBP_Pause_C_0/Btn_Resume')
    expect(result.sweep.map((entry) => entry.action)).toContain('IA_Broken')
  })
})

describe('runAutoplay —— 目标', () => {
  it('走到门口、按交互、等到 DoorOpened：达成并提前收手', async () => {
    const { result } = await play(
      {
        navmesh: true,
        actors: { BP_Door: { x: 1200, y: 400, z: 100 } },
        door: { x: 1200, y: 400, z: 100 }
      },
      {
        mode: 'goal',
        goal: { reach: { actor: 'BP_Door' }, press: 'IA_Interact', untilLog: 'DoorOpened' },
        durationSeconds: 30
      }
    )
    expect(result.outcome).toBe('goal_reached')
    expect(result.goal).toMatchObject({
      reached: true,
      reachedTarget: true,
      pressed: true,
      logSeen: true
    })
  })

  it('目标名字写错：当场报找不到，不去乱走', async () => {
    const { result } = await play(
      { actors: { BP_Door: { x: 1200, y: 0, z: 100 } } },
      { mode: 'goal', goal: { reach: { actor: 'BP_Dor' } } }
    )
    expect(result.outcome).toBe('goal_failed')
    expect(result.findings[0]?.kind).toBe('target_missing')
  })

  it('一堵矮墙挡路：先记卡住，再跳过去，最后到达', async () => {
    const { result, trace } = await play(
      {
        actors: { Goal: { x: 1500, y: 0, z: 100 } },
        walls: [{ minX: 600, maxX: 650, minY: -2000, maxY: 2000, low: true }]
      },
      { mode: 'goal', goal: { reach: { actor: 'Goal' } }, durationSeconds: 30 }
    )
    expect(result.findings.some((f) => f.kind === 'stuck')).toBe(true)
    expect(result.outcome).toBe('goal_reached')
    const unstick = trace.records.find((r) => r.type === 'decision' && r.kind === 'unstick')
    expect(unstick?.chosen).toBe('jump_forward')
  })

  it('一堵高墙挡路：脱困方式试完就放弃，报到不了和卡住的位置', async () => {
    const { result } = await play(
      {
        actors: { Goal: { x: 1500, y: 0, z: 100 } },
        walls: [{ minX: 600, maxX: 650, minY: -5000, maxY: 5000 }]
      },
      { mode: 'goal', goal: { reach: { actor: 'Goal' } }, durationSeconds: 30 }
    )
    expect(result.outcome).toBe('goal_failed')
    const stuck = result.findings.find((f) => f.kind === 'stuck')
    expect(stuck?.at?.x).toBeGreaterThan(500)
    expect(stuck?.at?.x).toBeLessThan(650)
    expect(result.findings.some((f) => f.kind === 'unreachable')).toBe(true)
  })
})

describe('runAutoplay —— trace', () => {
  it('每个决策点都带状态、全部选项、选了哪个和结果 —— 给以后换策略回放用', async () => {
    const { trace } = await play({ navmesh: true }, { durationSeconds: 15 })
    const decisions = trace.records.filter((r) => r.type === 'decision')
    expect(decisions.length).toBeGreaterThan(0)
    for (const decision of decisions) {
      expect(decision).toHaveProperty('state')
      expect(Array.isArray(decision.options)).toBe(true)
      expect(decision).toHaveProperty('chosen')
      expect(decision).toHaveProperty('outcome')
      expect(decision.policy).toBe('rule')
    }
    expect(trace.records[0]?.type).toBe('header')
    expect(trace.records.at(-1)?.type).toBe('end')
  })
})
