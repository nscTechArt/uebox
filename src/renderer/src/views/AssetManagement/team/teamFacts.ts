/**
 * 内容哈希 → 缩略图和类型（目录服务 facts，契约 4.8）的本机缓存。
 *
 * 动态、对比、历史、签出中、最近删除、交付都用它画缩略图条：同一个哈希全页只问一次，
 * 一次最多 500 个（服务端上限）。拿不到的画类型图标（方案 2.10）。
 */
import { reactive } from 'vue'
import type { TeamFact } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'

const cache = reactive(new Map<string, TeamFact | null>())
const pending = new Map<string, Promise<void>>()

function cacheKey(libraryKey: string, library: string | null, hash: string): string {
  return `${libraryKey}|${library ?? ''}|${hash}`
}

/** 取这些哈希的缩略图（已缓存的不再问）；`library` 省略 = 这个工程的库 */
export async function loadFacts(
  libraryKey: string,
  hashes: Array<string | null | undefined>,
  library: string | null = null
): Promise<void> {
  const wanted = [
    ...new Set(hashes.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0))
  ].filter((hash) => !cache.has(cacheKey(libraryKey, library, hash)))
  if (wanted.length === 0) return
  const batchKey = `${libraryKey}|${library ?? ''}|${wanted.join(',')}`
  const existing = pending.get(batchKey)
  if (existing) return await existing
  const work = (async () => {
    for (let start = 0; start < wanted.length; start += 500) {
      const slice = wanted.slice(start, start + 500)
      const result = await teamAPI.facts(libraryKey, slice, library).catch(() => ({}))
      for (const hash of slice)
        cache.set(
          cacheKey(libraryKey, library, hash),
          (result as Record<string, TeamFact | null>)[hash] ?? null
        )
    }
  })()
  pending.set(batchKey, work)
  try {
    await work
  } finally {
    pending.delete(batchKey)
  }
}

export function factOf(
  libraryKey: string | null,
  hash: string | null | undefined,
  library: string | null = null
): TeamFact | null {
  if (!libraryKey || !hash) return null
  return cache.get(cacheKey(libraryKey, library, hash)) ?? null
}
