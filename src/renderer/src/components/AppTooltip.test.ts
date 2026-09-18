import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import AppTooltip from './AppTooltip.vue'

// 定位交给 @floating-ui/dom，这里不测它算得准不准 —— 那是它自己的测试该管的事。
// 这里测的是我们自己的行为：什么时候弹、什么时候不弹、无障碍属性挂没挂上。
vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 10, y: 20 }),
  autoUpdate: vi.fn(() => vi.fn()),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn()
}))

function mountTooltip(
  props: Record<string, unknown> = {},
  slots: Record<string, string> = {}
): VueWrapper {
  return mount(AppTooltip, {
    props: { title: '重命名', mouseEnterDelay: 0, ...props },
    slots: { default: '<button id="target">按钮</button>', ...slots },
    attachTo: document.body
  })
}

describe('AppTooltip', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('悬停之后才弹，弹出来的是 role=tooltip', async () => {
    const wrapper = mountTooltip()

    expect(document.querySelector('[role="tooltip"]')).toBeNull()

    await wrapper.get('.app-tooltip-trigger').trigger('mouseenter')
    vi.runAllTimers()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('重命名')
  })

  // 空 title 弹一个空框出来最丑，antd 也是不弹
  it('title 为空就完全不弹', async () => {
    const wrapper = mountTooltip({ title: '   ' })

    await wrapper.get('.app-tooltip-trigger').trigger('mouseenter')
    vi.runAllTimers()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('移开鼠标就收起来', async () => {
    const wrapper = mountTooltip()
    await wrapper.get('.app-tooltip-trigger').trigger('mouseenter')
    vi.runAllTimers()
    await wrapper.vm.$nextTick()

    await wrapper.get('.app-tooltip-trigger').trigger('mouseleave')
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  // 延迟没到就移开的话，不该再弹出来
  it('还没到延迟就移开，不弹', async () => {
    const wrapper = mountTooltip({ mouseEnterDelay: 0.5 })

    await wrapper.get('.app-tooltip-trigger').trigger('mouseenter')
    vi.advanceTimersByTime(200)
    await wrapper.get('.app-tooltip-trigger').trigger('mouseleave')
    vi.runAllTimers()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  // 键盘用户走 focus 触发；不给的话这些提示对他们等于不存在
  it('键盘聚焦也能触发，Esc 能关掉', async () => {
    const wrapper = mountTooltip()

    await wrapper.get('.app-tooltip-trigger').trigger('focusin')
    vi.runAllTimers()
    await wrapper.vm.$nextTick()
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull()

    await wrapper.get('.app-tooltip-trigger').trigger('keydown', { key: 'Escape' })
    await wrapper.vm.$nextTick()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  // 读屏软件靠 aria-describedby 把气泡念成目标元素的说明
  it('显示期间给被包住的元素挂 aria-describedby，收起后摘掉', async () => {
    const wrapper = mountTooltip()
    const target = wrapper.get('#target')

    await wrapper.get('.app-tooltip-trigger').trigger('mouseenter')
    vi.runAllTimers()
    await wrapper.vm.$nextTick()

    const described = target.attributes('aria-describedby')
    expect(described).toBeDefined()
    expect(document.querySelector('[role="tooltip"]')?.id).toBe(described)

    await wrapper.get('.app-tooltip-trigger').trigger('mouseleave')
    await wrapper.vm.$nextTick()
    expect(target.attributes('aria-describedby')).toBeUndefined()
  })

  it('#title 插槽能放富文本，此时不看 title 属性', async () => {
    const wrapper = mountTooltip(
      { title: '' },
      { title: '<span class="rich">带 <b>格式</b> 的说明</span>' }
    )

    await wrapper.get('.app-tooltip-trigger').trigger('mouseenter')
    vi.runAllTimers()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[role="tooltip"] .rich')).not.toBeNull()
  })

  // display: contents 是关键 —— 套上去不能把原来的 flex/grid 排版挤歪
  it('触发器外壳不生成布局盒', () => {
    const wrapper = mountTooltip()
    expect(wrapper.get('.app-tooltip-trigger').classes()).toContain('app-tooltip-trigger')
    // 被包住的元素原样留在原位，没有被多套一层带尺寸的盒子
    expect(wrapper.find('#target').exists()).toBe(true)
    expect(wrapper.get('.app-tooltip-trigger').element.firstElementChild?.id).toBe('target')
  })
})
