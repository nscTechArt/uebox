/**
 * `material_graph_slice` —— 只读一张材质图里你关心的那一段。
 *
 * 2026-09-24 买量定序器反馈（缺口 4）：一张 510 节点、528 根线的母材质，
 * `material_get_graph` 按上下文预算列了 60 个节点的全貌加一段简表，
 * 其余「350 个节点连简表都没列、478 根连线未列」，而且没有参数能接着往下读。
 * 当时要查的只是 OpacityMask 往回那一小段，却得接收大量无关信息，尾部又够不到。
 *
 * 这里不动引擎侧：`material.get_graph` 本来就回全图，截断发生在给模型排版的那一步。
 * 所以在同一份数据上**按连线往回走**，只排版走到的那一段：
 *
 *   - `from`：从主节点引脚（`OpacityMask`）或某个节点（node_id / guid）开始往上游走
 *   - `depth`：走几层（默认 3）
 *   - `node_ids`：或者直接点名要看哪几个节点
 *
 * 命名重定向的 usage 顺着 declaration 接着走 —— 复杂材质到处是它，走到 usage 就停等于没走。
 * 走到深度上限还没到头的节点列成「边界」，拿它们的 id 再调一次就能接着往上读。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

export interface SliceNode {
  node_id: string
  class?: string
  guid?: string
  value?: unknown
  description?: string
  inputs?: Array<{ name: string; is_connected?: boolean; type?: string }>
  outputs?: Array<{ name: string; index?: number; type?: string }>
  reroute_kind?: string
  reroute_name?: string
  reroute_declaration_node?: string
}

export interface SliceConnection {
  from_node?: string
  from_pin?: string
  to_node?: string
  /** 引擎侧目标引脚的键名是 `to_input` */
  to_input?: string
  from_type?: string
  to_type?: string
}

export interface GraphData {
  material_name?: string
  material_path?: string
  nodes?: SliceNode[]
  connections?: SliceConnection[]
  material_pins?: string[]
  use_material_attributes?: boolean
}

/** 主节点在连线里的名字 */
const ROOT = 'Material'
/** 切片排版的字符额度。切片本来就是为了小，超了说明 depth 给大了 */
const SLICE_CHAR_BUDGET = 16_000

export interface SliceResult {
  nodes: SliceNode[]
  connections: SliceConnection[]
  /** 走到深度上限、上游还有东西没展开的节点 */
  frontier: string[]
  /** 起点里认不出来的 */
  unknownStarts: string[]
}

/**
 * 在全图上按连线往回走。纯函数，便于测试。
 *
 * 起点可以是主节点引脚名（`OpacityMask` 或 `Material.OpacityMask`）、node_id 或 guid。
 */
export function sliceGraph(
  graph: GraphData,
  opts: { from?: string[]; nodeIds?: string[]; depth: number }
): SliceResult {
  const nodes = graph.nodes ?? []
  const connections = graph.connections ?? []
  const byId = new Map(nodes.map((n) => [n.node_id, n]))
  const byGuid = new Map(nodes.filter((n) => n.guid).map((n) => [n.guid!.toLowerCase(), n]))
  const resolve = (ref: string): SliceNode | undefined =>
    byId.get(ref) ?? byGuid.get(ref.toLowerCase())

  /** 某个节点的上游：连进它的线的源头，加上 usage → declaration 这一跳 */
  const upstream = (id: string): string[] => {
    const out = connections.filter((c) => c.to_node === id && c.from_node).map((c) => c.from_node!)
    const node = byId.get(id)
    if (node?.reroute_declaration_node) out.push(node.reroute_declaration_node)
    return out
  }

  const picked = new Set<string>()
  const unknownStarts: string[] = []
  const frontier = new Set<string>()

  for (const ref of opts.nodeIds ?? []) {
    const node = resolve(ref)
    if (node) picked.add(node.node_id)
    else unknownStarts.push(ref)
  }

  // 广度优先，记每个节点第一次到达时的层数
  let layer: string[] = []
  for (const ref of opts.from ?? []) {
    const pin = ref.startsWith(`${ROOT}.`) ? ref.slice(ROOT.length + 1) : ref
    const rootSources = connections
      .filter((c) => c.to_node === ROOT && c.to_input?.toLowerCase() === pin.toLowerCase())
      .map((c) => c.from_node!)
      .filter(Boolean)
    if (rootSources.length > 0) {
      layer.push(...rootSources)
      continue
    }
    const node = resolve(ref)
    if (node) layer.push(node.node_id)
    else unknownStarts.push(ref)
  }

  for (let level = 1; layer.length > 0; level++) {
    const next: string[] = []
    for (const id of layer) {
      if (picked.has(id) || !byId.has(id)) continue
      picked.add(id)
      const up = upstream(id).filter((u) => !picked.has(u))
      if (level >= opts.depth) {
        if (up.length > 0) frontier.add(id)
        continue
      }
      next.push(...up)
    }
    layer = next
  }

  const inSlice = (id?: string): boolean => Boolean(id && (picked.has(id) || id === ROOT))
  return {
    nodes: nodes.filter((n) => picked.has(n.node_id)),
    connections: connections.filter((c) => inSlice(c.from_node) && inSlice(c.to_node)),
    frontier: [...frontier],
    unknownStarts
  }
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value === '' ? '(未设置)' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function pin(p: { name: string; type?: string }): string {
  return p.type ? `${p.name} ${p.type}` : p.name
}

export function formatSlice(graph: GraphData, slice: SliceResult, depth: number): string {
  const total = graph.nodes?.length ?? 0
  const name = graph.material_name ?? graph.material_path ?? '材质'
  const lines = [
    `${name}：全图 ${total} 个节点，这一段 ${slice.nodes.length} 个、${slice.connections.length} 根线（往上游走 ${depth} 层）。`
  ]
  if (graph.use_material_attributes) {
    lines.push('⚠️ use_material_attributes=true：主节点上只有 MaterialAttributes 那一根有效。')
  }
  if (slice.unknownStarts.length > 0) {
    const pins = (graph.material_pins ?? []).join('、')
    lines.push(
      `⚠️ 这些起点对不上：${slice.unknownStarts.join('、')}。起点写主节点引脚名（${pins || '如 OpacityMask'}，没接线的引脚走不出东西）、node_id 或 guid。`
    )
  }

  const body: string[] = ['', '节点（node_id ｜ 类型 ｜ 值 ｜ 输入（*=已接线）｜ 输出 ｜ guid）：']
  let chars = 0
  let cut = 0
  for (const node of slice.nodes) {
    const parts = [`  ${node.node_id}`, node.class ?? '?']
    const value = formatValue(node.value)
    if (value) parts.push(value)
    const inputs = (node.inputs ?? [])
      .map((p) => `${pin(p)}${p.is_connected ? '*' : ''}`)
      .join(', ')
    const outputs = (node.outputs ?? []).map(pin).join(', ')
    if (inputs) parts.push(`in: ${inputs}`)
    if (outputs) parts.push(`out: ${outputs}`)
    if (node.guid) parts.push(node.guid)
    let line = parts.join(' ｜ ')
    if (node.reroute_declaration_node)
      line += `\n    命名重定向 usage → ${node.reroute_declaration_node}`
    if (node.description) line += `\n    注释：${node.description}`
    if (chars + line.length > SLICE_CHAR_BUDGET) {
      cut++
      continue
    }
    chars += line.length
    body.push(line)
  }
  body.push('', '连线（源.输出 → 目标.输入）：')
  for (const c of slice.connections) {
    const line = `  ${c.from_node}${c.from_pin ? `.${c.from_pin}` : ''} → ${c.to_node}.${c.to_input ?? '?'}`
    if (chars + line.length > SLICE_CHAR_BUDGET) {
      cut++
      continue
    }
    chars += line.length
    body.push(line)
  }
  lines.push(...body)

  if (slice.frontier.length > 0) {
    lines.push(
      '',
      `边界：${slice.frontier.join('、')} 的上游还没展开。要接着读，把它们放进 from 再调一次。`
    )
  }
  if (cut > 0) {
    lines.push('', `⚠️ 这一段也超过了排版额度，少列了 ${cut} 行。把 depth 调小或换更近的起点。`)
  }
  return lines.join('\n')
}

const InputSchema = z
  .object({
    path: z.string().trim().min(1).describe('材质资产路径（母材质，不是材质实例）'),
    from: z
      .array(z.string().trim().min(1))
      .max(20)
      .optional()
      .describe('从这里往上游走：主节点引脚名如 "OpacityMask"，或 node_id / guid'),
    depth: z.number().int().min(1).max(12).default(3).describe('往上游走几层，默认 3'),
    node_ids: z
      .array(z.string().trim().min(1))
      .max(60)
      .optional()
      .describe('或者直接点名要看的节点（node_id / guid）')
  })
  .refine((v) => (v.from?.length ?? 0) + (v.node_ids?.length ?? 0) > 0, {
    message: 'from 和 node_ids 至少给一个；要看全图用 material_get_graph'
  })

export function createMaterialGraphSliceTool(): UnrealAgentTool<SliceResult> {
  return defineTool({
    name: 'material_graph_slice',
    namespace: 'ue.material',
    risk: 'safe',
    concurrency: 'parallel',
    description: `只读材质图里的一段：从主节点引脚（如 OpacityMask）或某个节点往上游走 N 层，或直接点名几个节点。
material_get_graph 在大图上会截断（几百个节点只列得出一部分）时，用它把要查、要改的那一段读全：
每个节点的类型、值、带类型的输入输出引脚、guid，段内的连线。命名重定向会顺着 declaration 接着走。
走到深度上限还有上游的节点会列成「边界」，拿它们当 from 再调一次就能接着往上读。`,
    input: InputSchema,
    execute: async (input) => {
      const graph = await callUe<GraphData>(
        'material.get_graph',
        { path: input.path, include_values: true },
        { timeoutMs: 60_000 }
      )
      const slice = sliceGraph(graph, {
        ...(input.from ? { from: input.from } : {}),
        ...(input.node_ids ? { nodeIds: input.node_ids } : {}),
        depth: input.depth
      })
      return { text: formatSlice(graph, slice, input.depth), details: slice }
    }
  })
}
