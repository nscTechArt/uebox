import type { LibrarySortType } from '../types'

/**
 * 库条目排序（两库逐行同构的逻辑，收归一处）。
 *
 * 输入不改原数组；排序语义：
 * - recent：updatedAt 降序
 * - name：名称字典序升序
 * - created：createdAt 降序
 */
export function sortLibraryEntries<
  T extends { name: string; createdAt: number; updatedAt: number }
>(list: T[], sortType: LibrarySortType): T[] {
  const sorted = [...list]
  if (sortType === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name))
  } else if (sortType === 'created') {
    sorted.sort((a, b) => b.createdAt - a.createdAt)
  } else {
    sorted.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  return sorted
}
