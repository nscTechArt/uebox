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
  widget_name: string
  is_variable: boolean
  /** 插件写的失败原因，由 WebSocket 那层从 code>=400 的响应补上。不透传等于把诊断扔了 */
  error?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function makeVariableTool() {
  return defineV2Tool({
    description: `将 Widget 控件设置为蓝图变量。

【功能说明】：
- 设置控件的 bIsVariable 为 true
- 可选指定变量名称

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
          ok: true,
          widget_name: response.widget_name,
          is_variable: response.is_variable,
          message: `控件 "${response.widget_name}" 已设置为蓝图变量`
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
