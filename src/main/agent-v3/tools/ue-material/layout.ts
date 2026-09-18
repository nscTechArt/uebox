/**
 * 材质图的自动排版。
 *
 * ## 为什么不复用蓝图那套
 *
 * `blueprint-layout/elkLayout.ts` 有 500 多行，其中大半是**执行流**特有的：
 * `isExecPin()` 靠 `exec`/`then` 这类关键字认执行引脚，`assignExecutionBackbone()`
 * 从没有 exec 输入的节点起排主干，数据节点再吊在用到它的 exec 节点旁边。
 *
 * 材质图里没有执行流，全是数据流。那套逻辑套上来的结果是所有节点都被判成
 * 「数据节点」、主干为空 —— 整个骨架落空。
 *
 * 反过来说材质图**更简单**：一个纯 DAG，唯一的汇聚点是材质主节点。
 * 这正好是 ELK `layered` 最擅长的形状，直接交给它就行，不用自己分层。
 *
 * ## 方向
 *
 * 材质图从右往左读：材质主节点在最右边，数据从左边流进去。
 * ELK 的 `direction: RIGHT` 说的是**边的方向**（源在左、汇在右），
 * 而材质的边正是「表达式 → 主节点」，所以 RIGHT 排出来主节点就在最右 ——
 * 名字听着反，方向是对的。
 */

import { getElk } from '../../../blueprint-layout/elkLayout'

/** 材质主节点在图里的虚拟 id。`material.get_graph` 的连线就是用这个字符串指它的 */
const MATERIAL_ROOT = 'Material'

/** UE 材质节点的典型尺寸。ELK 只拿它算间距，不必精确 */
const NODE_WIDTH = 180
const NODE_HEIGHT = 110

export interface MaterialLayoutNode {
  node_id: string
  /** 只用于估节点高度：贴图节点比常量节点高得多 */
  class?: string
}

export interface MaterialLayoutConnection {
  from_node: string
  to_node: string
}

export interface MaterialNodePosition {
  node_id: string
  x: number
  y: number
}

/**
 * 贴图采样节点又高又宽（六个输出引脚 + 一张预览图），
 * 按常量节点的尺寸排会让它压到下面的节点上。
 */
function nodeSize(className: string | undefined): { width: number; height: number } {
  const name = className ?? ''
  if (name.includes('TextureSample') || name.includes('TextureObject')) {
    return { width: 260, height: 220 }
  }
  if (name.includes('Constant3Vector') || name.includes('Constant4Vector')) {
    return { width: NODE_WIDTH, height: 150 }
  }
  return { width: NODE_WIDTH, height: NODE_HEIGHT }
}

/**
 * 算出每个表达式节点该放哪。
 *
 * @param rootPosition 材质主节点的当前位置。排完的图会平移到以它为锚点，
 *                     这样主节点**不动**，表达式都排到它左边 ——
 *                     不这么做的话整张图会跳到别处，用户还得自己找回来。
 * @returns 只包含表达式节点的新坐标；主节点不在里面（它不是表达式，也不该被挪）
 */
export async function layoutMaterialNodes(
  nodes: MaterialLayoutNode[],
  connections: MaterialLayoutConnection[],
  rootPosition: { x: number; y: number }
): Promise<MaterialNodePosition[]> {
  if (nodes.length === 0) return []

  const known = new Set(nodes.map((n) => n.node_id))

  const elkNodes = nodes.map((node) => ({ id: node.node_id, ...nodeSize(node.class) }))
  // 主节点也进图，否则 ELK 不知道往哪汇聚，孤立的分支会被排成平行的几列
  elkNodes.push({ id: MATERIAL_ROOT, width: NODE_WIDTH, height: 260 })

  const edges = connections
    // 指向图外节点的连线要丢掉，ELK 遇到未知端点会直接抛
    .filter(
      (c) =>
        (known.has(c.from_node) || c.from_node === MATERIAL_ROOT) &&
        (known.has(c.to_node) || c.to_node === MATERIAL_ROOT)
    )
    .map((c, index) => ({
      id: `e${index}`,
      sources: [c.from_node],
      targets: [c.to_node]
    }))

  const elk = await getElk()
  const laid = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      // 边从表达式指向主节点，所以 RIGHT 会把主节点排到最右 —— 正是材质图的读法
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '50',
      'elk.layered.spacing.nodeNodeBetweenLayers': '120',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.favorStraightEdges': 'true'
    },
    children: elkNodes,
    edges
  })

  const placed = new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))

  // 把主节点算出来的位置对齐到它的真实位置，其余节点跟着平移同样的量
  const rootLaid = placed.get(MATERIAL_ROOT) ?? { x: 0, y: 0 }
  const dx = rootPosition.x - rootLaid.x
  const dy = rootPosition.y - rootLaid.y

  return nodes
    .map((node) => {
      const pos = placed.get(node.node_id)
      if (!pos) return null
      return { node_id: node.node_id, x: Math.round(pos.x + dx), y: Math.round(pos.y + dy) }
    })
    .filter((p): p is MaterialNodePosition => p !== null)
}
