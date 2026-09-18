/**
 * `blueprint_tidy_graph` —— 把一张已经存在的图重新排版。
 *
 * ## 为什么需要它
 *
 * `blueprint_apply_graph` 只会给**它这次建的**节点算坐标。图里原有的节点、
 * 用户手搓的节点、以及这个工具出现之前建的一切，都没人管过。
 *
 * 真机上的样子：`Event BeginPlay` 排在它驱动的 `Print String` 右边（执行流
 * 从右往左读）、`Event ActorBeginOverlap` 直接压在 `Set Actor Rotation` 上面。
 *
 * 这个工具读整张图 → 用同一套 ELK 分层布局重算 → 把坐标写回去。
 * 不改任何节点和连线，纯挪位置。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import {
  autoLayoutBlueprintNodes,
  BlueprintLayoutConnection,
  BlueprintLayoutNode
} from '../../../../blueprint-layout/elkLayout'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { deriveConnectionsFromPins } from './getBlueprintGraph'
import type { BlueprintGraphNodeInfo } from './getBlueprintGraph'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/**
 * 这里直接走裸 RPC，拿到的是**插件的原始形状**（`node_id` / `pos_x` / `pos_y`），
 * 不是 `blueprint_get_graph` 工具整理过的那份（`id` / 已改过名的字段）。
 *
 * 而插件的 `get_graph` **不回连线数组** —— 连接信息藏在每个引脚的 `linked_to`
 * 里，要用 `deriveConnectionsFromPins` 推出来。没有连线的话 ELK 拿不到任何
 * 边，排出来的就是一堆没有关系的方块，比不排还难看。
 */
interface GetGraphResponse {
  ok?: boolean
  graph_name?: string
  nodes?: BlueprintGraphNodeInfo[]
}

const TidySchema = z.object({
  blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
  graph_name: z.string().optional().describe('图表名，默认 EventGraph')
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createTidyBlueprintGraphTool() {
  return defineV2Tool({
    description: `把一张已有的蓝图图表重新排版，让它顺着执行流从左到右读。

**只挪位置，不改任何节点和连线。** 逻辑一个字都不会变。

什么时候用：
- 图看起来乱（节点重叠、执行流倒着走、连线到处交叉）
- 分多次往同一张图里加过东西
- 用户手搓的图想整理一下

排完可以用 ue_screenshot 看一眼效果。改动是可撤销的（Ctrl+Z）。

排版本身不改逻辑，所以排完不需要重新编译。`,

    inputSchema: TidySchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const readParams: Record<string, unknown> = { blueprint_path: input.blueprint_path }
        if (input.graph_name) readParams.graph_name = input.graph_name

        const graph = await wsService.callRequest<GetGraphResponse>(
          'blueprint.get_graph',
          readParams,
          getTargetConnectionId(),
          30000
        )

        const nodes = graph?.nodes ?? []
        if (!graph || nodes.length === 0) {
          return {
            success: false,
            error: `读不到图，或者图里一个节点都没有：${input.blueprint_path}`
          }
        }

        // 一两个节点排不排都一样，还白改一次脏状态
        if (nodes.length < 3) {
          return {
            success: true,
            moved: 0,
            node_count: nodes.length,
            summary: `图里只有 ${nodes.length} 个节点，不需要排版。`
          }
        }

        /**
         * 节点 id 用引擎的 GUID，连线也必须用同一套。
         *
         * 布局器按点号切「节点id.引脚名」，而 GUID 里没有点号，所以拼起来
         * 不会切错。
         */
        const layoutNodes: BlueprintLayoutNode[] = nodes.map((node) => ({
          id: node.node_id,
          name: node.title || node.class,
          type: node.class,
          x: node.pos_x,
          y: node.pos_y
        }))

        const layoutConnections: BlueprintLayoutConnection[] = deriveConnectionsFromPins(nodes).map(
          (conn) => ({
            from: `${String(conn.from_node_id)}.${String(conn.from_pin)}`,
            to: `${String(conn.to_node_id)}.${String(conn.to_pin)}`
          })
        )

        const layouted = await autoLayoutBlueprintNodes(layoutNodes, layoutConnections)

        const positions = layouted.map((node) => ({
          node_id: node.id,
          x: Math.round(node.x),
          y: Math.round(node.y)
        }))

        const writeParams: Record<string, unknown> = {
          blueprint_path: input.blueprint_path,
          positions
        }
        if (input.graph_name) writeParams.graph_name = input.graph_name

        const applied = await wsService.callRequest<{
          ok: boolean
          moved: number
          not_found?: string[]
          note?: string
          error?: string
        }>('blueprint.set_node_positions', writeParams, getTargetConnectionId(), 60000)

        if (!applied) {
          return { success: false, error: '插件没有响应（blueprint.set_node_positions）' }
        }
        if (!applied.ok && !applied.moved) {
          return { success: false, error: applied.error ?? '写回坐标失败' }
        }

        return {
          success: true,
          moved: applied.moved,
          node_count: nodes.length,
          ...(applied.not_found?.length ? { not_found: applied.not_found } : {}),
          summary:
            `已重新排版 ${applied.moved}/${nodes.length} 个节点，现在顺着执行流从左到右。` +
            (applied.not_found?.length
              ? `有 ${applied.not_found.length} 个节点没找到（图可能在这期间被改过）。`
              : '') +
            '逻辑没有任何改动，用 ue_screenshot 可以看一眼效果。'
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
