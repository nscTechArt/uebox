/**
 * 删除快捷键。
 *
 * 红灯用例：Backspace 曾经和 Delete 走同一个分支。在「最近删除」视图里，那一下是
 * **永久**删除 —— 数据库记录、保管库里的备份副本、缩略图一起没，没有撤销。
 * 而 Backspace 在 Windows 上的通用含义是「退格 / 返回上一级」，很多人拿它当返回键用。
 *
 * 所以这里锁两件事：Delete 仍然要能删，Backspace 一定不能删。
 */
import { defineComponent, h, nextTick } from 'vue'

import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { useFileSelection } from './useFileSelection'

/**
 * 把 composable 挂进一个真组件里跑 —— 它的键盘监听是在 onMounted 里挂到 document 上的，
 * 直接调函数测不到那条线。
 */
function mountSelection(onDelete: (ids: string[]) => void): {
  unmount: () => void
} {
  const wrapper = mount(
    defineComponent({
      setup() {
        const selection = useFileSelection()
        selection.setDeleteCallback(onDelete)
        // 键盘分支的前置条件是「容器可见 + 有选中项」。jsdom 里所有元素的
        // getBoundingClientRect 都是全 0，不伪造就会被 isContainerActive 挡在门外。
        const container = document.createElement('div')
        container.getBoundingClientRect = (() =>
          ({
            width: 800,
            height: 600,
            top: 0,
            bottom: 600
          }) as DOMRect) as HTMLElement['getBoundingClientRect']
        selection.containerRef.value = container
        selection.setSelected('asset-1', true)
        return () => h('div')
      }
    })
  )
  return wrapper
}

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('资产列表的删除快捷键', () => {
  it('按 Delete 触发删除', async () => {
    const onDelete = vi.fn()
    const wrapper = mountSelection(onDelete)
    await nextTick()

    press('Delete')

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(['asset-1'])
    wrapper.unmount()
  })

  it('按 Backspace 不触发删除', async () => {
    const onDelete = vi.fn()
    const wrapper = mountSelection(onDelete)
    await nextTick()

    press('Backspace')

    expect(onDelete).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
