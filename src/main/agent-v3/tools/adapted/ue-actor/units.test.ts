/**
 * @vitest-environment node
 *
 * 「位置是厘米」这件事必须出现在返回体里的契约测试。
 *
 * 背景是一次真机事故：按参考图还原场景，23 个 Blender 资产、72 个 Actor，摆完
 * 全堆在原点附近 —— 13 米的建筑以 0.2 米间距挤成一团。根因是布局按米算、UE 按
 * 厘米收，坐标整体缩小 100 倍。
 *
 * 但这里守的不是「有人算错了」，而是**当时为什么查不出来**：位置类返回体是一串
 * 裸数字，`-19.5` 按米读、按厘米读都合理，于是自检只能做成「填的和读回的一致
 * 吗」—— 一致，但同错。自洽性校验对单位错误是结构性失明的。
 *
 * 所以断言的是：跨度必须以**米**出现在 message 里。这是那类错误唯一能被自动看见
 * 的地方，掉了就等于回到事故当天的状态。
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
import { createSetTransformUnifiedTool } from './setTransformUnified'
import { createSpawnActorTool } from './spawnActor'
import { describePlacementScale, formatMeters, toMeters } from '../../ueUnits'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }
const run = (tool: unknown, input: unknown): Promise<ToolResult> =>
  (tool as Executable).execute(input)

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('换算本身', () => {
  it('单个位置报成「厘米 = 米」，100 倍的错一眼可见', () => {
    // 事故当天填进去的就是这个数：本意 19.5 米，实际 19.5 厘米
    expect(describePlacementScale([{ x: -19.5, y: 0, z: 0 }])).toContain('-0.20')
    expect(describePlacementScale([{ x: -19.5, y: 0, z: 0 }])).toContain('厘米')
    expect(describePlacementScale([{ x: -19.5, y: 0, z: 0 }])).toContain('米')
  })

  it('多个位置报跨度，单位是米', () => {
    const text = describePlacementScale([
      { x: 0, y: 0, z: 0 },
      { x: 1950, y: 800, z: 0 }
    ])
    expect(text).toContain('19.50')
    expect(text).toContain('8.00')
    expect(text).toContain('米')
  })

  it('没有位置就不硬凑一句', () => {
    expect(describePlacementScale([])).toBe('')
  })

  it('formatMeters / toMeters 按 100 换算', () => {
    expect(formatMeters({ x: 1300, y: 0, z: 200 })).toBe('13.00 × 0.00 × 2.00 米')
    expect(toMeters({ x: 1300, y: -50, z: 0 })).toEqual({ x: 13, y: -0.5, z: 0 })
  })
})

describe('ue_spawn_actor', () => {
  it('摆完把这批的位置跨度按米报出来', async () => {
    callRequest.mockResolvedValue({ success: true, count: 2, created: [] })

    const result = await run(createSpawnActorTool(), {
      instances: [
        { asset_id: 'cube', transform: { location: { x: 0, y: 0, z: 0 } } },
        { asset_id: 'cube', transform: { location: { x: 2000, y: 0, z: 0 } } }
      ]
    })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('20.00')
    expect(String(result.message)).toContain('米')
  })

  it('用发出去的坐标算，不依赖插件回不回 transform', async () => {
    // created 里什么都没有 —— 真机上插件就不保证回 transform
    callRequest.mockResolvedValue({ success: true, count: 1, created: [{ name: 'Cube_0' }] })

    const result = await run(createSpawnActorTool(), {
      asset_id: 'cube',
      location: { x: -19.5, y: 0, z: 0 }
    })

    expect(String(result.message)).toContain('-0.20')
  })

  it('没给位置就不加这一句，别拿默认原点冒充结果', async () => {
    callRequest.mockResolvedValue({ success: true, count: 1, created: [] })

    const result = await run(createSpawnActorTool(), { asset_id: 'cube' })

    expect(String(result.message)).not.toContain('跨度')
  })
})

describe('ue_get_actor', () => {
  it('读回场景时按米报整体跨度', async () => {
    callRequest.mockResolvedValue({
      count: 2,
      total_found: 2,
      actors: [
        { name: 'A', path: '/a', class: 'C', transform: { location: { x: 0, y: 0, z: 0 } } },
        { name: 'B', path: '/b', class: 'C', transform: { location: { x: 20, y: 0, z: 0 } } }
      ]
    })

    const result = await run(createGetActorTool(), { targets: { filter: {} } })

    // 20 厘米 = 0.2 米：这正是事故现场的样子，一眼就能看出不对
    expect(String(result.message)).toContain('0.20')
  })

  it('计数模式没有 actors，也就不报跨度', async () => {
    callRequest.mockResolvedValue({ count: 0, total_found: 72, actors: [] })

    const result = await run(createGetActorTool(), { targets: { filter: {} }, limit: 0 })

    expect(String(result.message)).not.toContain('跨度')
  })
})

describe('ue_set_transform', () => {
  it('改完按引擎回读的位置报跨度', async () => {
    callRequest.mockResolvedValue({
      count: 2,
      actors: [
        { name: 'A', location: { x: 0, y: 0, z: 0 } },
        { name: 'B', location: { x: 2000, y: 0, z: 0 } }
      ]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { filter: {} },
      operation: { multiply: { location: { x: 100, y: 100, z: 100 } } }
    })

    expect(String(result.message)).toContain('20.00')
  })
})
