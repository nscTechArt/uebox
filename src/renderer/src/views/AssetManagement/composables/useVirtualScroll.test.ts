/**
 * 网格虚拟滚动。
 *
 * 两条红灯用例：
 *  1. 绑到不滚动的元素上时，scrollTop 恒为 0、clientHeight 等于全部内容高度 ——
 *     startIndex 恒 0、endIndex 恒为末尾，几千条资产全量进 DOM，虚拟滚动整体失效。
 *  2. 网格上方还有文件夹区时，scrollTop 里包含那段高度。不扣掉就等于把文件夹区
 *     当成「已经滚过的资产行」，滚到资产区顶部时前几行是空白占位。
 */
import { defineComponent, h, nextTick, ref } from 'vue'

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { useVirtualScroll } from './useVirtualScroll'

const ITEM_HEIGHT = 100
const COLUMNS = 4
const VIEWPORT = 500

/** 造一个能被 useVirtualScroll 读到尺寸的假滚动容器 */
function fakeElement(overrides: {
  scrollTop?: number
  clientHeight?: number
  clientWidth?: number
  scrollHeight?: number
  rectTop?: number
}): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperties(el, {
    scrollTop: { value: overrides.scrollTop ?? 0, writable: true },
    clientHeight: { value: overrides.clientHeight ?? VIEWPORT },
    clientWidth: { value: overrides.clientWidth ?? 800 },
    scrollHeight: { value: overrides.scrollHeight ?? 10_000 }
  })
  el.getBoundingClientRect = (() =>
    ({ top: overrides.rectTop ?? 0 }) as DOMRect) as HTMLElement['getBoundingClientRect']
  return el
}

/** 在组件上下文里跑 composable（它用了 onMounted / onUnmounted） */
function run(
  container: HTMLElement | null,
  grid?: HTMLElement | null,
  itemCount = 400
): { api: ReturnType<typeof useVirtualScroll>; wrapper: ReturnType<typeof mount> } {
  let api: ReturnType<typeof useVirtualScroll> | null = null
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useVirtualScroll({
          containerRef: ref(container),
          gridRef: grid === undefined ? undefined : ref(grid),
          itemCount: ref(itemCount),
          columnsPerRow: ref(COLUMNS),
          itemHeight: ref(ITEM_HEIGHT),
          overscan: 0
        })
        return () => h('div')
      }
    })
  )
  return { api: api!, wrapper }
}

describe('useVirtualScroll', () => {
  it('只渲染可视区域附近的项，不是全量', async () => {
    const container = fakeElement({ scrollTop: 1000 })
    const { api, wrapper } = run(container)
    await nextTick()

    // 滚过 10 行，视口 5 行 → 大致是第 10 行到第 15 行
    expect(api.startIndex.value).toBe(10 * COLUMNS)
    expect(api.endIndex.value).toBeLessThan(400 - 1)
    wrapper.unmount()
  })

  it('绑错元素（永不滚动）时会退化成全量渲染 —— 这正是修复前的样子', async () => {
    // 内层包裹元素：scrollTop 恒 0，clientHeight 等于全部内容高度
    const notScrollable = fakeElement({ scrollTop: 0, clientHeight: 10_000 })
    const { api, wrapper } = run(notScrollable)
    await nextTick()

    expect(api.startIndex.value).toBe(0)
    expect(api.endIndex.value).toBe(399) // 全部 400 条都进 DOM
    wrapper.unmount()
  })

  it('扣掉网格上方内容的高度（文件夹区）', async () => {
    // 已经滚了 1000px，其中前 600px 是文件夹区 ——
    // 此刻网格顶边在视口上方 400px 处（600 - 1000）
    const container = fakeElement({ scrollTop: 1000, rectTop: 0 })
    const grid = fakeElement({ rectTop: -400 })
    const { api, wrapper } = run(container, grid)
    await nextTick()

    // 真正滚过的网格高度是 400px = 4 行，不是 10 行
    expect(api.startIndex.value).toBe(4 * COLUMNS)
    wrapper.unmount()
  })

  it('还没滚到网格时从第 0 行开始，不出现负数', async () => {
    const container = fakeElement({ scrollTop: 100 })
    const grid = fakeElement({ rectTop: 500 }) // 网格还在视口下方
    const { api, wrapper } = run(container, grid)
    await nextTick()

    expect(api.startIndex.value).toBe(0)
    expect(api.paddingTop.value).toBe(0)
    wrapper.unmount()
  })

  it('上下占位高度加起来正好补齐被跳过的行', async () => {
    const container = fakeElement({ scrollTop: 1000 })
    const { api, wrapper } = run(container)
    await nextTick()

    const renderedRows = (api.endIndex.value - api.startIndex.value + 1) / COLUMNS
    expect(api.paddingTop.value + api.paddingBottom.value + renderedRows * ITEM_HEIGHT).toBe(
      api.totalHeight.value
    )
    wrapper.unmount()
  })

  it('容器还没挂上时不报错', async () => {
    const { api, wrapper } = run(null)
    await nextTick()

    expect(api.startIndex.value).toBe(0)
    wrapper.unmount()
  })
})
