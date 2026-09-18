/**
 * @vitest-environment node
 *
 * 「按用户当前选中来操作」的契约测试。
 *
 * 背景：插件端 `ResolveTargetsToActors` 一直认 `targets.selection`，但盒子这边
 * 四个 Actor 工具的 schema 一个都没暴露它，`ue_get_actor` 的 targets 还是
 * `.strict()` —— 模型就算猜对写法也会被校验拒掉。结果是用户问「我选中的这个是啥」，
 * 它只能绕去写 Python 读 EditorActorSubsystem，慢且还得再猜一次资产路径。
 *
 * 所以这里守的是**端到端那条线**：从工具入参一路到发给引擎的 payload，
 * selection 不能在任何一层被吃掉。只测 normalize 函数不够 —— 当初的 bug
 * 正是出在 schema 那一层。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { createGetActorTool } from './getActor'
import { createSetPropertyTool } from './setProperty'
import { createSetTransformUnifiedTool } from './setTransformUnified'
import { createDestroyActorTool } from './destroyActor'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }
const run = (tool: unknown, input: unknown): Promise<ToolResult> =>
  (tool as Executable).execute(input)

/** 取最后一次发给引擎的 payload */
const sentPayload = (): Record<string, unknown> =>
  callRequest.mock.calls[callRequest.mock.calls.length - 1][1] as Record<string, unknown>

const sentTargets = (): Record<string, unknown> => sentPayload().targets as Record<string, unknown>

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('targets.selection 透传到引擎', () => {
  it('ue_get_actor：selection 不被 strict schema 拒掉，也不退化成全场景扫描', async () => {
    callRequest.mockResolvedValue({ count: 1, total_found: 1, actors: [] })

    await run(createGetActorTool(), { targets: { selection: true } })

    expect(callRequest.mock.calls[0][0]).toBe('actor.get_info')
    expect(sentTargets()).toEqual({ selection: true })
    // 关键：不能因为「没给 names/paths」就补一个空 filter —— 那等于扫全场景
    expect(sentTargets().filter).toBeUndefined()
  })

  it('ue_get_actor：selection 也能走属性内省分支', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [{ name: 'BP_Door0', path: '/p', class: 'BP_Door_C', props: { bHidden: false } }]
    })

    await run(createGetActorTool(), {
      targets: { selection: true },
      properties: ['bHidden']
    })

    expect(callRequest.mock.calls[0][0]).toBe('actor.inspect')
    expect(sentTargets()).toEqual({ selection: true })
  })

  it('ue_set_property：selection 满足「至少一个选择条件」', async () => {
    callRequest.mockResolvedValue({ count: 1, actors: [{ name: 'A', class: 'C', path: '/p' }] })

    await run(createSetPropertyTool(), {
      targets: { selection: true },
      properties: { bHidden: true }
    })

    expect(callRequest.mock.calls[0][0]).toBe('actor.set_property')
    expect(sentTargets()).toEqual({ selection: true })
  })

  it('ue_set_transform：selection 满足「至少一个选择条件」', async () => {
    callRequest.mockResolvedValue({ count: 1, actors: [] })

    await run(createSetTransformUnifiedTool(), {
      targets: { selection: true },
      operation: { add: { location: { z: 100 } } }
    })

    expect(callRequest.mock.calls[0][0]).toBe('actor.set_transform')
    expect(sentTargets()).toEqual({ selection: true })
  })

  it('ue_destroy_actor：selection 满足「至少一个选择条件」', async () => {
    callRequest.mockResolvedValue({ ok: true, count: 1, deleted_actors: [] })

    await run(createDestroyActorTool(), { targets: { selection: true } })

    expect(callRequest.mock.calls[0][0]).toBe('actor.destroy')
    expect(sentTargets()).toEqual({ selection: true })
  })

  it('selection 能和 names 叠加，不互相顶掉', async () => {
    callRequest.mockResolvedValue({ count: 2, total_found: 2, actors: [] })

    await run(createGetActorTool(), { targets: { selection: true, names: ['Floor'] } })

    expect(sentTargets()).toEqual({ selection: true, names: ['Floor'] })
  })

  it('selection: false 等于没给 —— 只有它时仍视为没有选择条件', async () => {
    const result = await run(createSetPropertyTool(), {
      targets: { selection: false },
      properties: { bHidden: true }
    })

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('没选中任何东西时的回话', () => {
  it('不能只说「找到 0 个」—— 要点破是用户没选，别让模型改用猜的', async () => {
    callRequest.mockResolvedValue({ count: 0, total_found: 0, actors: [] })

    const result = await run(createGetActorTool(), { targets: { selection: true } })

    expect(result.success).toBe(true)
    expect(result.count).toBe(0)
    expect(String(result.message)).toContain('没有选中')
  })

  it('按名字查不到时保持原来的措辞，不误报成「没选中」', async () => {
    callRequest.mockResolvedValue({ count: 0, total_found: 0, actors: [] })

    const result = await run(createGetActorTool(), { targets: { names: ['NoSuchActor'] } })

    expect(String(result.message)).not.toContain('没有选中')
  })
})

describe('蓝图实例的资产路径', () => {
  it('引擎回的 blueprint_path 原样透出，供 blueprint_describe 直接用', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      total_found: 1,
      actors: [
        {
          name: 'BP_Door0',
          path: '/Game/NewMap.NewMap:PersistentLevel.BP_Door_C_0',
          class: 'BP_Door_C',
          blueprint_path: '/Game/PartyMVP/Props/BP_Door'
        }
      ]
    })

    const result = await run(createGetActorTool(), { targets: { selection: true } })

    const actors = result.actors as Array<Record<string, unknown>>
    expect(actors[0].blueprint_path).toBe('/Game/PartyMVP/Props/BP_Door')
  })
})
