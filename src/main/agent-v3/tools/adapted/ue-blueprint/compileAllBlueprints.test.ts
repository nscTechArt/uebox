/**
 * @vitest-environment node
 *
 * `ue_compile_all_blueprints` 的契约。
 *
 * 核心那条和 `ue_save` 是同一个坑：插件用 code>=400 报错时，`callRequest`
 * 归一出来的对象**没有 failures 数组**。不先拦住它，`response.failures.length`
 * 会抛 TypeError；就算不抛，这个函数也会带着一堆 undefined 返回 `success: true`,
 * 把一次失败的调用报成「没有需要编译的蓝图」—— 比崩还糟，模型会接着往下走。
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

import { createCompileAllBlueprintsTool } from './compileAllBlueprints'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown = {}): Promise<ToolResult> =>
  (createCompileAllBlueprintsTool() as unknown as Executable).execute(input)

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('ue_compile_all_blueprints', () => {
  it('正常编译：有错误也算调用成功，是蓝图有问题不是工具有问题', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: '/Game',
      compiled_count: 12,
      error_count: 2,
      warning_count: 1,
      failures: [{ path: '/Game/BP_A', errors: ['boom'] }]
    })

    const result = await run({})

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('编译了 12 个蓝图')
    expect(String(result.summary)).toContain('有问题的 1 个')
  })

  it('全部通过时说全部通过', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      scope: '/Game',
      compiled_count: 3,
      error_count: 0,
      warning_count: 0,
      failures: []
    })

    expect(String((await run({})).summary)).toContain('全部通过')
  })

  it('插件回错误响应（没有 failures 数组）时不崩、也不报成功', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      success: false,
      code: 503,
      error: 'Asset registry is still scanning',
      __rpc: { code: 503 }
    })

    const result = await run({})

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Asset registry')
  })

  it('错误响应连原因都没有时，也要说清是插件回了错误', async () => {
    callRequest.mockResolvedValue({ ok: false, code: 500, __rpc: { code: 500 } })

    const result = await run({})

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('错误响应')
  })

  it('插件没响应时不发假成功', async () => {
    callRequest.mockResolvedValue(undefined)

    expect((await run({})).success).toBe(false)
  })
})
