import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import AppSegmented from './AppSegmented.vue'

describe('AppSegmented', () => {
  it('读取当前选项，挂载时不覆盖已保存的选择', () => {
    const wrapper = mount(AppSegmented, {
      props: { modelValue: 'detailed', options: ['concise', 'detailed'], ariaLabel: '语音反馈' }
    })

    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('语音反馈')
    expect(wrapper.findAll('button').map((button) => button.attributes('aria-pressed'))).toEqual([
      'false',
      'true'
    ])
    expect(wrapper.get('.active').text()).toBe('detailed')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('点击交回原始值，父组件更新后切换选中态，按钮不提交表单', async () => {
    const wrapper = mount(AppSegmented, {
      props: { modelValue: 7, options: [7, 30], ariaLabel: '统计范围' }
    })

    await wrapper.findAll('button')[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[30]])
    expect(
      wrapper.findAll('button').every((button) => button.attributes('type') === 'button')
    ).toBe(true)
    await wrapper.setProps({ modelValue: 30 })
    expect(wrapper.get('.active').text()).toBe('30')
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(1)
  })

  it('选项插槽保留翻译与数量，选项删除后不留下旧按钮', async () => {
    const wrapper = mount(AppSegmented, {
      props: { modelValue: 'all', options: ['all', 'local'], ariaLabel: '技能来源' },
      slots: { default: ({ option }) => h('span', option === 'all' ? '全部 8' : '本地 3') }
    })

    expect(wrapper.findAll('button').map((button) => button.text())).toEqual(['全部 8', '本地 3'])
    await wrapper.setProps({ options: ['all'] })
    expect(wrapper.findAll('button')).toHaveLength(1)
    expect(wrapper.get('button').text()).toBe('全部 8')
  })
})
