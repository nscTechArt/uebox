/**
 * @vitest-environment node
 *
 * `blueprint_set_property` 失败时要把**每一条属性为什么失败**转给模型。
 *
 * 真机上的事故：给金币蓝图的 Mesh 设 OverrideMaterials，插件回 400，
 * failed_properties 里写着「could not write '(/Game/Materials/M_CoinGold)' ...」，
 * 工具却只透出「Failed to set any properties」。模型对着这一句换了三种写法，
 * 每次拿到的都是同一句空话。
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

import { createSetBlueprintPropertyTool } from './setBlueprintProperty'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createSetBlueprintPropertyTool() as unknown as Executable).execute(input)

const INPUT = {
  blueprint_path: '/Game/BP_Collectible',
  component_name: 'Mesh',
  properties: { OverrideMaterials: ['/Game/Materials/M_CoinGold'] }
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('blueprint_set_property 的失败原因', () => {
  it('全部失败时逐条带上 failed_properties 里的原因，不只回一句总结', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      message: 'Failed to set any properties',
      modified_properties: [],
      failed_properties: [
        {
          property: 'OverrideMaterials',
          error:
            "could not write '(/Game/Materials/M_CoinGold)' into 'OverrideMaterials' (TArray<UMaterialInterface*>)",
          suggestions: ['OverrideMaterials']
        }
      ],
      __rpc: { code: 400 }
    })

    const result = await run(INPUT)

    expect(result.success).toBe(false)
    const error = String(result.error)
    expect(error).toContain('Failed to set any properties')
    expect(error).toContain('OverrideMaterials')
    expect(error).toContain('could not write')
    expect(result.code).toBe(400)
  })

  it('插件没给 failed_properties 时不编造，只透出它的 message', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      message: 'Blueprint not found',
      __rpc: { code: 404 }
    })

    const result = await run(INPUT)

    expect(result.success).toBe(false)
    expect(String(result.error)).toBe('设置蓝图属性失败：Blueprint not found')
    expect(result).not.toHaveProperty('failed_properties')
  })
})
