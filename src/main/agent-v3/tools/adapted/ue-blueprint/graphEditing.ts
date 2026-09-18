/**
 * 删节点 / 断连线 —— 图编辑的两个逆操作。
 *
 * 在它们之前图只能往上加：接错一根线、多建一个节点，唯一的收回办法是
 * `blueprint_apply_graph` + `clear_existing` 整图重写，顺带把别的节点也重建一遍。
 * 代价和风险都远大于这件事本身（2026-09-16 的用户反馈）。
 *
 * 两个都是薄透传：插件侧 `blueprint.delete_node` 一直都在，
 * `blueprint.disconnect_pins` 是这次补的。
 */

import { z } from 'zod'

import { defineV2Tool } from '../../adaptV2Tool'
import { serviceManager } from '../../../../services'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { describeToolError } from '../../engineErrors'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const TIMEOUT_MS = 30_000

async function callBlueprintRpc(
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const wsService = serviceManager.getWebSocketService()
  if (wsService.getConnectionCount() === 0) {
    return { success: false, error: UE_NOT_CONNECTED_MESSAGE }
  }
  try {
    const response = await wsService.callRequest<Record<string, unknown>>(
      method,
      params,
      getTargetConnectionId(),
      TIMEOUT_MS
    )
    if (!response?.ok) {
      return { success: false, error: String(response?.error ?? `${method} 失败`), raw: response }
    }
    return { success: true, ...response }
  } catch (error) {
    return describeToolError(error)
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createDeleteBlueprintNodeTool() {
  return defineV2Tool({
    description: `删掉蓝图图表里的一个节点。

node_id 是 blueprint_get_graph 返回的那个 GUID。节点身上的连线会一起断开。

**删完要 blueprint_compile。** 被它喂着的下游节点可能因此少了输入而报错，
不编译一次看不出来。

删错了用 ue_undo 撤回（这一步在你自己那条撤销栈上）。`,
    inputSchema: z.object({
      blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
      node_id: z.string().describe('要删的节点 GUID，来自 blueprint_get_graph'),
      graph_name: z.string().optional().describe('图表名，省略为 EventGraph')
    }),
    execute: async (input) => callBlueprintRpc('blueprint.delete_node', input)
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createDisconnectBlueprintPinsTool() {
  return defineV2Tool({
    description: `断开蓝图里某个引脚上的连线。

默认断掉这个引脚上的**全部**连线。只想断其中一根就再给 other_node_id + other_pin
（两个要一起给）—— 执行输入引脚可以同时被好几个节点驱动，那种时候才需要指名道姓。

本来就没接线不算失败，「确保这里是断的」可以直接调。

引脚名要用真名，不是界面上显示的那个（Branch 的出口真名是 then / else）。
拿不准先 blueprint_get_graph 看一眼。

**断完要 blueprint_compile。**`,
    inputSchema: z.object({
      blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
      node_id: z.string().describe('引脚所在节点的 GUID，来自 blueprint_get_graph'),
      pin: z.string().describe('引脚真名，如 then / else / execute / Target'),
      graph_name: z.string().optional().describe('图表名，省略为 EventGraph'),
      other_node_id: z.string().optional().describe('只断某一根线时，线另一端的节点 GUID'),
      other_pin: z.string().optional().describe('只断某一根线时，线另一端的引脚名')
    }),
    execute: async (input) => callBlueprintRpc('blueprint.disconnect_pins', input)
  })
}
