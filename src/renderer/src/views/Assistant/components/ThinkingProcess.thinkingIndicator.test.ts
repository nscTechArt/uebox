import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { PhCircleNotch, PhLightbulb } from '@phosphor-icons/vue'

import ThinkingProcess from './ThinkingProcess.vue'

function mountProcess(isThinking: boolean): ReturnType<typeof mount> {
  return mount(ThinkingProcess, {
    props: { content: '分析用户的需求', isThinking },
    global: {
      stubs: { MarkdownRenderer: true }
    }
  })
}

describe('ThinkingProcess live feedback', () => {
  it('does not mount the Markdown renderer while thinking is collapsed', async () => {
    const wrapper = mountProcess(true)

    expect(wrapper.find('.thinking-content').exists()).toBe(false)
    expect(wrapper.find('markdown-renderer-stub').exists()).toBe(false)

    await wrapper.find('.thinking-header').trigger('click')

    expect(wrapper.find('.thinking-content').exists()).toBe(true)
    expect(wrapper.find('markdown-renderer-stub').exists()).toBe(true)
  })

  it('spins the icon while thinking so the wait is visible', () => {
    const wrapper = mountProcess(true)

    // spinning class 是旋转动画（自含 keyframes）的载体
    expect(wrapper.find('.thinking-icon.spinning').exists()).toBe(true)
    // Phosphor 画出来是裸 <svg>，没有 antd 那种 .anticon-loading 类名可认，
    // 所以直接问「渲染的是哪个图标组件」
    expect(wrapper.findComponent(PhCircleNotch).exists()).toBe(true)
    expect(wrapper.findComponent(PhLightbulb).exists()).toBe(false)
  })

  it('shows the static bulb once thinking finishes', () => {
    const wrapper = mountProcess(false)

    expect(wrapper.find('.thinking-icon.spinning').exists()).toBe(false)
    expect(wrapper.findComponent(PhLightbulb).exists()).toBe(true)
    expect(wrapper.findComponent(PhCircleNotch).exists()).toBe(false)
  })
})
