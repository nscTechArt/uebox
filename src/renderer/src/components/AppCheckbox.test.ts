import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import AppCheckbox from './AppCheckbox.vue'

describe('AppCheckbox', () => {
  it('点方框发出 change 和 update:checked', async () => {
    const wrapper = mount(AppCheckbox, { props: { checked: false } })

    await wrapper.get('.app-checkbox__box').trigger('click')

    expect(wrapper.emitted('change')).toEqual([[true]])
    expect(wrapper.emitted('update:checked')).toEqual([[true]])
  })

  /**
   * 这条盯的是一个具体的坑：外层如果用 <label>，它会把点击转发给里面的
   * <button>（button 是 labelable 元素）。点一次文字会触发两次 toggle，
   * 一来一回等于没动 —— 复选框看着完全是坏的，而且不报任何错。
   */
  it('点文字只切换一次，不会被外层转发成两次', async () => {
    const wrapper = mount(AppCheckbox, { props: { checked: false }, slots: { default: '记住我' } })

    await wrapper.get('.app-checkbox__label').trigger('click')

    expect(wrapper.emitted('change')).toEqual([[true]])
  })

  it('已选中时点一下变成未选中', async () => {
    const wrapper = mount(AppCheckbox, { props: { checked: true } })

    await wrapper.get('.app-checkbox__box').trigger('click')

    expect(wrapper.emitted('change')).toEqual([[false]])
  })

  // 半选点一下应该是「全选上」。取反的话点半选会变成全不选，很反直觉
  it('半选点一下是全选，不是取反', async () => {
    const wrapper = mount(AppCheckbox, { props: { checked: false, indeterminate: true } })

    await wrapper.get('.app-checkbox__box').trigger('click')

    expect(wrapper.emitted('change')).toEqual([[true]])
  })

  it('禁用时点不动', async () => {
    const wrapper = mount(AppCheckbox, { props: { disabled: true } })

    await wrapper.get('.app-checkbox__box').trigger('click')

    expect(wrapper.emitted('change')).toBeUndefined()
    expect(wrapper.get('.app-checkbox__box').attributes('disabled')).toBeDefined()
  })

  // 半选念成「已勾选」的话，用户会以为一组全选上了
  it('半选对读屏软件报 mixed，不是 true', () => {
    const mixed = mount(AppCheckbox, { props: { checked: false, indeterminate: true } })
    const on = mount(AppCheckbox, { props: { checked: true } })
    const off = mount(AppCheckbox, { props: { checked: false } })

    expect(mixed.get('.app-checkbox__box').attributes('aria-checked')).toBe('mixed')
    expect(on.get('.app-checkbox__box').attributes('aria-checked')).toBe('true')
    expect(off.get('.app-checkbox__box').attributes('aria-checked')).toBe('false')
  })

  it('有文字时用 aria-labelledby 指向那段文字', () => {
    const wrapper = mount(AppCheckbox, { slots: { default: '记住我' } })

    const labelledby = wrapper.get('.app-checkbox__box').attributes('aria-labelledby')
    expect(labelledby).toBeDefined()
    expect(wrapper.get('.app-checkbox__label').attributes('id')).toBe(labelledby)
  })

  // 三种状态不能只靠颜色区分：空框 / 勾 / 横杠，形状本身就分得开
  it('选中画勾，半选画横杠，未选中什么都不画', () => {
    const off = mount(AppCheckbox, { props: { checked: false } })
    const on = mount(AppCheckbox, { props: { checked: true } })
    const mixed = mount(AppCheckbox, { props: { indeterminate: true } })

    expect(off.find('.app-checkbox__mark').exists()).toBe(false)
    expect(on.find('.app-checkbox__mark').exists()).toBe(true)
    expect(mixed.find('.app-checkbox__mark').exists()).toBe(true)
    // 勾是折线（三段坐标），横杠是一条直线 —— 画的确实不是同一个东西
    expect(on.get('.app-checkbox__mark path').attributes('d')).not.toBe(
      mixed.get('.app-checkbox__mark path').attributes('d')
    )
  })
})
