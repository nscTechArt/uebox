/**
 * 网格里点开一张卡，详情插在**这一行的下面**（不是整个网格的最下面），并用小三角指着那张卡。
 *
 * 网格列数随面板宽度变（auto-fill），所以「这一行」要现量：几列、选中的是第几张、
 * 它的中心在哪。卡片按 `order = 序号 × 2` 排，详情的 `order` 取这一行最后一张的
 * `× 2 + 1`，就落在这一行和下一行之间，DOM 顺序不用动。
 */

import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

export interface RowInsert {
  /** 详情的 CSS order */
  order: Ref<number>
  /** 小三角离详情左边多远（px） */
  arrow: Ref<number>
  /** 列表变了、宽度变了之后重算 */
  update: () => void
}

export function useRowInsert(
  grid: Ref<HTMLElement | null>,
  count: () => number,
  selectedIndex: () => number
): RowInsert {
  const order = ref(0)
  const arrow = ref(0)

  const update = (): void => {
    const el = grid.value
    const index = selectedIndex()
    if (!el || index < 0) return
    const columns = Math.max(
      1,
      getComputedStyle(el)
        .gridTemplateColumns.split(' ')
        .filter((part) => part && part !== 'none').length
    )
    const rowEnd = Math.min(count() - 1, Math.floor(index / columns) * columns + columns - 1)
    order.value = rowEnd * 2 + 1
    const card = el.querySelector<HTMLElement>(`[data-row-item="${index}"]`)
    // 网格是定位容器（position: relative），offsetLeft 就是相对网格左边
    if (card) arrow.value = card.offsetLeft + card.offsetWidth / 2
  }

  let observer: ResizeObserver | null = null
  onMounted(() => {
    if (typeof ResizeObserver === 'undefined' || !grid.value) return
    observer = new ResizeObserver(() => update())
    observer.observe(grid.value)
  })
  onBeforeUnmount(() => observer?.disconnect())
  watch([selectedIndex, count], () => void nextTick(update), { immediate: true })

  return { order, arrow, update }
}
