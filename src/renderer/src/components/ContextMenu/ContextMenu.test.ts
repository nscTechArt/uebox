import { describe, expect, it, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import ContextMenu from './ContextMenu.vue'

// 定位交给 @floating-ui/dom；这里测的是「菜单到底出不出来、点得动不动」
vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  autoUpdate: vi.fn(() => vi.fn()),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn()
}))

const ICON = { template: '<svg class="menu-icon" />' }

const ITEMS = [
  { key: 'open', label: '打开', icon: ICON },
  { key: 'sep', type: 'divider' as const },
  { key: 'delete', label: '删除', danger: true },
  { key: 'locked', label: '不可用', disabled: true }
]

const mounted: VueWrapper[] = []

function mountMenu(): VueWrapper {
  const wrapper = mount(ContextMenu, { props: { menuItems: ITEMS } }) as VueWrapper
  mounted.push(wrapper)
  return wrapper
}

/**
 * 组件把 show/hide 挂在实例上供外部调用。
 * show() 内部有一个 10ms 的 setTimeout（为了先把位置写进去再显示），
 * 所以这里得真的等一下，光 nextTick 不够。
 */
async function show(wrapper: VueWrapper): Promise<void> {
  ;(wrapper.vm as unknown as { show: (x: number, y: number) => void }).show(120, 80)
  await new Promise((resolve) => setTimeout(resolve, 30))
  await wrapper.vm.$nextTick()
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

describe('ContextMenu（全应用共享的右键菜单）', () => {
  it.each([
    ['darwin', '⌘+C'],
    ['win32', 'Ctrl+C']
  ])('renders the %s shortcut label', async (platform, label) => {
    const previous = Object.getOwnPropertyDescriptor(window, 'api')
    try {
      Object.defineProperty(window, 'api', { configurable: true, value: { platform } })
      const wrapper = mount(ContextMenu, {
        props: { menuItems: [{ key: 'copy', label: 'Copy', shortcut: 'CommandOrControl+C' }] }
      }) as VueWrapper
      mounted.push(wrapper)
      await show(wrapper)
      expect(document.querySelector('.menu-item-shortcut')?.textContent).toBe(label)
    } finally {
      if (previous) Object.defineProperty(window, 'api', previous)
      else Reflect.deleteProperty(window, 'api')
    }
  })
  it('调 show 之后菜单真的渲染出来', async () => {
    const wrapper = mountMenu()
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await show(wrapper)

    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3)
  })

  /**
   * 这条是回归用的：菜单项的图标走 #icon 插槽。
   * AppMenuItem 一度没有这个插槽，Vue 就把它默默丢了 —— 右键菜单里的图标
   * 全部消失，而且不报任何错。
   */
  it('菜单项的图标渲染出来', async () => {
    const wrapper = mountMenu()
    await show(wrapper)

    expect(document.querySelector('.menu-icon')).not.toBeNull()
  })

  it('分隔线渲染成 separator，不算进菜单项', async () => {
    const wrapper = mountMenu()
    await show(wrapper)

    expect(document.querySelector('[role="separator"]')).not.toBeNull()
  })

  it('点菜单项把 key 交出去', async () => {
    const wrapper = mountMenu()
    await show(wrapper)

    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    items[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('click')?.[0]?.[0]).toBe('open')
  })

  /**
   * 回归：判断「点在不在菜单里」认的是浮层类名。迁到 AppDropdown 之后浮层是
   * `.app-dropdown`，而这里原来还写着 `.ant-dropdown` —— 判断恒为「在外面」，
   * 于是点菜单项本身也会先把菜单关掉，表现就是右键菜单点了没反应。
   */
  it('点菜单内部不会把菜单关掉', async () => {
    const wrapper = mountMenu()
    await show(wrapper)

    const item = document.querySelector<HTMLElement>('[role="menuitem"]')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    // 点中的那一项要把 key 交出去 —— 菜单如果先关了，这个事件就发不出来
    expect(wrapper.emitted('click')?.[0]?.[0]).toBe('open')
  })

  it('点菜单外面才关掉', async () => {
    const wrapper = mountMenu()
    await show(wrapper)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('禁用项点不动', async () => {
    const wrapper = mountMenu()
    await show(wrapper)

    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    items[2].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('click')).toBeUndefined()
  })
})
