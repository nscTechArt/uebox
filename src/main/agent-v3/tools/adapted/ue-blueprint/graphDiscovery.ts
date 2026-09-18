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
