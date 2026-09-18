/**
 * 改一个已经放好的控件在父容器里的槽位（位置、尺寸、对齐、内边距）。
 *
 * ## 为什么补
 *
 * 槽位参数原来**只能在添加控件的那一刻给**（`widget_add_child`）。加完之后
 * 想把按钮往下挪 20 像素、把血条拉宽、给列表项加点内边距 —— 一个都做不到，
 * 唯一的办法是把控件删了按新参数重加，而重加会丢掉它身上已经设过的属性、
 * 事件绑定和变量标记。
 *
 * 插件侧 `widget.set_canvas_slot` / `widget.set_vertical_slot` 两条命令一直在，
 * 从来没有任何 TS 调用点。做 UI 是「摆上去 → 看一眼 → 挪一挪」的循环，
 * 缺了「挪一挪」这一步，模型只能一次摆对，摆不对就重来。
 *
 * ## 一个工具，两条命令
 *
 * 槽位类型由**父容器**决定，控件自己说了不算：CanvasPanel 里的控件有
 * 锚点/位置/尺寸/Z 序，VerticalBox 里的有尺寸规则/内边距/对齐。所以这里按
 * 给了哪一组参数决定发哪条命令 —— 模型不需要先搞清楚「我这个控件的槽位叫什么」。
 *
 * 两组一起给是**矛盾的输入**（一个控件只在一个容器里），直接报错，
 * 不猜其中一组 —— 猜错的话另一组悄悄不生效，而返回值看着是成功的。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { serviceManager } from '../../../../services'
import { getTargetConnectionId } from '../../../core/projectTargetContext'

/** CanvasPanel 槽位专属 */
const CANVAS_KEYS = ['anchors', 'position', 'size', 'alignment', 'z_order'] as const
/** VerticalBox 槽位专属 */
const BOX_KEYS = ['size_rule', 'padding', 'h_align', 'v_align'] as const

const SetSlotSchema = z.object({
  path: z.string().describe('Widget Blueprint 路径，如 /Game/UI/WBP_MainMenu'),
  widget_name: z.string().describe('要调整的控件名（widget_get_hierarchy 里能看到）'),

  // ── CanvasPanel 槽位 ───────────────────────────────────────────────────
  anchors: z
    .string()
    .optional()
    .describe(
      'CanvasPanel: 锚点预设。TopLeft / TopCenter / TopRight / CenterLeft / Center / ' +
        'CenterRight / BottomLeft / BottomCenter / BottomRight / StretchHorizontal / ' +
        'StretchVertical / Stretch'
    ),
  position: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('CanvasPanel: 相对锚点的位置偏移（像素）'),
  size: z
    .object({ width: z.number(), height: z.number() })
    .optional()
    .describe('CanvasPanel: 控件尺寸（像素）'),
  alignment: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('CanvasPanel: 控件自身的对齐支点，0~1。0.5/0.5 = 以中心为准，居中时要设它'),
  z_order: z.number().optional().describe('CanvasPanel: 层级，大的盖在上面'),

  // ── VerticalBox 槽位 ──────────────────────────────────────────────────
  size_rule: z
    .enum(['Auto', 'Fill'])
    .optional()
    .describe('VerticalBox: Auto = 按内容大小，Fill = 占满剩余空间'),
  padding: z
    .object({
      left: z.number().optional(),
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional()
    })
    .optional()
    .describe('VerticalBox: 内边距。没给的边按 0 算'),
  h_align: z.enum(['Fill', 'Left', 'Center', 'Right']).optional().describe('VerticalBox: 水平对齐'),
  v_align: z.enum(['Fill', 'Top', 'Center', 'Bottom']).optional().describe('VerticalBox: 垂直对齐')
})

interface SetSlotResponse {
  ok: boolean
  widget_name?: string
  slot_type?: string
  slot_data?: Record<string, unknown>
  error?: string
}

export function setSlotTool(): V2Tool {
  return defineV2Tool({
    description: `调整已有控件在父容器里的槽位：位置、尺寸、对齐、内边距、层级。

【什么时候用】控件已经加进去了，但摆得不对 —— 往下挪一点、拉宽一点、居中、
  加点内边距、让它盖在别的东西上面。**不用删了重加**：重加会丢掉它身上已经
  设过的属性、事件绑定和变量标记。
【参数分两组，按父容器选一组】
- 控件在 CanvasPanel 里：anchors / position / size / alignment / z_order
- 控件在 VerticalBox 里：size_rule / padding / h_align / v_align
  两组一起给会直接报错 —— 一个控件只在一个容器里，混着给说明搞错了它在哪。
【居中要连 alignment 一起设】只设 anchors: "Center" 是把控件的**左上角**放到中心；
  要真正居中还得 alignment: { x: 0.5, y: 0.5 }。
【不知道控件在哪个容器里】先 widget_get_hierarchy 看一眼树。
【只给要改的】没给的槽位属性保持原样。`,

    inputSchema: SetSlotSchema,

    execute: async (input) => {
      if (!input?.path || !input?.widget_name) {
        return { ok: false, error: '缺少必填参数 path 或 widget_name' }
      }

      const canvas = CANVAS_KEYS.filter((key) => input[key] !== undefined)
      const box = BOX_KEYS.filter((key) => input[key] !== undefined)

      if (canvas.length === 0 && box.length === 0) {
        return {
          ok: false,
          error:
            '没有给任何要改的槽位属性。CanvasPanel 里的控件用 anchors/position/size/alignment/z_order，' +
            'VerticalBox 里的用 size_rule/padding/h_align/v_align。'
        }
      }
      if (canvas.length > 0 && box.length > 0) {
        return {
          ok: false,
          error:
            `同时给了 CanvasPanel 的参数（${canvas.join('、')}）和 VerticalBox 的参数（${box.join('、')}）——` +
            '一个控件只在一个容器里，这两组不可能同时生效。先用 widget_get_hierarchy 看清它的父容器是哪个，再只给那一组。'
        }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return { ok: false, error: '没有连接的虚幻引擎项目', path: input.path }
      }

      const isCanvas = canvas.length > 0
      const command = isCanvas ? 'widget.set_canvas_slot' : 'widget.set_vertical_slot'
      const keys = isCanvas ? canvas : box
      const params: Record<string, unknown> = {
        path: input.path,
        widget_name: input.widget_name
      }
      for (const key of keys) params[key] = input[key]

      try {
        const response = await wsService.callRequest<SetSlotResponse>(
          command,
          params,
          getTargetConnectionId()
        )

        if (!response || !response.ok) {
          // 「不在这种容器里」是这里最常见的失败，插件的原话就说清楚了是哪种，
          // 原样带出去比换成一句「设置失败」有用得多
          return {
            ok: false,
            error: response?.error || '设置槽位失败',
            widget_name: input.widget_name,
            hint: '如果错误说控件不在这种容器里，用 widget_get_hierarchy 确认它的父容器，再换另一组参数。'
          }
        }

        return {
          ok: true,
          widget_name: response.widget_name ?? input.widget_name,
          slot_type: response.slot_type ?? (isCanvas ? 'CanvasPanelSlot' : 'VerticalBoxSlot'),
          slot_data: response.slot_data,
          message: `控件 "${input.widget_name}" 的槽位已更新：${keys.join('、')}`
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
