import { describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import NoteSourcePanel from './NoteSourcePanel.vue'
import type { SourceItem } from '@renderer/store/modules/notebookStore'

// 这里测的是「按钮在不在」，位置算得准不准是 AppDropdown 自己的事
vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  autoUpdate: vi.fn(() => vi.fn()),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn()
}))

const source: SourceItem = {
  id: 's1',
  title: 'Untitled Note',
  type: 'note',
  content: '正文'
}

function mountPanel(): VueWrapper {
  return mount(NoteSourcePanel, {
    props: { sources: [source], notebookId: 'nb1' },
    global: { stubs: { 'a-input': true } }
  }) as VueWrapper
}

/**
 * 来源行尾那颗「…」。
 *
 * 它平时是 `display: none`，整行 hover 才出现。菜单弹出来之后鼠标要往菜单上移，
 * 一离开这一行按钮就消失 —— 触发器连盒子都不剩，浮层失去锚点，
 * 菜单会从按钮底下跳到窗口左上角（用户看到的就是「菜单跑到界面角落去了」）。
 */
describe('NoteSourcePanel 来源的「…」菜单', () => {
  it('菜单开着的时候按钮钉住不隐藏', async () => {
    const wrapper = mountPanel()

    const more = wrapper.get('.more-btn')
    expect(more.classes()).not.toContain('open')

    await more.trigger('click')

    expect(wrapper.get('.more-btn').classes()).toContain('open')
  })

  it('菜单关掉之后按钮交还给 hover', async () => {
    const wrapper = mountPanel()
    await wrapper.get('.more-btn').trigger('click')
    expect(wrapper.get('.more-btn').classes()).toContain('open')

    // 点到别处 —— AppDropdown 在捕获阶段听 document 的 pointerdown
    document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.more-btn').classes()).not.toContain('open')
  })
})
