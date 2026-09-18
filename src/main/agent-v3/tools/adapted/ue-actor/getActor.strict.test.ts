/**
 * @vitest-environment node
 *
 * `ue_get_actor` 顶层参数必须 strict。
 *
 * 真机上新用户那一轮：模型写了 `{ filter: { class: "BP_JumpPad" } }`，少套了一层
 * targets。顶层宽松校验把 filter 当空气，targets 缺席等于扫全图，于是拿回按字母排的
 * 前 10 个 Actor，模型据此断定「filter 不可靠」。放错位置要当场报错，不能静默变成别的查询。
 */

import { describe, expect, it, vi } from 'vitest'
const { callRequest } = vi.hoisted(() => ({ callRequest: vi.fn() }))

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount: () => 1 })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { createGetActorTool } from './getActor'

type WithSchema = { inputSchema: { safeParse: (input: unknown) => { success: boolean } } }

const schema = (): WithSchema['inputSchema'] =>
  (createGetActorTool() as unknown as WithSchema).inputSchema

describe('ue_get_actor 参数校验', () => {
  it('几何字段携带世界空间和单位，不改原始数字', async () => {
    callRequest.mockResolvedValueOnce({
      count: 1,
      actors: [
        {
          name: 'Cube',
          path: '/Game/L.Cube',
          transform: { location: { x: 123, y: 0, z: 0 } },
          bounds: { x: 100, y: 200, z: 300 }
        }
      ]
    })
    const instance = createGetActorTool() as unknown as {
      execute: (
        input: unknown
      ) => Promise<{ actors: Array<{ geometry: unknown; bounds: unknown }> }>
    }
    const result = await instance.execute({ targets: { names: ['Cube'] }, return_bounds: true })
    expect(result.actors[0].geometry).toEqual({
      space: 'world',
      length_unit: 'cm',
      rotation_unit: 'deg'
    })
    expect(result.actors[0].bounds).toEqual({ x: 100, y: 200, z: 300 })
  })
  it('filter 放在顶层（漏了 targets）直接被拒，不会变成扫全图', () => {
    expect(schema().safeParse({ filter: { class: 'BP_JumpPad' } }).success).toBe(false)
  })

  it('name_pattern 放在 targets 下（漏了 filter）同样被拒', () => {
    expect(schema().safeParse({ targets: { name_pattern: '*Coin*' } }).success).toBe(false)
  })

  it('放对位置照常通过', () => {
    expect(schema().safeParse({ targets: { filter: { class: 'BP_JumpPad' } } }).success).toBe(true)
    expect(schema().safeParse({ targets: { names: ['Coin1'] }, limit: 5 }).success).toBe(true)
  })
})
