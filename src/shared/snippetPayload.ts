/**
 * 片段条目的 payload 约定。
 *
 * IPC 层不解释包清单中的 `payload`（见 `shared/libraryPackage.ts`）。
 * 主进程与渲染进程共用片段 payload 的类型、判别和读取逻辑，
 * 避免分别维护导致行为不一致；这类差异无法仅靠类型检查发现。
 *
 * ## 两种 payload 形态
 *
 * ```jsonc
 * // 片段（从引擎里存下来的一段逻辑）
 * { "form": "snippet", "t3d": "Begin Object ...", "meta": { nodeCount, ... } }
 * // 老条目（2026-08-29 之前手工粘进来的整张图）
 * { "graphs": [ { "name": "EventGraph", "code": "Begin Object ..." } ] }
 * ```
 *
 * 两种存的其实是**同一种文本** —— 引擎自己的节点序列化（编辑器 Ctrl+C
 * 那一段）。区别只在片段多带一份摘要，以及它是圈定选区存下来的、
 * 扫过外部依赖。
 *
 * **缺少 `form` 时按老条目处理**。2026-08-29 之前保存的包
 * 使用 `{ graphs, functions, macros }` 作为 `payload`，没有形态标记；
 * 若将其视为无法识别的格式，升级后将无法读取这些存量条目。
 *
 * 片段的 `t3d` 正文必须是非空字符串。判宽的代价有两处：详情页会把
 * 老条目当片段打开，读到一段不存在的正文，用户看到空白摘要页，以为
 * 东西丢了；放回工程时会把空正文交给 `blueprint.import_t3d`，那是一次
 * 必然失败的写入。
 *
 * > 2026-09-16 之前短暂存在过第三种形态 `form: "graph"`（结构化节点表）。
 * > 该方案经实机验证后已弃用，且「放进当前工程」从未对外开放。
 * > 该形态按老条目处理，不提供兼容读取，需从工程重新保存。
 */

export type PayloadForm = 'snippet' | 't3d'

/** 悬空端口：片段里的某个引脚，原本连到选区外面去了 */
export interface SnippetOpenPort {
  nodeId: string
  pinName: string
  dir: 'in' | 'out'
  /** 原来连到哪儿，只作说明用，跨工程没有意义 */
  formerPeer: string
}

/**
 * 片段的摘要。**只作展示与检索，不参与放回工程** ——
 * 放回工程用的是那段 T3D 正文，这里一个字都不参与。
 */
export interface SnippetMeta {
  nodeCount: number
  /** 两端都在选区内的连线条数 */
  connectionCount: number
  /** 用到的节点类型，去重后按出现顺序。能给简名的给简名（Branch），给不出的给引擎类名 */
  classes: string[]
  openPorts: SnippetOpenPort[]
}

/** 片段形态：一段 T3D 正文 + 一份只作展示的摘要 */
export interface SnippetFormPayload {
  form: 'snippet'
  /**
   * 引擎导出的节点序列化文本，原样传给 `blueprint.import_t3d`。
   */
  t3d: string
  /** 来源图表名称，仅用于说明 */
  sourceGraphName?: string
  /** 来源蓝图路径，仅用于说明 */
  sourceBlueprintPath?: string
  /** 节点数、连线数、用到的类型、悬空端口。检索和详情页读它，写回工程不读 */
  meta: SnippetMeta
}

/**
 * 仅当 `form` 为 `"snippet"` 且 `t3d` 为非空字符串时，才识别为片段。
 */
export function detectPayloadForm(payload: unknown): PayloadForm {
  if (!payload || typeof payload !== 'object') return 't3d'
  const record = payload as Record<string, unknown>
  if (record.form !== 'snippet') return 't3d'
  if (typeof record.t3d !== 'string' || record.t3d.length === 0) return 't3d'
  return 'snippet'
}

/** 取出片段；不是片段形态就返回 null */
export function readSnippetPayload(payload: unknown): SnippetFormPayload | null {
  if (detectPayloadForm(payload) !== 'snippet') return null
  const record = payload as Record<string, unknown>
  const meta = (record.meta ?? {}) as Record<string, unknown>

  return {
    form: 'snippet',
    t3d: record.t3d as string,
    sourceGraphName:
      typeof record.sourceGraphName === 'string' ? record.sourceGraphName : undefined,
    sourceBlueprintPath:
      typeof record.sourceBlueprintPath === 'string' ? record.sourceBlueprintPath : undefined,
    meta: {
      nodeCount: typeof meta.nodeCount === 'number' ? meta.nodeCount : 0,
      connectionCount: typeof meta.connectionCount === 'number' ? meta.connectionCount : 0,
      classes: Array.isArray(meta.classes)
        ? meta.classes.filter((item): item is string => typeof item === 'string')
        : [],
      openPorts: Array.isArray(meta.openPorts)
        ? meta.openPorts.filter(
            (port): port is SnippetOpenPort => typeof port === 'object' && port !== null
          )
        : []
    }
  }
}
