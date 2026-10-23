/**
 * 删除控件和它的子控件
 * 通过 WebSocket 向虚幻引擎插件发送 widget.remove 命令
 *
 * 图表里还在用的默认不删、列出引用，force 才连节点一起删 —— 和删 Actor 前查引用
 * 是同一个规矩。插件端开在事务里，ue_undo 撤得回来。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'

const RemoveWidgetSchema = z.object({
  path: z.string().describe('Widget Blueprint 路径'),
  widget_name: z.string().describe('要删的控件名，它的子控件一起删'),
  force: z
    .boolean()
    .optional()
    .describe('图表里还有节点在用它们时，连那些节点一起删。不给就拒绝并列出引用')
})

export interface RemoveWidgetResponse {
  ok: boolean
  widget_name: string
  parent: string
  removed?: { name: string; class: string; text?: string }[]
  removed_graph_nodes?: string[]
  error?: string
}

export function describeRemoveWidget(r: RemoveWidgetResponse): string {
  const removed = r.removed ?? []
  const children = removed.length - 1
  const head =
    `已从 ${r.parent} 删除 ${r.widget_name}` + (children > 0 ? `（连同 ${children} 个子控件）` : '')
  const nodes = r.removed_graph_nodes ?? []
  return nodes.length > 0
    ? `${head}。图表里引用它们的 ${nodes.length} 个节点也删了：${nodes.join('、')}。` +
        '事件后面连的逻辑还在图里、已断开，不要了就用 blueprint_delete_node 清掉'
    : head
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function removeWidgetTool() {
  return defineV2Tool({
    description: `删除控件蓝图里的一个控件，它的子控件一起删。

图表里还有节点在用它们（变量读写、OnClicked 这类绑定事件）时默认拒绝，并列出那些节点；
确认不要了再传 force=true 连节点一起删。事件后面连的逻辑会留在图里，只是断开。

要换成别的控件而不是删掉，用 widget_replace，它会保住位置和事件。`,

    inputSchema: RemoveWidgetSchema,

    execute: async (input) => {
      if (!input || !input.path || !input.widget_name) {
        return { ok: false, error: '缺少必填参数 path / widget_name' }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return { ok: false, error: '没有连接的虚幻引擎项目', path: input.path }
      }

      try {
        const response = await wsService.callRequest<RemoveWidgetResponse>(
          'widget.remove',
          input,
          getTargetConnectionId()
        )

        if (!response || !response.ok) {
          return {
            ok: false,
            error: response?.error || '删除控件失败',
            widget_name: input.widget_name
          }
        }

        return {
          message: describeRemoveWidget(response),
          ok: true,
          widget_name: response.widget_name,
          removed: (response.removed ?? []).map((w) => w.name),
          ...(response.removed_graph_nodes?.length
            ? { removed_graph_nodes: response.removed_graph_nodes }
            : {})
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
