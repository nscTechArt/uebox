/**
 * 标签管理页的排序与首字母锚点。
 *
 * 单独拎出来是因为这两件事有真逻辑（升序把 0 用量排最前、中文取拼音首字母、
 * `#` 永远垫底），放在 SFC 的 computed 里没法直接测。
 */
import { pinyin } from 'pinyin-pro'
import type { Tag } from './types'

export type TagSortMode = 'name' | 'usage'

/** tagId → 当前保管库里的引用数 */
export type UsageCounts = Record<number, number>

/**
 * 取一个标签的本库用量
 * @param tag 标签
 * @param usageCounts 用量表
 * @returns 引用数，查不到按 0 算
 */
export const usageOf = (tag: Tag, usageCounts: UsageCounts): number =>
  tag.id ? (usageCounts[tag.id] ?? 0) : 0

/**
 * 按当前排序方式排列标签。
 *
 * 用量排序是**升序**：一次都没用过的排最前。这一屏的用途就是清理，
 * 把用得最多的顶上去没有意义。
 *
 * @param tags 待排序的标签
 * @param mode 排序方式
 * @param usageCounts 用量表
 * @returns 新数组，不改动入参
 */
export const sortTags = (tags: Tag[], mode: TagSortMode, usageCounts: UsageCounts): Tag[] => {
  const list = [...tags]
  if (mode === 'usage') {
    return list.sort(
      (a, b) => usageOf(a, usageCounts) - usageOf(b, usageCounts) || a.name.localeCompare(b.name)
    )
  }
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 取一个标签名的锚点字母。中文走拼音首字母，其它一律归到 `#`
 * @param name 标签名
 * @returns 单个大写字母，或 `#`
 */
export const anchorLetter = (name: string): string => {
  const first = pinyin(name, { pattern: 'first', toneType: 'none' })[0] || '#'
  return /^[A-Za-z]$/.test(first) ? first.toUpperCase() : '#'
}

/**
 * 把已排好序的标签按首字母切成若干行。
 *
 * 注意这里只是**分行**，不是分区块：每个字母在界面上占左边 16px 的一列，
 * 标签照常往右流。原来那版每个字母都要「标题 + 分隔线 + 下边距 + 网格」，
 * 20 个标签能撑出三屏。
 *
 * @param sorted 已按名称排好序的标签
 * @returns 字母升序的行，`#` 排在最后
 */
export const groupByAnchor = (sorted: Tag[]): Array<{ letter: string; tags: Tag[] }> => {
  const grouped = new Map<string, Tag[]>()
  sorted.forEach((tag) => {
    const letter = anchorLetter(tag.name)
    const bucket = grouped.get(letter)
    if (bucket) bucket.push(tag)
    else grouped.set(letter, [tag])
  })
  return [...grouped.entries()]
    .sort((a, b) => (a[0] === '#' ? 1 : b[0] === '#' ? -1 : a[0].localeCompare(b[0])))
    .map(([letter, tags]) => ({ letter, tags }))
}
