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

/** 颜色类属性名。值是 { r, g, b, a }，分量 0..1 */
const COLOR_PROPERTIES = new Set(['FillColorAndOpacity', 'ColorAndOpacity', 'BrushColor'])

const SetPropertySchema = z.object({
  path: z.string().describe('Widget Blueprint 路径'),
  widget_name: z.string().describe('控件名称'),
  // 开放字符串：表里的是有专门处理的常用项，表外的插件按反射找同名属性。
  // 原来是 z.enum，表外的名字在这一层就被拒，插件那边再能干也够不着
  property_name: z
    .string()
    .min(1)
    .describe(
      `属性名。常用：${SUPPORTED_PROPERTIES.join(' / ')}；` +
        '其余写细节面板里的属性名（Background、Brush、WidgetStyle、用户控件的实例可编辑变量如 InText）'
    ),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())])
    .describe(
      '属性值。颜色类传 { r, g, b, a }，分量 0..1；结构体传对象，只写要改的字段；' +
        '也收 UE 文本格式字符串，如 (R=1,G=0,B=0,A=1)'
    )
})

interface SetPropertyResponse {
  ok: boolean
  widget_name: string
  property_name: string
  message: string
  /**
   * 写完从控件上读回来的值（新版插件，目前 Visibility 有）。
   * 回执以它为准，不以请求为准 —— 原来 SelfHitTestInvisible 会被设成
   * HitTestInvisible，而回执照抄输入，谁也发现不了
   */
  value?: unknown
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
    description: `设置 Widget 控件的属性值（设计期默认值，和在细节面板里改一样）。

【常用属性】有专门处理，按控件类型分派：
- Text: TextBlock 的文本内容（字符串）
- Visibility: 可见性，只认 Visible / Collapsed / Hidden / HitTestInvisible / SelfHitTestInvisible
- IsEnabled: 是否启用（布尔值）
- ToolTipText: 提示文本（字符串）
- Percent: ProgressBar 的百分比（0.0-1.0）
- FontSize: 字号（数字，如 34）。TextBlock / RichTextBlock
- Justification: 水平对齐，Left / Center / Right。文本类控件
- FillColorAndOpacity / ColorAndOpacity / BrushColor: 颜色，传 { r, g, b, a }，分量是 **0..1 浮点**

【其余属性】写细节面板里的属性名，插件按反射找到再写：
- 用户控件（WB_Text_Button 这类）上勾了「实例可编辑」的变量，比如按钮文字 InText
- 结构体只写要改的字段，如 Border 圆角：property_name="Background"，
  value={ "DrawAs": "RoundedBox", "OutlineSettings": { "RoundingType": "FixedRadius", "CornerRadii": { "X": 8, "Y": 8, "Z": 8, "W": 8 } } }
- 资产引用写对象路径字符串
不知道叫什么就随便给一个，失败回执会列出这个控件能设的属性名。

【这里设的是设计期默认值】不是运行时的值。游戏跑起来要变的文字和数值，
必须在蓝图图表里改（TextBlock.SetText / ProgressBar.SetPercent），
**不要**用 KismetSystemLibrary 的 SetTextPropertyByName 那类反射写字段的节点 ——
那种写法字段值会变、屏幕不会重画。`,

    inputSchema: SetPropertySchema,

    execute: async (input) => {
      if (!input || !input.path || !input.widget_name || !input.property_name) {
        return { ok: false, error: '缺少必填参数', widget_name: 'unknown' }
      }

      // 颜色给成 0..255 时，插件会把它当成超亮的 HDR 色照写不误，这里先拦下
      const value = input.value as unknown
      if (COLOR_PROPERTIES.has(input.property_name) && value && typeof value === 'object') {
        const channels = ['r', 'g', 'b', 'a'].map((k) => (value as Record<string, unknown>)[k])
        if (channels.some((c) => typeof c === 'number' && (c < 0 || c > 1))) {
          return {
            ok: false,
            error: `颜色分量要 0..1 的浮点，不是 0..255：收到 ${JSON.stringify(value)}`,
            widget_name: input.widget_name,
            property_name: input.property_name
          }
        }
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
              `常用项（${SUPPORTED_PROPERTIES.join(' / ')}）分控件类型：Percent 只有 ProgressBar 有，` +
              `FontSize 只有 TextBlock / RichTextBlock 有，颜色只支持 ProgressBar / TextBlock / Image / Border。` +
              `表外的属性按名字反射写，回执会列出这个控件实际能设的名字，照那张清单改，别凭记忆换名字。` +
              `先用 widget_get_hierarchy 确认 "${input.widget_name}" 存在、是哪个类。`
          }
        }

        // 引擎读回来的值和请求的不一样时，第一句就说（AGENTS.md §5 第 14 条）
        const readBack = response.value
        const requested = input.value
        // 反射写的 float 读回来带单精度尾巴（0.3 → 0.30000001），差得在误差内不算不一致
        const differs =
          readBack !== undefined &&
          (typeof requested === 'number' && typeof readBack === 'number'
            ? Math.abs(readBack - requested) > 1e-4
            : (typeof requested === 'string' ||
                typeof requested === 'number' ||
                typeof requested === 'boolean') &&
              String(readBack).toLowerCase() !== String(requested).toLowerCase())
        const show = (v: unknown): string =>
          v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)
        const message = differs
          ? `⚠️ ${response.property_name} 请求的是 ${show(requested)}，` +
            `引擎里实际是 ${show(readBack)}。${response.message ?? ''}`
          : readBack !== undefined
            ? `${response.property_name} 现在是 ${show(readBack)}`
            : response.message

        return {
          message,
          ok: true,
          widget_name: response.widget_name,
          property_name: response.property_name,
          ...(readBack !== undefined ? { value: readBack } : {})
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
