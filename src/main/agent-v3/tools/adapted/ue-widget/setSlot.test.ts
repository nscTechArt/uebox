/**
 * @vitest-environment node
 *
 * 改已有控件的槽位。
 *
 * 守三条：按给了哪组参数选对命令、两组混着给要报错（一个控件只在一个容器里，
 * 猜一组的话另一组会悄悄不生效）、失败时把插件的原话带出去。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRequest, getConnectionCount } = vi.hoisted(() => ({
  callRequest: vi.fn(),
  getConnectionCount: vi.fn()
}))

vi.mock('../../../../services', () => ({
  serviceManager: { getWebSocketService: () => ({ getConnectionCount, callRequest }) }
}))
vi.mock('../../../core/projectTargetContext', () => ({ getTargetConnectionId: () => undefined }))

import { setSlotTool } from './setSlot'

const tool = setSlotTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

const sentCommand = (): string => callRequest.mock.calls[0][0] as string
const sentParams = (): Record<string, unknown> =>
  callRequest.mock.calls[0][1] as Record<string, unknown>

beforeEach(() => {
  getConnectionCount.mockReset().mockReturnValue(1)
  callRequest.mockReset().mockResolvedValue({ ok: true, widget_name: 'StartButton' })
})

describe('选对命令', () => {
  it('给 CanvasPanel 那组参数就发 set_canvas_slot', async () => {
    const r = await run({
      path: '/Game/UI/WBP_A',
      widget_name: 'StartButton',
      anchors: 'Center',
      alignment: { x: 0.5, y: 0.5 }
    })

    expect(sentCommand()).toBe('widget.set_canvas_slot')
    expect(sentParams()).toMatchObject({ anchors: 'Center', alignment: { x: 0.5, y: 0.5 } })
    expect(r.ok).toBe(true)
  })

  it('给 VerticalBox 那组参数就发 set_vertical_slot', async () => {
    await run({
      path: '/Game/UI/WBP_A',
      widget_name: 'Row1',
      size_rule: 'Fill',
      padding: { top: 8 }
    })

    expect(sentCommand()).toBe('widget.set_vertical_slot')
    expect(sentParams()).toMatchObject({ size_rule: 'Fill', padding: { top: 8 } })
  })

  it('只把给了的属性发过去 —— 没给的槽位属性保持原样', async () => {
    await run({ path: '/Game/UI/WBP_A', widget_name: 'StartButton', z_order: 3 })

    expect(Object.keys(sentParams()).sort()).toEqual(['path', 'widget_name', 'z_order'])
  })
})

describe('不动手的情况', () => {
  it('两组参数混着给直接报错，不猜一组发出去', async () => {
    const r = await run({
      path: '/Game/UI/WBP_A',
      widget_name: 'StartButton',
      anchors: 'Center',
      size_rule: 'Fill'
    })

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('anchors')
    expect(String(r.error)).toContain('size_rule')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('一个要改的都没给时不空跑一趟', async () => {
    const r = await run({ path: '/Game/UI/WBP_A', widget_name: 'StartButton' })

    expect(r.ok).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('没连引擎时直接说清楚', async () => {
    getConnectionCount.mockReturnValue(0)

    const r = await run({ path: '/Game/UI/WBP_A', widget_name: 'X', z_order: 1 })

    expect(r.ok).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('失败的时候', () => {
  it('把插件那句「不在这种容器里」原样带出去，并说下一步怎么办', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: "Widget 'Row1' is not in a VerticalBox"
    })

    const r = await run({ path: '/Game/UI/WBP_A', widget_name: 'Row1', size_rule: 'Fill' })

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('not in a VerticalBox')
    expect(String(r.hint)).toContain('widget_get_hierarchy')
  })
})
