/**
 * 把渲染层的"第 start 行起取 limit 行"翻成目录服务的一次请求（纯函数，单测直接调）。
 *
 * 目录服务翻页只有两种方式（asset-catalog-api.md）：
 * - keyset 游标：从上一页的 `nextCursor` 接着往下，一页的代价；
 * - `position=N`：服务端把排好序的 id 缓存 5 分钟（结果快照），任意位置取一页也是一页的代价。
 *
 * 所以：第 0 行不带游标；紧接着上一窗的，用上一窗给的游标；跳着来的（拖滚动条），用 position。
 * 搜索（带 q）只有游标，最多翻到第 1000 条，跳不过去的由调用方按顺序补齐。
 */
import type { CatalogListQuery } from '../../shared/catalogLibrary'

export const ASSET_PAGE_LIMIT = 200
export const SEARCH_PAGE_LIMIT = 100
export const SEARCH_REACH = 1000

export interface PlannedRequest {
  path: string
  query: Record<string, string | number>
  kind: 'assets' | 'search'
}

function joined(values?: string[]): string | undefined {
  if (!values || values.length === 0) return undefined
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].join(',') || undefined
}

export function planListRequest(
  libraryId: string,
  query: CatalogListQuery,
  start: number,
  limit: number,
  cursor: string | null,
  facets: string[] = []
): PlannedRequest {
  const q = query.q?.trim() ?? ''
  const base = `/v1/libraries/${encodeURIComponent(libraryId)}`
  const params: Record<string, string | number> = {}
  params.dir = query.dir
  const filters: Array<[string, string | undefined]> = [
    ['class', joined(query.class)],
    ['ext', joined(query.ext)],
    ['engine', joined(query.engine)],
    ['tag', joined(query.tag)]
  ]
  for (const [key, value] of filters) if (value) params[key] = value

  if (q) {
    params.q = q
    // 搜索默认递归；只看当前文件夹时显式传 0
    params.recursive = query.recursive ? 1 : 0
    params.limit = Math.max(1, Math.min(limit, SEARCH_PAGE_LIMIT))
    if (cursor) params.cursor = cursor
    if (facets.length > 0) params.facets = facets.join(',')
    return { path: `${base}/search`, query: params, kind: 'search' }
  }

  if (query.recursive) params.recursive = 1
  const sort = query.sort && query.sort !== 'relevance' ? query.sort : 'name'
  params.sort = sort
  params.order = query.order ?? (sort === 'name' ? 'asc' : 'desc')
  params.limit = Math.max(1, Math.min(limit, ASSET_PAGE_LIMIT))
  if (start > 0) {
    if (cursor) params.cursor = cursor
    else params.position = start
  }
  return { path: `${base}/assets`, query: params, kind: 'assets' }
}

/** 游标表的键：同一个规范化查询、同一个起点 */
export function cursorKey(normalizedQuery: string, start: number): string {
  return `${normalizedQuery}#${start}`
}
