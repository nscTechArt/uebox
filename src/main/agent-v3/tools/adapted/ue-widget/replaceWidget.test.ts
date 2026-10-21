/**
 * @vitest-environment node
 *
 * 替换 / 删除控件的回执：第一句说引擎里的事实，没挂好的事件、随之删掉的东西
 * 都要点名（AGENTS.md §5 第 14 条）。样本取自 UE 5.5 真机回执（2026-10-20）。
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

import {
  describeReplaceWidget,
  replaceWidgetTool,
  type ReplaceWidgetResponse
} from './replaceWidget'
import { describeRemoveWidget, removeWidgetTool } from './removeWidget'

type Runner = (input: Record<string, unknown>) => Promise<Record<string, unknown>>
const runner =
  (tool: { execute?: unknown }): Runner =>
  (input) =>
    (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

/** Button → CommonUI 按钮，OnClicked 改挂到 OnButtonBaseClicked，按钮里的字被删 */
const REPLACED: ReplaceWidgetResponse = {
  ok: true,
  widget_name: 'Btn_Login',
  old_class: 'Button',
  new_class: 'WB_NavButton_C',
  parent: 'CanvasPanel_0',
  slot_type: 'CanvasPanelSlot',
  moved_children: [],
  dropped_widgets: [{ name: 'Txt_Login', class: 'TextBlock', text: '登录' }],
  events_moved: [
    {
      from: 'OnClicked',
      to: 'OnButtonBaseClicked',
      ok: true,
      node: 'EventGraph: On Clicked (Btn_Login)'
    }
  ],
  carried_properties: ['Visibility'],
  bindable_events: ['OnButtonBaseClicked', 'OnButtonBaseHovered'],
  editable_properties: 'InText / MinWidth / Style'
}

beforeEach(() => {
  getConnectionCount.mockReset().mockReturnValue(1)
  callRequest.mockReset()
})

describe('widget_replace 回执', () => {
  it('换成了什么、事件挂到哪、删掉的字和该往哪设，一次说清', () => {
    const text = describeReplaceWidget(REPLACED)
    expect(text.split('\n')[0]).toBe('Btn_Login 已从 Button 换成 WB_NavButton_C，位置和布局不变')
    expect(text).toContain('OnClicked → OnButtonBaseClicked')
    expect(text).toContain('「登录」')
    expect(text).toContain('widget_set_property')
    expect(text).toContain('InText')
  })

  it('事件没挂好时第一句就是 ⚠️，点名孤儿引脚', () => {
    const text = describeReplaceWidget({
      ...REPLACED,
      failed_count: 1,
      events_moved: [
        { from: 'OnValueChanged', to: 'OnClicked', ok: false, orphaned_pins: ['Value'] }
      ]
    })
    expect(text.startsWith('⚠️ 部分完成')).toBe(true)
    expect(text).toContain('Value')
  })

  it('插件拒绝时把原话带出去，不说成功', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error:
        'Nothing replaced: Btn_Login has events bound in the graph that WB_NavButton_C does not have: OnClicked. ...'
    })
    const r = await runner(replaceWidgetTool())({
      path: '/Game/UITest/WB_Start',
      widget_name: 'Btn_Login',
      new_type: 'WB_NavButton'
    })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('OnClicked')
  })

  it('event_map 和 drop_children 原样发给插件', async () => {
    callRequest.mockResolvedValue(REPLACED)
    const input = {
      path: '/Game/UITest/WB_Start',
      widget_name: 'Btn_Login',
      new_type: 'WB_NavButton',
      event_map: { OnClicked: 'OnButtonBaseClicked' },
      drop_children: true
    }
    const r = await runner(replaceWidgetTool())(input)
    expect(r.ok).toBe(true)
    expect(callRequest.mock.calls[0][0]).toBe('widget.replace')
    expect(callRequest.mock.calls[0][1]).toMatchObject(input)
  })
})

describe('widget_remove 回执', () => {
  it('连带删掉的子控件和图表节点都点名', () => {
    const text = describeRemoveWidget({
      ok: true,
      widget_name: 'Btn_Del',
      parent: 'CanvasPanel_0',
      removed: [
        { name: 'Btn_Del', class: 'Button' },
        { name: 'Txt_Del', class: 'TextBlock', text: '删' }
      ],
      removed_graph_nodes: ['EventGraph: On Clicked (Btn_Del)']
    })
    expect(text).toContain('连同 1 个子控件')
    expect(text).toContain('On Clicked (Btn_Del)')
    expect(text).toContain('已断开')
  })

  it('图表还在用时插件拒绝，原话带出去', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error:
        'Nothing removed: the graph still uses Btn_Del or its children: EventGraph: On Clicked (Btn_Del). ' +
        'Pass force: true to remove them together with these nodes (logic wired after a removed event stays, disconnected), ' +
        'or move the logic first.'
    })
    const r = await runner(removeWidgetTool())({
      path: '/Game/UITest/WB_Start',
      widget_name: 'Btn_Del'
    })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('force')
  })
})
