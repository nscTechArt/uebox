/**
 * @vitest-environment node
 *
 * 控件工具失败时**必须把插件的原话带出去**。
 *
 * 2026-09-16 的反馈里，一次 `BrushColor` 设置失败回给模型的全部信息是
 * 「widget_set_property 失败：设置属性失败」六个字 —— 而插件那边其实
 * 写清楚了原因（控件没找到 / 这个控件不支持颜色 / 颜色要传对象）。
 * 中间这一层把诊断扔了，模型只能改个参数再猜一轮。
 *
 * 失败原因由 WebSocket 层从 code>=400 的响应补进 `error` 字段
 * （`services/websocket/server.ts` 的 `routeMessage`），工具只要不丢它。
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
vi.mock('../../contextImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contextImage')>()),
  compressForContext: vi.fn(async () => ({ data: 'ZmFrZQ==', mimeType: 'image/jpeg' }))
}))
vi.mock('fs', () => ({ promises: { readFile: vi.fn(async () => Buffer.from('png')) } }))

import { addChildTool } from './addChild'
import { createWidgetTool } from './createWidget'
import { makeVariableTool } from './makeVariable'
import { previewWidgetTool } from './previewWidget'
import { setPropertyTool } from './setProperty'

type Runner = (input: Record<string, unknown>) => Promise<Record<string, unknown>>

const runner =
  (tool: { execute?: unknown }): Runner =>
  (input) =>
    (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

/** 插件报错长这样：ok=false + error 是那句有用的原话 */
const PLUGIN_REFUSAL = {
  ok: false,
  error:
    '控件 Bd_Panel（SizeBox）不支持颜色设置，目前支持 ProgressBar / TextBlock / Image / Border。',
  code: 400
}

beforeEach(() => {
  getConnectionCount.mockReset().mockReturnValue(1)
  callRequest.mockReset().mockResolvedValue(PLUGIN_REFUSAL)
})

describe('插件说了为什么失败，工具就不许只说「失败了」', () => {
  it('widget_set_property', async () => {
    const r = await runner(setPropertyTool())({
      path: '/Game/UI/WBP_ScoreHUD',
      widget_name: 'Bd_Panel',
      property_name: 'BrushColor',
      value: { r: 0.04, g: 0.05, b: 0.09, a: 0.55 }
    })

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('不支持颜色设置')
    expect(String(r.error)).not.toBe('设置属性失败')
  })

  it('widget_add_child', async () => {
    const r = await runner(addChildTool())({
      path: '/Game/UI/WBP_ScoreHUD',
      parent_name: 'Root',
      control_type: 'TextBlock',
      name: 'Txt_Score'
    })

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('不支持颜色设置')
  })

  it('widget_create', async () => {
    const r = await runner(createWidgetTool())({ name: 'WBP_ScoreHUD', path: '/Game/UI' })

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('不支持颜色设置')
  })

  it('widget_make_variable', async () => {
    const r = await runner(makeVariableTool())({
      path: '/Game/UI/WBP_ScoreHUD',
      widget_name: 'Txt_Score'
    })

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('不支持颜色设置')
  })

  it('widget_preview', async () => {
    const r = await runner(previewWidgetTool())({ path: '/Game/UI/WBP_ScoreHUD' })

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('不支持颜色设置')
  })
})

describe('插件一个字都没说时才用兜底文案', () => {
  it('回一个空对象也不能崩，兜底句子照样给', async () => {
    callRequest.mockResolvedValue({ ok: false })

    const r = await runner(setPropertyTool())({
      path: '/Game/UI/WBP_ScoreHUD',
      widget_name: 'Bd_Panel',
      property_name: 'BrushColor',
      value: { r: 0, g: 0, b: 0, a: 1 }
    })

    expect(r.error).toBe('设置属性失败')
  })
})

describe('设不了的属性要当场说清楚，别让模型换个名字再试', () => {
  it('失败时把「认哪些属性、去哪儿确认控件类型」写进 hint', async () => {
    const r = await runner(setPropertyTool())({
      path: '/Game/UI/WBP_ScoreHUD',
      widget_name: 'Bd_Panel',
      property_name: 'BrushColor',
      value: { r: 0, g: 0, b: 0, a: 1 }
    })

    expect(String(r.hint)).toContain('BrushColor')
    expect(String(r.hint)).toContain('widget_get_hierarchy')
    // 真的没有入口的那几项要直说别再试
    expect(String(r.hint)).toContain('圆角')
  })

  /**
   * 工具不许比后端窄：插件认 FontSize / Justification，schema 就必须收。
   * 这两项原来没有入口，调用方只能绕 Python 设字号。
   */
  it('字号和对齐能发下去，参数不被 schema 挡掉', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      widget_name: 'Txt_Score',
      property_name: 'FontSize',
      message: 'Set FontSize to: 34'
    })

    const r = await runner(setPropertyTool())({
      path: '/Game/UI/WBP_ScoreHUD',
      widget_name: 'Txt_Score',
      property_name: 'FontSize',
      value: 34
    })

    expect(r.ok).toBe(true)
    expect(callRequest.mock.calls[0][0]).toBe('widget.set_property')
    expect(callRequest.mock.calls[0][1]).toMatchObject({
      property_name: 'FontSize',
      value: 34
    })
  })

  it('Justification 同理', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      widget_name: 'Txt_Score',
      property_name: 'Justification',
      message: 'Set Justification to: Left'
    })

    const r = await runner(setPropertyTool())({
      path: '/Game/UI/WBP_ScoreHUD',
      widget_name: 'Txt_Score',
      property_name: 'Justification',
      value: 'Left'
    })

    expect(r.ok).toBe(true)
    expect(callRequest.mock.calls[0][1]).toMatchObject({ property_name: 'Justification' })
  })
})
