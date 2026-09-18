/**
 * @vitest-environment node
 *
 * 「属性和位置一次就能拿全」的回归。
 *
 * 2026-09-11 盒子自己的 agent 报的：`ue_get_actor` 的 properties 和 transform
 * 是二选一（描述原文「两者是二选一，不会同时返回」），所以「这盏灯在哪 + 它多亮」
 * 必须调两次工具。根因在插件：`actor.inspect` 走一参数版 `BuildActorInfo`，
 * 只有 name/path/class/folder_path；带 transform 的 `BuildActorInfoWithOptions`
 * 只有 `actor.get_info` 在用（UAL_CommandUtils.cpp:1178 / 1218）。
 *
 * 正解是让插件的 inspect 也走 WithOptions；这里先在 TS 侧并发两条 RPC 合并，
 * 因为改插件要重编包，而当时另一个会话正在刷同一个 zip。
 * **插件改完之后这组测试仍然该过** —— 它断言的是对外行为（一次调用两样都有），
 * 不是内部发了几条 RPC。
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

const getActor = (input: unknown): Promise<ToolResult> =>
  (createGetActorTool() as unknown as Executable).execute(input)

const TRANSFORM = {
  location: { x: 100, y: 200, z: 300 },
  rotation: { pitch: 0, yaw: 90, roll: 0 },
  scale: { x: 1, y: 1, z: 1 }
}

/** inspect 回属性（不带 transform），get_info 回 transform —— 和插件现状一致 */
function mockBothCommands(): void {
  callRequest.mockImplementation(async (method: string) => {
    if (method === 'actor.inspect') {
      return {
        count: 1,
        actors: [
          {
            name: 'PointLight_1',
            path: '/Game/Maps/Test.Test:PersistentLevel.PointLight_1',
            class: 'PointLight',
            props: { Intensity: 5000 }
          }
        ]
      }
    }
    return {
      count: 1,
      total_found: 1,
      actors: [
        {
          name: 'PointLight_1',
          path: '/Game/Maps/Test.Test:PersistentLevel.PointLight_1',
          class: 'PointLight',
          transform: TRANSFORM
        }
      ]
    }
  })
}

const methodsCalled = (): string[] => callRequest.mock.calls.map((c) => c[0] as string)

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_get_actor：属性和位置一次拿全', () => {
  it('给了 properties 时，返回里既有 props 也有 transform', async () => {
    mockBothCommands()

    const r = await getActor({
      targets: { names: ['PointLight_1'] },
      properties: ['Intensity']
    })

    expect(r.success).toBe(true)
    const actors = r.actors as Array<Record<string, unknown>>
    expect(actors[0]!.props).toMatchObject({ Intensity: 5000 })
    expect(actors[0]!.transform).toMatchObject(TRANSFORM)
  })

  it('明说不要位置（return_transform: false）时不去查 transform', async () => {
    mockBothCommands()

    await getActor({
      targets: { names: ['PointLight_1'] },
      properties: ['Intensity'],
      return_transform: false
    })

    expect(methodsCalled()).toEqual(['actor.inspect'])
  })

  /**
   * 位置是附加信息：取它的那一条挂了，属性值还得照常回来。
   * 反过来做（整次判失败）等于让一个次要字段绑架主结果。
   */
  it('取 transform 的那条 RPC 失败时，属性照常返回', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'actor.inspect') {
        return {
          count: 1,
          actors: [
            {
              name: 'PointLight_1',
              path: '/Game/Maps/Test.Test:PersistentLevel.PointLight_1',
              class: 'PointLight',
              props: { Intensity: 5000 }
            }
          ]
        }
      }
      throw new Error('引擎超时')
    })

    const r = await getActor({
      targets: { names: ['PointLight_1'] },
      properties: ['Intensity']
    })

    expect(r.success).toBe(true)
    const actors = r.actors as Array<Record<string, unknown>>
    expect(actors[0]!.props).toMatchObject({ Intensity: 5000 })
    expect(actors[0]!.transform).toBeUndefined()
  })

  /**
   * 按 path 合并，不按名字。同名 Actor 在不同关卡/子关卡里是可能的，
   * 按名字合会把 A 的位置安到 B 头上 —— 而那种错读起来完全正常。
   */
  it('两条返回的顺序不同时，按 path 对上而不是按下标', async () => {
    const base = '/Game/Maps/Test.Test:PersistentLevel.'
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'actor.inspect') {
        return {
          count: 2,
          actors: [
            { name: 'A', path: `${base}A`, class: 'PointLight', props: { Intensity: 1 } },
            { name: 'B', path: `${base}B`, class: 'PointLight', props: { Intensity: 2 } }
          ]
        }
      }
      // 顺序故意反过来
      return {
        count: 2,
        total_found: 2,
        actors: [
          {
            name: 'B',
            path: `${base}B`,
            class: 'PointLight',
            transform: { ...TRANSFORM, location: { x: 2, y: 0, z: 0 } }
          },
          {
            name: 'A',
            path: `${base}A`,
            class: 'PointLight',
            transform: { ...TRANSFORM, location: { x: 1, y: 0, z: 0 } }
          }
        ]
      }
    })

    const r = await getActor({ targets: { filter: {} }, properties: ['Intensity'] })

    const actors = r.actors as Array<Record<string, unknown>>
    const byName = Object.fromEntries(actors.map((a) => [a.name as string, a]))
    expect((byName.A!.transform as typeof TRANSFORM).location.x).toBe(1)
    expect((byName.B!.transform as typeof TRANSFORM).location.x).toBe(2)
  })
})
