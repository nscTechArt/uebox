/**
 * 设置控件属性工具
 * 通过 WebSocket 向虚幻引擎插件发送 widget.set_property 命令
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
/**
 * 插件那侧认的全部属性名（`UAL_WidgetCommands.cpp` 的 `Handle_SetProperty`）。
 *
 * 抽成常量是为了让**报错里那句话**和 schema 用同一份 —— 两边各写一遍的下场是
 * 某天加了属性只改了 schema，而模型失败时读到的还是旧清单。
 */
const SUPPORTED_PROPERTIES = [
  'Text',
  'Visibility',
  'IsEnabled',
  'ToolTipText',
  'Percent',
  // 字号和对齐。原来没有入口，文档只写「设不了」，于是做 HUD 的时候
  // 调用方被逼去 Python 里绕（`widget_tree` 是 protected、CDO 上找不到控件，
  // 要按 `:WidgetTree.控件名` 的对象路径 load 才行）—— 一个字号四次往返。
  // 插件里各加一个分支就完了，不该让模型去写脚本。
  'FontSize',
  'Justification',
  // 颜色类。做 UI 绕不开 —— 「做一个红色血条」原来直接办不到。
  // ProgressBar 用 FillColorAndOpacity，TextBlock/Image 用 ColorAndOpacity，
  // Border 用 BrushColor；引擎侧三个名字都认，按控件类型分派。
  'FillColorAndOpacity',
  'ColorAndOpacity',
  'BrushColor'
] as const

const SetPropertySchema = z.object({
  path: z.string().describe('Widget Blueprint 路径'),
  widget_name: z.string().describe('控件名称'),
  property_name: z.enum(SUPPORTED_PROPERTIES).describe('属性名称'),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      // 颜色是对象：{ r, g, b, a }，分量取 0..1（不是 0..255）
      z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional().default(1)
      })
    ])
    .describe('属性值。颜色类属性传 { r, g, b, a }，分量 0..1')
})

interface SetPropertyResponse {
  ok: boolean
  widget_name: string
  property_name: string
  message: string
  /**
   * 插件把失败原因写在这里 —— 由 WebSocket 那层从 code>=400 的响应里补上
   * （`services/websocket/server.ts` 的 `routeMessage`）。原来这个字段被丢掉，
   * 模型只拿到「设置属性失败」六个字：不知道是控件没找到、类型不对，
   * 还是这个控件本来就不支持这个属性 —— 三种情况下一步完全不同。
   */
  error?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function setPropertyTool() {
  return defineV2Tool({
    description: `设置 Widget 控件的属性值。

【支持的属性】：
- Text: TextBlock 的文本内容（字符串）
- Visibility: 可见性（Visible/Hidden/Collapsed）
- IsEnabled: 是否启用（布尔值）
- ToolTipText: 提示文本（字符串）
- Percent: ProgressBar 的百分比（0.0-1.0）
- FontSize: 字号（数字，如 34）。TextBlock / RichTextBlock
- Justification: 水平对齐，Left / Center / Right。文本类控件
  （TextBlock / RichTextBlock / EditableText / EditableTextBox）
- FillColorAndOpacity: ProgressBar 的填充色
- ColorAndOpacity: TextBlock / Image 的着色
- BrushColor: Border 的底色
  颜色一律传 { r, g, b, a }，分量是 **0..1 浮点**，不是 0..255

【还是设不了的】圆角、背景笔刷贴图、字体资产本身（FontSize 只改大小，不换字体）。
碰到这类要求照实说「这几项现在设不了」，别报一个只做了一半的控件说做完了。

【这里设的是设计期默认值】不是运行时的值。游戏跑起来要变的文字和数值，
必须在蓝图图表里改（TextBlock.SetText / ProgressBar.SetPercent），
**不要**用 KismetSystemLibrary 的 SetTextPropertyByName 那类反射写字段的节点 ——
那种写法字段值会变、屏幕不会重画。

【适用场景】：
- 设置默认文本
- 配置初始可见性
- 设置进度条默认值`,

    inputSchema: SetPropertySchema,

    execute: async (input) => {
      if (!input || !input.path || !input.widget_name || !input.property_name) {
        return { ok: false, error: '缺少必填参数', widget_name: 'unknown' }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return { ok: false, error: '没有连接的虚幻引擎项目', path: input.path }
      }

      try {
        const response = await wsService.callRequest<SetPropertyResponse>(
          'widget.set_property',
          input,
          getTargetConnectionId()
        )

        if (!response || !response.ok) {
          return {
            ok: false,
            error: response?.error || '设置属性失败',
            widget_name: input.widget_name,
            property_name: input.property_name,
            hint:
              `这个工具只认 ${SUPPORTED_PROPERTIES.join(' / ')}，而且分控件类型：` +
              `Percent 只有 ProgressBar 有，FontSize 只有 TextBlock / RichTextBlock 有，` +
              `Justification 要文本类控件，颜色只支持 ProgressBar / TextBlock / Image / Border。` +
              `先用 widget_get_hierarchy 确认 "${input.widget_name}" 存在、是哪个类。` +
              `圆角、背景笔刷这些不在列表里的样式属性这个工具设不了，别换个名字再试。`
          }
        }

        return {
          ok: true,
          widget_name: response.widget_name,
          property_name: response.property_name,
          message: response.message
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
