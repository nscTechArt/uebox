/**
 * @vitest-environment node
 *
 * 控件写工具的回执要跟着引擎走（AGENTS.md §5 第 14 条）。
 *
 * 2026-09-24 审计出来的三处：root_type 认不出来悄悄换成 CanvasPanel 却照抄请求；
 * Visibility 的 SelfHitTestInvisible 被设成 HitTestInvisible、回执照抄输入；
 * add_child 给 VBox 传 anchors、给 Button 传 text、顶掉 Button 原有子控件，全都 ok:true。
 *
 * 模型读的是 JSON 化的返回值，**第一个键**就是它最先读到的那句话，所以这里断言
 * message 排在最前、有问题时以 ⚠️ 开头。
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

import { addChildTool } from './addChild'
import { createWidgetTool } from './createWidget'
import { makeVariableTool } from './makeVariable'
import { setPropertyTool } from './setProperty'

type Result = Record<string, unknown>
const runner =
  (tool: { execute?: unknown }) =>
  (input: Record<string, unknown>): Promise<Result> =>
    (tool.execute as (i: unknown, o: unknown) => Promise<Result>)(input, {})

const firstLine = (r: Result): string => String(r.message).split('\n')[0]

beforeEach(() => {
  getConnectionCount.mockReset().mockReturnValue(1)
  callRequest.mockReset()
})

describe('widget_create', () => {
  const run = runner(createWidgetTool())

  it('root_type 报引擎读回来的类，和请求不同时第一句就说', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      name: 'WBP_Hud',
      path: '/Game/UI/WBP_Hud.WBP_Hud',
      root_type: 'CanvasPanel',
      requested_root_type: 'VerticalBox',
      warning:
        "Requested root_type 'VerticalBox' (VerticalBox) but the root widget is 'CanvasPanel'.",
      saved: true
    })

    const r = await run({ name: 'WBP_Hud', root_type: 'VerticalBox' })

    expect(Object.keys(r)[0]).toBe('message')
    expect(firstLine(r)).toMatch(/^⚠️ 部分完成/)
    expect(r.root_type).toBe('CanvasPanel')
    expect(String(r.message)).toContain('根控件是 CanvasPanel')
  })

  it('没存上盘也算没办成', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      name: 'WBP_Hud',
      path: '/Game/UI/WBP_Hud.WBP_Hud',
      root_type: 'CanvasPanel',
      requested_root_type: 'CanvasPanel',
      saved: false
    })

    const r = await run({ name: 'WBP_Hud' })

    expect(firstLine(r)).toMatch(/^⚠️/)
    expect(String(r.message)).toContain('保存')
    expect(r.saved).toBe(false)
  })

  it('全对时照常说，不带 ⚠️', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      name: 'WBP_Hud',
      path: '/Game/UI/WBP_Hud.WBP_Hud',
      root_type: 'VerticalBox',
      requested_root_type: 'VerticalBox',
      saved: true
    })

    const r = await run({ name: 'WBP_Hud', root_type: 'VerticalBox' })

    expect(String(r.message)).not.toContain('⚠️')
    expect(String(r.message)).toContain('根控件是 VerticalBox')
  })

  it('旧版插件照抄请求的 root_type，不当事实说', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      name: 'WBP_Hud',
      path: '/Game/UI/WBP_Hud.WBP_Hud',
      root_type: 'VerticalBox'
    })

    const r = await run({ name: 'WBP_Hud', root_type: 'VerticalBox' })

    expect(r.root_type_verified).toBe(false)
    expect(String(r.message)).toContain('未核实')
  })
})

describe('widget_add_child', () => {
  const run = runner(addChildTool())

  it('父容器不认的参数和被顶掉的子控件，都摆在最前面', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      name: 'Icon',
      class: 'Image',
      parent: 'StartButton',
      parent_type: 'Button',
      slot_type: 'ContentSlot',
      ignored_fields: ['anchors', 'text'],
      failed_count: 2,
      ignored_note:
        "Not applied: parent 'StartButton' (Button) gives a ContentSlot, which does not take anchors; 'text' only applies to TextBlock, this is a Image - add a TextBlock child to it.",
      replaced_child: { name: 'Label', class: 'TextBlock' }
    })

    const r = await run({
      path: '/Game/UI/WBP_A',
      parent_name: 'StartButton',
      control_type: 'Image',
      anchors: 'Center',
      text: '开始'
    })

    expect(Object.keys(r)[0]).toBe('message')
    expect(firstLine(r)).toMatch(/^⚠️/)
    expect(firstLine(r)).toContain('Label')
    expect(String(r.message)).toContain('部分完成：1 项成功 / 2 项失败')
    expect(String(r.message)).toContain('- anchors：')
    expect(r.ignored_fields).toEqual(['anchors', 'text'])
    expect(r.replaced_child).toEqual({ name: 'Label', class: 'TextBlock' })
  })

  it('文本报的是控件上读回来的', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      name: 'Title',
      class: 'TextBlock',
      parent: 'CanvasPanel_0',
      parent_type: 'CanvasPanel',
      slot_type: 'CanvasPanelSlot',
      text: '开始游戏'
    })

    const r = await run({
      path: '/Game/UI/WBP_A',
      parent_name: 'root',
      control_type: 'TextBlock',
      text: '开始游戏 '
    })

    expect(String(r.message)).not.toContain('⚠️')
    expect(r.text).toBe('开始游戏')
    expect(String(r.message)).toContain('「开始游戏」')
  })

  it('旧版插件不带 ignored_fields 时照常说', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      name: 'Title',
      class: 'TextBlock',
      parent: 'VBox',
      parent_type: 'VerticalBox',
      slot_type: 'VerticalBoxSlot'
    })

    const r = await run({ path: '/Game/UI/WBP_A', parent_name: 'VBox', control_type: 'TextBlock' })

    expect(String(r.message)).toMatch(/^已添加 TextBlock/)
    expect(r).not.toHaveProperty('ignored_fields')
  })
})

describe('widget_set_property', () => {
  const run = runner(setPropertyTool())

  it('引擎读回来的值和请求不一样时，第一句就说引擎里的值', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      widget_name: 'Panel',
      property_name: 'Visibility',
      message: 'Visibility is now: HitTestInvisible',
      value: 'HitTestInvisible'
    })

    const r = await run({
      path: '/Game/UI/WBP_A',
      widget_name: 'Panel',
      property_name: 'Visibility',
      value: 'SelfHitTestInvisible'
    })

    expect(Object.keys(r)[0]).toBe('message')
    expect(firstLine(r)).toMatch(/^⚠️/)
    expect(r.value).toBe('HitTestInvisible')
  })

  it('一致时报读回来的值', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      widget_name: 'Panel',
      property_name: 'Visibility',
      message: 'Visibility is now: Collapsed',
      value: 'Collapsed'
    })

    const r = await run({
      path: '/Game/UI/WBP_A',
      widget_name: 'Panel',
      property_name: 'Visibility',
      value: 'collapsed'
    })

    expect(r.message).toBe('Visibility 现在是 Collapsed')
  })
})

describe('widget_make_variable', () => {
  const run = runner(makeVariableTool())

  it('改名后报引擎读回来的名字和改过来的图表引用数', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      widget_name: 'HPBar',
      old_name: 'ProgressBar_0',
      renamed: true,
      is_variable: true,
      graph_references_found: 3,
      graph_references_renamed: 3,
      graph_references_updated: true
    })

    const r = await run({
      path: '/Game/UI/WBP_HUD',
      widget_name: 'ProgressBar_0',
      variable_name: 'HP Bar'
    })

    expect(Object.keys(r)[0]).toBe('message')
    expect(firstLine(r)).toMatch(/^控件 "ProgressBar_0" 已改名为 "HPBar"/)
    expect(String(r.message)).toContain('请求的是 "HP Bar"')
    expect(String(r.message)).toContain('3 处引用')
    expect(r.widget_name).toBe('HPBar')
    expect(r.graph_references_updated).toBe(true)
  })

  it('有引用没跟着改时第一句就说部分完成，并列出是哪几个节点', async () => {
    callRequest.mockResolvedValue({
      failed_count: 1,
      ok: true,
      widget_name: 'HPBar',
      old_name: 'ProgressBar_0',
      renamed: true,
      is_variable: true,
      graph_references_found: 2,
      graph_references_renamed: 1,
      graph_references_updated: false,
      stale_graph_references: ['EventGraph: Get ProgressBar_0']
    })

    const r = await run({
      path: '/Game/UI/WBP_HUD',
      widget_name: 'ProgressBar_0',
      variable_name: 'HPBar'
    })

    expect(firstLine(r)).toMatch(/^⚠️ 部分完成/)
    expect(firstLine(r)).toContain('1 处引用没跟着改')
    expect(String(r.message)).toContain('- EventGraph: Get ProgressBar_0')
    expect(r.graph_references_updated).toBe(false)
    expect(r.stale_graph_references).toEqual(['EventGraph: Get ProgressBar_0'])
  })

  it('旧版插件只改对象名，不能当成引用也改好了', async () => {
    callRequest.mockResolvedValue({ ok: true, widget_name: 'HPBar', is_variable: true })

    const r = await run({
      path: '/Game/UI/WBP_HUD',
      widget_name: 'ProgressBar_0',
      variable_name: 'HPBar'
    })

    expect(firstLine(r)).toMatch(/^⚠️/)
    expect(String(r.message)).toContain('不改图表引用')
    expect(r).not.toHaveProperty('graph_references_updated')
  })

  it('不改名时只说设成了变量', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      widget_name: 'Txt_Score',
      old_name: 'Txt_Score',
      renamed: false,
      is_variable: true,
      graph_references_found: 0,
      graph_references_renamed: 0,
      graph_references_updated: true
    })

    const r = await run({ path: '/Game/UI/WBP_HUD', widget_name: 'Txt_Score' })

    expect(r.message).toBe('控件 "Txt_Score" 已设为蓝图变量')
    expect(r.is_variable).toBe(true)
  })
})
