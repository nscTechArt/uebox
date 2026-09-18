/**
 * PCG 图的自动排版。
 *
 * ## 跟材质那套的区别
 *
 * 形状上 PCG 图和材质图很像 —— 都是纯数据流 DAG，没有执行流，所以同样直接
 * 交给 ELK 的 `layered` 就行，不用像蓝图那样自己分执行主干。
 *
 * 差别在锚点：材质图只有一个汇聚点（材质主节点），排完把它钉在原地即可。
 * PCG 图有**两个**固定端点 —— 图自带的 Input 和 Output 节点，它们不能删也不能
 * 通过 add_node 重建。这里以 Input 节点为锚，排完整张图平移回它原来的位置，
 * 用户视角里「图还在老地方，只是变整齐了」。
 *
 * ## 方向
 *
 * PCG 图从左往右读：Input 在最左、Output 在最右，数据顺着边往右流。
 * 边的方向和阅读方向一致，所以 `direction: RIGHT` 就是字面意思。
 */

import { getElk } from '../../../blueprint-layout/elkLayout'

/** PCG 节点的典型尺寸。ELK 只拿它算间距，不必精确 */
const NODE_WIDTH = 220
const NODE_HEIGHT = 90

export interface PcgLayoutNode {
  node_id: string
  /** 只用于估高度：引脚多的节点更高 */
  input_pins?: string[]
  output_pins?: string[]
}

export interface PcgLayoutEdge {
  from_node: string
  to_node: string
}

export interface PcgNodePosition {
  node_id: string
  x: number
  y: number
}

/**
 * 引脚多的节点在图里明显更高，按统一高度排会让它压到下面那个节点上。
 * 一个引脚约 22px，加上标题栏的基础高度。
 */
function nodeSize(node: PcgLayoutNode): { width: number; height: number } {
  const pinCount = Math.max(node.input_pins?.length ?? 1, node.output_pins?.length ?? 1)
  return { width: NODE_WIDTH, height: Math.max(NODE_HEIGHT, 50 + pinCount * 22) }
}

/**
 * 算出每个节点该放哪。
 *
 * @param anchorId 排完要钉回原位的节点 id（通常是图的 Input 节点）
 * @param anchorPosition 该节点当前的位置
 * @returns 全部节点的新坐标，含锚点自己（它算出来的坐标正好等于原位）
 */
export async function layoutPcgNodes(
  nodes: PcgLayoutNode[],
  edges: PcgLayoutEdge[],
  anchorId: string,
  anchorPosition: { x: number; y: number }
): Promise<PcgNodePosition[]> {
  if (nodes.length === 0) return []

  const known = new Set(nodes.map((n) => n.node_id))

  const elk = await getElk()
  const laid = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '160',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.favorStraightEdges': 'true'
    },
    children: nodes.map((node) => ({ id: node.node_id, ...nodeSize(node) })),
    // 指向图外节点的连线要丢掉，ELK 遇到未知端点会直接抛
    edges: edges
      .filter((e) => known.has(e.from_node) && known.has(e.to_node))
      .map((e, index) => ({ id: `e${index}`, sources: [e.from_node], targets: [e.to_node] }))
  })

  const placed = new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))

  // 锚点算出来的位置对齐到它的真实位置，其余节点跟着平移同样的量。
  // 锚点不在图里（比如调用方传了个不存在的 id）就不平移 —— 排出来的图仍然是
  // 对的，只是整体挪了位置，比直接失败强
  const anchorLaid = placed.get(anchorId) ?? { x: 0, y: 0 }
  const dx = anchorPosition.x - anchorLaid.x
  const dy = anchorPosition.y - anchorLaid.y

  return nodes
    .map((node) => {
      const pos = placed.get(node.node_id)
      if (!pos) return null
      return { node_id: node.node_id, x: Math.round(pos.x + dx), y: Math.round(pos.y + dy) }
    })
    .filter((p): p is PcgNodePosition => p !== null)
}
