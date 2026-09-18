import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import AppButton from './AppButton.vue'

/**
 * 按钮接替了 antd 的 `<a-button>`（196 处）。这里测的是那些「坏了也不会报错、
 * 只会悄悄变得不对」的行为：禁用/加载时还能不能点、纯图标按钮认不认得出来、
 * 以及默认的 html type 是不是 button（放进 <form> 里不写就会意外提交表单）。
 */
describe('AppButton', () => {
  it('默认是 default 档、medium 尺寸、html type=button', () => {
    const wrapper = mount(AppButton, { slots: { default: '保存' } })
    const button = wrapper.get('button')

    expect(button.classes()).toContain('app-button--default')
    expect(button.classes()).toContain('app-button--medium')
    // 不显式写 type，浏览器默认是 submit，放在表单里会意外提交
    expect(button.attributes('type')).toBe('button')
  })

  it('variant / size / shape 各自落到自己的 class 上', () => {
    const wrapper = mount(AppButton, {
      props: { variant: 'primary', size: 'large', shape: 'circle' },
      slots: { default: '走' }
    })

    expect(wrapper.get('button').classes()).toEqual(
      expect.arrayContaining(['app-button--primary', 'app-button--large', 'app-button--circle'])
    )
  })

  // 设置页原来八套手搓按钮全收编到这一档，它必须真的存在
  it('soft 是一个可选的 variant', () => {
    const wrapper = mount(AppButton, { props: { variant: 'soft' }, slots: { default: '复制路径' } })
    expect(wrapper.get('button').classes()).toContain('app-button--soft')
  })

  it('禁用时既不发 click，也带上 disabled 属性', async () => {
    const wrapper = mount(AppButton, { props: { disabled: true }, slots: { default: '删除' } })

    await wrapper.get('button').trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  })

  // 不挡住的话用户会把同一个请求打两遍
  it('加载中也挡住点击，并告诉读屏软件正在忙', async () => {
    const wrapper = mount(AppButton, { props: { loading: true }, slots: { default: '提交' } })

    await wrapper.get('button').trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
    expect(wrapper.get('button').attributes('aria-busy')).toBe('true')
    expect(wrapper.find('.app-button__spinner').exists()).toBe(true)
  })

  it('正常状态点得动', async () => {
    const wrapper = mount(AppButton, { slots: { default: '确定' } })

    await wrapper.get('button').trigger('click')

    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('只有图标没有文字时标记成 icon-only，好收成正方形', () => {
    const iconOnly = mount(AppButton, {
      props: { ariaLabel: '关闭' },
      slots: { icon: '<svg />' }
    })
    const withText = mount(AppButton, { slots: { icon: '<svg />', default: '关闭' } })

    expect(iconOnly.get('button').classes()).toContain('app-button--icon-only')
    expect(withText.get('button').classes()).not.toContain('app-button--icon-only')
  })

  // 没有可见文字的按钮，读屏软件只能靠 aria-label
  it('把 ariaLabel 透到按钮上', () => {
    const wrapper = mount(AppButton, {
      props: { ariaLabel: '关闭面板' },
      slots: { icon: '<svg />' }
    })

    expect(wrapper.get('button').attributes('aria-label')).toBe('关闭面板')
  })

  it('加载时不渲染 icon 插槽 —— 那个位置让给转圈', () => {
    const wrapper = mount(AppButton, {
      props: { loading: true },
      slots: { icon: '<svg class="my-icon" />', default: '提交' }
    })

    expect(wrapper.find('.my-icon').exists()).toBe(false)
    expect(wrapper.find('.app-button__spinner').exists()).toBe(true)
  })
})
