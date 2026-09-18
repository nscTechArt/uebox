/**
 * Widget 层级查询工具
 * 通过 WebSocket 向虚幻引擎插件发送 widget.get_hierarchy 命令
 * 获取 Widget Blueprint 的完整结构，包含 Slot 类型识别
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
const GetWidgetHierarchySchema = z.object({
  path: z.string().describe('Widget Blueprint 的资产路径，如 /Game/UI/WBP_MainMenu')
})

/** Slot 数据 */
interface SlotData {
  anchors?: { min_x: number; min_y: number; max_x: number; max_y: number }
  offsets?: { left: number; top: number; right: number; bottom: number }
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  alignment?: { x: number; y: number }
  auto_size?: boolean
  z_order?: number
  padding?: { left: number; top: number; right: number; bottom: number }
  size_rule?: 'Auto' | 'Fill'
  size_value?: number
  h_align?: string
  v_align?: string
  row?: number
  column?: number
  row_span?: number
  column_span?: number
}

/** Widget 节点 */
interface WidgetNode {
  name: string
  class: string
  is_variable: boolean
  is_visible: boolean
  slot_type?: string
  slot_data?: SlotData
  children?: WidgetNode[]
}

/** 响应数据 */
interface GetHierarchyResponse {
  path: string
  name: string
  root: WidgetNode | null
  widget_count: number
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getWidgetHierarchyTool() {
  return defineV2Tool({
    description: `获取 Widget Blueprint 的层级结构。

【功能说明】：
- 读取 Widget 树的完整结构
- 识别每个控件的 Slot 类型（CanvasPanelSlot, VerticalBoxSlot 等）
- 返回 Slot 的具体属性（位置、锚点、尺寸、对齐等）

【适用场景】：
- 分析现有 Widget 的布局结构
- 在修改 Widget 前获取当前状态
- 作为 Agent 自优化 UI 的第一步`,

    inputSchema: GetWidgetHierarchySchema,

    execute: async (input) => {
      if (!input || !input.path) {
        return { ok: false, error: '缺少必填参数 path（Widget 路径）', path: 'unknown' }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return {
          ok: false,
          error: '没有连接的虚幻引擎项目',
          path: input.path
        }
      }

      try {
        const response = await wsService.callRequest<GetHierarchyResponse>(
          'widget.get_hierarchy',
          { path: input.path },
          getTargetConnectionId()
        )

        if (!response) {
          return { ok: false, error: '未收到响应', path: input.path }
        }

        // 格式化输出
        const formatWidgetTree = (node: WidgetNode | null, indent = 0): string => {
          if (!node) return '(空)'
          const prefix = '  '.repeat(indent)
          let result = `${prefix}📦 ${node.name} [${node.class}]`
          if (node.slot_type) result += ` (${node.slot_type})`
          if (node.is_variable) result += ' 🔹变量'
          result += '\n'
          if (node.children?.length) {
            for (const child of node.children) {
              result += formatWidgetTree(child, indent + 1)
            }
          }
          return result
        }

        return {
          ok: true,
          path: response.path,
          name: response.name,
          widget_count: response.widget_count,
          hierarchy: response.root,
          tree_text: formatWidgetTree(response.root)
        }
      } catch (error) {
        return {
          ok: false,
          error: `获取层级失败: ${error instanceof Error ? error.message : String(error)}`,
          path: input.path
        }
      }
    }
  })
}
