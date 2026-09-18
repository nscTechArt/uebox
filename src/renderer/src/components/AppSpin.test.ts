import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import AppSpin from './AppSpin.vue'
import AppTag from './AppTag.vue'
import AppEmpty from './AppEmpty.vue'

describe('AppSpin', () => {
  it('不带内容时只画一个转圈', () => {
    const wrapper = mount(AppSpin)

    expect(wrapper.find('.app-spin').exists()).toBe(true)
    expect(wrapper.find('.app-spin-wrap').exists()).toBe(false)
  })

  it('带内容时包住它，spinning 才盖上遮罩', async () => {
    const wrapper = mount(AppSpin, {
      props: { spinning: false },
      slots: { default: '<p class="body">列表</p>' }
    })

    expect(wrapper.find('.body').exists()).toBe(true)
    expect(wrapper.find('.app-spin-overlay').exists()).toBe(false)

    await wrapper.setProps({ spinning: true })
    expect(wrapper.find('.app-spin-overlay').exists()).toBe(true)
  })

  /**
   * 不挡点击的话，用户能点到底下正在被替换的列表项 —— 点中的还是旧数据。
   * 这条靠 class 断言：pointer-events 的实际效果 jsdom 量不出来。
   */
  it('加载时把内容标成不可点', async () => {
    const wrapper = mount(AppSpin, {
      props: { spinning: true },
      slots: { default: '<p class="body">列表</p>' }
    })

    expect(wrapper.get('.app-spin-content').classes()).toContain('app-spin-content--blurred')

    await wrapper.setProps({ spinning: false })
    expect(wrapper.get('.app-spin-content').classes()).not.toContain('app-spin-content--blurred')
  })

  it('尺寸落到 class 上；tip 同时用作读屏软件的说明', () => {
    const wrapper = mount(AppSpin, { props: { size: 'large', tip: '正在加载工程' } })

    expect(wrapper.get('.app-spin__dot').classes()).toContain('app-spin__dot--large')
    expect(wrapper.get('.app-spin__dot').attributes('aria-label')).toBe('正在加载工程')
    expect(wrapper.get('.app-spin__tip').text()).toBe('正在加载工程')
  })
})

describe('AppTag', () => {
  it('按语义档给 class，默认中性', () => {
    expect(mount(AppTag).classes()).toContain('app-tag--neutral')
    expect(mount(AppTag, { props: { tone: 'danger' } }).classes()).toContain('app-tag--danger')
    expect(mount(AppTag, { props: { tone: 'success' } }).classes()).toContain('app-tag--success')
  })

  it('内容原样渲染', () => {
    expect(mount(AppTag, { slots: { default: '已连接' } }).text()).toBe('已连接')
  })
})

describe('AppEmpty', () => {
  it('说明文字渲染出来，图标对读屏软件隐藏', () => {
    const wrapper = mount(AppEmpty, { props: { description: '还没有素材' } })

    expect(wrapper.get('.app-empty__text').text()).toBe('还没有素材')
    // 念一遍「图片」再念「还没有素材」是噪音
    expect(wrapper.get('.app-empty__icon').attributes('aria-hidden')).toBe('true')
  })

  it('没有说明时不渲染那行空的 <p>', () => {
    const wrapper = mount(AppEmpty)
    expect(wrapper.find('.app-empty__text').exists()).toBe(false)
  })

  it('#icon 插槽能换掉默认那张图', () => {
    const wrapper = mount(AppEmpty, {
      props: { description: '还没有录屏' },
      slots: { icon: '<svg class="film" />' }
    })

    expect(wrapper.find('.film').exists()).toBe(true)
  })

  it('标题和说明各占一行，都渲染出来', () => {
    const wrapper = mount(AppEmpty, {
      props: { title: '还没有工程', description: '拖一个 .uproject 进来' }
    })

    expect(wrapper.get('.app-empty__title').text()).toBe('还没有工程')
    expect(wrapper.get('.app-empty__text').text()).toBe('拖一个 .uproject 进来')
  })

  it('只给标题时不渲染那行空的说明', () => {
    const wrapper = mount(AppEmpty, { props: { title: '没有匹配的工程' } })

    expect(wrapper.get('.app-empty__title').text()).toBe('没有匹配的工程')
    expect(wrapper.find('.app-empty__text').exists()).toBe(false)
  })

  it('没有标题时不渲染那行空的标题', () => {
    const wrapper = mount(AppEmpty, { props: { description: '还没有素材' } })
    expect(wrapper.find('.app-empty__title').exists()).toBe(false)
  })
})
