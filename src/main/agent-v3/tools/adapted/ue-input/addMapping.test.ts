/**
 * @vitest-environment node
 *
 * `ue_input_add_mapping` 的契约：没传的字段不透传（引擎按「有没有 axis_scale」分动作 / 轴），
 * 回执跟着引擎读回来的走，没存上盘第一段就要说。
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

import { createInputAddMappingTool } from './addMapping'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createInputAddMappingTool() as unknown as Executable).execute(input)

const lastParams = (): Record<string, unknown> =>
  (callRequest.mock.calls.at(-1) as [string, Record<string, unknown>])[1]

const ENHANCED_OK = {
  ok: true,
  system: 'enhanced',
  context_path: '/Game/Input/IMC_Default.IMC_Default',
  action_path: '/Game/Input/IA_Interact.IA_Interact',
  value_type: 'Boolean',
  key: 'E',
  action_created: true,
  already_mapped: false,
  saved: true,
  keys: [{ key: 'E' }]
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_input_add_mapping（Enhanced Input）', () => {
  it('发 input.add_mapping，没传的字段不发', async () => {
    callRequest.mockResolvedValue(ENHANCED_OK)
    await run({
      key: 'E',
      context_path: '/Game/Input/IMC_Default',
      action_path: '/Game/Input/IA_Interact'
    })
    expect(callRequest.mock.calls.at(-1)?.[0]).toBe('input.add_mapping')
    expect(lastParams()).toEqual({
      system: 'enhanced',
      key: 'E',
      context_path: '/Game/Input/IMC_Default',
      action_path: '/Game/Input/IA_Interact'
    })
  })

  /** 回执跟着引擎走：引擎读回来这个动作绑着两个键，就报两个 */
  it('回执报引擎读回的键表和值类型，不回显入参', async () => {
    callRequest.mockResolvedValue({
      ...ENHANCED_OK,
      value_type: 'Axis2D',
      action_created: false,
      keys: [{ key: 'W', modifiers: [{ type: 'SwizzleAxis' }] }, { key: 'S' }]
    })
    const r = await run({
      key: 'S',
      context_path: '/Game/Input/IMC_Default',
      action_path: '/Game/Input/IA_Move',
      value_type: 'Boolean'
    })
    expect(r.success).toBe(true)
    expect(String(r.message)).toContain('Axis2D')
    expect(String(r.message)).toContain('W、S')
  })

  it('新建了动作要提醒 IMC 得挂到玩家身上才生效', async () => {
    callRequest.mockResolvedValue(ENHANCED_OK)
    const r = await run({
      key: 'E',
      context_path: '/Game/Input/IMC_Default',
      action_path: '/Game/Input/IA_Interact'
    })
    expect(String(r.message)).toContain('动作是这次新建的')
    expect(String(r.message)).toContain('AddMappingContext')
  })

  it('已经绑着就说没有改动', async () => {
    callRequest.mockResolvedValue({ ...ENHANCED_OK, already_mapped: true, action_created: false })
    const r = await run({
      key: 'E',
      context_path: '/Game/Input/IMC_Default',
      action_path: '/Game/Input/IA_Interact'
    })
    expect(String(r.message)).toContain('没有改动')
  })

  it('没存上盘要说', async () => {
    callRequest.mockResolvedValue({ ...ENHANCED_OK, saved: false })
    const r = await run({
      key: 'E',
      context_path: '/Game/Input/IMC_Default',
      action_path: '/Game/Input/IA_Interact'
    })
    expect(String(r.message)).toContain('没存盘成功')
  })

  it('引擎拒绝时把 details（如已有的 IMC 列表）带回去', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: '找不到输入映射上下文（IMC）：/Game/IMC_X',
      details: { contexts: ['/Game/Input/IMC_Default'] }
    })
    const r = await run({
      key: 'E',
      context_path: '/Game/IMC_X',
      action_path: '/Game/Input/IA_Interact'
    })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('找不到输入映射上下文')
    expect(r.details).toEqual({ contexts: ['/Game/Input/IMC_Default'] })
  })
})

describe('ue_input_add_mapping（旧输入系统）', () => {
  it('轴映射带 axis_scale，动作映射不带', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      system: 'legacy',
      kind: 'action',
      name: 'Jump',
      key: 'SpaceBar',
      already_mapped: false,
      config_saved: true,
      keys: ['SpaceBar']
    })
    await run({ system: 'legacy', name: 'Jump', key: 'SpaceBar' })
    expect(lastParams()).toEqual({ system: 'legacy', name: 'Jump', key: 'SpaceBar' })
  })

  it('没写进 DefaultInput.ini 要说清后果', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      system: 'legacy',
      kind: 'axis',
      name: 'MoveForward',
      key: 'S',
      already_mapped: false,
      config_saved: false,
      keys: [
        { key: 'W', scale: 1 },
        { key: 'S', scale: -1 }
      ]
    })
    const r = await run({ system: 'legacy', name: 'MoveForward', key: 'S', axis_scale: -1 })
    expect(String(r.message)).toContain('没写进 Config/DefaultInput.ini')
    expect(String(r.message)).toContain('W(1)、S(-1)')
  })
})
