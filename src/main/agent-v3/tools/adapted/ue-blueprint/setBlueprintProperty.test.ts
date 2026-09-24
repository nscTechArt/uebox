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

/**
 * 回执只报写完之后引擎里的状态，不回显请求；任何一处失败，第一句都不能是成功。
 *
 * 以前的三个问题：部分失败照样 success:true；编译报错也回 compiled:true；
 * modified_properties 只有名字和类型，写进去的值被夹紧 / 改写了看不出来。
 */
describe('blueprint_set_property 的回执', () => {
  const receipt = (over: Record<string, unknown>): Record<string, unknown> => ({
    ok: true,
    blueprint_path: '/Game/BP_Collectible.BP_Collectible',
    blueprint_name: 'BP_Collectible',
    target_type: 'component',
    component_name: 'Mesh',
    modified_properties: [],
    failed_properties: [],
    compiled: true,
    compile_status: 'UpToDate',
    saved: true,
    undoable: true,
    message: "Set 1 properties on component 'Mesh'",
    ...over
  })

  it('全部写成：success 为 true，每项带插件读回的值而不是请求里的原样', async () => {
    callRequest.mockResolvedValue(
      receipt({
        modified_properties: [{ property: 'Mass', type: 'FloatProperty', value: '100.000000' }]
      })
    )

    const result = await run({ ...INPUT, properties: { Mass: 1e9 } })

    expect(result.success).toBe(true)
    expect(result.modified_properties).toEqual([
      { name: 'Mass', type: 'FloatProperty', value: '100.000000' }
    ])
    expect(result.undoable).toBe(true)
    expect(result).not.toHaveProperty('error')
  })

  it('部分失败：success 为 false，第一行是成败比，写成的那几项和读回值照样给出', async () => {
    callRequest.mockResolvedValue(
      receipt({
        ok: false,
        modified_properties: [{ property: 'Mass', type: 'FloatProperty', value: '5.000000' }],
        failed_properties: [
          { property: 'Bogus', error: 'Property not found', suggestions: ['Bounce'] }
        ],
        message: "1 succeeded / 1 failed on component 'Mesh' - see failed_properties",
        __rpc: { code: 207 }
      })
    )

    const result = await run({ ...INPUT, properties: { Mass: 5, Bogus: 1 } })

    expect(result.success).toBe(false)
    const error = String(result.error)
    expect(error.split('\n')[0]).toBe('1 succeeded / 1 failed')
    expect(error).toContain('Bogus: Property not found')
    expect(String(result.message).split('\n')[0]).toBe('1 succeeded / 1 failed')
    expect(result.modified_properties).toEqual([
      { name: 'Mass', type: 'FloatProperty', value: '5.000000' }
    ])
    expect(result.failed_count).toBe(1)
  })

  it('旧版插件部分失败也回 ok:true —— 照样不算成功', async () => {
    callRequest.mockResolvedValue(
      receipt({
        ok: true,
        modified_properties: [{ property: 'Mass', type: 'FloatProperty' }],
        failed_properties: [{ property: 'Bogus', error: 'Property not found' }],
        message: 'Partially set properties: 1 succeeded, 1 failed'
      })
    )

    const result = await run(INPUT)

    expect(result.success).toBe(false)
    expect(String(result.error).split('\n')[0]).toBe('1 succeeded / 1 failed')
    // 旧插件不带 value，就不编一个出来
    expect(result.modified_properties).toEqual([{ name: 'Mass', type: 'FloatProperty' }])
  })

  it('属性都写成但编译没过：不算成功，并指出编译状态', async () => {
    callRequest.mockResolvedValue(
      receipt({
        ok: false,
        modified_properties: [{ property: 'Mass', type: 'FloatProperty', value: '5.000000' }],
        compiled: false,
        compile_status: 'Error'
      })
    )

    const result = await run(INPUT)

    expect(result.success).toBe(false)
    const lines = String(result.error).split('\n')
    expect(lines[0]).toBe('1 succeeded / 0 failed')
    expect(lines[1]).toContain('编译未通过（Error）')
    expect(result.compiled).toBe(false)
  })

  it('auto_compile:false 时 compiled:false 是预期，不算失败', async () => {
    callRequest.mockResolvedValue(
      receipt({
        modified_properties: [{ property: 'Mass', type: 'FloatProperty', value: '5.000000' }],
        compiled: false,
        compile_status: undefined
      })
    )

    const result = await run({ ...INPUT, auto_compile: false })

    expect(result.success).toBe(true)
  })

  it('没存下盘：不算成功', async () => {
    callRequest.mockResolvedValue(
      receipt({
        ok: false,
        modified_properties: [{ property: 'Mass', type: 'FloatProperty', value: '5.000000' }],
        saved: false
      })
    )

    const result = await run(INPUT)

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('未能保存到磁盘')
  })
})
