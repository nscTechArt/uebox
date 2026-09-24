/**
 * @vitest-environment node
 *
 * `blueprint_create` 的回执要跟着引擎走（AGENTS.md §5 第 14 条）。
 *
 * 两处审计出来的问题：组件属性没写进去 / 没存上盘时 warnings 只躺在 JSON 里，
 * 文案一律「创建成功」；同名蓝图已存在时，回执里的 parent_class 是请求值、
 * path 是 folder + name 拼的 —— 已有的是 Pawn，回执却说是 Actor。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: { getWebSocketService: () => ({ callRequest, getConnectionCount }) }
}))
vi.mock('../../../core/projectTargetContext', () => ({ getTargetConnectionId: () => 'conn-1' }))

import { createBlueprintTool } from './createBlueprint'

type Result = Record<string, unknown>
const run = (input: unknown): Promise<Result> =>
  (createBlueprintTool() as unknown as { execute: (i: unknown) => Promise<Result> }).execute(input)
const firstLine = (r: Result): string => String(r.message).split('\n')[0]

const CREATED = {
  ok: true,
  name: 'BP_Lamp',
  path: '/Game/Blueprints/BP_Lamp.BP_Lamp',
  parent_class: 'Actor',
  generated_class: '/Game/Blueprints/BP_Lamp.BP_Lamp_C',
  saved: true,
  components: [
    { name: 'DefaultSceneRoot', class: 'SceneComponent', attach_to: '' },
    { name: 'Bulb', class: 'PointLightComponent', attach_to: 'DefaultSceneRoot' }
  ],
  warnings: []
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('新建', () => {
  it('全部办成时照常说创建了，父类报引擎的', async () => {
    callRequest.mockResolvedValue(CREATED)

    const r = await run({ name: 'BP_Lamp', parent_class: 'Actor' })

    expect(r.success).toBe(true)
    expect(String(r.message)).not.toContain('⚠️')
    expect(String(r.message)).toContain('父类 Actor')
  })

  it('组件属性没写进去、组件被跳过、没存上盘，第一句就说部分完成', async () => {
    callRequest.mockResolvedValue({
      ...CREATED,
      saved: false,
      save_warning: 'The Blueprint exists in memory but could not be written to disk',
      warnings: ['component property not applied - Bulb.Intensity: no such property']
    })

    const r = await run({
      name: 'BP_Lamp',
      components: [
        { component_type: 'PointLightComponent', component_name: 'Bulb' },
        { component_type: 'NoSuchComponent', component_name: 'Ghost' }
      ]
    })

    expect(Object.keys(r)[0]).toBe('message')
    expect(firstLine(r)).toMatch(/^⚠️ 部分完成：3 项成功 \/ 3 项失败/)
    expect(String(r.message)).toContain('Bulb.Intensity')
    expect(String(r.message)).toContain('Ghost')
    expect(String(r.message)).toContain('未能保存')
    expect(r.saved).toBe(false)
    expect(r.save_warning).toBeDefined()
  })
})

describe('同名蓝图已存在', () => {
  const CONFLICT = {
    ok: false,
    error: " '/Game/Blueprints/BP_Door' 下已经存在同名蓝图 'BP_Door'，请更换新的名字或路径。",
    __rpc: { code: 409 }
  }

  it('路径和父类从引擎读回来，父类和请求不同时第一句就说', async () => {
    callRequest.mockResolvedValueOnce(CONFLICT).mockResolvedValueOnce({
      ok: true,
      name: 'BP_Door',
      path: '/Game/Blueprints/BP_Door.BP_Door',
      parent_class: 'Pawn'
    })

    const r = await run({ name: 'BP_Door', parent_class: 'Actor' })

    expect(callRequest.mock.calls[1][0]).toBe('blueprint.describe')
    expect(callRequest.mock.calls[1][1]).toEqual({ blueprint_path: '/Game/Blueprints/BP_Door' })
    expect(r.parent_class).toBe('Pawn')
    expect(r.path).toBe('/Game/Blueprints/BP_Door.BP_Door')
    expect(r.verified).toBe(true)
    expect(firstLine(r)).toMatch(/^⚠️/)
    expect(String(r.message)).toContain('Pawn')
  })

  it('父类一致时不报警', async () => {
    callRequest.mockResolvedValueOnce(CONFLICT).mockResolvedValueOnce({
      ok: true,
      name: 'BP_Door',
      path: '/Game/Blueprints/BP_Door.BP_Door',
      parent_class: 'Actor'
    })

    const r = await run({ name: 'BP_Door', parent_class: 'Actor' })

    expect(String(r.message)).not.toContain('⚠️')
    expect(r.parent_class).toBe('Actor')
  })

  it('读不回来时不拿请求补 parent_class，并明说未核实', async () => {
    callRequest
      .mockResolvedValueOnce(CONFLICT)
      .mockResolvedValueOnce({ ok: false, error: 'not found' })

    const r = await run({ name: 'BP_Door', parent_class: 'Actor', folder: '/Game/Blueprints' })

    expect(r).not.toHaveProperty('parent_class')
    expect(r.verified).toBe(false)
    expect(firstLine(r)).toMatch(/^⚠️/)
    expect(String(r.message)).toContain('未核实')
  })
})
