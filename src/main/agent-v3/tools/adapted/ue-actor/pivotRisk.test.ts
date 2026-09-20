/**
 * @vitest-environment node
 *
 * 「你填的是原点，不是几何中心」这句提醒该不该出现。
 *
 * 背景：真机上 19 个白模掩体全部浮空 1~2 米、4 面围墙没围住场地，根因都是一个 ——
 * `location` 填的是网格原点，而原点在几何体的哪儿全看美术（引擎自带 SM_Cube 在角上，
 * 外部资产常在几何中心）。所以「z 填半个高度」对一半的资产是错的，而且摆歪了不报错。
 *
 * 这句话刻意不进工具描述（前缀是每一轮都要付的），只在**这一批真有风险**时挂在回执上。
 * 于是「哪算有风险」就成了唯一的逻辑，这里守的就是它：
 *   外部网格 + 给了 Z → 说；内置几何体、或压根没给 Z → 不说。
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

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }
const run = (input: unknown): Promise<ToolResult> =>
  (createSpawnActorTool() as unknown as Executable).execute(input)

/** 引擎照单全收，回一个和请求等长的 created 列表 */
function mockSpawn(): void {
  callRequest.mockImplementation(async (_method: string, payload: unknown) => {
    const instances = (payload as { instances: unknown[] }).instances
    return {
      count: instances.length,
      created: instances.map((_, i) => ({ name: `Actor_${i}` }))
    }
  })
}

const messageOf = async (input: unknown): Promise<string> =>
  String((await run(input)).message ?? '')

const HINT = '网格原点'

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
  mockSpawn()
})

describe('describePivotRisk：什么时候值得提醒', () => {
  it('外部网格资产 + 给了 Z → 提醒', async () => {
    const message = await messageOf({
      asset_id: '/Game/FPS_Guns/SM_Crate',
      location: { x: 0, y: 0, z: 50 }
    })
    expect(message).toContain(HINT)
  })

  it('显式覆盖 mesh + 给了 Z → 提醒', async () => {
    const message = await messageOf({
      asset_id: 'StaticMeshActor',
      mesh: '/Game/Pack/SM_House',
      transform: { location: { z: 0 } }
    })
    // z: 0 也算「给了 Z」—— 落地摆放正是最常见的那一种
    expect(message).toContain(HINT)
  })

  it('内置几何体不提醒 —— 它的原点在哪是已知的', async () => {
    const message = await messageOf({ asset_id: 'cube', location: { x: 0, y: 0, z: 50 } })
    expect(message).not.toContain(HINT)
  })

  it('没给 Z 就不提醒 —— 没有「按高度算」这一步，也就没这个坑', async () => {
    const message = await messageOf({ asset_id: '/Game/Pack/SM_House' })
    expect(message).not.toContain(HINT)
  })

  it('一批里只要有一个有风险就提醒，而且只说一次', async () => {
    const message = await messageOf({
      instances: [
        { asset_id: 'cube', location: { z: 0 } },
        { asset_id: '/Game/Pack/SM_House', location: { z: 100 } },
        { asset_id: '/Game/Pack/SM_Shed', location: { z: 100 } }
      ]
    })
    expect(message.match(new RegExp(HINT, 'g'))).toHaveLength(1)
  })
})
