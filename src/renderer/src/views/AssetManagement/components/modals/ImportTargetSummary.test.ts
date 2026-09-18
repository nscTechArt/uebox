import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ImportTargetSummary from './ImportTargetSummary.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const props = {
  projectKey: 'forest',
  projectName: 'Forest',
  compatibilityText: 'No known version conflicts',
  blocked: 0,
  failed: false
}

describe('import target summary', () => {
  it('一切正常时底栏只有结论那一句：没有展开器，也不念预检的旁白', () => {
    const wrapper = mount(ImportTargetSummary, { props })
    expect(wrapper.text()).toContain('importToProjectModal.targetProject')
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(props.compatibilityText)
  })

  it.each([
    { blocked: 2, failed: false },
    { blocked: 0, failed: true }
  ])('有问题才多一行警告 (%j)', async (problem) => {
    const wrapper = mount(ImportTargetSummary, {
      props: { ...props, ...problem, compatibilityText: 'Please retry or choose another project' }
    })
    expect(wrapper.get('[role="status"]').text()).toContain('Please retry')
    if (problem.failed) {
      await wrapper.get('.target-warning button').trigger('click')
      expect(wrapper.emitted('retry')).toHaveLength(1)
    } else {
      // 版本冲突是导入时才处理的事，这里没得重试
      expect(wrapper.find('.target-warning button').exists()).toBe(false)
    }
  })
})
