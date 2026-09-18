import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { PhCheckCircle, PhCircleNotch, PhLightning } from '@phosphor-icons/vue'

import AgentProcessLog from './AgentProcessLog.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

// 带有效思考内容的 notify 条目：currentThinking 由此推导，thinking 区才会渲染
const thinkingItems: AgentProcessItem[] = [
  {
    type: 'notify-users',
    data: { notifyType: 'thinking', message: '分析用户的需求并拆解步骤' },
    timestamp: 1
  }
]

function mountLog(isThinking: boolean): ReturnType<typeof mount> {
  return mount(AgentProcessLog, {
    props: { items: thinkingItems, isThinking },
    global: {
      stubs: {
        MarkdownRenderer: true,
        'a-tooltip': true
      }
    }
  })
}

describe('AgentProcessLog thinking feedback', () => {
  it('keeps details collapsed by default, including live work', () => {
    const wrapper = mountLog(true)

    expect(wrapper.find('.process-header').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('markdown-renderer-stub').exists()).toBe(false)
  })

  it('only mounts the thinking Markdown after the user expands details', async () => {
    const wrapper = mountLog(true)

    await wrapper.find('.process-header').trigger('click')

    expect(wrapper.find('markdown-renderer-stub').exists()).toBe(true)
  })

  it('marks the header status icon as spinning while thinking', () => {
    const wrapper = mountLog(true)

    // spinning class 是旋转动画（自含 keyframes）的载体
    expect(wrapper.find('.status-icon.spinning').exists()).toBe(true)
    // Phosphor 画出来是裸 <svg>，没有 antd 那种 .anticon-loading 类名可认，
    // 所以直接问「渲染的是哪个图标组件」
    expect(wrapper.findComponent(PhCircleNotch).exists()).toBe(true)
    expect(wrapper.findComponent(PhCheckCircle).exists()).toBe(false)
  })

  it('swaps the header spinner for a check once thinking finishes', () => {
    const wrapper = mountLog(false)

    expect(wrapper.find('.status-icon.spinning').exists()).toBe(false)
    expect(wrapper.findComponent(PhCheckCircle).exists()).toBe(true)
    expect(wrapper.findComponent(PhCircleNotch).exists()).toBe(false)
  })

  it('shows the live spinning indicator in front of the thinking section', () => {
    const wrapper = mountLog(true)

    expect(wrapper.find('.thinking-header .thinking-icon.is-live').exists()).toBe(true)
    expect(wrapper.find('.thinking-header').text()).toContain('思考中')
  })

  it('restores the static icon on the thinking section after it finishes', () => {
    const wrapper = mountLog(false)

    expect(wrapper.find('.thinking-header .thinking-icon.is-live').exists()).toBe(false)
    expect(wrapper.findComponent(PhLightning).exists()).toBe(true)
  })
})
