/**
 * 蓝图图表发现辅助工具
 * 兼容不同 UnrealAgentLink 版本返回字段（含 UALinkDev53 扩展字段）
 */

export interface BlueprintGraphRef {
  name: string
  type?: string
  source?: string
}

type UnknownObject = Record<string, unknown>

const GRAPH_LIST_KEYS: Array<{ key: string; defaultType?: string }> = [
  { key: 'graphs' },
  { key: 'graph_list' },
  { key: 'graphs_list' },
  { key: 'function_graphs', defaultType: 'function' },
  { key: 'event_graphs', defaultType: 'event' },
  { key: 'macro_graphs', defaultType: 'macro' },
  { key: 'functions', defaultType: 'function' },
  { key: 'events', defaultType: 'event' }
]

function parseGraphNameFromObject(item: UnknownObject): string | undefined {
  const candidates = [
    item.name,
    item.graph_name,
    item.title,
    item.function_name,
    item.event_name,
    item.display_name
  ]
  const firstString = candidates.find((v) => typeof v === 'string' && v.trim().length > 0) as
    | string
    | undefined
  return firstString?.trim()
}

function parseGraphTypeFromObject(item: UnknownObject, fallback?: string): string | undefined {
  const candidates = [item.type, item.graph_type, item.kind, fallback]
  const firstString = candidates.find((v) => typeof v === 'string' && v.trim().length > 0) as
    | string
    | undefined
  return firstString?.trim()
}

export function extractBlueprintGraphRefs(payload: unknown): BlueprintGraphRef[] {
  if (!payload || typeof payload !== 'object') return []
  const data = payload as UnknownObject
  const refs: BlueprintGraphRef[] = []

  for (const { key, defaultType } of GRAPH_LIST_KEYS) {
    const value = data[key]
    if (!Array.isArray(value)) continue

    for (const item of value) {
      if (typeof item === 'string') {
        const name = item.trim()
        if (!name) continue
        refs.push({ name, type: defaultType, source: key })
        continue
      }
      if (item && typeof item === 'object') {
        const obj = item as UnknownObject
        const name = parseGraphNameFromObject(obj)
        if (!name) continue
        refs.push({ name, type: parseGraphTypeFromObject(obj, defaultType), source: key })
      }
    }
  }

  const dedup = new Map<string, BlueprintGraphRef>()
  for (const ref of refs) {
    const k = ref.name.toLowerCase()
    if (!dedup.has(k)) dedup.set(k, ref)
  }

  return Array.from(dedup.values())
}

export function pickPreferredGraphName(graphs: BlueprintGraphRef[]): string | undefined {
  if (graphs.length === 0) return undefined
  const priorities = ['eventgraph', 'constructionscript']
  for (const target of priorities) {
    const hit = graphs.find((g) => g.name.toLowerCase() === target)
    if (hit) return hit.name
  }
  return graphs[0].name
}

/**
 * 图路径的比较形式，和插件 `UAL_AnimGraphNames::SplitPath` 同一套规矩：
 * 每段去首尾空白、`->` 两边的空格去掉、空段丢掉；插件按 IgnoreCase 比，这里转小写。
 */
function normalizeGraphPath(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim().replace(/\s*->\s*/g, '->'))
    .filter((segment) => segment.length > 0)
    .join('/')
    .toLowerCase()
}

/** 「图找不到」之后查出来的真实情况 */
export type GraphNameMiss =
  /** 那个名字是某张子图的名字或路径后半段，而且只对得上一张 —— 换成完整路径重来 */
  | { kind: 'resolved'; path: string }
  | { kind: 'ambiguous'; candidates: string[] }
  /** 插件早于动画蓝图支持（1.2.12）：子图一张都列不出来，AnimGraph 也不认得 */
  | { kind: 'plugin_too_old' }
  | { kind: 'not_found'; available: string[] }

/**
 * 调用方给的图名插件找不到时，对着图列表查一遍是怎么回事。
 *
 * 子图（状态机、状态、转换规则、折叠图）插件只认完整路径
 * `AnimGraph/MR22基础动作/待机`，而模型最自然的写法是只写一个 `待机` ——
 * 用户嘴里、编辑器标签页上都是这么叫的。以前这一下只回一句
 * 「Graph not found: 待机」，模型据此断定「状态内部的图读不到」，转头让用户手点。
 *
 * 返回 null 表示名字本身就在列表里：失败另有原因，原报错照用。
 */
export function explainGraphNameMiss(
  graphName: string,
  graphs: BlueprintGraphRef[]
): GraphNameMiss | null {
  const wanted = normalizeGraphPath(graphName)
  if (!wanted) return null
  if (graphs.some((graph) => normalizeGraphPath(graph.name) === wanted)) return null

  const matches = graphs
    .filter((graph) => graph.name.includes('/'))
    .filter((graph) => normalizeGraphPath(graph.name).endsWith(`/${wanted}`))
    .map((graph) => graph.name)
  if (matches.length === 1) return { kind: 'resolved', path: matches[0] }
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches }

  // 新插件把 AnimGraph 报成 anim_graph 类型；旧插件当它是普通函数图
  const animGraph = graphs.find((graph) => graph.name.toLowerCase() === 'animgraph')
  if (animGraph && animGraph.type !== 'anim_graph') return { kind: 'plugin_too_old' }

  return { kind: 'not_found', available: graphs.map((graph) => graph.name) }
}

/** 列给模型看的图名上限，动画蓝图的子图一多能有上百张 */
const MAX_LISTED_GRAPHS = 60

/** 没法自动换成完整路径时，给模型的那句下一步 */
export function describeGraphNameMiss(
  graphName: string,
  miss: Exclude<GraphNameMiss, { kind: 'resolved' }>,
  pluginUpdateHint: string
): string {
  switch (miss.kind) {
    case 'ambiguous':
      return (
        `"${graphName}" matches more than one graph. Pass the full path as graph_name: ` +
        miss.candidates.join(', ')
      )
    case 'plugin_too_old':
      return (
        'The UnrealAgentLink plugin in this project predates Animation Blueprint support ' +
        '(1.2.12), so it cannot open state machines, states or transition rules. ' +
        pluginUpdateHint
      )
    case 'not_found': {
      const listed = miss.available.slice(0, MAX_LISTED_GRAPHS)
      const more =
        miss.available.length > listed.length
          ? ` (+${miss.available.length - listed.length} more)`
          : ''
      return (
        `No graph named "${graphName}". Graphs inside other graphs are addressed by full path. ` +
        `Graphs in this Blueprint: ${listed.join(', ')}${more}`
      )
    }
  }
}
