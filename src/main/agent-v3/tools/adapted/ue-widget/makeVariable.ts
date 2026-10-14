/**
 * 设置控件为蓝图变量工具
 * 通过 WebSocket 向虚幻引擎插件发送 widget.make_variable 命令
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
const MakeVariableSchema = z.object({
  path: z.string().describe('Widget Blueprint 路径'),
  widget_name: z.string().describe('控件名称'),
  variable_name: z.string().optional().describe('变量名称（可选，默认使用控件名）')
})

interface MakeVariableResponse {
  ok: boolean
  /** 引擎里控件现在的名字（改名后读回来的） */
  widget_name: string
  is_variable: boolean
  /** 以下是改名修复后的插件才带（旧插件没有）：改名走编辑器那条路，图表引用跟着改，并逐个读回核对 */
  old_name?: string
  renamed?: boolean
  graph_references_found?: number
  graph_references_renamed?: number
  graph_references_updated?: boolean
  stale_graph_references?: string[]
  failed_count?: number
  /** 插件写的失败原因，由 WebSocket 那层从 code>=400 的响应补上。不透传等于把诊断扔了 */
  error?: string
}

/**
 * 回执第一句说引擎里的事实（AGENTS.md §5 第 14 条）：改没改名、改成了什么、
 * 图表里用旧名的节点是不是都跟着改了。有一处没跟上就以 ⚠️ 开头。
 */
export function describeMakeVariable(
  input: { widget_name: string; variable_name?: string },
  response: MakeVariableResponse
): string {
  const oldName = response.old_name ?? input.widget_name
  const newName = response.widget_name
  const renamed = response.renamed ?? newName !== oldName
  if (!renamed) {
    const asked = input.variable_name && input.variable_name !== input.widget_name
    return asked
      ? `⚠️ 控件 "${newName}" 已设为蓝图变量，但没有改名：请求的 "${input.variable_name}" 去掉不能用的字符后和原名相同`
      : `控件 "${newName}" 已设为蓝图变量`
  }

  const head = `控件 "${oldName}" 已改名为 "${newName}" 并设为蓝图变量`
  const nameNote =
    input.variable_name && input.variable_name !== newName
      ? `（请求的是 "${input.variable_name}"，不能做变量名的字符已去掉）`
      : ''

  if (response.graph_references_updated === undefined) {
    return (
      `⚠️ ${head}${nameNote}，但这一版插件只改控件名、不改图表引用：` +
      `蓝图里读写 "${oldName}" 或绑在它上面的事件节点已经断了，要手动改，或先升级插件再改名`
    )
  }

  const found = response.graph_references_found ?? 0
  const stale = response.stale_graph_references ?? []
  if (!response.graph_references_updated) {
    const missing = found - (response.graph_references_renamed ?? 0)
    return (
      `⚠️ 部分完成：${head}${nameNote}，但图表里 ${missing} 处引用没跟着改，仍指向旧名 "${oldName}"` +
      (stale.length > 0 ? `：\n${stale.map((s) => `- ${s}`).join('\n')}` : '')
    )
  }
  return found > 0
    ? `${head}${nameNote}，图表里 ${found} 处引用（变量读写、绑定事件）已跟着改名`
    : `${head}${nameNote}，图表里原本没有节点引用它`
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function makeVariableTool() {
  return defineV2Tool({
    description: `将 Widget 控件设置为蓝图变量。

【功能说明】：
- 设置控件的 bIsVariable 为 true
- 可选 variable_name：和编辑器里改名一样，图表里的变量读写、绑定事件跟着改；名字被占用会拒绝

【适用场景】：
- 事件绑定前的必要步骤
- 需要在蓝图图表中引用控件时`,

    inputSchema: MakeVariableSchema,

    execute: async (input) => {
      if (!input || !input.path || !input.widget_name) {
        return { ok: false, error: '缺少必填参数 path 或 widget_name', widget_name: 'unknown' }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return { ok: false, error: '没有连接的虚幻引擎项目', path: input.path }
      }

      try {
        const response = await wsService.callRequest<MakeVariableResponse>(
          'widget.make_variable',
          input,
          getTargetConnectionId()
        )

        if (!response || !response.ok) {
          return {
            ok: false,
            error: response?.error || '设置变量失败',
            widget_name: input.widget_name
          }
        }

        return {
          message: describeMakeVariable(input, response),
          ok: true,
          widget_name: response.widget_name,
          is_variable: response.is_variable,
          ...(response.graph_references_updated !== undefined
            ? {
                graph_references_updated: response.graph_references_updated,
                graph_references_found: response.graph_references_found ?? 0
              }
            : {}),
          ...(response.stale_graph_references?.length
            ? { stale_graph_references: response.stale_graph_references }
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
