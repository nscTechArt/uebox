import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { MenuItem } from '@renderer/common/routeUtils'
import SidebarToolsCustomize from './SidebarToolsCustomize.vue'

/**
 * 「自定义」弹窗的三条关键行为：
 * 打开时按侧边栏当前状态建草稿；勾选/取消勾选改常驻；拖拽调整顺序。
 * 「完成」把草稿一次性提交，关窗不提交。
 */

function makeItem(key: string, label: string): MenuItem {
  return { key, icon: null, label, path: `/${key.toLowerCase()}` }
}

const ITEMS: MenuItem[] = [
  makeItem('Home', '项目库'),
  makeItem('AssetManagement', '资产库'),
  makeItem('Notebooks', '知识库'),
  makeItem('AIGCStudio', 'AI 创作')
]

function mountModal(open = true): ReturnType<typeof mount> {
  return mount(SidebarToolsCustomize, {
    props: {
      open,
      items: ITEMS,
      pinnedKeys: ['Home', 'AssetManagement']
    },
    global: {
      stubs: {
        // Teleport 弹窗在 happy-dom 里直接铺开插槽，断言内容用
        AppModal: {
          props: ['title', 'closable', 'hideFooter'],
          template: `
            <div class="modal-stub">
              <header v-if="title || closable">
                <slot v-if="title" name="title">{{ title }}</slot>
              </header>
              <slot />
              <footer v-if="!hideFooter"><slot name="footer" /></footer>
            </div>
          `
        }
      }
    }
  })
}

function mockDragGeometry(wrapper: ReturnType<typeof mount>): void {
  const list = wrapper.find('.customize-list').element as HTMLElement
  const firstRow = wrapper.find('.customize-row').element as HTMLElement
  list.style.rowGap = '2px'
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 360,
    bottom: 136,
    left: 0,
    width: 360,
    height: 136,
    toJSON: () => ({})
  })
  vi.spyOn(firstRow, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 360,
    bottom: 32,
    left: 0,
    width: 360,
    height: 32,
    toJSON: () => ({})
  })
}

function dispatchPointer(type: 'pointermove' | 'pointerup', clientY: number): void {
  window.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, clientY, pointerId: 1 })
  )
}

async function clickDone(wrapper: ReturnType<typeof mount>): Promise<void> {
  const done = wrapper.findAll('button').find((b) => b.text().includes('完成'))
  expect(done, '「完成」按钮应存在').toBeDefined()
  await done!.trigger('click')
}

describe('SidebarToolsCustomize', () => {
  it('不显示标题和提示，只在右下角显示「完成」主按钮', () => {
    const wrapper = mountModal()

    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.find('.customize-hint').exists()).toBe(false)
    expect(wrapper.find('footer button.customize-done').text()).toBe('完成')
    expect(wrapper.find('footer button.customize-done').classes()).toContain('app-button--primary')
  })

  it('打开时按传入顺序渲染，勾选状态对应常驻名单', () => {
    const wrapper = mountModal()

    const labels = wrapper.findAll('.customize-row').map((row) => row.text())
    expect(labels).toEqual(['项目库', '资产库', '知识库', 'AI 创作'])

    // AppCheckbox 画的是 <button role="checkbox">，不是 antd 那个内嵌的 <input>
    const checked = wrapper
      .findAll('.customize-row')
      .filter((row) => row.find('.app-checkbox__box').attributes('aria-checked') === 'true')
    expect(checked.map((row) => row.text())).toEqual(['项目库', '资产库'])
  })

  it('勾选新工具后「完成」提交新的常驻名单并关窗', async () => {
    const wrapper = mountModal()

    const notebookRow = wrapper.findAll('.customize-row')[2]
    await notebookRow.find('.app-checkbox__box').trigger('click')
    await clickDone(wrapper)

    const saved = wrapper.emitted('save')?.[0]?.[0] as {
      order: string[]
      pinned: string[]
    }
    expect(saved.pinned).toEqual(['Home', 'AssetManagement', 'Notebooks'])
    expect(saved.order).toEqual(ITEMS.map((i) => i.key))
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('拖拽重排后「完成」按新顺序提交', async () => {
    const wrapper = mountModal()
    mockDragGeometry(wrapper)

    const rows = wrapper.findAll('.customize-row')
    await rows[0]
      .find('.drag-handle')
      .trigger('pointerdown', { button: 0, clientY: 16, pointerId: 1 })
    dispatchPointer('pointermove', 118)
    dispatchPointer('pointerup', 118)
    await nextTick()
    await clickDone(wrapper)

    const saved = wrapper.emitted('save')?.[0]?.[0] as { order: string[] }
    expect(saved.order).toEqual(['AssetManagement', 'Notebooks', 'AIGCStudio', 'Home'])
  })

  it('拖拽悬停时被拖行半透明、途经行让位，松手后状态复位', async () => {
    const wrapper = mountModal()
    mockDragGeometry(wrapper)

    const rows = wrapper.findAll('.customize-row')
    const handle = rows[0].find('.drag-handle')
    await handle.trigger('pointerdown', { button: 0, clientY: 16, pointerId: 1 })
    dispatchPointer('pointermove', 84)
    await nextTick()

    // 被拖的行标记半透明
    expect(rows[0].classes()).toContain('is-dragging')
    expect(rows[2].classes()).toContain('is-drag-over')
    // 从第 0 行拖到第 2 行：中间的第 1、2 行上移一格补位
    expect(rows[1].attributes('style')).toContain('--row-shift: -1')
    expect(rows[2].attributes('style')).toContain('--row-shift: -1')
    expect(rows[3].attributes('style')).toContain('--row-shift: 0')
    expect(rows[0].attributes('style')).toContain('--drag-offset: 68px')

    // 松手后拖拽状态复位
    dispatchPointer('pointerup', 84)
    await nextTick()
    expect(rows[0].classes()).not.toContain('is-dragging')
    expect(rows[2].classes()).not.toContain('is-drag-over')
    expect(rows[1].attributes('style')).toContain('--row-shift: 0')
  })

  it('草稿不外泄：未点「完成」直接关窗不触发 save', async () => {
    const wrapper = mountModal()

    await wrapper.findAll('.customize-row')[2].find('.app-checkbox__box').trigger('click')
    await wrapper.setProps({ open: false })

    expect(wrapper.emitted('save')).toBeUndefined()
  })
})
