import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import DragOverlay from './DragOverlay.vue'

/**
 * 跟着光标走的小标签。原生 HTML5 拖拽期间 mousemove 是不触发的，
 * 只监听 mousemove/dragover 的话小标签会一直停在 (0,0)，也就是窗口左上角。
 */
const mountOverlay = (): ReturnType<typeof mount> =>
  mount(DragOverlay, {
    props: { visible: true, text: 'BPOnly55' },
    attachTo: document.body
  })

const overlayStyle = (): string => {
  const nodes = document.querySelectorAll('.global-drag-overlay')
  return nodes[nodes.length - 1]?.getAttribute('style') || ''
}

const fireDrag = async (type: string, x: number, y: number): Promise<void> => {
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }))
  await nextTick()
}

describe('drag overlay follows the cursor', () => {
  it('moves with the native drag event, not just mousemove', async () => {
    const wrapper = mountOverlay()
    await fireDrag('drag', 400, 300)
    expect(overlayStyle()).toContain('left: 412px')
    expect(overlayStyle()).toContain('top: 312px')
    wrapper.unmount()
  })

  it('still follows plain mouse drags and dragover', async () => {
    const wrapper = mountOverlay()
    await fireDrag('mousemove', 100, 100)
    expect(overlayStyle()).toContain('left: 112px')
    await fireDrag('dragover', 200, 150)
    expect(overlayStyle()).toContain('left: 212px')
    wrapper.unmount()
  })

  it('ignores the (0,0) event browsers fire when the drag ends', async () => {
    const wrapper = mountOverlay()
    await fireDrag('drag', 400, 300)
    await fireDrag('drag', 0, 0)
    expect(overlayStyle()).toContain('left: 412px')
    wrapper.unmount()
  })
})
