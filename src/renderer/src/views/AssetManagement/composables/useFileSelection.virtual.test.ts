import { defineComponent, h, ref, type Ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useFileSelection } from './useFileSelection'

function setup(loadAll?: () => Promise<boolean>): {
  selection: ReturnType<typeof useFileSelection>
  items: Ref<Array<{ id: string; type: 'file' }>>
  container: HTMLElement
  wrapper: ReturnType<typeof mount>
} {
  const items = ref(
    Array.from({ length: 2000 }, (_, i) => ({ id: String(i), type: 'file' as const }))
  )
  let selection!: ReturnType<typeof useFileSelection>
  const container = document.createElement('div')
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: 600, width: 800, height: 600 }) as DOMRect
  const wrapper = mount(
    defineComponent({
      setup() {
        selection = useFileSelection({ getItems: () => items.value, loadAll })
        selection.containerRef.value = container
        return () => h('div')
      }
    })
  )
  return { selection, items, container, wrapper }
}

describe('virtual asset selection', () => {
  it('selects the full data range and sends the same IDs to batch actions', async () => {
    const { selection, items, wrapper } = setup()
    const onDelete = vi.fn()
    selection.setDeleteCallback(onDelete)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    await flushPromises()
    expect(selection.getSelectedIds()).toEqual(items.value.map((item) => item.id))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith(items.value.map((item) => item.id))
    selection.handleItemClick('0', new MouseEvent('click'))
    selection.handleItemClick('120', new MouseEvent('click', { shiftKey: true }))
    expect(selection.getSelectedIds()).toEqual(items.value.slice(0, 121).map((item) => item.id))
    wrapper.unmount()
  })

  it('waits for pagination, and cancels selection if the user clears or changes scope', async () => {
    let complete!: (success: boolean) => void
    const { selection, items, wrapper } = setup(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    items.value = items.value.slice(0, 100)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    expect(selection.getSelectedIds()).toEqual([])
    items.value.push({ id: '100', type: 'file' })
    complete(true)
    await flushPromises()
    expect(selection.getSelectedIds()).toHaveLength(101)
    selection.handleItemClick('0', new MouseEvent('click'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    selection.handleItemClick('80', new MouseEvent('click', { shiftKey: true }))
    complete(true)
    await flushPromises()
    expect(selection.getSelectedIds()).toHaveLength(81)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    selection.clearSelection()
    complete(true)
    await flushPromises()
    expect(selection.getSelectedIds()).toEqual([])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    complete(false)
    await flushPromises()
    expect(selection.getSelectedIds()).toEqual([])
    wrapper.unmount()
  })

  it('refreshes box candidates without interrupting a drag and retains recycled selections on release', async () => {
    const { selection, items, container, wrapper } = setup()
    document.body.append(container)
    const card = (id: string): HTMLElement => {
      const el = document.createElement('div')
      el.className = 'file-item asset-item'
      el.dataset.fileId = id
      el.getBoundingClientRect = () =>
        ({ left: 20, right: 80, top: 20, bottom: 80, width: 60, height: 60 }) as DOMRect
      return el
    }
    container.append(card('0'))
    await selection.initDragSelect(container)
    const move = (): void => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }))
    }
    container.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0 }))
    move()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(selection.getSelectedIds()).toEqual(['0'])
    container.replaceChildren(card('120'))
    await selection.updateSelectables()
    move()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(selection.getSelectedIds()).toEqual(['0', '120'])
    // 旧卡片已回收；缩窄、再放大选框，都应重新计算旧卡片是否命中。
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 100 }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(selection.getSelectedIds()).toEqual([])
    move()
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 100 }))
    expect(selection.getSelectedIds()).toEqual(['0', '120'])
    // 下一次拖动不能带入上一次缓存的卡片。
    container.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0 }))
    move()
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 100 }))
    expect(selection.getSelectedIds()).toEqual(['120'])
    // Shift 累加选择在缩框和松手后仍应保留原来的选择。
    selection.setSelected('1999')
    container.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0, shiftKey: true }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 100 }))
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 2, clientY: 100 }))
    expect(selection.getSelectedIds()).toEqual(['120', '1999'])
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(selection.getSelectedIds()).toEqual(['120', '1999'])
    container.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0 }))
    move()
    items.value = items.value.filter((item) => item.id !== '120')
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 100 }))
    expect(selection.getSelectedIds()).toEqual([])
    wrapper.unmount()
    container.remove()
  })
})
