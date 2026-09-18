/**
 * 创建 Widget Blueprint 工具
 * 通过 WebSocket 向虚幻引擎插件发送 widget.create 命令
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { WIDGET_TYPE_HINT } from './widgetTypes'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const CreateWidgetSchema = z.object({
  name: z.string().describe('Widget Blueprint 名称（必填）'),
  folder: z.string().optional().describe('保存目录，默认 /Game/UI'),
  root_type: z.string().optional().describe(`根控件类型，默认 CanvasPanel。${WIDGET_TYPE_HINT}`)
})

interface CreateWidgetResponse {
  ok: boolean
  name: string
  path: string
  root_type: string
  /** 插件写的失败原因，由 WebSocket 那层从 code>=400 的响应补上。不透传等于把诊断扔了 */
  error?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createWidgetTool() {
  return defineV2Tool({
    description: `创建一个新的 Widget Blueprint 资产。

【功能说明】：
- 在 Content Browser 中创建 Widget Blueprint
- 自动设置根控件（默认 CanvasPanel）
- 支持指定保存目录

【根控件选择】：
- CanvasPanel: 自由定位布局，适合 HUD、主菜单
- VerticalBox: 垂直排列，适合列表、表单
- HorizontalBox: 水平排列，适合工具栏、按钮组
- Overlay: 层叠布局，适合需要重叠的场景
- ScrollBox: 内容超屏要能滚的（长设置页、排行榜）
- GridPanel / UniformGridPanel: 背包格子、技能栏这类网格
其它 UWidget 子类也能当根，见 root_type 的说明。`,

    inputSchema: CreateWidgetSchema,

    execute: async (input) => {
      // 防御性检查：Gemini 并行工具调用时可能 args 为 undefined
      if (!input || typeof input !== 'object') {
        return {
          ok: false,
          error: '工具参数解析失败，请重试',
          name: 'unknown'
        }
      }

      if (!input.name) {
        return {
          ok: false,
          error: '缺少必填参数 name（Widget 名称）',
          name: 'unknown'
        }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return {
          ok: false,
          error: UE_NOT_CONNECTED_MESSAGE,
          name: input.name
        }
      }

      // 手动应用默认值
      const folder = input.folder ?? '/Game/UI'
      const rootType = input.root_type ?? 'CanvasPanel'

      try {
        const response = await wsService.callRequest<CreateWidgetResponse>(
          'widget.create',
          {
            name: input.name,
            folder: folder,
            root_type: rootType
          },
          getTargetConnectionId()
        )

        if (!response || !response.ok) {
          return {
            ok: false,
            error: response?.error || '创建失败',
            name: input.name
          }
        }

        return {
          ok: true,
          name: response.name,
          path: response.path,
          root_type: response.root_type,
          message: `Widget Blueprint "${response.name}" 已创建于 ${response.path}`
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          name: input.name
        }
      }
    }
  })
}
