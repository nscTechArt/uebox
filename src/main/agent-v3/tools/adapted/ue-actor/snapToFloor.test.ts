/**
 * @vitest-environment node
 *
 * 「贴地必须说出到底贴上了没有」的契约测试。
 *
 * 背景：把角色放到街面上，`snap_to_floor` 三种写法
 * 全废 —— 按工具说明单独给直接 400，写进 `set` 里则报成功而位置一动不动。
 * 调用方只能去读周围道具的包围盒反推地面高度。
 *
 * 真因和「射线打不到碰撞」这个直觉不同：插件那边用的是
 * `GEditor->Exec(TEXT("SNAPTOFLOOR"))`，而引擎里根本没有这条 Exec 命令
 * （`SnapToFloor` 是 LevelEditor 的 UI 命令，绑 End 键），Exec 返回 false
 * 然后什么都不做。
 *
 * 所以这里守三件事 —— 都是**产品行为**，不是格式：
 * 1. 单独给 snap_to_floor 是一条合法操作，不能被工具层拦掉；
 * 2. 贴上了要说落在哪、挪了多少；
 * 3. **没贴上必须显式说「位置没有变」**，否则调用方读到 success 就当贴好了。
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

import { createSetTransformUnifiedTool } from './setTransformUnified'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }
const run = (tool: unknown, input: unknown): Promise<ToolResult> =>
  (tool as Executable).execute(input)

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('snap_to_floor 的入口', () => {
  it('单独给 snap_to_floor 就能发出去 —— 工具说明里就是这么写的', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [{ name: 'Soldier', location: { x: 0, y: 0, z: 9 }, snap: { hit: true } }]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Soldier'] },
      operation: { snap_to_floor: true }
    })

    expect(result.success).toBe(true)
    expect(callRequest).toHaveBeenCalledTimes(1)
    const sent = callRequest.mock.calls[0][1] as { operation: Record<string, unknown> }
    expect(sent.operation.snap_to_floor).toBe(true)
  })
})

describe('snap_to_floor 的回读', () => {
  it('贴上了要说落在哪个 z、挪了多少、打到了什么', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [
        {
          name: 'Soldier',
          location: { x: 600, y: -750, z: 9 },
          snap: {
            hit: true,
            channel: 'WorldStatic',
            surface_z: 0,
            moved_dz: -46.4,
            hit_actor: 'Road_01a'
          }
        }
      ]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Soldier'] },
      operation: { snap_to_floor: true }
    })

    const message = String(result.message)
    expect(message).toContain('贴地')
    expect(message).toContain('z=0.0')
    expect(message).toContain('-46.4')
    expect(message).toContain('Road_01a')
  })

  it('没贴上必须说「位置没有变」，并给出下一步', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      snap_missed: 1,
      actors: [
        {
          name: 'Soldier',
          location: { x: 0, y: 0, z: 200 },
          snap: { hit: false, reason: 'no collision below' }
        }
      ]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Soldier'] },
      operation: { set: { location: { z: 200 } }, snap_to_floor: true }
    })

    // 插件确实改了位置，所以整体仍是 success —— 但贴地这一步失败了要看得见
    expect(result.success).toBe(true)
    const message = String(result.message)
    expect(message).toContain('⚠️')
    expect(message).toContain('位置没有变')
    expect(message).toContain('碰撞')
  })

  it('没请求贴地时整段不出现 —— 不给无关的话占上下文', async () => {
    callRequest.mockResolvedValue({
      count: 1,
      actors: [{ name: 'Soldier', location: { x: 0, y: 0, z: 9 } }]
    })

    const result = await run(createSetTransformUnifiedTool(), {
      targets: { names: ['Soldier'] },
      operation: { set: { location: { z: 9 } } }
    })

    expect(String(result.message)).not.toContain('贴地')
  })
})
