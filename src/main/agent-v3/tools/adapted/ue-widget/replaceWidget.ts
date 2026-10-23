/**
 * 把现成界面里的一个控件原地换成另一种（编辑器右键「替换为」，但不丢图表）。
 * 通过 WebSocket 向虚幻引擎插件发送 widget.replace 命令
 *
 * ## 为什么要有
 *
 * 控件工具原来全按「从零搭新界面」做：建、加、摆、设、预览。用户拿来的多半是
 * 现成的界面，要的是「把登录按钮换成导航那种」—— 原来只能在旁边加一个新的，
 * 旧的删不掉、点击事件接不过去，最后让用户自己去编辑器里改。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { WIDGET_TYPE_HINT } from './widgetTypes'

const ReplaceWidgetSchema = z.object({
  path: z.string().describe('Widget Blueprint 路径，如 /Game/UI/WB_StartScreen'),
  widget_name: z.string().describe('要换掉的控件名'),
  new_type: z.string().min(1).describe(`换成什么。${WIDGET_TYPE_HINT}`),
  event_map: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      '旧控件上绑的事件 → 新类上的事件，如 { "OnClicked": "OnButtonBaseClicked" }。' +
        '新类有同名事件的不用写；没有的必须写，否则插件拒绝并列出新类能绑的事件'
    ),
  drop_children: z
    .boolean()
    .optional()
    .describe(
      '新类装不下旧控件里的子控件（Button 里的文字，换成不带插槽的用户控件）时，确认连它们一起删'
    )
})

interface EventMove {
  from: string
  to: string
  ok: boolean
  node?: string
  orphaned_pins?: string[]
  error?: string
}

export interface ReplaceWidgetResponse {
  ok: boolean
  widget_name: string
  old_class: string
  new_class: string
  new_class_path?: string
  parent: string
  slot_type?: string
  is_variable?: boolean
  moved_children?: string[]
  /** 跟着旧控件一起删掉的子孙。TextBlock 带 text，好把字搬到新控件上 */
  dropped_widgets?: { name: string; class: string; text?: string }[]
  removed_graph_nodes?: string[]
  events_moved?: EventMove[]
  variable_references?: string[]
  dropped_bindings?: string[]
  carried_properties?: string[]
  bindable_events?: string[]
  /** 新控件在实例上能设的属性，「 / 」分隔。按钮文字之类就在这里 */
  editable_properties?: string
  failed_count?: number
  /** 插件写的失败原因，由 WebSocket 那层从 code>=400 的响应补上 */
  error?: string
}

/**
 * 回执第一句说引擎里的事实（AGENTS.md §5 第 14 条）：换成了什么、事件挂上没有、
 * 删了什么。有事件没挂好就以 ⚠️ 开头。
 */
export function describeReplaceWidget(r: ReplaceWidgetResponse): string {
  const events = r.events_moved ?? []
  const failed = events.filter((e) => !e.ok)
  const lines: string[] = []

  const head = `${r.widget_name} 已从 ${r.old_class} 换成 ${r.new_class}，位置和布局不变`
  lines.push(
    failed.length > 0
      ? `⚠️ 部分完成：${head}，但 ${failed.length} 个事件没挂好：` +
          failed
            .map((e) =>
              e.orphaned_pins?.length
                ? `${e.from} → ${e.to}（新事件没有 ${e.orphaned_pins.join('、')} 引脚，原来连着的线成了孤儿引脚，要重连）`
                : `${e.from} → ${e.to}（${e.error ?? '未给原因'}）`
            )
            .join('；')
      : head
  )

  const moved = events.filter((e) => e.ok)
  if (moved.length > 0) {
    lines.push(
      `事件已改挂，后面连的逻辑没断：${moved.map((e) => (e.from === e.to ? e.from : `${e.from} → ${e.to}`)).join('、')}`
    )
  }
  if (r.moved_children?.length) {
    lines.push(`子控件已搬到新控件里：${r.moved_children.join('、')}`)
  }
  const dropped = r.dropped_widgets ?? []
  if (dropped.length > 0) {
    const texts = dropped.filter((w) => w.text !== undefined).map((w) => `「${w.text}」`)
    lines.push(
      `随旧控件删掉：${dropped.map((w) => `${w.name}（${w.class}）`).join('、')}` +
        (texts.length
          ? `。原来显示的文字 ${texts.join('、')} 要用 widget_set_property 设到新控件上（见下面的可设属性）`
          : '')
    )
  }
  if (r.removed_graph_nodes?.length) {
    lines.push(`图表里随之删掉的节点：${r.removed_graph_nodes.join('、')}`)
  }
  if (r.dropped_bindings?.length) {
    lines.push(`新类没有这些可绑属性，属性绑定已去掉：${r.dropped_bindings.join('、')}`)
  }
  if (r.variable_references?.length) {
    lines.push(
      `图表里读写它的节点已按新类型重建：${r.variable_references.join('、')}。` +
        '调了旧类专有函数的会在编译时报错，跑一次 blueprint_compile 确认'
    )
  }
  if (r.editable_properties && r.editable_properties !== '(none)') {
    lines.push(`新控件在实例上能设的属性：${r.editable_properties}`)
  }
  return lines.join('\n')
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function replaceWidgetTool() {
  return defineV2Tool({
    description: `把现成界面里的一个控件原地换成另一种，和编辑器右键「替换为」一样，但不丢图表。

保留：名字、槽位（位置 / 锚点 / 尺寸 / 对齐 / 边距）、显隐、可用、提示、透明度、渲染变换。
新类装得下的子控件搬过去。绑在旧控件上的事件改挂到新类的事件上，后面连的逻辑不断。

【常见用法】普通 Button 换成工程里的 CommonUI 按钮（WB_Text_Button 这类）：
1. widget_get_hierarchy 看清旧控件名、里面有什么
2. widget_replace，new_type 写控件蓝图名。Button 的 OnClicked 在 CommonUI 按钮上叫
   OnButtonBaseClicked，要写 event_map；不写插件会拒绝并列出新类能绑的事件
3. 新按钮不带插槽时，旧 Button 里的 TextBlock 装不下，要 drop_children=true；
   回执会给出那段文字和新控件能设的属性（如 InText），用 widget_set_property 设上
4. blueprint_compile，再 widget_preview 看效果

插件拒绝时什么都没改，照它说的补参数再调。`,

    inputSchema: ReplaceWidgetSchema,

    execute: async (input) => {
      if (!input || !input.path || !input.widget_name || !input.new_type) {
        return { ok: false, error: '缺少必填参数 path / widget_name / new_type' }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return { ok: false, error: '没有连接的虚幻引擎项目', path: input.path }
      }

      try {
        const response = await wsService.callRequest<ReplaceWidgetResponse>(
          'widget.replace',
          input,
          getTargetConnectionId()
        )

        if (!response || !response.ok) {
          return {
            ok: false,
            error: response?.error || '替换控件失败',
            widget_name: input.widget_name
          }
        }

        return {
          message: describeReplaceWidget(response),
          ok: true,
          widget_name: response.widget_name,
          old_class: response.old_class,
          new_class: response.new_class,
          ...(response.failed_count ? { failed_count: response.failed_count } : {}),
          ...(response.events_moved?.length ? { events_moved: response.events_moved } : {}),
          ...(response.dropped_widgets?.length
            ? { dropped_widgets: response.dropped_widgets }
            : {}),
          ...(response.bindable_events?.length ? { bindable_events: response.bindable_events } : {})
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          widget_name: input.widget_name
        }
      }
    }
  })
}
