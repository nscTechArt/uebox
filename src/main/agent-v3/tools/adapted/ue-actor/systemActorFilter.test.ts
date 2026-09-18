/**
 * @vitest-environment node
 *
 * `ue_get_actor` 默认不列出引擎的系统 Actor —— 以及**必须如实报出隐藏了多少**。
 *
 * 背景（2026-08-31，UE 5.5 真机）：`ue_get_actor(filter: { class: "PCGVolume" })`
 * 回了 144 个 WorldPartitionHLOD，用户要找的那一个 PCG 体积埋在几十行 HLOD 中间。
 * 这些东西是引擎自己的记账对象，用户没放过它们，也不会去改。
 *
 * 过滤本身在引擎侧做（必须在 limit 截断之前，否则 144 个 HLOD 会先把 50 条额度吃光）。
 * 盒子这边守两件事：
 *   1. `include_system_actors` 一路透传到 payload，不在任何一层被吃掉；
 *   2. 引擎回的「隐藏了 N 个」一定出现在 message 里。
 *
 * 第 2 条比第 1 条重要。静默过滤会让调用方以为「场景里就这些」并据此下结论 ——
 * 那是比满屏 HLOD 更难查的一类错：满屏至少看得见。
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

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }
const run = (input: unknown): Promise<ToolResult> =>
  (createGetActorTool() as unknown as Executable).execute(input)

/** 取最后一次发给引擎的 payload */
const sentPayload = (): Record<string, unknown> =>
  callRequest.mock.calls[callRequest.mock.calls.length - 1][1] as Record<string, unknown>

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('include_system_actors 透传到引擎', () => {
  it('默认是 false —— 不给这个参数也要显式发出去，不能靠引擎猜默认值', async () => {
    callRequest.mockResolvedValue({ count: 0, total_found: 0, actors: [] })

    await run({ targets: { filter: { class: 'PCGVolume' } } })

    expect(callRequest.mock.calls[0][0]).toBe('actor.get_info')
    expect(sentPayload().include_system_actors).toBe(false)
  })

  it('显式要回系统 actor 时透传 true', async () => {
    callRequest.mockResolvedValue({ count: 1, total_found: 1, actors: [] })

    await run({ targets: { filter: {} }, include_system_actors: true })

    expect(sentPayload().include_system_actors).toBe(true)
  })

  it('属性内省分支同样透传 —— 内省更受不了 144 个 HLOD，每条还带一组属性值', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [{ name: 'A', path: '/p', class: 'C', props: {} }]
    })

    await run({ targets: { filter: { class: 'Light' } }, properties: ['Intensity'] })

    expect(callRequest.mock.calls[0][0]).toBe('actor.inspect')
    expect(sentPayload().include_system_actors).toBe(false)
  })
})

describe('被过滤掉的数量必须如实报出来', () => {
  it('真机那一幕：查 PCGVolume，隐藏的 144 个 HLOD 要写进 message', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      total_found: 1,
      actors: [{ name: 'PCGVolume_0', path: '/p', class: 'PCGVolume' }],
      system_actors_excluded: 144,
      system_actors_by_class: { WorldPartitionHLOD: 144 }
    })

    const result = await run({ targets: { filter: { class: 'PCGVolume' } } })

    expect(result.success).toBe(true)
    expect(result.count).toBe(1)
    const message = String(result.message)
    expect(message).toContain('144')
    // 类名也要报 —— 它可以直接抄进 filter.exclude_classes
    expect(message).toContain('WorldPartitionHLOD')
    // 还要告诉调用方怎么把它们要回来，否则「未列出」是个死胡同
    expect(message).toContain('include_system_actors')
  })

  it('计数字段原样透出，调用方不必去解析 message', async () => {
    callRequest.mockResolvedValue({
      count: 0,
      total_found: 0,
      actors: [],
      system_actors_excluded: 144,
      system_actors_by_class: { WorldPartitionHLOD: 144 }
    })

    const result = await run({ targets: { filter: {} } })

    expect(result.system_actors_excluded).toBe(144)
    expect(result.system_actors_by_class).toEqual({ WorldPartitionHLOD: 144 })
  })

  it('一个都没剩下时最不能沉默 —— 否则读起来就是「场景里没有」', async () => {
    callRequest.mockResolvedValue({
      count: 0,
      total_found: 0,
      actors: [],
      system_actors_excluded: 144,
      system_actors_by_class: { WorldPartitionHLOD: 144 }
    })

    const result = await run({ targets: { filter: {} } })

    expect(String(result.message)).toContain('144')
  })

  it('计数模式（limit: 0）也要说 —— total_found 是扣掉之后的数，不说就对不上', async () => {
    callRequest.mockResolvedValue({
      count: 0,
      total_found: 3,
      actors: [],
      system_actors_excluded: 144,
      system_actors_by_class: { WorldPartitionHLOD: 144 }
    })

    const result = await run({ targets: { filter: {} }, limit: 0 })

    const message = String(result.message)
    expect(message).toContain('3')
    expect(message).toContain('144')
  })

  it('多个类分项列全，不截断 —— 截断又是一次「以为就这些」', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      total_found: 1,
      actors: [{ name: 'Floor', path: '/p', class: 'StaticMeshActor' }],
      system_actors_excluded: 7,
      system_actors_by_class: {
        DefaultPhysicsVolume: 1,
        WorldPartitionHLOD: 4,
        RecastNavMesh: 2
      }
    })

    const result = await run({ targets: { filter: {} } })

    const message = String(result.message)
    expect(message).toContain('WorldPartitionHLOD 4')
    expect(message).toContain('RecastNavMesh 2')
    expect(message).toContain('DefaultPhysicsVolume 1')
    // 按数量从多到少排，最吵的排在前面
    expect(message.indexOf('WorldPartitionHLOD')).toBeLessThan(message.indexOf('RecastNavMesh'))
  })

  it('内省分支也要报', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [{ name: 'Light_0', path: '/p', class: 'PointLight', props: { Intensity: 5 } }],
      system_actors_excluded: 12,
      system_actors_by_class: { WorldPartitionHLOD: 12 }
    })

    const result = await run({
      targets: { filter: { class: 'Light' } },
      properties: ['Intensity']
    })

    expect(String(result.message)).toContain('12')
    expect(result.system_actors_excluded).toBe(12)
  })

  it('内省一个都没剩下时，错误信息里也要带上隐藏计数', async () => {
    callRequest.mockResolvedValue({
      count: 0,
      actors: [],
      system_actors_excluded: 12,
      system_actors_by_class: { WorldPartitionHLOD: 12 }
    })

    const result = await run({ targets: { filter: {} }, properties: ['Intensity'] })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('12')
  })
})

describe('没有隐藏任何东西时不要平白多话', () => {
  it('引擎没回这两个字段（老版本插件）时，摘要保持原样', async () => {
    callRequest.mockResolvedValue({
      count: 2,
      total_found: 2,
      actors: [
        { name: 'A', path: '/a', class: 'StaticMeshActor' },
        { name: 'B', path: '/b', class: 'StaticMeshActor' }
      ]
    })

    const result = await run({ targets: { filter: {} } })

    expect(String(result.message)).not.toContain('系统 actor')
    expect(result.system_actors_excluded).toBeUndefined()
  })

  it('excluded 为 0 等同于没隐藏', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      total_found: 1,
      actors: [{ name: 'A', path: '/a', class: 'StaticMeshActor' }],
      system_actors_excluded: 0,
      system_actors_by_class: {}
    })

    const result = await run({ targets: { filter: {} } })

    expect(String(result.message)).not.toContain('系统 actor')
    expect(result.system_actors_excluded).toBeUndefined()
  })
})
