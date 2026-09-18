/**
 * @vitest-environment node
 *
 * `blueprint_add_variable` 的 `default_value` 这条路，两头都得是真的。
 *
 * 2026-09-16 的用户反馈：八个变量全带着 default_value 报成功、返回里也回显了
 * 填进去的值，CDO 里实际是 0。插件那头当时只写了一句 UE_LOG 就把值丢了，
 * 然后把入参原样抄进响应 —— 回显和落地是两回事，而调用方只看得见回显。
 *
 * 插件已经改成「写不进去就报 400」，这里盯的是 app 这一层别把那句原因吞掉，
 * 以及别再自己编一个「成功」出来。
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

import { createAddBlueprintVariableTool } from './addBlueprintVariable'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createAddBlueprintVariableTool() as unknown as Executable).execute(input)

const INPUT = {
  blueprint_path: '/Game/BP_Door',
  name: 'OpenAngle',
  type: 'float',
  default_value: '90.0'
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('blueprint_add_variable 的默认值', () => {
  it('default_value 要发给插件 —— 剥掉它变量就永远是 0', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door.BP_Door',
      variable: { name: 'OpenAngle', type: 'real', is_array: false, default_value: '90.000000' }
    })

    await run(INPUT)

    const sent = callRequest.mock.calls[0][1] as Record<string, unknown>
    expect(sent.default_value).toBe('90.0')
  })

  /**
   * 回的是引擎读回来的值（90.000000），不是入参的回声（90.0）。
   * 断言它原样透出，免得哪天又在 app 这层「美化」成入参。
   */
  it('回读到的默认值原样透出，不换成入参', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door.BP_Door',
      variable: { name: 'OpenAngle', type: 'real', is_array: false, default_value: '90.000000' }
    })

    const result = await run(INPUT)

    expect(result.success).toBe(true)
    expect((result.variable as Record<string, unknown>).default_value).toBe('90.000000')
  })

  it('插件说默认值没落地时算失败，并把原因带上', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error:
        "Variable 'OpenAngle' was created but its default_value was not applied: 'ninety' is not a valid literal for type 'float'",
      __rpc: { code: 400 }
    })

    const result = await run(INPUT)

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('not a valid literal')
    expect(result.code).toBe(400)
  })
})
