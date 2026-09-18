/**
 * 库条目的按 id 读写 —— 给 agent 工具用的那一层。
 *
 * `libraryPackageStore.ts` 认的是「目录路径」，而工具拿到的是「条目 id」。
 * 这一层负责在两者之间转，另外定死 payload 的两种形态怎么分辨。
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
 * 扫过外部依赖。老条目是整张图，没扫过。
 *
 * **缺 `form` 一律按老条目处理**，不是「无法识别就报错」。2026-08-29 之前
 * 存下来的包里 `payload` 直接就是 `{ graphs, functions, macros }`，没有判别字段 ——
 * 按「不认识就报错」处理的话，所有存量条目在升级后一条都打不开。
 *
 * > 2026-09-16 之前短暂存在过第三种形态 `form: "graph"`（结构化节点表）。
 * > 那条路线被真机验证否了，
 * > 而且「放进当前工程」从未对外开放过，所以不留兼容分支：
 * > 它会落进「老条目」这一支，详情页打开是空的，重新存一遍即可。
 */

import { createPackage, scanPackages, type LibraryPackageEntry } from '../libraryPackageStore'
import type { LibraryKind } from '../../utils/libraryPackage'
import type { SnippetMeta } from './snippetScan'

/** 片段形态：一段 T3D 正文 + 一份只作展示的摘要 */
export interface SnippetFormPayload {
  form: 'snippet'
  /**
   * 引擎自己的节点序列化文本。放回工程时**原样**发给
   * `blueprint.import_t3d`，盒子这边一个字都不改。
   */
  t3d: string
  /** 从哪张图抠出来的，只作说明 */
  sourceGraphName?: string
  /** 从哪个蓝图抠出来的，只作说明 */
  sourceBlueprintPath?: string
  /** 节点数、连线数、用到的类型、悬空端口。检索和详情页读它，写回工程不读 */
  meta: SnippetMeta
}

/** 老形态：手工粘进来的整张图导出文本 */
export interface LegacyFormPayload {
  [key: string]: unknown
}

export type LibraryPayload = SnippetFormPayload | LegacyFormPayload

/**
 * 判别 payload 形态。
 *
 * 只有**明确写着** `form: "snippet"` 且带得出非空 `t3d` 正文的才算片段。
 * 判宽一点的代价是拿一条没有正文的条目去放进工程 —— 那会是一次必然失败的写入。
 */
export function detectPayloadForm(payload: unknown): 'snippet' | 't3d' {
  if (!payload || typeof payload !== 'object') return 't3d'
  const record = payload as Record<string, unknown>
  if (record.form !== 'snippet') return 't3d'
  if (typeof record.t3d !== 'string' || record.t3d.length === 0) return 't3d'
  return 'snippet'
}

const EMPTY_META: SnippetMeta = { nodeCount: 0, connectionCount: 0, classes: [], openPorts: [] }

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
      nodeCount: typeof meta.nodeCount === 'number' ? meta.nodeCount : EMPTY_META.nodeCount,
      connectionCount:
        typeof meta.connectionCount === 'number'
          ? meta.connectionCount
          : EMPTY_META.connectionCount,
      classes: Array.isArray(meta.classes) ? (meta.classes as string[]) : [],
      openPorts: Array.isArray(meta.openPorts) ? (meta.openPorts as SnippetMeta['openPorts']) : []
    }
  }
}

export interface FoundEntry {
  entry: LibraryPackageEntry
  form: 'snippet' | 't3d'
}

/**
 * 按条目 id 找一个包。
 *
 * 走的是 `scanPackages` —— 磁盘是唯一真相源，不查数据库。代价是每次都要
 * 走一遍保管库（本地 SSD 上 500 个包约 300ms），换来的是「手动拷进来的包
 * 也认得出」和「删掉数据库还能用」。
 */
export async function findEntryById(
  vaultRoot: string,
  library: LibraryKind,
  entryId: string
): Promise<FoundEntry | null> {
  if (!vaultRoot || !entryId) return null

  const { entries } = await scanPackages(vaultRoot)
  const hit = entries.find((item) => item.library === library && item.manifest.id === entryId)
  if (!hit) return null

  return { entry: hit, form: detectPayloadForm(hit.manifest.payload) }
}

export interface SaveSnippetOptions {
  vaultRoot: string
  library: LibraryKind
  entryId: string
  name: string
  /** 引擎导出的那段 T3D 正文 */
  t3d: string
  meta: SnippetMeta
  sourceBlueprintPath?: string
  sourceGraphName?: string
  now: number
  parentRelPath?: string
}

/** 把一段片段存成一个新包 */
export async function saveSnippetEntry(
  options: SaveSnippetOptions
): Promise<LibraryPackageEntry | null> {
  const payload: SnippetFormPayload = {
    form: 'snippet',
    t3d: options.t3d,
    sourceBlueprintPath: options.sourceBlueprintPath,
    sourceGraphName: options.sourceGraphName,
    meta: options.meta
  }

  return createPackage(options.vaultRoot, {
    library: options.library,
    id: options.entryId,
    name: options.name,
    payload,
    now: options.now,
    parentRelPath: options.parentRelPath
  })
}

export interface EntrySummary {
  id: string
  name: string
  library: LibraryKind
  form: 'snippet' | 't3d'
  relPath: string
  updatedAt: number
  /** 只有片段形态才有 */
  nodeCount?: number
  connectionCount?: number
  openPortCount?: number
  /** 图里用到的节点类型，去重后按出现顺序 */
  classes?: string[]
}

function summarize(entry: LibraryPackageEntry): EntrySummary {
  const form = detectPayloadForm(entry.manifest.payload)
  const base: EntrySummary = {
    id: entry.manifest.id,
    name: entry.manifest.name,
    library: entry.library,
    form,
    relPath: entry.relPath,
    updatedAt: entry.manifest.updatedAt
  }

  if (form !== 'snippet') return base

  const payload = readSnippetPayload(entry.manifest.payload)
  if (!payload) return base

  return {
    ...base,
    nodeCount: payload.meta.nodeCount,
    connectionCount: payload.meta.connectionCount,
    openPortCount: payload.meta.openPorts.length,
    classes: payload.meta.classes
  }
}

export interface SearchOptions {
  vaultRoot: string
  /** 不传就两个库都搜 */
  library?: LibraryKind
  /** 匹配名字，大小写不敏感 */
  keyword?: string
  /** 匹配图里用到的节点类型，大小写不敏感 */
  nodeClass?: string
  limit?: number
}

/**
 * 检索两个库。
 *
 * 一个函数管两个库，靠参数区分 —— 开两个几乎一样的检索工具，模型选错了
 * 只会拿到一句「没找到」，而它根本不知道自己搜错了库。
 */
export async function searchEntries(options: SearchOptions): Promise<EntrySummary[]> {
  const { entries } = await scanPackages(options.vaultRoot)

  const keyword = options.keyword?.trim().toLowerCase()
  const nodeClass = options.nodeClass?.trim().toLowerCase()

  const matched = entries
    .filter((entry) => !options.library || entry.library === options.library)
    .map(summarize)
    .filter((summary) => {
      if (keyword && !summary.name.toLowerCase().includes(keyword)) return false
      if (nodeClass) {
        const classes = summary.classes ?? []
        if (!classes.some((item) => item.toLowerCase().includes(nodeClass))) return false
      }
      return true
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const limit = options.limit && options.limit > 0 ? options.limit : 50
  return matched.slice(0, limit)
}

export { summarize as summarizeEntry }
