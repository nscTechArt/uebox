/**
 * 创建蓝图函数图表工具
 * 通过 WebSocket 向虚幻引擎插件发送 blueprint.create_function 命令
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
const ParamSchema = z.object({
  name: z.string().describe('参数名，如 BaseValue'),
  type: z
    .string()
    .describe(
      '参数类型：Bool/Int/Int64/Float/Double/String/Name/Text/Vector/Rotator/Color/LinearColor/Object/Class/SoftObject/SoftClass'
    ),
  object_class: z
    .string()
    .optional()
    .describe('当 type=Object/Class/SoftObject/SoftClass 时指定类，如 /Script/Engine.Actor'),
  is_array: z.boolean().optional().default(false).describe('是否数组（默认 false）')
})

const CreateBlueprintFunctionSchema = z.object({
  blueprint_path: z.string().describe('蓝图路径（必填），如 /Game/BP_MyHero'),
  function_name: z.string().describe('函数名（必填），如 CalculateHealth'),
  inputs: z.array(ParamSchema).optional().describe('输入参数定义（可选）'),
  outputs: z.array(ParamSchema).optional().describe('输出参数定义（可选）'),
  pure: z.boolean().optional().default(false).describe('是否纯函数（无 Exec 引脚），默认 false')
})

export interface CreateBlueprintFunctionResponse {
  ok: boolean
  graph_name: string
  entry_node_id: string
  result_node_id: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createCreateBlueprintFunctionTool() {
  return defineV2Tool({
    description: `创建蓝图自定义函数图表（Functions），并可选定义输入/输出参数。

【工作流建议（模块化/封装）】
- 复杂独立逻辑优先封装到 Function：先用本工具建出函数图，再用 blueprint_apply_graph
  往这张图里一次写完节点和连线（graph_name 填下面返回的那个），最后在 EventGraph
  里调用该函数。逐节点建图的工具已经下线，写图只有 blueprint_apply_graph 一个。

【返回】
- graph_name: 函数图表名（后续 blueprint_get_graph / blueprint_apply_graph 的 graph_name 就填它）
- entry_node_id / result_node_id: 入口/返回节点 GUID（便于定位）`,

    inputSchema: CreateBlueprintFunctionSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const params: Record<string, unknown> = {
          blueprint_path: input.blueprint_path,
          function_name: input.function_name,
          pure: input.pure
        }
        if (input.inputs) params.inputs = input.inputs
        if (input.outputs) params.outputs = input.outputs

        const response = await wsService.callRequest<CreateBlueprintFunctionResponse>(
          'blueprint.create_function',
          params,
          getTargetConnectionId(),
          30000
        )

        if (!response || !response.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = (response as any)?.error || (response as any)?.message || '无响应或 ok=false'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const code = (response as any)?.__rpc?.code ?? (response as any)?.code
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details = (response as any)?.details
          return { success: false, error: `创建函数失败：${msg}`, code, details, raw: response }
        }

        return {
          success: true,
          graph_name: response.graph_name,
          entry_node_id: response.entry_node_id,
          result_node_id: response.result_node_id,
          message: `已创建函数图表 ${response.graph_name}（Entry=${response.entry_node_id}，Result=${response.result_node_id}）`
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
