/**
 * 删节点 / 断连线 / 注释框 —— apply_graph 之外的零散图编辑。
 *
 * 在它们之前图只能往上加：接错一根线、多建一个节点，唯一的收回办法是
 * `blueprint_apply_graph` + `clear_existing` 整图重写，顺带把别的节点也重建一遍。
 * 代价和风险都远大于这件事本身（2026-09-16 的用户反馈）。
 *
 * 三个都是薄透传：插件侧 `blueprint.delete_node` 一直都在，
 * `blueprint.disconnect_pins` 和 `blueprint.set_comment` 是后来补的。
 *
 * 注释框（`blueprint_comment`）也放在这里：它同样是「图上的一处小改动」，
 * 而不是写一片逻辑 —— 跟 apply_graph 不构成选择负担。
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
    description: `删掉蓝图图表里的一个节点，它身上的连线跟着一起断。

**删完要 blueprint_compile** —— 下游节点可能因此少了输入，不编译看不出来。
删错了用 ue_undo。`,
    inputSchema: z.object({
      blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
      node_id: z.string().describe('要删的节点 GUID，来自 blueprint_get_graph'),
      graph_name: z.string().optional().describe('图表名，省略为 EventGraph')
    }),
    execute: async (input) => callBlueprintRpc('blueprint.delete_node', input)
  })
}

/**
 * 注释框是蓝图里唯一的分组手段，也是图上那些「这一段在干嘛」的说明的载体。
 * 在这个工具之前，注释框只能读出一个左上角坐标，写更是完全做不到。
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createBlueprintCommentTool() {
  return defineV2Tool({
    description: `加一个注释框，或改一个已有的（省略 node_id ＝ 新建）。注释框是蓝图里
唯一的分组手段。没传的字段不动，不参与编译，可以 Ctrl+Z。

enclose_nodes 不只是用来算框多大 —— 引擎靠它决定「用户拖这个框时带走谁」，
名单空的框一动，里面的节点会留在原地。`,
    inputSchema: z.object({
      blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
      graph_name: z.string().optional().describe('图表名，省略为 EventGraph'),
      node_id: z.string().optional().describe('要改的注释框 GUID，省略＝新建'),
      text: z.string().optional().describe('框上的文字'),
      enclose_nodes: z.array(z.string()).optional().describe('被框住的节点 GUID'),
      color: z.string().optional().describe('框的颜色，"r,g,b" 三个 0~1 的数，如 "0.2,0.4,0.9"')
    }),
    execute: async ({ color, ...rest }) => {
      // 颜色在 schema 里是一个字符串而不是 {r,g,b} 对象：工具定义是每轮请求都要
      // 全额付的前缀，一个四字段的嵌套对象光 schema 就比这条说明还贵。
      // 插件那边认对象，在这里拆
      const parsed = color?.split(',').map(Number)
      const rgb =
        parsed && parsed.length >= 3 && parsed.every((n) => Number.isFinite(n))
          ? { color: { r: parsed[0], g: parsed[1], b: parsed[2], a: parsed[3] ?? 1 } }
          : {}
      return callBlueprintRpc('blueprint.set_comment', { ...rest, ...rgb })
    }
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createDisconnectBlueprintPinsTool() {
  return defineV2Tool({
    description: `断开某个引脚上的连线，默认断掉这个引脚上的**全部**。只断其中一根就再给
other_node_id + other_pin（两个要一起给）。

本来就没线不算失败。引脚名要用真名（Branch 的出口是 then / else），拿不准先
blueprint_get_graph。**断完要 blueprint_compile。**`,
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
