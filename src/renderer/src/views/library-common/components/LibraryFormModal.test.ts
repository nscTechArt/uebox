import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import LibraryFormModal from './LibraryFormModal.vue'

function mountModal(
  props: Record<string, unknown> = {},
  slots: Record<string, string> = {}
): VueWrapper {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: {
      'zh-CN': { libraryCommon: { close: '关闭', modal: { advanced: '高级设置' } } }
    }
  })

  return mount(LibraryFormModal, {
    props: {
      open: true,
      title: '新建蓝图',
      confirmText: '创建',
      cancelText: '取消',
      ...props
    },
    slots,
    global: {
      plugins: [i18n],
      // 组件 Teleport 到 body，打桩后内容留在 wrapper 里
      stubs: { teleport: true }
    }
  })
}

describe('LibraryFormModal', () => {
  it('关闭时不渲染任何东西', () => {
    const wrapper = mountModal({ open: false })
    expect(wrapper.find('.modal-overlay').exists()).toBe(false)
  })

  it('渲染标题、动作按钮，并把默认插槽放进 modal-body', () => {
    const wrapper = mountModal({}, { default: '<input class="form-input" />' })

    expect(wrapper.find('.modal-title').text()).toBe('新建蓝图')
    expect(wrapper.find('.btn-confirm').text()).toBe('创建')
    expect(wrapper.find('.btn-cancel').text()).toBe('取消')
    expect(wrapper.find('.modal-body .form-input').exists()).toBe(true)
  })

  it('取消、关闭按钮、点遮罩都发 update:open false', async () => {
    const wrapper = mountModal()

    await wrapper.find('.btn-cancel').trigger('click')
    await wrapper.find('.modal-close').trigger('click')
    await wrapper.find('.modal-overlay').trigger('click')

    expect(wrapper.emitted('update:open')).toEqual([[false], [false], [false]])
  })

  it('确认按钮发 confirm；禁用时点不动', async () => {
    const wrapper = mountModal()
    await wrapper.find('.btn-confirm').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)

    const disabled = mountModal({ confirmDisabled: true })
    expect((disabled.find('.btn-confirm').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('没有 advanced 插槽时不长出折叠区', () => {
    const wrapper = mountModal({}, { default: '<span />' })
    expect(wrapper.find('.advanced-section').exists()).toBe(false)
  })

  /**
   * 展开状态由调用方持有（蓝图库存在 store 里，跨次打开保持），
   * 所以组件自己不记状态，只负责发事件 —— 这条守的就是这个边界。
   */
  it('有 advanced 插槽时，折叠条按 advancedExpanded 显隐并发出翻转事件', async () => {
    const wrapper = mountModal(
      { advancedExpanded: false, advancedHint: '蓝图类型、引擎版本、描述' },
      { default: '<span />', advanced: '<div class="advanced-body" />' }
    )

    expect(wrapper.find('.toggle-hint').text()).toBe('蓝图类型、引擎版本、描述')
    expect(wrapper.find('.toggle-text').text()).toBe('高级设置')
    expect(wrapper.find('.toggle-icon').classes()).not.toContain('expanded')
    // v-show：元素在，但被 display:none 藏起来
    expect((wrapper.find('.advanced-content').element as HTMLElement).style.display).toBe('none')

    await wrapper.find('.advanced-toggle').trigger('click')
    expect(wrapper.emitted('update:advancedExpanded')).toEqual([[true]])

    await wrapper.setProps({ advancedExpanded: true })
    expect(wrapper.find('.toggle-icon').classes()).toContain('expanded')
    expect((wrapper.find('.advanced-content').element as HTMLElement).style.display).not.toBe(
      'none'
    )
  })

  it('size 决定面板宽度类名', () => {
    expect(mountModal({ size: 'wide' }).find('.modal-box').classes()).toContain('size-wide')
    expect(mountModal().find('.modal-box').classes()).toContain('size-default')
  })
})
