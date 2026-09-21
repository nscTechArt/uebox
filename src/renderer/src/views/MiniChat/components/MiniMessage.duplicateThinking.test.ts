import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import MiniMessage from './MiniMessage.vue'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'

/**
 * 小窗只有三百多像素宽：一轮还在跑的时候，「思考中」只该有一个框。
 * 曾经同时画了三个：思考框、过程条、外加一张正文只有占位符的卡片。
 */
function mountMessage(message: Partial<ChatMessage>): ReturnType<typeof mount> {
  return mount(MiniMessage, {
    props: {
      message: {
        id: 'm1',
        role: 'assistant',
        content: '正在思考...',
        status: 'typing',
        ...message
      } as ChatMessage
    },
    global: {
      stubs: {
        MarkdownRenderer: true,
        ThinkingProcess: true,
        AgentProcessLog: true,
        MessageSources: true,
        AskUserCard: true,
        UserBubble: true,
        'a-tooltip': true
      }
    }
  })
}

describe('MiniMessage 运行中的重复指示', () => {
  it('过程条已经在转时，不再补一张只写着占位符的正文卡片', () => {
    const wrapper = mountMessage({
      agentProcess: [{ type: 'notify-users', data: { notifyType: 'thinking' }, timestamp: 1 }]
    } as Partial<ChatMessage>)

    expect(wrapper.find('agent-process-log-stub').exists()).toBe(true)
    expect(wrapper.find('.assistant-card').exists()).toBe(false)
  })

  it('思考框已经在了，同样不补占位卡片', () => {
    const wrapper = mountMessage({ thinking: '先拆解需求' })

    expect(wrapper.find('thinking-process-stub').exists()).toBe(true)
    expect(wrapper.find('.assistant-card').exists()).toBe(false)
  })

  it('什么指示都没有时，占位符仍然要有地方显示', () => {
    const wrapper = mountMessage({})

    expect(wrapper.find('.assistant-card').exists()).toBe(true)
  })

  it('运行中把推理正文折进过程条，不再单开一个思考框', () => {
    const wrapper = mountMessage({
      thinking: '先拆解需求',
      agentProcess: [{ type: 'notify-users', data: { notifyType: 'thinking' }, timestamp: 1 }]
    } as Partial<ChatMessage>)

    expect(wrapper.find('thinking-process-stub').exists()).toBe(false)
    expect(wrapper.find('agent-process-log-stub').attributes('thinking')).toBe('先拆解需求')
  })

  it('跑完之后思考框变回独立的一块', () => {
    const wrapper = mountMessage({
      status: 'done',
      content: '灯没开',
      thinking: '先拆解需求',
      agentProcess: [{ type: 'notify-users', data: { notifyType: 'thinking' }, timestamp: 1 }]
    } as Partial<ChatMessage>)

    expect(wrapper.find('thinking-process-stub').exists()).toBe(true)
    expect(wrapper.find('agent-process-log-stub').attributes('thinking')).toBeUndefined()
  })

  it('正文来了就正常显示', () => {
    const wrapper = mountMessage({
      content: '场景是黑的，多半是没开灯',
      agentProcess: [{ type: 'notify-users', data: { notifyType: 'thinking' }, timestamp: 1 }]
    } as Partial<ChatMessage>)

    expect(wrapper.find('.assistant-card').exists()).toBe(true)
  })
})
