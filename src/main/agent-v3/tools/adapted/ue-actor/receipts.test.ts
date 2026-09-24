/**
 * @vitest-environment node
 *
 * Actor 写工具回执的契约测试（AGENTS.md §5 第 14 条）。
 *
 * 2026-09-24 的回执审计里这几个工具各有一种「说错了不报错」：
 * - set_transform 回执里写的是插件算出来的目标值，引擎没动也照样说到了；
 * - set_property 全部失败时回 `success: false` 却不带 error，模型看到「失败：成功修改 0 个」；
 * - spawn / destroy 批量里失败的那几项只剩一个 null 或干脆消失，第一句照样是「成功」。
 *
 * 守两件事：回执跟着引擎走（引擎值和入参不同时报引擎值）；有一件没办成，第一句不说成功。
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

import { createSpawnActorTool } from './spawnActor'
import { createSetPropertyTool } from './setProperty'
import { createDestroyActorTool } from './destroyActor'
import { createSetTransformUnifiedTool } from './setTransformUnified'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }
const run = (tool: unknown, input: unknown): Promise<ToolResult> =>
  (tool as Executable).execute(input)

/** 适配层把返回对象整个 JSON 化给模型；第一个键就是模型第一眼看到的东西 */
const firstLine = (result: ToolResult): string => {
  const first = Object.values(result)[0]
  return String(first).split('\n')[0]
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_spawn_actor 批量部分失败', () => {
  it('建出 2 / 3：第一句说部分完成，并列出没建出来的下标和原因', async () => {
    callRequest.mockResolvedValue({
      count: 2,
      failed_count: 1,
      created: [
        { name: 'Cube_A', path: '/Game/L.L:Cube_A', class: 'StaticMeshActor' },
        null,
        { name: 'Cube_C', path: '/Game/L.L:Cube_C', class: 'StaticMeshActor' }
      ],
      failed: [{ index: 1, reason: "could not resolve asset_id '/Game/Nope'" }]
    })

    const result = await run(createSpawnActorTool(), {
      instances: [
        { asset_id: 'cube', name: 'Cube_A' },
        { asset_id: '/Game/Nope', name: 'Cube_B' },
        { asset_id: 'cube', name: 'Cube_C' }
      ]
    })

    expect(result.success).toBe(true)
    expect(firstLine(result)).toBe('⚠️ 部分完成：2 个 Actor 成功 / 1 个 Actor 失败。')
    expect(String(result.message)).toContain('instances[1]（Cube_B）')
    expect(String(result.message)).toContain("could not resolve asset_id '/Game/Nope'")
    expect(result.failed_count).toBe(1)
  })

  it('老插件只留 null 不给原因：照样按 null 的下标数出来', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      created: [null, { name: 'Lamp', path: '/Game/L.L:Lamp', class: 'PointLight' }]
    })

    const result = await run(createSpawnActorTool(), {
      instances: [{ asset_id: 'point_light' }, { asset_id: 'point_light', name: 'Lamp' }]
    })

    expect(firstLine(result)).toBe('⚠️ 部分完成：1 个 Actor 成功 / 1 个 Actor 失败。')
    expect(String(result.message)).toContain('instances[0]')
    expect(String(result.message)).toContain('未给原因')
  })

  it('全部建出来时不加部分完成的开头', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      failed_count: 0,
      created: [{ name: 'Cube', path: '/Game/L.L:Cube', class: 'StaticMeshActor' }]
    })

    const result = await run(createSpawnActorTool(), { asset_id: 'cube' })

    expect(String(result.message)).not.toContain('部分完成')
    expect(result.failed_count).toBeUndefined()
  })

  it('一个都没建出来：失败里带上逐项原因', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      success: false,
      count: 0,
      failed_count: 1,
      created: [null],
      failed: [{ index: 0, reason: "class '/Script/Nope.Nope' could not be loaded" }],
      error: 'No actor spawned (1 requested). First failure: ...'
    })

    const result = await run(createSpawnActorTool(), { class: '/Script/Nope.Nope' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain("class '/Script/Nope.Nope' could not be loaded")
  })
})

describe('ue_set_property', () => {
  it('全部失败：success=false 且 error 里有逐条原因，不再说「成功修改 0 个」', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      success: false,
      count: 0,
      failed_count: 1,
      error: 'No property was applied',
      actors: [
        {
          name: 'Lamp',
          class: 'PointLight',
          path: '/Game/L.L:Lamp',
          errors: [
            { property: 'Intensty', error: 'Property not found', suggestions: ['Intensity'] }
          ]
        }
      ]
    })

    const result = await run(createSetPropertyTool(), {
      targets: { names: ['Lamp'] },
      properties: { Intensty: 5000 }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Lamp.Intensty: Property not found')
    expect(String(result.error)).toContain('Intensity')
    expect(String(result.error)).not.toContain('成功修改')
  })

  it('部分失败：第一句按属性条数说部分完成', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      failed_count: 1,
      actors: [
        {
          name: 'Lamp',
          class: 'PointLight',
          path: '/Game/L.L:Lamp',
          updated: { Intensity: 5000 },
          errors: [{ property: 'Bogus', error: 'Property not found' }]
        }
      ]
    })

    const result = await run(createSetPropertyTool(), {
      targets: { names: ['Lamp'] },
      properties: { Intensity: 5000, Bogus: 1 }
    })

    expect(result.success).toBe(true)
    expect(firstLine(result)).toBe('⚠️ 部分完成：1 项属性成功 / 1 项属性失败。')
    expect(String(result.message)).toContain('Lamp.Bogus：Property not found')
  })

  it('回执里的值跟着引擎走：引擎把 5000 夹成 100 时报 100', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      failed_count: 0,
      actors: [
        {
          name: 'Lamp',
          class: 'PointLight',
          path: '/Game/L.L:Lamp',
          updated: { AttenuationRadius: 100 }
        }
      ]
    })

    const result = await run(createSetPropertyTool(), {
      targets: { names: ['Lamp'] },
      properties: { AttenuationRadius: 5000 }
    })

    const actors = result.actors as Array<{ updated: Record<string, unknown> }>
    expect(actors[0].updated.AttenuationRadius).toBe(100)
    expect(String(result.message)).not.toContain('部分完成')
  })

  it('写进去但读不回来：不冒充回读值，正文点名', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      failed_count: 0,
      actors: [
        {
          name: 'Lamp',
          class: 'PointLight',
          path: '/Game/L.L:Lamp',
          updated: {},
          readback_unavailable: ['IESTexture']
        }
      ]
    })

    const result = await run(createSetPropertyTool(), {
      targets: { names: ['Lamp'] },
      properties: { IESTexture: '/Game/IES/Foo' }
    })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('Lamp.IESTexture')
    expect(String(result.message)).toContain('读不回')
  })

  it('ActorLabel 撞名只是 warning，不算失败', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [
        {
          name: 'Door_1',
          class: 'StaticMeshActor',
          path: '/Game/L.L:Door',
          updated: { ActorLabel: 'Door_1' },
          errors: [
            {
              property: 'ActorLabel',
              warning: 'Name conflict resolved with suffix',
              requested: 'Door',
              actual: 'Door_1'
            }
          ]
        }
      ]
    })

    const result = await run(createSetPropertyTool(), {
      targets: { names: ['Door'] },
      properties: { ActorLabel: 'Door' }
    })

    expect(String(result.message)).not.toContain('部分完成')
    expect(String(result.message)).toContain('实际为 Door_1')
    expect(result.errors).toBeUndefined()
  })
})

describe('ue_destroy_actor 部分失败', () => {
  it('删掉 6 / 7：第一句说部分完成，并点名没删掉的那个', async () => {
    callRequest.mockResolvedValue({
      count: 6,
      target_count: 7,
      failed_count: 1,
      failed: [
        {
          name: 'WorldSettings',
          path: '/Game/L.L:WorldSettings',
          reason: 'the editor refused to destroy this actor'
        }
      ],
      deleted_actors: Array.from({ length: 6 }, (_, i) => ({ name: `Crate_${i}` }))
    })

    const result = await run(createDestroyActorTool(), {
      targets: { filter: { name_pattern: '*' } }
    })

    expect(result.success).toBe(true)
    expect(firstLine(result)).toBe('⚠️ 部分完成：6 个 Actor 成功 / 1 个 Actor 失败。')
    expect(String(result.message)).toContain('WorldSettings：the editor refused')
    expect(String(result.message)).not.toMatch(/^成功删除/)
  })

  it('老插件只给了 count < target_count：照样按差值说部分完成', async () => {
    callRequest.mockResolvedValue({
      count: 6,
      target_count: 7,
      deleted_actors: []
    })

    const result = await run(createDestroyActorTool(), { targets: { names: ['A'] } })

    expect(firstLine(result)).toBe('⚠️ 部分完成：6 个 Actor 成功 / 1 个 Actor 失败。')
  })

  it('全删掉时不加部分完成的开头', async () => {
    callRequest.mockResolvedValue({
      count: 2,
      target_count: 2,
      failed_count: 0,
      deleted_actors: []
    })

    const result = await run(createDestroyActorTool(), { targets: { names: ['A', 'B'] } })

    expect(String(result.message)).toBe('已删除 2 个 Actor')
  })
})

describe('ue_set_transform 回读', () => {
  it('报的是引擎回读值，不是入参', async () => {
    // 请求 z=500，引擎因为挂在父级下只落到了 480
    callRequest.mockResolvedValue({
      count: 0,
      failed_count: 1,
      ok: false,
      success: false,
      error: 'None of the 1 actors reached the requested transform: location did not land',
      failed: [{ name: 'Child', reason: 'location did not land on the requested value' }],
      actors: [
        {
          name: 'Child',
          location: { x: 0, y: 0, z: 480 },
          applied: false,
          requested: { location: { x: 0, y: 0, z: 500 } }
        }
      ]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Child'] },
      operation: { set: { location: { z: 500 } } }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Child：location did not land')
  })

  it('部分没到位：第一句说部分完成，actors 里是引擎值', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      failed_count: 1,
      failed: [{ name: 'NoRoot', reason: 'actor has no root component' }],
      actors: [
        { name: 'Box', location: { x: 0, y: 0, z: 480 } },
        { name: 'NoRoot', location: { x: 0, y: 0, z: 0 }, applied: false }
      ]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Box', 'NoRoot'] },
      operation: { set: { location: { z: 500 } } }
    })

    expect(result.success).toBe(true)
    expect(firstLine(result)).toBe('⚠️ 部分完成：1 个 Actor 成功 / 1 个 Actor 失败。')
    expect(String(result.message)).toContain('成功变换 1 个 Actor：Box')
    expect(String(result.message)).not.toContain('：Box, NoRoot')
    expect(String(result.message)).toContain('NoRoot：actor has no root component')
    const actors = result.actors as Array<{ location: { z: number } }>
    expect(actors[0].location.z).toBe(480)
  })
})
