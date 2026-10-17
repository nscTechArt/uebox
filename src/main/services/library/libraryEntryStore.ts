/**
 * 库条目的按 id 读写 —— 给 agent 工具用的那一层。
 *
 * 工具使用条目 ID，底层 `libraryPackageStore.ts` 使用目录路径。
 * 本模块负责衔接两者；payload 的形态判别与读取逻辑由
 * `src/shared/snippetPayload.ts` 提供，主进程与渲染进程共用。
 */

import { createPackage, scanPackages, type LibraryPackageEntry } from '../libraryPackageStore'
import type { LibraryKind } from '../../utils/libraryPackage'
import {
  detectPayloadForm,
  readSnippetPayload,
  type PayloadForm,
  type SnippetFormPayload,
  type SnippetMeta
} from '../../../shared/snippetPayload'

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
): Promise<LibraryPackageEntry | null> {
  if (!vaultRoot || !entryId) return null

  const { entries } = await scanPackages(vaultRoot)
  return entries.find((item) => item.library === library && item.manifest.id === entryId) ?? null
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
  form: PayloadForm
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
