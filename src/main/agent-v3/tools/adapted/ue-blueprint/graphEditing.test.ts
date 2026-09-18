/**
 * @vitest-environment node
 *
 * `blueprint_delete_node` / `blueprint_disconnect_pins` 的契约测试。
 *
 * 两个都是薄透传，所以测的是「透传对不对」：打的是哪条 RPC、参数有没有被吃掉、
 * 失败有没有被当成成功（薄工具最容易在最后这条上出事）。
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

import { createDeleteBlueprintNodeTool, createDisconnectBlueprintPinsTool } from './graphEditing'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const del = (input: unknown): Promise<ToolResult> =>
  (createDeleteBlueprintNodeTool() as unknown as Executable).execute(input)
const disconnect = (input: unknown): Promise<ToolResult> =>
  (createDisconnectBlueprintPinsTool() as unknown as Executable).execute(input)

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('blueprint_delete_node', () => {
  it('走 blueprint.delete_node，参数原样透传', async () => {
    callRequest.mockResolvedValue({ ok: true, node_id: 'abc' })

    const result = await del({ blueprint_path: '/Game/BP_Door', node_id: 'abc' })

    expect(callRequest.mock.calls[0][0]).toBe('blueprint.delete_node')
    expect(callRequest.mock.calls[0][1]).toEqual({
      blueprint_path: '/Game/BP_Door',
      node_id: 'abc'
    })
    expect(result.success).toBe(true)
  })

  it('插件说失败就是失败，不吞成成功', async () => {
    callRequest.mockResolvedValue({ ok: false, error: 'Node not found with ID: abc' })

    const result = await del({ blueprint_path: '/Game/BP_Door', node_id: 'abc' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Node not found')
  })
})

describe('blueprint_disconnect_pins', () => {
  it('走 blueprint.disconnect_pins，只断一根时把另一端也带上', async () => {
    callRequest.mockResolvedValue({ ok: true, broken: 1, remaining: 2 })

    const result = await disconnect({
      blueprint_path: '/Game/BP_Door',
      node_id: 'n1',
      pin: 'execute',
      other_node_id: 'n2',
      other_pin: 'then'
    })

    expect(callRequest.mock.calls[0][0]).toBe('blueprint.disconnect_pins')
    expect(callRequest.mock.calls[0][1]).toMatchObject({
      node_id: 'n1',
      pin: 'execute',
      other_node_id: 'n2',
      other_pin: 'then'
    })
    expect(result.broken).toBe(1)
  })

  /** 「确保这里是断的」要能直接调，本来就没线不是错误 */
  it('本来就没接线（broken=0）仍然算成功', async () => {
    callRequest.mockResolvedValue({ ok: true, broken: 0, remaining: 0 })

    const result = await disconnect({
      blueprint_path: '/Game/BP_Door',
      node_id: 'n1',
      pin: 'Target'
    })

    expect(result.success).toBe(true)
    expect(result.broken).toBe(0)
  })

  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await disconnect({ blueprint_path: '/Game/BP_Door', node_id: 'n1', pin: 'then' })

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})
