/**
 * 库条目的两种 payload 形态，以及怎么在渲染层安全地分辨。
 *
 * ## 为什么会有两种
 *
 * 老条目是手工粘进来的整张图，payload 长这样：
 * `{ graphs, functions, macros, variables, components, ... }`
 *
 * 片段条目是从引擎里圈一段存下来的，payload 长这样：
 * `{ form: "snippet", t3d: "Begin Object ...", meta: { nodeCount, ... } }`
 *
 * 两种存的其实是**同一种文本** —— 引擎自己的节点序列化。区别在于片段是
 * 圈定选区存的、扫过外部依赖、多带一份摘要，所以它能放回工程，老条目不能。
 *
 * ## 判别规则：缺 form 一律按老条目
 *
 * 2026-08-29 之前存下来的包里根本没有 `form` 字段。按「不认识就报错」处理的话，
 * **所有存量条目在升级后一条都打不开**。所以缺省一定要落在老形态上。
 *
 * 反过来判宽也不行：把老条目当片段，详情页会去读一段不存在的正文，
 * 用户看到的是一个空白的摘要页 —— 他的东西看着像丢了。
 * 所以只有**明确写着** `form: "snippet"` 且带得出非空 `t3d` 正文的才算片段。
 */

export type SnippetForm = 'snippet' | 't3d'

/** 选区边界切断的连线 —— 放回工程后要手动接 */
export interface SnippetOpenPort {
  nodeId: string
  pinName: string
  dir: 'in' | 'out'
  formerPeer: string
}

/** 片段摘要。只作展示与检索，放回工程用的是 `t3d` 正文 */
export interface SnippetMetaData {
  nodeCount: number
  connectionCount: number
  classes: string[]
  openPorts: SnippetOpenPort[]
}

export interface SnippetPayload {
  form: 'snippet'
  /** 引擎导出的节点序列化文本 */
  t3d: string
  meta: SnippetMetaData
  sourceBlueprintPath?: string
  sourceGraphName?: string
}

/** 判别形态。规则见文件头 —— 缺 `form` 一律按老条目。 */
export function detectSnippetForm(payload: unknown): SnippetForm {
  if (!payload || typeof payload !== 'object') return 't3d'
  const record = payload as Record<string, unknown>
  if (record.form !== 'snippet') return 't3d'
  if (typeof record.t3d !== 'string' || record.t3d.length === 0) return 't3d'
  return 'snippet'
}

/** 取出片段；不是片段形态就返回 null */
export function readSnippetPayload(payload: unknown): SnippetPayload | null {
  if (detectSnippetForm(payload) !== 'snippet') return null
  const record = payload as Record<string, unknown>
  const meta = (record.meta ?? {}) as Record<string, unknown>

  return {
    form: 'snippet',
    t3d: record.t3d as string,
    meta: {
      nodeCount: typeof meta.nodeCount === 'number' ? meta.nodeCount : 0,
      connectionCount: typeof meta.connectionCount === 'number' ? meta.connectionCount : 0,
      classes: Array.isArray(meta.classes) ? (meta.classes as string[]) : [],
      openPorts: Array.isArray(meta.openPorts) ? (meta.openPorts as SnippetOpenPort[]) : []
    },
    sourceBlueprintPath:
      typeof record.sourceBlueprintPath === 'string' ? record.sourceBlueprintPath : undefined,
    sourceGraphName: typeof record.sourceGraphName === 'string' ? record.sourceGraphName : undefined
  }
}

export interface SnippetSummary {
  nodeCount: number
  connectionCount: number
  openPortCount: number
  /** 用到的节点类型，去重、保持出现顺序 */
  classes: string[]
  sourceBlueprintPath?: string
  sourceGraphName?: string
}

/** 给详情页用的摘要 */
export function summarizeSnippet(payload: SnippetPayload): SnippetSummary {
  return {
    nodeCount: payload.meta.nodeCount,
    connectionCount: payload.meta.connectionCount,
    openPortCount: payload.meta.openPorts.length,
    classes: payload.meta.classes,
    sourceBlueprintPath: payload.sourceBlueprintPath,
    sourceGraphName: payload.sourceGraphName
  }
}
