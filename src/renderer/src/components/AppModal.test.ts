import { describe, expect, it, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import AppModal from './AppModal.vue'

/**
 * 挂过的 wrapper 都记下来，afterEach 里逐个 unmount。
 *
 * 不能只用 `document.body.innerHTML = ''` —— 那只是把 DOM 抹了，组件还活着，
 * 下一个用例里它一旦重新渲染就会去 patch 一段已经不存在的 DOM。
 */
const mounted: VueWrapper[] = []

function mountModal(
  props: Record<string, unknown> = {},
  slots: Record<string, string> = {}
): VueWrapper {
  const wrapper = mount(AppModal, {
    props: { open: true, title: '确认操作', ...props },
    slots: { default: '<input class="first" /><input class="second" />', ...slots },
    attachTo: document.body
  }) as VueWrapper
  mounted.push(wrapper)
  return wrapper
}

function panel(): HTMLElement | null {
  return document.querySelector('.app-modal__panel')
}

/**
 * 内容是 Teleport 到 body 的，vue-test-utils 的 wrapper.find traverse 不进去，
 * 所以一律从 document 上查、用原生事件触发。
 */
function q<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

function click(selector: string): void {
  q(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

describe('AppModal', () => {
  it('将外部属性传给面板，关闭和重新打开时不产生属性继承警告', async () => {
    const warnHandler = vi.fn()
    const onClick = vi.fn()
    const wrapper = mount(AppModal, {
      props: { open: false, title: '安全提示', destroyOnClose: true },
      attrs: {
        class: 'link-confirm-modal',
        style: { maxHeight: '80vh' },
        'data-testid': 'link-confirm',
        onClick
      },
      global: { config: { warnHandler } },
      attachTo: document.body
    })
    mounted.push(wrapper)
    expect(panel()).toBeNull()

    for (let i = 0; i < 2; i += 1) {
      await wrapper.setProps({ open: true })
      expect(panel()?.classList.contains('link-confirm-modal')).toBe(true)
      expect(panel()?.getAttribute('data-testid')).toBe('link-confirm')
      expect(panel()?.style.maxHeight).toBe('80vh')
      expect(panel()?.style.width).toBe('520px')
      expect(q('.app-modal-root')?.classList.contains('link-confirm-modal')).toBe(false)
      click('.app-modal__panel')
      expect(onClick).toHaveBeenCalledTimes(i + 1)
      await wrapper.setProps({ open: false })
      expect(panel()).toBeNull()
    }
    expect(warnHandler).not.toHaveBeenCalled()
  })

  it('打开时挂到 body 上，带 role=dialog 和 aria-modal', () => {
    mountModal()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
  })

  it('标题挂 aria-labelledby，读屏软件才念得出这是什么弹窗', () => {
    mountModal({ title: '删除保管库' })

    const labelledby = panel()?.getAttribute('aria-labelledby')
    expect(labelledby).toBeTruthy()
    expect(document.getElementById(labelledby as string)?.textContent?.trim()).toBe('删除保管库')
  })

  /**
   * 标题原来只认 `title` prop：`v-if="title"` 把 `<h2>` 整个挡掉，连里面的
   * `#title` 插槽一起不渲染。于是自己拼标题的弹窗（「模型与服务商」那个）
   * 头部只剩一个关闭叉，而且叉子滑到了最左边 —— 它成了这一行唯一的 flex 子元素。
   */
  it('用 #title 插槽拼的标题照样渲染，并且挂得上 aria-labelledby', () => {
    mountModal({ title: undefined }, { title: '<span>模型与服务商</span>' })

    const labelledby = panel()?.getAttribute('aria-labelledby')
    expect(labelledby).toBeTruthy()
    expect(document.getElementById(labelledby as string)?.textContent?.trim()).toBe('模型与服务商')
  })

  /** 叉子靠右是 `.app-modal__close { margin-left: auto }` 管的；scoped 样式进不了 jsdom，测不到 */
  it('标题和插槽都没有时，头部只剩关闭叉，也不挂 aria-labelledby', () => {
    mountModal({ title: undefined })

    expect(q('.app-modal__title')).toBeNull()
    expect(q('.app-modal__close')).not.toBeNull()
    expect(panel()?.getAttribute('aria-labelledby')).toBeNull()
  })

  /**
   * 背景不锁的话，弹窗开着时滚鼠标滚的是后面的页面，
   * 关掉之后发现自己已经滚到了别的地方。
   */
  it('打开锁住 body 滚动，关闭解锁', async () => {
    const wrapper = mountModal({ open: false })

    await wrapper.setProps({ open: true })
    expect(document.body.style.overflow).toBe('hidden')

    await wrapper.setProps({ open: false })
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  /**
   * 这条盯的是「叠弹窗」：弹窗里再开一个，关掉里面那个时如果直接解锁，
   * 外面那个还开着，背景却能滚了。所以锁必须是计数不是布尔。
   */
  it('两个弹窗叠着时，关掉里面那个不会把锁一起解了', async () => {
    const outer = mountModal({ open: false })
    const inner = mountModal({ open: false })

    await outer.setProps({ open: true })
    await inner.setProps({ open: true })
    expect(document.body.style.overflow).toBe('hidden')

    await inner.setProps({ open: false })
    expect(document.body.style.overflow).toBe('hidden')

    await outer.setProps({ open: false })
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('点遮罩关闭；mask-closable=false 时点不关', async () => {
    const closable = mountModal()
    click('.app-modal__mask')
    expect(closable.emitted('update:open')).toEqual([[false]])
    closable.unmount()

    const locked = mountModal({ maskClosable: false })
    click('.app-modal__mask')
    expect(locked.emitted('update:open')).toBeUndefined()
  })

  it('Esc 关闭；keyboard=false 时按了不关', async () => {
    const esc = (): void => {
      q('.app-modal-root')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    }

    const wrapper = mountModal()
    esc()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    wrapper.unmount()

    const locked = mountModal({ keyboard: false })
    esc()
    expect(locked.emitted('update:open')).toBeUndefined()
  })

  it('确定按钮发 ok，取消按钮发 cancel', async () => {
    const wrapper = mountModal()
    const buttons = document.querySelectorAll<HTMLElement>('.app-modal__footer button')

    buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('ok')).toHaveLength(1)

    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('hide-footer 时不渲染底部按钮', () => {
    mountModal({ hideFooter: true })
    expect(q('.app-modal__footer')).toBeNull()
  })

  it('footer 插槽换掉默认的那两个按钮', () => {
    mountModal({}, { footer: '<button class="custom-footer">删除</button>' })

    expect(q('.custom-footer')).not.toBeNull()
    expect(document.querySelectorAll('.app-modal__footer button')).toHaveLength(1)
  })

  /**
   * `hide-footer` 会把 `<footer>` 整个删掉，**连同 footer 插槽**。
   *
   * 这个组合看着像「我要自定义底部」，实际是「底部什么都不要」——
   * 「技能」详情弹窗第一版就这么写的，那排按钮一个都没出现。
   */
  it('hide-footer 会连 footer 插槽一起删掉，两个不能一起用', () => {
    mountModal({ hideFooter: true }, { footer: '<button class="custom-footer">删除</button>' })
    expect(q('.custom-footer')).toBeNull()
  })

  /**
   * 焦点不还回去的话，焦点落回 <body>，
   * 键盘用户关掉弹窗之后得从页头重新 Tab 一遍。
   */
  it('关闭后把焦点还给打开它的那个元素', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const wrapper = mountModal({ open: false })
    await wrapper.setProps({ open: true })
    await wrapper.vm.$nextTick()

    await wrapper.setProps({ open: false })
    expect(document.activeElement).toBe(opener)
  })

  it('destroy-on-close 关掉后内容不再挂在 DOM 上', async () => {
    const wrapper = mountModal({ open: false, destroyOnClose: true })

    await wrapper.setProps({ open: true })
    expect(document.querySelector('.first')).not.toBeNull()

    await wrapper.setProps({ open: false })
    expect(document.querySelector('.first')).toBeNull()
  })

  it('不加 destroy-on-close 时内容留着（只是藏起来）', async () => {
    const wrapper = mountModal({ open: false })

    await wrapper.setProps({ open: true })
    await wrapper.setProps({ open: false })

    expect(document.querySelector('.first')).not.toBeNull()
  })

  // 焦点跑到弹窗外面的话，键盘用户会在看不见的背景里乱按
  it('Tab 走到最后一个可聚焦元素时绕回第一个，不跑出弹窗', async () => {
    const wrapper = mountModal({ hideFooter: true, closable: false })
    await wrapper.vm.$nextTick()

    const inputs = document.querySelectorAll<HTMLElement>('.app-modal__panel input')
    const last = inputs[inputs.length - 1]
    last.focus()

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    const prevented = vi.spyOn(event, 'preventDefault')
    document.querySelector('.app-modal-root')?.dispatchEvent(event)

    expect(prevented).toHaveBeenCalled()
    expect(document.activeElement).toBe(inputs[0])
  })
})
