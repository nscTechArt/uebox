/**
 * @vitest-environment node
 *
 * 「只写一个轴的缩放，另外两个轴不能变成 0」的回归。
 *
 * 2026-09-11 由盒子自己的 agent 在读自己的工具 schema 时发现：`ScaleSchema` 三个轴
 * 的默认值都写着 0，而描述写的是「1 = 原始大小」。一个倍率的默认值是 0，两种读法
 * 都说得通（「没给」还是「压扁」），它自己也分不出来，所以每次都显式填三个轴。
 *
 * 实际后果比「描述矛盾」重：**适配层会用 Zod 的 default 补齐缺失的键**
 * （`adaptV2Tool.ts` 里 `schema.parse(params)`，注释写明「V2 的 execute 依赖那些
 * 默认值」）。于是 `scale: { x: 2 }` 这种最自然的写法（「把它 X 方向拉长两倍」）
 * 到了 execute 手里是 `{ x: 2, y: 0, z: 0 }`，插件照着 `SetActorScale3D(2, 0, 0)`
 * 一执行，物体被压成一张纸。
 *
 * 这个错**自检查不出来**：回读也是「X 被放大了」，不盯着视口发现不了另外两个轴
 * 没了。和 units.test.ts 守的那次百倍缩放事故是同一类 —— 参数看着对，语义整个是错的。
 *
 * ## 为什么这个测试必须走 adaptV2Tool
 *
 * 直接 `createSpawnActorTool().execute(...)` 拿到的是**没过 Zod 的裸输入**，
 * 默认值一个都不会填，bug 复现不出来（第一版就这么写的，六条断言过了三条，
 * 差点把「已修复」报成「本来就没问题」）。模型走的是适配层那条路，测试也必须走。
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

import { adaptV2Tool, type V2Tool } from '../../adaptV2Tool'
import { createSpawnActorTool } from './spawnActor'

/** 和注册表里一样地适配一次 —— 模型走的就是这条路 */
const spawn = (input: unknown): Promise<unknown> =>
  adaptV2Tool(createSpawnActorTool() as unknown as V2Tool, {
    name: 'ue_spawn_actor',
    namespace: 'ue.actor',
    risk: 'mutating'
  }).execute('test-call', input)

/** 发给插件的那一份 payload 里，这次生成用的 scale */
function sentScale(): Record<string, number> | undefined {
  expect(callRequest).toHaveBeenCalled()
  const p = callRequest.mock.calls[0]![1] as Record<string, unknown>
  const instance = Array.isArray(p.instances)
    ? (p.instances[0] as Record<string, unknown> | undefined)
    : undefined
  const from = (o?: Record<string, unknown>): Record<string, number> | undefined =>
    (o?.scale as Record<string, number> | undefined) ??
    ((o?.transform as Record<string, unknown> | undefined)?.scale as
      | Record<string, number>
      | undefined)
  return from(instance) ?? from(p)
}

beforeEach(() => {
  // 回读必须真的回出创建了几个 —— 工具明写「不回读不许报 success」
  callRequest.mockReset().mockResolvedValue({ ok: true, count: 1, created: [{ name: 'Cube_1' }] })
  getConnectionCount.mockReturnValue(1)
})

describe('ue_spawn_actor 的缩放默认值', () => {
  it('只给 x 时，y/z 是 1（原始大小），不是 0（压扁）', async () => {
    await spawn({ asset_id: 'Cube', name: 'Cube_1', scale: { x: 2 } })

    const scale = sentScale()
    expect(scale).toBeDefined()
    expect(scale!.x).toBe(2)
    // 这两条是整个测试的意义所在：0 会把物体压成一张纸
    expect(scale!.y).toBe(1)
    expect(scale!.z).toBe(1)
  })

  it('三个轴都给时原样透传', async () => {
    await spawn({ asset_id: 'Cube', name: 'Cube_1', scale: { x: 2, y: 3, z: 4 } })

    expect(sentScale()).toMatchObject({ x: 2, y: 3, z: 4 })
  })

  it('明确要压扁时（显式写 0）照办 —— 默认值不能把用户的 0 改掉', async () => {
    await spawn({ asset_id: 'Cube', name: 'Cube_1', scale: { x: 1, y: 1, z: 0 } })

    expect(sentScale()).toMatchObject({ x: 1, y: 1, z: 0 })
  })

  it('嵌套 transform 形态下同样成立', async () => {
    await spawn({ asset_id: 'Cube', name: 'Cube_1', transform: { scale: { z: 5 } } })

    expect(sentScale()).toMatchObject({ x: 1, y: 1, z: 5 })
  })

  /**
   * 模型是照着 JSON Schema 里的 `default` 推理的，所以那份声明本身也要守：
   * 描述写着「1 = 原始大小」而 schema 声明 default 0，模型两边都读得到。
   */
  it('暴露给模型的 JSON Schema 里，缩放的默认值也是 1', () => {
    const tool = adaptV2Tool(createSpawnActorTool() as unknown as V2Tool, {
      name: 'ue_spawn_actor',
      namespace: 'ue.actor',
      risk: 'mutating'
    })
    const scale = (
      tool.parameters as {
        properties: { scale: { properties: Record<string, { default?: number }> } }
      }
    ).properties.scale.properties

    expect(scale.x.default).toBe(1)
    expect(scale.y.default).toBe(1)
    expect(scale.z.default).toBe(1)
  })

  /**
   * 位置和旋转的 0 是**对的**（原点、不转），不能跟着一起改。
   * 这条在这里，是为了防止以后有人看到上面几条就把三个 schema 一起「修」了。
   */
  it('位置的默认值仍然是 0', async () => {
    await spawn({ asset_id: 'Cube', name: 'Cube_1', location: { x: 100 } })

    const p = callRequest.mock.calls[0]![1] as Record<string, unknown>
    const instance = Array.isArray(p.instances)
      ? (p.instances[0] as Record<string, unknown>)
      : undefined
    const location = (instance?.location ??
      (instance?.transform as Record<string, unknown> | undefined)?.location ??
      p.location ??
      (p.transform as Record<string, unknown> | undefined)?.location ??
      {}) as Record<string, number>
    expect(location.x).toBe(100)
    expect(location.y).toBe(0)
    expect(location.z).toBe(0)
  })
})
