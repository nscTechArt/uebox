import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppTag from './AppTag.vue'

describe('AppTag', () => {
  it('默认是只读的 span，不是 button —— 没有交互的东西不该进 Tab 序列', () => {
    const wrapper = mount(AppTag, { slots: { default: 'Metallic' } })

    expect(wrapper.element.tagName).toBe('SPAN')
    expect(wrapper.text()).toBe('Metallic')
    expect(wrapper.classes()).toContain('app-tag--neutral')
    expect(wrapper.classes()).toContain('app-tag--filled')
  })

  it('interactive 才渲染成 button，并把选中态报给辅助技术', () => {
    const wrapper = mount(AppTag, {
      props: { interactive: true, selected: true },
      slots: { default: 'Material' }
    })

    expect(wrapper.element.tagName).toBe('BUTTON')
    expect(wrapper.attributes('type')).toBe('button')
    expect(wrapper.attributes('aria-pressed')).toBe('true')
    expect(wrapper.classes()).toContain('app-tag--selected')
  })

  it('非 interactive 不发 click —— 只读标签以前会放大唬人，点了却没反应', async () => {
    const wrapper = mount(AppTag, { props: { variant: 'outline' } })

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('删除按钮独立发 remove，且不冒泡成整块的 click', async () => {
    const wrapper = mount(AppTag, {
      props: { removable: true, removeLabel: '移除' },
      slots: { default: 'EasyFog' }
    })

    const removeBtn = wrapper.get('.app-tag__remove')
    expect(removeBtn.attributes('aria-label')).toBe('移除')

    await removeBtn.trigger('click')

    expect(wrapper.emitted('remove')).toHaveLength(1)
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('色点只是个前置小圆点，文字不落在彩色底上（旧实现那样对比度只有 2.6:1）', () => {
    const wrapper = mount(AppTag, {
      props: { dot: 'var(--color-uetype-material)' },
      slots: { default: 'Material' }
    })

    const dot = wrapper.get('.app-tag__dot')
    expect(dot.attributes('style')).toContain('var(--color-uetype-material)')
    // 整块不带内联背景色 —— 颜色只出现在色点上
    expect(wrapper.attributes('style')).toBeUndefined()
  })

  it('选中只改颜色不改盒子 —— 加勾会撑宽标签，流式排布整片跟着重新折行', () => {
    const slots = { default: 'Diffuse' }
    const off = mount(AppTag, { props: { interactive: true, selected: false }, slots })
    const on = mount(AppTag, { props: { interactive: true, selected: true }, slots })

    // 选中前后 DOM 结构必须一模一样，只有 class 不同
    expect(on.get('.app-tag__label').text()).toBe(off.get('.app-tag__label').text())
    expect(on.element.children.length).toBe(off.element.children.length)
    expect(on.classes()).toContain('app-tag--selected')
    expect(off.classes()).not.toContain('app-tag--selected')
  })
})
