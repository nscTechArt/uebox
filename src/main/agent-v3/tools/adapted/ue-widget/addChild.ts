/**
 * 向任意容器添加子控件的通用工具
 * 通过 WebSocket 向虚幻引擎插件发送 widget.add_child 命令
 * 自动检测父容器类型并使用正确的添加方式
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { WIDGET_TYPE_HINT } from './widgetTypes'
import { withPartialHeadline } from '../../partialResult'

/** 可选的槽位 / 文本参数。插件按父容器类型只认其中一部分，其余进 ignored_fields */
const OPTIONAL_FIELDS = [
  'anchors',
  'position',
  'size',
  'size_rule',
  'h_align',
  'v_align',
  'padding',
  'text'
] as const

const AddChildSchema = z.object({
  path: z.string().describe('Widget Blueprint 路径，如 /Game/UI/WBP_MainMenu'),
  parent_name: z.string().describe('父容器名称（根容器用 "root"）'),
  control_type: z.string().min(1).describe(`要添加的控件类型。${WIDGET_TYPE_HINT}`),
  name: z.string().optional().describe('控件名称（可选，自动生成）'),
  // CanvasPanel 参数
  anchors: z
    .enum([
      'TopLeft',
      'TopCenter',
      'TopRight',
      'CenterLeft',
      'Center',
      'CenterRight',
      'BottomLeft',
      'BottomCenter',
      'BottomRight',
      'StretchHorizontal',
      'StretchVertical',
      'Stretch'
    ])
    .optional()
    .describe('CanvasPanel: 锚点预设'),
  position: z.object({ x: z.number(), y: z.number() }).optional().describe('CanvasPanel: 位置偏移'),
  size: z
    .object({ width: z.number(), height: z.number() })
    .optional()
    .describe('CanvasPanel: 控件尺寸'),
  // VerticalBox/HorizontalBox 参数
  size_rule: z.enum(['Auto', 'Fill']).optional().describe('布局容器: 尺寸规则'),
  // Overlay/VerticalBox/HorizontalBox 参数
  h_align: z.enum(['Fill', 'Left', 'Center', 'Right']).optional().describe('水平对齐'),
  v_align: z.enum(['Fill', 'Top', 'Center', 'Bottom']).optional().describe('垂直对齐'),
  padding: z
    .object({
      left: z.number().optional(),
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional()
    })
    .optional()
    .describe('内边距'),
  // TextBlock 参数
  text: z.string().optional().describe('TextBlock: 文本内容')
})

interface AddChildResponse {
  ok: boolean
  name: string
  class: string
  parent: string
  parent_type: string
  slot_type: string
  slot_data?: Record<string, unknown>
  /** TextBlock 上读回来的文本（新版插件） */
  text?: string
  /**
   * 传了但没生效的参数（新版插件）。给 VerticalBox 传 anchors、给 Button 传 text
   * 原来都是静默丢掉、照回 ok:true
   */
  ignored_fields?: string[]
  /** 插件对 ignored_fields 的解释：父容器的槽位类型、text 只认 TextBlock */
  ignored_note?: string
  /** 单内容容器（Button/Border/SizeBox）里原来那个子控件被顶掉了 */
  replaced_child?: { name: string; class: string }
  /** 插件写的失败原因，由 WebSocket 那层从 code>=400 的响应补上。不透传等于把诊断扔了 */
  error?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function addChildTool() {
  return defineV2Tool({
    description: `向任意容器添加子控件（通用命令）。

【自动检测父容器类型】：
- CanvasPanel: 使用 anchors/position/size
- VerticalBox/HorizontalBox: 使用 size_rule/padding/alignment
- Overlay: 使用 h_align/v_align/padding
- Button/Border/SizeBox: 单内容容器，设置为 Content（已有子控件会被替换，返回 replaced_child）
- 其它容器（ScrollBox / GridPanel / WrapBox / UniformGridPanel…）: 照样能加，
  但这里的槽位参数对它们不生效 —— 加进去就是默认槽位设置
- 父容器不认的参数不会生效，返回 ignored_fields 列出来；text 只对 TextBlock 生效

【使用示例】：
1. 添加到 CanvasPanel: parent_name="root", anchors="Center"
2. 添加到 VerticalBox: parent_name="MyVBox", size_rule="Fill"
3. 添加到 Button: parent_name="StartButton", control_type="TextBlock", text="开始游戏"`,

    inputSchema: AddChildSchema,

    execute: async (input) => {
      if (!input || !input.path || !input.parent_name || !input.control_type) {
        return {
          ok: false,
          error: '缺少必填参数 path / parent_name / control_type',
          parent: 'unknown'
        }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return { ok: false, error: '没有连接的虚幻引擎项目', path: input.path }
      }

      try {
        const response = await wsService.callRequest<AddChildResponse>(
          'widget.add_child',
          input,
          getTargetConnectionId()
        )

        if (!response || !response.ok) {
          return {
            ok: false,
            error: response?.error || '添加控件失败',
            parent: input.parent_name
          }
        }

        /*
         * AGENTS.md §5 第 14 条：没生效的参数和被顶掉的子控件要摆在第一句。
         * 模型读到「已添加」就收工，按钮里原来的图标没了、anchors 没生效，
         * 它都会当成已经办好。旧版插件不回这两个字段，那就只能照常说。
         */
        const ignored = Array.isArray(response.ignored_fields) ? response.ignored_fields : []
        const requested = OPTIONAL_FIELDS.filter((field) => input[field] !== undefined).length
        const body =
          `已添加 ${response.class} "${response.name}" 到 ${response.parent} (${response.parent_type})` +
          (response.text !== undefined ? `，文本为「${response.text}」` : '')
        const reason =
          response.ignored_note?.trim() || `父容器 ${response.parent_type} 不认这些参数`
        let message = withPartialHeadline(
          body,
          {
            succeeded: 1 + Math.max(0, requested - ignored.length),
            failed: ignored.length,
            unit: '项'
          },
          ignored.map((field) => ({ item: field, reason }))
        )
        if (response.replaced_child) {
          const old = response.replaced_child
          message =
            `⚠️ ${response.parent} 只能放一个子控件，原来的 ${old.class} "${old.name}" 已被替换掉。\n` +
            message
        }

        return {
          message,
          ok: true,
          name: response.name,
          class: response.class,
          parent: response.parent,
          parent_type: response.parent_type,
          slot_type: response.slot_type,
          ...(response.slot_data ? { slot_data: response.slot_data } : {}),
          ...(response.text !== undefined ? { text: response.text } : {}),
          ...(ignored.length ? { ignored_fields: ignored } : {}),
          ...(response.replaced_child ? { replaced_child: response.replaced_child } : {})
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          parent: input.parent_name
        }
      }
    }
  })
}
