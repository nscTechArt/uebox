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
import { withPartialHeadline, type PartialFailure } from '../../partialResult'

const CreateWidgetSchema = z.object({
  name: z.string().describe('Widget Blueprint 名称（必填）'),
  folder: z.string().optional().describe('保存目录，默认 /Game/UI'),
  root_type: z.string().optional().describe(`根控件类型，默认 CanvasPanel。${WIDGET_TYPE_HINT}`)
})

interface CreateWidgetResponse {
  ok: boolean
  name: string
  path: string
  /**
   * 根控件的类名。新版插件是建完从 WidgetTree 上读回来的；
   * 旧版插件照抄请求（认不出来的类型悄悄换成 CanvasPanel 也照抄），不能当事实
   */
  root_type: string
  /** 新版插件才有。有它说明 root_type 是读回来的 */
  requested_root_type?: string
  /** 根控件没建出来，或建出来的类和请求的不是一个 */
  warning?: string
  /** 新版插件才有。false = 资产只在内存里，关编辑器就没了 */
  saved?: boolean
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

        /*
         * AGENTS.md §5 第 14 条：回执报引擎里的状态。旧版插件的 root_type 是照抄请求的
         * （认不出来的类型被换成 CanvasPanel 也照抄），所以没有 requested_root_type
         * 时不把它当事实说。根没建对、没存上盘，都要摆在第一句。
         */
        const verified = response.requested_root_type !== undefined
        const failures: PartialFailure[] = []
        if (response.warning) failures.push({ item: '根控件', reason: response.warning })
        if (response.saved === false) {
          failures.push({ item: '保存', reason: '资产只在内存里，没写到磁盘，关编辑器就没了' })
        }
        const rootText = verified
          ? response.root_type
            ? `根控件是 ${response.root_type}`
            : '没有根控件'
          : `根控件类型未核实（插件版本较旧，root_type 是请求值 ${rootType}）`
        const body = `Widget Blueprint "${response.name}" 已创建于 ${response.path}，${rootText}。`
        const steps = 1 + (verified ? 1 : 0) + (response.saved !== undefined ? 1 : 0)

        return {
          message: withPartialHeadline(
            body,
            { succeeded: steps - failures.length, failed: failures.length, unit: '步' },
            failures
          ),
          ok: true,
          name: response.name,
          path: response.path,
          root_type: response.root_type,
          ...(verified ? {} : { root_type_verified: false }),
          ...(response.saved !== undefined ? { saved: response.saved } : {})
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
