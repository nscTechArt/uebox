import type { ELK, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js'

export interface BlueprintLayoutNode {
  id: string
  name: string
  type: string
  x: number
  y: number
}

export interface BlueprintLayoutConnection {
  from: string
  to: string
}

interface GraphNodeState {
  id: string
  type: string
  name: string
  execOutEdges: Array<{ targetId: string; pinName: string }>
  execInEdges: string[]
  dataInEdges: string[]
  dataOutEdges: string[]
  rank: number
  lane: number
  positioned: boolean
}

interface TemplateLayoutContext<T extends BlueprintLayoutNode> {
  nodes: T[]
  graph: Map<string, GraphNodeState>
  byId: Map<string, T>
}

/**
 * 懒加载 elkjs。
 *
 * elk.bundled.js 是一个 7MB 以上的 GWT 产物，只有蓝图自动布局走不通
 * 内置模板、需要退回通用布局算法时才用得到。顶层 import + `new ELK()`
 * 会让它在每次开机时都被加载并实例化一次。
 */
let cachedElk: ELK | null = null

/**
 * 材质排版（`ue-material/layout.ts`）也要这个实例 —— elk.bundled.js 是个 7MB+
 * 的 GWT 产物，两边各 new 一个等于加载两遍。
 */
export async function getElk(): Promise<ELK> {
  if (!cachedElk) {
    const mod = await import('elkjs/lib/elk.bundled.js')
    const ElkCtor = (mod.default ?? mod) as unknown as new () => ELK
    cachedElk = new ElkCtor()
  }
  return cachedElk
}

const NODE_WIDTH = 220
const NODE_HEIGHT = 100
const EXEC_X_GAP = 130
const EXEC_Y_GAP = 180
const DATA_X_GAP = 150
const DATA_Y_GAP = 120
const DATA_SLOT_Y_GAP = 70
const TOP_PADDING = 80

function parsePinRef(ref: string): { nodeId: string; pinName: string } {
  const [nodeId, pinName = 'exec'] = ref.split('.')
  return { nodeId, pinName }
}

function isExecPin(pinName: string): boolean {
  const lower = pinName.toLowerCase()
  const execKeywords = [
    'exec',
    'execute',
    'then',
    'completed',
    'finished',
    'true',
    'false',
    'loop',
    'body',
    'loopbody',
    'play',
    'stop',
    'reverse',
    'update',
    'onsuccess',
    'onfail',
    'onfailed',
    'oncanceled',
    'oncomplete',
    'oncompleted'
  ]
  return execKeywords.some((keyword) => lower.includes(keyword))
}

function normalizeName(value: string): string {
  return value.toLowerCase()
}

function hasAny(value: string, patterns: string[]): boolean {
  const normalized = normalizeName(value)
  return patterns.some((pattern) => normalized.includes(pattern))
}

function isEntryNode(node: GraphNodeState): boolean {
  return (
    hasAny(node.type, ['functionentry', 'event']) ||
    hasAny(node.name, ['entry', 'beginplay', 'tick', 'input', 'fire'])
  )
}

function isReturnNode(node: GraphNodeState): boolean {
  return hasAny(node.type, ['functionresult']) || hasAny(node.name, ['return', '返回'])
}

function isBranchNode(node: GraphNodeState): boolean {
  return hasAny(node.name, ['branch', '分支']) || hasAny(node.type, ['ifthenelse'])
}

function isLineTraceNode(node: GraphNodeState): boolean {
  return (
    hasAny(node.name, ['line trace', '线条追踪', '射线检测', '射线']) ||
    hasAny(node.type, ['linetrace'])
  )
}

function isBreakHitResultNode(node: GraphNodeState): boolean {
  return (
    hasAny(node.name, ['break hit result', '中断命中结果']) || hasAny(node.type, ['breakstruct'])
  )
}

function isSetNode(node: GraphNodeState): boolean {
  return hasAny(node.type, ['variableset']) || hasAny(node.name, ['set '])
}

function isLocationNode(node: GraphNodeState): boolean {
  return hasAny(node.name, ['get actor location', '获取actor位置'])
}

function isForwardVectorNode(node: GraphNodeState): boolean {
  return hasAny(node.name, ['get actor forward vector', '获取actor向前向量'])
}

function isTraceDistanceNode(node: GraphNodeState): boolean {
  return hasAny(node.name, ['tracedistance', 'trace distance'])
}

function isSelfNode(node: GraphNodeState): boolean {
  return hasAny(node.type, ['self']) || hasAny(node.name, ['self', '自'])
}

function isMathNode(node: GraphNodeState): boolean {
  return hasAny(node.name, [
    'vector',
    'rotator',
    'make ',
    'break ',
    '转换',
    '中断',
    '+',
    '-',
    '*',
    '/'
  ])
}

function isPureDataNode(node: GraphNodeState): boolean {
  return node.execInEdges.length === 0 && node.execOutEdges.length === 0
}

function buildGraph<T extends BlueprintLayoutNode>(
  nodes: T[],
  connections: BlueprintLayoutConnection[]
): Map<string, GraphNodeState> {
  const graph = new Map<string, GraphNodeState>()
  for (const node of nodes) {
    graph.set(node.id, {
      id: node.id,
      type: node.type,
      name: node.name,
      execOutEdges: [],
      execInEdges: [],
      dataInEdges: [],
      dataOutEdges: [],
      rank: -1,
      lane: 0,
      positioned: false
    })
  }

  for (const connection of connections) {
    const from = parsePinRef(connection.from)
    const to = parsePinRef(connection.to)
    const fromNode = graph.get(from.nodeId)
    const toNode = graph.get(to.nodeId)
    if (!fromNode || !toNode) continue

    if (isExecPin(from.pinName) || isExecPin(to.pinName)) {
      fromNode.execOutEdges.push({ targetId: to.nodeId, pinName: from.pinName })
      toNode.execInEdges.push(from.nodeId)
    } else {
      fromNode.dataOutEdges.push(to.nodeId)
      toNode.dataInEdges.push(from.nodeId)
    }
  }

  return graph
}

function markPlaced<T extends BlueprintLayoutNode>(
  context: TemplateLayoutContext<T>,
  nodeId: string,
  x: number,
  y: number,
  rank = 0,
  lane = 0
): boolean {
  const state = context.graph.get(nodeId)
  const node = context.byId.get(nodeId)
  if (!state || !node) return false
  state.positioned = true
  state.rank = rank
  state.lane = lane
  node.x = x
  node.y = y
  return true
}

function detectTraceTemplate<T extends BlueprintLayoutNode>(
  context: TemplateLayoutContext<T>
): boolean {
  const states = [...context.graph.values()]
  const entry = states.find(isEntryNode)
  const trace = states.find(isLineTraceNode)
  const branch = states.find(isBranchNode)
  const returnNode = states.find(isReturnNode)

  if (!entry || !trace || !branch || !returnNode) {
    return false
  }

  const setNodes = states.filter(isSetNode)
  const primarySet =
    setNodes.find((node) => hasAny(node.name, ['lasthitactor', 'hitactor'])) || setNodes[0]
  const breakHit = states.find(isBreakHitResultNode)
  const locationNode = states.find(isLocationNode)
  const forwardNode = states.find(isForwardVectorNode)
  const distanceNode = states.find(isTraceDistanceNode)
  const selfNode = states.find(isSelfNode)
  const mathNodes = states.filter(
    (node) =>
      isMathNode(node) &&
      !isBreakHitResultNode(node) &&
      !isLocationNode(node) &&
      !isForwardVectorNode(node)
  )

  const xStep = NODE_WIDTH + EXEC_X_GAP
  const mainY = 260
  const topY = 120
  const upperY = 180

  markPlaced(context, entry.id, 0, mainY, 0, 0)
  markPlaced(context, trace.id, xStep, mainY, 1, 0)
  markPlaced(context, branch.id, xStep * 2, mainY, 2, 0)
  if (primarySet) {
    markPlaced(context, primarySet.id, xStep * 3, mainY - 70, 3, 0)
  }
  markPlaced(context, returnNode.id, xStep * 4, mainY - 40, 4, 0)

  if (breakHit) {
    markPlaced(context, breakHit.id, xStep * 2, topY, 2, -1)
  }

  if (selfNode) {
    markPlaced(context, selfNode.id, -220, upperY, -1, 0)
  }
  if (forwardNode) {
    markPlaced(context, forwardNode.id, -20, topY, -1, -1)
  }
  if (locationNode) {
    markPlaced(context, locationNode.id, 320, topY, 0, -1)
  }
  if (distanceNode) {
    markPlaced(context, distanceNode.id, -220, mainY - 40, -1, 1)
  }

  const sortedMathNodes = [...mathNodes].sort((a, b) => a.name.localeCompare(b.name))
  sortedMathNodes.forEach((node, index) => {
    const x = index === 0 ? 170 : 500 + (index - 1) * 180
    const y = index === 0 ? mainY - 20 : mainY - 10
    markPlaced(context, node.id, x, y, 0, index + 1)
  })

  return true
}

function sortExecEdges(
  edges: Array<{ targetId: string; pinName: string }>
): Array<{ targetId: string; pinName: string }> {
  const weight = (pinName: string): number => {
    const lower = pinName.toLowerCase()
    if (lower.includes('then')) return 0
    if (lower.includes('true')) return 1
    if (lower.includes('completed')) return 2
    if (lower.includes('false')) return 3
    if (lower.includes('else')) return 4
    return 5
  }

  return [...edges].sort((a, b) => weight(a.pinName) - weight(b.pinName))
}

function assignExecutionBackbone<T extends BlueprintLayoutNode>(
  context: TemplateLayoutContext<T>
): void {
  const sources = [...context.graph.values()]
    .filter((node) => node.execOutEdges.length > 0 && node.execInEdges.length === 0)
    .sort((a, b) => Number(!isEntryNode(a)) - Number(!isEntryNode(b)))

  if (sources.length === 0) {
    return
  }

  let baseLane = 0
  for (const source of sources) {
    const queue: Array<{ id: string; rank: number; lane: number }> = [
      { id: source.id, rank: 0, lane: baseLane }
    ]
    let maxLane = baseLane

    while (queue.length > 0) {
      const current = queue.shift()!
      const state = context.graph.get(current.id)
      const node = context.byId.get(current.id)
      if (!state || !node) continue
      if (state.positioned && current.rank <= state.rank) continue

      state.rank = current.rank
      state.lane = current.lane
      state.positioned = true
      node.x = current.rank * (NODE_WIDTH + EXEC_X_GAP)
      node.y = current.lane * EXEC_Y_GAP

      const outgoing = sortExecEdges(state.execOutEdges)
      if (outgoing.length === 1) {
        queue.push({ id: outgoing[0].targetId, rank: current.rank + 1, lane: current.lane })
      } else if (outgoing.length > 1) {
        const midpoint = (outgoing.length - 1) / 2
        outgoing.forEach((edge, index) => {
          const targetLane = current.lane + (index - midpoint)
          queue.push({ id: edge.targetId, rank: current.rank + 1, lane: targetLane })
          maxLane = Math.max(maxLane, targetLane)
        })
      }
    }

    baseLane = maxLane + 2
  }
}

function positionDataAncestors<T extends BlueprintLayoutNode>(
  context: TemplateLayoutContext<T>,
  nodeId: string,
  consumerX: number,
  consumerY: number,
  depth: number,
  slot: number
): void {
  const state = context.graph.get(nodeId)
  const node = context.byId.get(nodeId)
  if (!state || !node || state.positioned) return

  state.positioned = true
  const horizontalBias = isSelfNode(state)
    ? 0.72
    : isPureDataNode(state) && state.dataOutEdges.length > 0
      ? 0.64
      : 1
  const xGap = Math.round(DATA_X_GAP * horizontalBias)
  const baseY = consumerY - depth * DATA_Y_GAP
  const slotOffset = slot * DATA_SLOT_Y_GAP

  node.x = consumerX - depth * xGap
  node.y = baseY + slotOffset

  if (isSelfNode(state)) {
    node.y = consumerY - Math.floor(DATA_Y_GAP * 0.45)
  }
  if (isMathNode(state) && depth === 1) {
    node.y = consumerY - Math.floor(DATA_Y_GAP * 0.75) + slotOffset
  }

  for (const [index, inputId] of [...state.dataInEdges].entries()) {
    positionDataAncestors(context, inputId, node.x, node.y, depth + 1, index)
  }
}

function assignDataSatellites<T extends BlueprintLayoutNode>(
  context: TemplateLayoutContext<T>
): void {
  const execNodes = [...context.graph.values()]
    .filter((node) => node.positioned)
    .sort((a, b) => a.rank - b.rank)

  for (const execNode of execNodes) {
    const consumer = context.byId.get(execNode.id)
    if (!consumer) continue
    for (const [index, inputId] of [...execNode.dataInEdges].entries()) {
      positionDataAncestors(context, inputId, consumer.x, consumer.y, 1, index)
    }
  }

  let orphanRow = 0
  for (const state of context.graph.values()) {
    if (state.positioned) continue
    const node = context.byId.get(state.id)
    if (!node) continue
    state.positioned = true
    node.x = -DATA_X_GAP * 2
    node.y = TOP_PADDING + orphanRow * DATA_Y_GAP
    orphanRow += 1
  }
}

function normalizeVerticalOffset<T extends BlueprintLayoutNode>(nodes: T[]): void {
  const minY = Math.min(...nodes.map((node) => node.y))
  if (!Number.isFinite(minY) || minY >= TOP_PADDING) return
  const shiftY = TOP_PADDING - minY
  for (const node of nodes) {
    node.y += shiftY
  }
}

async function applyElkFallback<T extends BlueprintLayoutNode>(
  nodes: T[],
  connections: BlueprintLayoutConnection[]
): Promise<T[]> {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const elkNodes: ElkNode[] = nodes.map((node) => ({
    id: node.id,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    labels: [{ text: node.name }]
  }))

  const elkEdges: ElkExtendedEdge[] = connections
    .filter((connection) => {
      const from = parsePinRef(connection.from).nodeId
      const to = parsePinRef(connection.to).nodeId
      return nodeIds.has(from) && nodeIds.has(to)
    })
    .map((connection, index) => {
      const from = parsePinRef(connection.from)
      const to = parsePinRef(connection.to)
      return {
        id: `edge-${index}`,
        sources: [from.nodeId],
        targets: [to.nodeId],
        layoutOptions: isExecPin(from.pinName) ? { 'elk.priority': '10' } : { 'elk.priority': '1' }
      }
    })

  const elk = await getElk()
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.spacing.edgeEdge': '15',
      'elk.spacing.edgeNode': '25',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.edgeRouting': 'ORTHOGONAL'
    },
    children: elkNodes,
    edges: elkEdges
  })

  const positionMap = new Map(
    (graph.children || []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }])
  )

  const result = nodes.map((node) => {
    const position = positionMap.get(node.id)
    return position ? { ...node, x: position.x, y: position.y } : node
  })
  normalizeVerticalOffset(result)
  return result
}

export async function autoLayoutBlueprintNodes<T extends BlueprintLayoutNode>(
  nodes: T[],
  connections: BlueprintLayoutConnection[]
): Promise<T[]> {
  if (nodes.length === 0) return nodes

  const working = nodes.map((node) => ({ ...node }))
  const graph = buildGraph(working, connections)
  const byId = new Map(working.map((node) => [node.id, node]))
  const context: TemplateLayoutContext<T> = { nodes: working, graph, byId }

  if (detectTraceTemplate(context)) {
    normalizeVerticalOffset(working)
    return working
  }

  const hasExecutionEdges = [...graph.values()].some((node) => node.execOutEdges.length > 0)
  if (!hasExecutionEdges) {
    return applyElkFallback(working, connections)
  }

  assignExecutionBackbone(context)
  assignDataSatellites(context)

  const hasBackbonePlacement = [...graph.values()].some((node) => node.rank >= 0)
  if (!hasBackbonePlacement) {
    return applyElkFallback(working, connections)
  }

  const returnNodes = [...graph.values()].filter(isReturnNode)
  if (returnNodes.length > 0) {
    const maxRank = Math.max(...[...graph.values()].map((node) => node.rank))
    for (const returnNode of returnNodes) {
      const placed = byId.get(returnNode.id)
      if (!placed) continue
      placed.x = Math.max(placed.x, (maxRank + 1) * (NODE_WIDTH + EXEC_X_GAP))
    }
  }

  normalizeVerticalOffset(working)
  return working
}
