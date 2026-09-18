/**
 * @vitest-environment node
 *
 * 「旋转必须自己说出它朝哪」的契约测试。
 *
 * 背景是一次真机事故：从零搭湖景别墅，方向光被设成 (Pitch=30, Yaw=180, Roll=-135)。
 * UE 里 pitch 为正是仰照，光从地底往上打，画面整体发灰；roll 对方向光毫无意义。
 * 用户点了两次才纠正过来。
 *
 * 守的不是「有人把正负号搞反了」，而是**当时为什么查不出来**：旋转类返回体是三个
 * 裸数字，`pitch=30` 读成「太阳高度 30°」完全合理，于是自检只能做成「填的和读回的
 * 一致吗」—— 一致，但同错。和米/厘米那次是同一类结构性失明。
 *
 * 所以断言三件事：
 * 1. 换算本身对（公式逐字来自引擎，测几个已知答案）；
 * 2. 方向光 pitch 为正时，回读 message 里**必须**出现 ⚠️；
 * 3. 调用方可以只说「太阳在哪」，由工具换成正确的负 pitch。
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
import {
  describeCameraAim,
  describeDirection,
  describeOrientation,
  describeOrientations,
  directionToRotator,
  orientationWorthReporting,
  rotatorToAxes,
  rotatorToSun,
  sunToRotator
} from '../../ueOrientation'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }
const run = (tool: unknown, input: unknown): Promise<ToolResult> =>
  (tool as Executable).execute(input)

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('换算本身（UE 约定）', () => {
  it('零旋转：正面朝 +X，顶面朝 +Z', () => {
    const { forward, right, up } = rotatorToAxes({ pitch: 0, yaw: 0, roll: 0 })
    expect(forward).toEqual({ x: 1, y: 0, z: 0 })
    expect(close(right.y, 1)).toBe(true)
    expect(close(up.z, 1)).toBe(true)
  })

  it('pitch 为正是抬头：+X 翘向天上', () => {
    const { forward } = rotatorToAxes({ pitch: 30, yaw: 0, roll: 0 })
    expect(forward.z).toBeGreaterThan(0)
  })

  it('yaw=90 朝 +Y；roll=-90 让顶面转到 -Y（雾卡片就是这样立起来的）', () => {
    expect(close(rotatorToAxes({ yaw: 90 }).forward.y, 1)).toBe(true)
    const { up } = rotatorToAxes({ pitch: 0, yaw: 0, roll: -90 })
    expect(close(up.y, -1)).toBe(true)
    expect(close(up.z, 0)).toBe(true)
  })

  it('事故当天的方向光：太阳在地平线以下 30°', () => {
    const sun = rotatorToSun({ pitch: 30, yaw: 180, roll: -135 })
    expect(sun.elevation).toBe(-30)
  })

  it('sun → rotator 给的是负 pitch，且能原样反算回来', () => {
    const rot = sunToRotator({ elevation: 8, azimuth: 300 })
    expect(rot.pitch).toBe(-8)
    expect(rot.roll).toBe(0)
    const back = rotatorToSun(rot)
    expect(close(back.elevation, 8, 0.1)).toBe(true)
    expect(close(back.azimuth, -60, 0.1)).toBe(true) // 300° 归一到 (-180, 180]
  })

  it('face_direction 让 +X 指过去，roll 归零；零向量拒绝', () => {
    expect(directionToRotator({ x: -1, y: 0, z: 0 })).toEqual({ pitch: 0, yaw: 180, roll: 0 })
    expect(directionToRotator({ x: 0, y: 0, z: -1 })).toEqual({ pitch: -90, yaw: 0, roll: 0 })
    expect(directionToRotator({ x: 0, y: 0, z: 0 })).toBeNull()
  })

  it('方向说成轴名而不是东南西北', () => {
    expect(describeDirection({ x: -0.87, y: -0.5, z: 0 })).toBe('朝 -X 偏 -Y 30°，水平')
    expect(describeDirection({ x: 0.98, y: 0, z: -0.14 })).toBe('朝 +X 方向，向下 8°')
  })
})

describe('翻成人话', () => {
  it('方向光 pitch 为正：⚠️ 光从地底往上照', () => {
    const r = describeOrientation({ pitch: 30, yaw: 180, roll: -135 }, 'DirectionalLight')
    expect(r.sun?.below_horizon).toBe(true)
    expect(r.text).toContain('⚠️')
    expect(r.text).toContain('地平线以下')
    expect(r.warnings.join(' ')).toContain('pitch 必须是负数')
    expect(r.warnings.join(' ')).toContain('roll=-135')
  })

  it('方向光 pitch=-8：黄昏低角度，不报警', () => {
    const r = describeOrientation({ pitch: -8, yaw: -30, roll: 0 }, 'DirectionalLight')
    expect(r.warnings).toEqual([])
    expect(r.text).toContain('太阳高度角 8°')
    expect(r.text).toContain('黄昏')
    expect(r.sun?.below_horizon).toBe(false)
  })

  it('聚光灯/相机说照向哪', () => {
    const r = describeOrientation({ pitch: -90, yaw: 0, roll: 0 }, 'SpotLight')
    expect(r.text).toContain('照向/看向')
    expect(r.text).toContain('几乎垂直向下')
  })

  it('普通 Actor 说正面和顶面；roll=-90 的平面是「竖立着」', () => {
    const r = describeOrientation({ pitch: 0, yaw: 0, roll: -90 }, 'StaticMeshActor')
    expect(r.text).toContain('正面(+X)')
    expect(r.text).toContain('竖立着')
    expect(r.text).toContain('-Y')
  })

  it('只转了 yaw 的普通道具不值得说；灯永远值得说', () => {
    expect(orientationWorthReporting({ pitch: 0, yaw: 45, roll: 0 }, 'StaticMeshActor')).toBe(false)
    expect(orientationWorthReporting({ pitch: 0, yaw: 0, roll: 0 }, 'PointLight')).toBe(true)
    expect(orientationWorthReporting(undefined, 'PointLight')).toBe(false)
  })

  it('批量摘要把 ⚠️ 的排在前面，并按上限截断', () => {
    const text = describeOrientations(
      [
        { name: 'Sun_OK', class: 'DirectionalLight', rotation: { pitch: -45, yaw: 0, roll: 0 } },
        { name: 'Sun_Bad', class: 'DirectionalLight', rotation: { pitch: 20, yaw: 0, roll: 0 } },
        { name: 'Prop', class: 'StaticMeshActor', rotation: { pitch: 0, yaw: 90, roll: 0 } }
      ],
      1
    )
    expect(text.indexOf('Sun_Bad')).toBeGreaterThan(-1)
    expect(text).not.toContain('Sun_OK')
    expect(text).toContain('还有 1 个未列出')
  })

  it('相机：仰视 34° 要提醒画面多半是天空', () => {
    const text = describeCameraAim({ pitch: 33.6, yaw: 0, roll: 0 })
    expect(text).toContain('仰视 34°')
    expect(text).toContain('天空')
    expect(describeCameraAim({ pitch: -12, yaw: 90, roll: 0 })).toContain('俯视 12°')
    expect(describeCameraAim(undefined)).toBe('')
  })
})

describe('ue_set_transform', () => {
  it('sun 换成负 pitch 发给插件，语义键不透传', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [
        {
          name: 'Sun',
          class: 'DirectionalLight',
          location: { x: 0, y: 0, z: 0 },
          rotation: { pitch: -8, yaw: 120, roll: 0 }
        }
      ]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Sun'] },
      operation: { set: { sun: { elevation: 8, azimuth: 300 } } }
    })

    expect(result.success).toBe(true)
    const sent = callRequest.mock.calls[0][1] as { operation: Record<string, unknown> }
    expect(sent.operation.set).toEqual({ rotation: { pitch: -8, yaw: 120, roll: 0 } })
    expect(sent.operation).not.toHaveProperty('sun')
    expect(result.resolved_rotation).toEqual({ pitch: -8, yaw: 120, roll: 0 })
    expect(String(result.message)).toContain('太阳高度角 8°')
  })

  it('也接受 operation 顶层的 face_direction', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [{ name: 'Fog', class: 'StaticMeshActor', rotation: { pitch: 0, yaw: 180, roll: 0 } }]
    })

    await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Fog'] },
      operation: { face_direction: { x: -1, y: 0, z: 0 } }
    })

    const sent = callRequest.mock.calls[0][1] as { operation: Record<string, unknown> }
    expect(sent.operation).toEqual({ set: { rotation: { pitch: 0, yaw: 180, roll: 0 } } })
  })

  it('sun 和 rotation 同时给直接拒绝，不猜听谁的', async () => {
    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Sun'] },
      operation: { set: { sun: { elevation: 8 }, rotation: { pitch: 30 } } }
    })
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('只能给一个')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('sun.elevation ≤ 0 在入口就拦下', async () => {
    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Sun'] },
      operation: { sun: { elevation: -10 } }
    })
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('地平线以下')
  })

  it('直接写 rotation 把方向光设成仰照，回读 message 必须带 ⚠️', async () => {
    // 事故现场：填进去 pitch=30，引擎原样收下、原样回读
    callRequest.mockResolvedValue({
      count: 1,
      actors: [
        {
          name: 'Sun',
          class: 'DirectionalLight',
          location: { x: 0, y: 0, z: 0 },
          rotation: { pitch: 30, yaw: 180, roll: -135 }
        }
      ]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Sun'] },
      operation: { set: { rotation: { pitch: 30, yaw: 180, roll: -135 } } }
    })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('⚠️')
    expect(String(result.message)).toContain('地平线以下')
    expect(String(result.message)).toContain('roll=-135')
  })

  it('只挪位置不动旋转，就不刷朝向', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [
        {
          name: 'Sun',
          class: 'DirectionalLight',
          location: { x: 0, y: 0, z: 500 },
          rotation: { pitch: 30, yaw: 0, roll: 0 }
        }
      ]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Sun'] },
      operation: { add: { location: { z: 500 } } }
    })

    expect(String(result.message)).not.toContain('朝向')
  })
})

describe('ue_get_actor', () => {
  it('方向光带 orientation 字段，pitch 为正标 ⚠️；只转 yaw 的道具不带', async () => {
    callRequest.mockResolvedValue({
      count: 2,
      total_found: 2,
      actors: [
        {
          name: 'Sun',
          path: '/s',
          class: 'DirectionalLight',
          transform: {
            location: { x: 0, y: 0, z: 0 },
            rotation: { pitch: 30, yaw: 180, roll: 0 },
            scale: { x: 1, y: 1, z: 1 }
          }
        },
        {
          name: 'Chair',
          path: '/c',
          class: 'StaticMeshActor',
          transform: {
            location: { x: 0, y: 0, z: 0 },
            rotation: { pitch: 0, yaw: 45, roll: 0 },
            scale: { x: 1, y: 1, z: 1 }
          }
        }
      ]
    })

    const result = await run(createGetActorTool(), { targets: { filter: {} } })
    const actors = result.actors as Array<{ name: string; orientation?: string }>

    expect(actors[0].orientation).toContain('⚠️')
    expect(actors[0].orientation).toContain('地平线以下')
    expect(actors[1].orientation).toBeUndefined()
  })
})

describe('ue_spawn_actor', () => {
  it('生成方向光时给了仰照的 rotation，message 里当场标 ⚠️', async () => {
    // 插件不保证回 transform，所以按发出去的 rotation 说；类名从 created 拿
    callRequest.mockResolvedValue({
      success: true,
      count: 1,
      created: [{ name: 'DirectionalLight_1', class: 'DirectionalLight' }]
    })

    const result = await run(createSpawnActorTool(), {
      asset_id: 'directional_light',
      rotation: { pitch: 30, yaw: 180, roll: 0 }
    })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('⚠️')
    expect(String(result.message)).toContain('DirectionalLight_1')
  })

  it('没给 rotation 就不加这一句', async () => {
    callRequest.mockResolvedValue({ success: true, count: 1, created: [] })
    const result = await run(createSpawnActorTool(), { asset_id: 'cube' })
    expect(String(result.message)).not.toContain('朝向')
  })
})
