import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoScroll } from './useAutoScroll'

describe('useAutoScroll', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--color-text-primary', 'rebeccapurple')
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    document.querySelector('.auto-scroll-anchor')?.remove()
    document.querySelector('#auto-scroll-cursor-override')?.remove()
    document.documentElement.style.removeProperty('--color-text-primary')
    vi.restoreAllMocks()
  })

  it('鼠标经过过程日志的交互控件时保持自动滚动', async () => {
    const wrapper = mount(
      defineComponent({
        setup() {
          const scrollerRef = ref<HTMLElement | null>(null)
          const { handleMouseDown } = useAutoScroll(scrollerRef)
          return { scrollerRef, handleMouseDown }
        },
        template: `
          <div ref="scrollerRef" class="scroller" @mousedown="handleMouseDown">
            <div class="agent-process-log">
              <button type="button" class="process-header">Execution steps</button>
            </div>
          </div>
        `
      })
    )

    await wrapper.find('.scroller').trigger('mousedown', {
      button: 1,
      clientX: 40,
      clientY: 80
    })
    const anchor = document.querySelector<HTMLElement>('.auto-scroll-anchor')
    expect(anchor).not.toBeNull()
    expect(anchor?.style.color).toBe('var(--color-text-primary)')

    wrapper.find('.process-header').element.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 40,
        clientY: 120
      })
    )

    expect(document.querySelector('.auto-scroll-anchor')).not.toBeNull()

    window.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: 40,
        clientY: 120
      })
    )
    expect(document.querySelector('#auto-scroll-cursor-override')?.textContent).toContain(
      'rebeccapurple'
    )

    window.dispatchEvent(new MouseEvent('mousedown'))
    expect(document.querySelector('.auto-scroll-anchor')).toBeNull()

    wrapper.unmount()
  })
})
