import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import AppMenu from './AppMenu.vue'
import AppMenuItem from './AppMenuItem.vue'
import AppMenuDivider from './AppMenuDivider.vue'

function mountMenu(inner: string): VueWrapper {
  return mount(AppMenu, {
    global: { components: { AppMenuItem, AppMenuDivider } },
    slots: { default: inner },
    attachTo: document.body
  }) as VueWrapper
}

const THREE = `
  <AppMenuItem item-key="rename">重命名</AppMenuItem>
  <AppMenuDivider />
  <AppMenuItem item-key="archive">归档</AppMenuItem>
  <AppMenuItem item-key="delete" danger>删除</AppMenuItem>
`

describe('AppMenu', () => {
  it('点菜单项时容器发出 { key }，和 a-menu 的回调形状一致', async () => {
    const wrapper = mountMenu(THREE)

    await wrapper.findAll('[role="menuitem"]')[1].trigger('click')

    expect(wrapper.emitted('click')).toEqual([[{ key: 'archive' }]])
  })

  it('分隔线是 separator，不算进菜单项', () => {
    const wrapper = mountMenu(THREE)

    expect(wrapper.findAll('[role="menuitem"]')).toHaveLength(3)
    expect(wrapper.find('[role="separator"]').exists()).toBe(true)
  })

  // ↑↓ 在菜单里循环，是菜单该有的键盘行为（Tab 是跳出去，不是往下走）
  it('↓ 从第一项开始往下走，到底绕回第一项', async () => {
    const wrapper = mountMenu(THREE)
    const items = wrapper.findAll('[role="menuitem"]')
    const menu = wrapper.get('[role="menu"]')

    await menu.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0].element)

    await menu.trigger('keydown', { key: 'ArrowDown' })
    await menu.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[2].element)

    await menu.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0].element)
  })

  it('↑ 从最后一项开始往上走', async () => {
    const wrapper = mountMenu(THREE)
    const items = wrapper.findAll('[role="menuitem"]')

    await wrapper.get('[role="menu"]').trigger('keydown', { key: 'ArrowUp' })

    expect(document.activeElement).toBe(items[2].element)
  })

  it('Home / End 跳到两端', async () => {
    const wrapper = mountMenu(THREE)
    const items = wrapper.findAll('[role="menuitem"]')
    const menu = wrapper.get('[role="menu"]')

    await menu.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(items[2].element)

    await menu.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(items[0].element)
  })

  it('Enter 触发当前项', async () => {
    const wrapper = mountMenu(THREE)

    await wrapper.findAll('[role="menuitem"]')[0].trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('click')).toEqual([[{ key: 'rename' }]])
  })

  it('禁用项点不动，方向键也跳过它', async () => {
    const wrapper = mountMenu(`
      <AppMenuItem item-key="a">能点</AppMenuItem>
      <AppMenuItem item-key="b" disabled>点不动</AppMenuItem>
      <AppMenuItem item-key="c">也能点</AppMenuItem>
    `)
    const items = wrapper.findAll('[role="menuitem"]')

    await items[1].trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()

    const menu = wrapper.get('[role="menu"]')
    await menu.trigger('keydown', { key: 'ArrowDown' })
    await menu.trigger('keydown', { key: 'ArrowDown' })
    // 跳过了禁用的 b，直接到 c
    expect(document.activeElement).toBe(items[2].element)
  })

  /**
   * ContextMenu.vue（全应用的右键菜单）一直在给每一项传 #icon。
   * 组件没有这个插槽的话，Vue 一声不吭地丢掉 —— 右键菜单里的图标全没了，不报错。
   */
  it('#icon 插槽渲染出来', () => {
    const wrapper = mountMenu(
      '<AppMenuItem item-key="a"><template #icon><svg class="ic" /></template>重命名</AppMenuItem>'
    )

    expect(wrapper.find('.ic').exists()).toBe(true)
  })

  // 排序菜单这类「当前是哪一档」要标出来，否则用户不知道现在按什么排的
  it('selected-keys 命中的项标成选中，并带 aria-current', () => {
    const wrapper = mount(AppMenu, {
      props: { selectedKeys: ['archive'] },
      global: { components: { AppMenuItem, AppMenuDivider } },
      slots: { default: THREE },
      attachTo: document.body
    }) as VueWrapper

    const items = wrapper.findAll('[role="menuitem"]')
    expect(items[1].classes()).toContain('app-menu-item--selected')
    expect(items[1].attributes('aria-current')).toBe('true')
    expect(items[0].classes()).not.toContain('app-menu-item--selected')
  })

  it('danger 项标红', () => {
    const wrapper = mountMenu(THREE)
    const items = wrapper.findAll('[role="menuitem"]')

    expect(items[2].classes()).toContain('app-menu-item--danger')
    expect(items[0].classes()).not.toContain('app-menu-item--danger')
  })
})
