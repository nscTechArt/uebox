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
- Button/Border/SizeBox: 单内容容器，设置为 Content
- 其它容器（ScrollBox / GridPanel / WrapBox / UniformGridPanel…）: 照样能加，
  但这里的槽位参数对它们不生效 —— 加进去就是默认槽位设置

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

        return {
          ok: true,
          name: response.name,
          class: response.class,
          parent: response.parent,
          parent_type: response.parent_type,
          slot_type: response.slot_type,
          message: `已添加 ${response.class} "${response.name}" 到 ${response.parent} (${response.parent_type})`
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
