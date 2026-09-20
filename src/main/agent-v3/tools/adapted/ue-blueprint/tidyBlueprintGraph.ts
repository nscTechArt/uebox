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
 * 这个工具读整张图 → 用分层布局（`blueprint-layout/blueprintLayout.ts`）重算 →
 * 把坐标写回去。
 *
 * ## 它会改图的那一处
 *
 * 除了挪位置，它只做一件改图的事：**把被远处用到的纯 getter 就近复制一份**。
 * 一个变量读取节点被三个相距很远的地方用到时，它只能待在最左边那个消费者的
 * 左边，另外两根线只好横跨整张图 —— 这不是摆放问题，怎么摆都有长线。手排图
 * 的人从来不这么干，他们在每处再拖一个同名的 Get 出来。纯节点本来就按消费者
 * 各求值一次，所以复制前后**完全等价**。`duplicate_getters: false` 可以关掉。
 *
 * 注释框也跟着走：按它原来框住的那些节点的新位置整个挪过去（`planCommentBoxes`）。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import {
  autoLayoutBlueprintNodes,
  estimateBlueprintNodeSize,
  planGetterDuplicates,
  BlueprintLayoutConnection,
  BlueprintLayoutNode
} from '../../../../blueprint-layout/blueprintLayout'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { deriveConnectionsFromPins } from './getBlueprintGraph'
import type { BlueprintGraphNodeInfo } from './getBlueprintGraph'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/**
 * 这里直接走裸 RPC，拿到的是**插件的原始形状**（`node_id` / `pos_x` / `pos_y`），
 * 不是 `blueprint_get_graph` 工具整理过的那份（`id` / 已改过名的字段）。
 *
 * 而插件的 `get_graph` **不回连线数组** —— 连接信息藏在每个引脚的 `linked_to`
 * 里，要用 `deriveConnectionsFromPins` 推出来。没有连线的话布局器拿不到任何
 * 边，排出来的就是一堆没有关系的方块，比不排还难看。
 */
interface GetGraphResponse {
  ok?: boolean
  graph_name?: string
  nodes?: BlueprintGraphNodeInfo[]
}

/**
 * 注释框（`EdGraphNode_Comment`）不和普通节点一起排 —— 它是框，不是节点。
 * 排完之后按它原来框住的那些节点的新位置，整个框跟着挪过去（见 `planCommentBoxes`）。
 */
function isCommentNode(node: BlueprintGraphNodeInfo): boolean {
  return node.class?.includes('Comment') ?? false
}

/** 注释框排完之后该待的地方 */
export interface CommentBoxPlan {
  node_id: string
  bounds: { x: number; y: number; width: number; height: number }
  enclose_nodes: string[]
}

/** 框边距，和插件里 enclose_nodes 那条用的是同一套值 */
const COMMENT_PADDING = 40
const COMMENT_TITLE_BAR = 48

/**
 * 算出每个注释框排完之后该待在哪。
 *
 * ## 它框住了谁
 *
 * 先信引擎的 `nodes_under_comment`。但那份名单**只在用户拖动或缩放过这个框
 * 之后才会被填上** —— 一个建好就没动过的框，名单是空的。所以空的时候退回
 * 几何包含：按框**原来**的 x/y/width/height，看哪些节点原来在框里。
 *
 * ## 为什么必须挪
 *
 * 不挪的话，图整理完，用户手写的「这一段在算间距」还贴在原来的位置上，
 * 指着一片空白 —— 比排乱更糟，因为它看起来还是对的。
 */
export function planCommentBoxes(
  comments: BlueprintGraphNodeInfo[],
  originalNodes: BlueprintGraphNodeInfo[],
  laidOut: Array<{ id: string; x: number; y: number; width?: number; height?: number }>
): CommentBoxPlan[] {
  const placed = new Map(laidOut.map((node) => [node.id, node]))
  const plans: CommentBoxPlan[] = []

  for (const comment of comments) {
    const width = comment.node_width ?? 0
    const height = comment.node_height ?? 0

    const declared = (comment.nodes_under_comment ?? []).filter((id) => placed.has(id))
    const contained =
      declared.length > 0
        ? declared
        : width > 0 && height > 0
          ? originalNodes
              .filter(
                (node) =>
                  node.pos_x >= comment.pos_x &&
                  node.pos_y >= comment.pos_y &&
                  node.pos_x <= comment.pos_x + width &&
                  node.pos_y <= comment.pos_y + height
              )
              .map((node) => node.node_id)
              .filter((id) => placed.has(id))
          : []

    // 一个节点都框不住的（纯粹飘在旁边的说明文字）就别动它 ——
    // 猜不出它在说哪一段，挪过去只会挪错
    if (contained.length === 0) continue

    const boxes = contained.map((id) => placed.get(id)!)
    const minX = Math.min(...boxes.map((box) => box.x))
    const minY = Math.min(...boxes.map((box) => box.y))
    const maxX = Math.max(...boxes.map((box) => box.x + (box.width ?? 200)))
    const maxY = Math.max(...boxes.map((box) => box.y + (box.height ?? 100)))

    plans.push({
      node_id: comment.node_id,
      bounds: {
        x: Math.round(minX - COMMENT_PADDING),
        // 标题栏画在框体上方，不留出来会压住第一排节点
        y: Math.round(minY - COMMENT_PADDING - COMMENT_TITLE_BAR),
        width: Math.round(maxX - minX + COMMENT_PADDING * 2),
        height: Math.round(maxY - minY + COMMENT_PADDING * 2 + COMMENT_TITLE_BAR)
      },
      enclose_nodes: contained
    })
  }

  return plans
}

/**
 * 这根线是执行流还是数据流 —— 按**引脚的类型**判，不靠名字猜。
 *
 * 引脚名里带 `Update`、`Play Rate`、`bLoop` 的数据引脚多的是，猜错一根，
 * 整张图的分层就从那里歪掉。而 `category` 是引擎给的，这里本来就有。
 */
function buildPinCategoryIndex(nodes: BlueprintGraphNodeInfo[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const node of nodes) {
    for (const pin of node.pins ?? []) {
      if (pin?.name) index.set(`${node.node_id}.${pin.name}`, pin.category)
    }
  }
  return index
}

/**
 * 能安全复制的节点类。
 *
 * 判据是**复制它不会改变任何行为**：变量读取、Self、字面量，这三类只是把一个
 * 已有的值读出来，读两次和读一次结果一样。
 *
 * 纯函数调用（`Get Actor Location` 那种）其实也一样 —— 蓝图里的纯节点本来就
 * 按消费者各求值一次，不是求一次共用。但「纯不纯」要看引擎给的 bIsPureFunc，
 * 而 get_graph 现在不回这个字段；靠猜的话，万一把一个有副作用的节点复制了，
 * 用户是查不出来的。所以先只放这三类，等插件回了纯度再说。
 */
const DUPLICABLE_NODE_CLASSES = new Set(['K2Node_VariableGet', 'K2Node_Self', 'K2Node_Literal'])

/** 真正的纯 getter：没有执行引脚，没有任何输入连线，而且能被重建出来 */
function isDuplicableGetter(node: BlueprintGraphNodeInfo): boolean {
  if (!DUPLICABLE_NODE_CLASSES.has(node.class)) return false
  if (!node.write_as) return false
  const pins = node.pins ?? []
  if (pins.some((pin) => pin.category === 'exec')) return false
  return !pins.some((pin) => pin.dir === 'Input' && (pin.linked_to?.length ?? 0) > 0)
}

/** getter 的那个输出引脚名 —— 复制出来的节点引脚同名，连线要用它 */
function getterOutputPin(node: BlueprintGraphNodeInfo): string | undefined {
  return (node.pins ?? []).find((pin) => pin.dir === 'Output' && pin.category !== 'exec')?.name
}

const TidySchema = z.object({
  blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
  graph_name: z.string().optional().describe('图表名，默认 EventGraph'),
  duplicate_getters: z
    .boolean()
    .optional()
    .describe('远处用到的纯 getter 是否就近复制一份，默认 true。false ＝ 只挪位置')
})

/** 把一批节点翻译成布局器的入参：尺寸按真实引脚估，连线从 linked_to 推 */
function toLayoutInputs(nodes: BlueprintGraphNodeInfo[]): {
  layoutNodes: BlueprintLayoutNode[]
  layoutConnections: BlueprintLayoutConnection[]
} {
  const layoutNodes: BlueprintLayoutNode[] = nodes.map((node) => {
    // 排版按**真实大小**避让：同一张图里既有 40 像素高的 getter，
    // 也有二十多个引脚的 Timeline，按一个固定尺寸算必然有一头要叠
    const size = estimateBlueprintNodeSize({
      title: node.title || node.class,
      inputPins: (node.pins ?? []).filter((pin) => pin.dir === 'Input').map((pin) => pin.name),
      outputPins: (node.pins ?? []).filter((pin) => pin.dir === 'Output').map((pin) => pin.name)
    })
    return {
      id: node.node_id,
      name: node.title || node.class,
      type: node.class,
      x: node.pos_x,
      y: node.pos_y,
      width: size.width,
      height: size.height
    }
  })

  const pinCategories = buildPinCategoryIndex(nodes)
  const layoutConnections: BlueprintLayoutConnection[] = deriveConnectionsFromPins(nodes).map(
    (conn) => {
      const from = `${String(conn.from_node_id)}.${String(conn.from_pin)}`
      const category = pinCategories.get(from)
      return {
        from,
        to: `${String(conn.to_node_id)}.${String(conn.to_pin)}`,
        // 类型拿不到才让布局器去猜引脚名
        ...(category ? { kind: category === 'exec' ? ('exec' as const) : ('data' as const) } : {})
      }
    }
  )

  return { layoutNodes, layoutConnections }
}

export interface GetterCopyRequest {
  nodes: Array<Record<string, unknown>>
  connections: Array<{ from: string; to: string }>
  /** 每个被复制的 getter 复制了几份 —— 只用来跟用户说清楚改了什么 */
  copies: Array<{ name: string; copies: number }>
}

/**
 * 算出「要复制哪些 getter」，并翻译成一次 `blueprint.create_graph` 的入参。
 *
 * 新节点的坐标随便给一个 —— 复制完会立刻重排一次，这里填的值一个都留不下。
 * 连线指向的是图里已有节点的 GUID，`create_graph` 认这个；接到一个已经连着的
 * 输入引脚上时，引擎自己会把旧的那根断掉（`CONNECT_RESPONSE_BREAK_OTHERS`），
 * 所以不用先手动拆线。
 */
export function buildGetterCopyRequest(nodes: BlueprintGraphNodeInfo[]): GetterCopyRequest | null {
  const { layoutNodes, layoutConnections } = toLayoutInputs(nodes)
  const byId = new Map(nodes.map((node) => [node.node_id, node]))

  const plans = planGetterDuplicates(layoutNodes, layoutConnections, (layoutNode) => {
    const source = byId.get(layoutNode.id)
    return source ? isDuplicableGetter(source) : false
  })
  if (plans.length === 0) return null

  const created: Array<Record<string, unknown>> = []
  const connections: Array<{ from: string; to: string }> = []
  const copyCount = new Map<string, number>()

  for (const [index, plan] of plans.entries()) {
    const source = byId.get(plan.sourceId)
    const outputPin = source ? getterOutputPin(source) : undefined
    if (!source || !source.write_as || !outputPin) continue

    const copyId = `uebox-getter-copy-${index}`
    created.push({
      id: copyId,
      class: source.write_as,
      ...(source.member_name ? { member_name: source.member_name } : {}),
      ...(source.target_class ? { target_class: source.target_class } : {}),
      position: { x: source.pos_x, y: source.pos_y }
    })
    for (const target of plan.targets) {
      connections.push({ from: `${copyId}.${outputPin}`, to: `${target.nodeId}.${target.pin}` })
    }
    const label = source.member_name || source.title || source.class
    copyCount.set(label, (copyCount.get(label) ?? 0) + 1)
  }

  if (created.length === 0) return null
  return {
    nodes: created,
    connections,
    copies: [...copyCount.entries()].map(([name, copies]) => ({ name, copies }))
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createTidyBlueprintGraphTool() {
  return defineV2Tool({
    description: `把一张已有的图重新排版，顺着执行流从左到右读；注释框跟着它框住的逻辑走。

**逻辑不会变，可以 Ctrl+Z，不用重新编译。** 唯一会改图的动作：被远处用到的纯 getter
就近复制一份，省掉横跨整张图的长线 —— 纯节点本就按消费者各求值一次，复制前后等价。`,

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

        const readGraph = async (): Promise<GetGraphResponse | null> =>
          wsService.callRequest<GetGraphResponse>(
            'blueprint.get_graph',
            readParams,
            getTargetConnectionId(),
            30000
          )

        const graph = await readGraph()
        const allNodes = graph?.nodes ?? []
        if (!graph || allNodes.length === 0) {
          return {
            success: false,
            error: `读不到图，或者图里一个节点都没有：${input.blueprint_path}`
          }
        }

        let nodes = allNodes.filter((node) => !isCommentNode(node))
        let comments = allNodes.filter(isCommentNode)

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
         * 复制 getter 要在排版**之前**做完：复制完图就变了，位置必须按新图算，
         * 否则新节点全落在原点上。所以这里复制完重新读一遍，再进排版。
         */
        let duplicated: GetterCopyRequest['copies'] = []
        if (input.duplicate_getters !== false) {
          const request = buildGetterCopyRequest(nodes)
          if (request) {
            const createParams: Record<string, unknown> = {
              blueprint_path: input.blueprint_path,
              nodes: request.nodes,
              connections: request.connections,
              // 只是多了几个读变量的节点，逻辑没变，没什么可编译的
              compile: false
            }
            if (input.graph_name) createParams.graph_name = input.graph_name

            const applied = await wsService.callRequest<{ ok?: boolean; error?: string }>(
              'blueprint.create_graph',
              createParams,
              getTargetConnectionId(),
              60000
            )

            // 复制失败不该让整理跟着失败 —— 排版本身还是有价值的，
            // 但要如实说复制没成，否则用户以为长线已经解决了
            if (applied?.ok) {
              duplicated = request.copies
              const refreshed = await readGraph()
              const refreshedNodes = refreshed?.nodes ?? []
              if (refreshedNodes.length > 0) {
                nodes = refreshedNodes.filter((node) => !isCommentNode(node))
                comments = refreshedNodes.filter(isCommentNode)
              }
            }
          }
        }

        /**
         * 节点 id 用引擎的 GUID，连线也必须用同一套。
         *
         * 布局器按点号切「节点id.引脚名」，而 GUID 里没有点号，所以拼起来
         * 不会切错。
         */
        const { layoutNodes, layoutConnections } = toLayoutInputs(nodes)

        // 排完的图留在用户原来放它的地方，不会整张跳到坐标原点去
        const layouted = await autoLayoutBlueprintNodes(layoutNodes, layoutConnections, {
          anchor: 'original'
        })

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

        /**
         * 注释框跟着它框住的那段逻辑走。
         *
         * 排在挪节点**之后**：框要按节点的新位置算。挪不动框不该让整理失败 ——
         * 节点已经排好了，框没跟上顶多是说明贴偏了，如实报出来就行。
         */
        let commentsMoved = 0
        const commentPlans = planCommentBoxes(comments, nodes, layouted)
        for (const plan of commentPlans) {
          const commentParams: Record<string, unknown> = {
            blueprint_path: input.blueprint_path,
            node_id: plan.node_id,
            bounds: plan.bounds,
            // 顺手把名单补上：引擎靠它决定「用户拖动这个框时带走谁」，
            // 空名单的框一动，里面的节点会全部留在原地
            enclose_nodes: plan.enclose_nodes
          }
          if (input.graph_name) commentParams.graph_name = input.graph_name

          const moved = await wsService.callRequest<{ ok?: boolean }>(
            'blueprint.set_comment',
            commentParams,
            getTargetConnectionId(),
            30000
          )
          if (moved?.ok) commentsMoved += 1
        }

        const copyTotal = duplicated.reduce((sum, item) => sum + item.copies, 0)
        const commentsLeft = comments.length - commentsMoved

        return {
          success: true,
          moved: applied.moved,
          node_count: nodes.length,
          ...(duplicated.length ? { duplicated_getters: duplicated } : {}),
          ...(commentsMoved ? { comments_moved: commentsMoved } : {}),
          ...(commentsLeft ? { comments_left_in_place: commentsLeft } : {}),
          ...(applied.not_found?.length ? { not_found: applied.not_found } : {}),
          summary:
            `已重新排版 ${applied.moved}/${nodes.length} 个节点，现在顺着执行流从左到右。` +
            (copyTotal
              ? `就近复制了 ${copyTotal} 个纯 getter（${duplicated
                  .map((item) => item.name)
                  .join('、')}），省掉横跨整张图的长线。`
              : '') +
            (commentsMoved ? `${commentsMoved} 个注释框跟着它框住的逻辑一起挪了。` : '') +
            (commentsLeft ? `${commentsLeft} 个注释框没框住任何节点，保持原位。` : '') +
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
