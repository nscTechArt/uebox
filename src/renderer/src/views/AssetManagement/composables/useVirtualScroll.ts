import { ref, computed, onMounted, onUnmounted, type Ref, type ComputedRef } from 'vue'

/**
 * 虚拟滚动配置选项
 */
export interface VirtualScrollOptions {
  /** 滚动容器元素引用（必须是真正带 overflow 滚动的那个元素） */
  containerRef: Ref<HTMLElement | null>
  /**
   * 网格本身的元素引用。
   *
   * 滚动容器里网格上方还有别的内容时（资产库的网格上面是文件夹区），
   * `scrollTop` 里包含那段高度。不扣掉的话就等于把文件夹区的高度当成
   * 「已经滚过的资产行」，滚到资产区顶部时前几行是空白占位。
   */
  gridRef?: Ref<HTMLElement | null>
  /** 数据总数 */
  itemCount: Ref<number> | ComputedRef<number>
  /** 每行显示的项目数（网格布局） */
  columnsPerRow: Ref<number> | ComputedRef<number>
  /** 单个项目的高度（包含 margin） */
  itemHeight: Ref<number> | ComputedRef<number>
  /** 预渲染缓冲区行数（上下各多渲染几行） */
  overscan?: number
  /** 滚动到底部的阈值（像素） */
  loadMoreThreshold?: number
}

/**
 * 虚拟滚动返回值
 */
export interface VirtualScrollReturn {
  /** 可见项的起始索引 */
  startIndex: ComputedRef<number>
  /** 可见项的结束索引 */
  endIndex: ComputedRef<number>
  /** 顶部占位高度 */
  paddingTop: ComputedRef<number>
  /** 底部占位高度 */
  paddingBottom: ComputedRef<number>
  /** 容器总高度 */
  totalHeight: ComputedRef<number>
  /** 是否滚动到底部附近 */
  isNearBottom: Ref<boolean>
  /** 容器宽度（响应式，用于计算列数） */
  containerWidth: Ref<number>
  /** 手动触发滚动位置更新 */
  updateScrollPosition: () => void
  /** 滚动到顶部 */
  scrollToTop: () => void
}

/**
 * 网格布局虚拟滚动 Composable
 * 用于优化大量资产项的渲染性能，只渲染可视区域内的项目
 *
 * @param options 虚拟滚动配置
 * @returns 虚拟滚动状态和方法
 */
export function useVirtualScroll(options: VirtualScrollOptions): VirtualScrollReturn {
  const {
    containerRef,
    gridRef,
    itemCount,
    columnsPerRow,
    itemHeight,
    overscan = 3,
    loadMoreThreshold = 200
  } = options

  // 当前滚动位置
  const scrollTop = ref(0)
  /** 网格区域在滚动容器里的起始偏移（网格上方那些内容的高度） */
  const gridOffset = ref(0)
  /** 扣掉网格上方内容之后，真正滚过的网格高度 */
  const gridScrollTop = computed(() => Math.max(0, scrollTop.value - gridOffset.value))
  // 容器可见高度
  const containerHeight = ref(0)
  // 容器宽度（响应式，用于外部计算列数）
  const containerWidth = ref(0)
  // 是否接近底部
  const isNearBottom = ref(false)

  /**
   * 计算总行数
   */
  const totalRows = computed(() => {
    const count = itemCount.value
    const cols = columnsPerRow.value
    return Math.ceil(count / cols)
  })

  /**
   * 计算内容总高度
   */
  const totalHeight = computed(() => {
    const height = itemHeight.value
    return totalRows.value * height
  })

  /**
   * 计算可见的起始行索引
   */
  const startRowIndex = computed(() => {
    const height = itemHeight.value
    if (height === 0) return 0
    const row = Math.floor(gridScrollTop.value / height)
    return Math.max(0, row - overscan)
  })

  /**
   * 计算可见的结束行索引
   */
  const endRowIndex = computed(() => {
    const height = itemHeight.value
    if (height === 0) return 0
    const visibleRows = Math.ceil(containerHeight.value / height)
    const row = Math.floor(gridScrollTop.value / height) + visibleRows
    return Math.min(totalRows.value - 1, row + overscan)
  })

  /**
   * 计算可见项的起始索引
   */
  const startIndex = computed(() => {
    const cols = columnsPerRow.value
    return startRowIndex.value * cols
  })

  /**
   * 计算可见项的结束索引
   */
  const endIndex = computed(() => {
    const cols = columnsPerRow.value
    const count = itemCount.value
    return Math.min(count - 1, (endRowIndex.value + 1) * cols - 1)
  })

  /**
   * 计算顶部占位高度
   */
  const paddingTop = computed(() => {
    const height = itemHeight.value
    return startRowIndex.value * height
  })

  /**
   * 计算底部占位高度
   */
  const paddingBottom = computed(() => {
    const height = itemHeight.value
    return Math.max(0, (totalRows.value - endRowIndex.value - 1) * height)
  })

  /**
   * 更新滚动位置和容器高度
   */
  const updateScrollPosition = () => {
    const container = containerRef.value
    if (!container) return

    scrollTop.value = container.scrollTop
    containerHeight.value = container.clientHeight
    containerWidth.value = container.clientWidth

    // 网格上方还有多少内容（文件夹区展开/收起会变，所以每次都量）
    const grid = gridRef?.value
    gridOffset.value = grid
      ? Math.max(
          0,
          grid.getBoundingClientRect().top -
            container.getBoundingClientRect().top +
            container.scrollTop
        )
      : 0

    // 检查是否接近底部
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    isNearBottom.value = distanceToBottom < loadMoreThreshold
  }

  /**
   * 滚动到顶部
   */
  const scrollToTop = () => {
    const container = containerRef.value
    if (!container) return
    container.scrollTop = 0
    updateScrollPosition()
  }

  // 滚动事件处理（使用 requestAnimationFrame 节流）
  let rafId: number | null = null
  const handleScroll = () => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      updateScrollPosition()
      rafId = null
    })
  }

  // ResizeObserver 用于监听容器尺寸变化
  let resizeObserver: ResizeObserver | null = null

  onMounted(() => {
    const container = containerRef.value
    if (!container) return

    // 初始化
    updateScrollPosition()

    // 监听滚动事件
    container.addEventListener('scroll', handleScroll, { passive: true })

    // 监听容器尺寸变化
    resizeObserver = new ResizeObserver(() => {
      updateScrollPosition()
    })
    resizeObserver.observe(container)
  })

  onUnmounted(() => {
    const container = containerRef.value
    if (container) {
      container.removeEventListener('scroll', handleScroll)
    }

    if (rafId !== null) {
      cancelAnimationFrame(rafId)
    }

    if (resizeObserver) {
      resizeObserver.disconnect()
    }
  })

  return {
    startIndex,
    endIndex,
    paddingTop,
    paddingBottom,
    totalHeight,
    isNearBottom,
    containerWidth,
    updateScrollPosition,
    scrollToTop
  }
}

export default useVirtualScroll
