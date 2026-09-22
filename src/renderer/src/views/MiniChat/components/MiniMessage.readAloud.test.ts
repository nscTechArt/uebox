import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import MiniMessage from './MiniMessage.vue'
import { AGENT_RESUME_ACTION } from '@renderer/views/Assistant/composables/agentHandlerShared'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'

/**
 * 小窗气泡上的朗读按钮。念的和主聊天页、自动朗读是同一份：最终答复那一段。
 */

const toggle = vi.hoisted(() => vi.fn())
const stop = vi.hoisted(() => vi.fn())
const active = vi.hoisted(() => ({ value: false }))
vi.mock('@renderer/views/Assistant/composables/useReadAloud', () => ({
  useReadAloud: (owner?: () => string) => ({
    active,
    loading: { value: false },
    label: { value: '朗读回复' },
    toggle: (text: string) => toggle(text, owner?.()),
    stop
  }),
  stopReadAloud: stop
}))

function mountMessage(message: Partial<ChatMessage>): ReturnType<typeof mount> {
  return mount(MiniMessage, {
    props: {
      message: {
        id: 'm1',
        role: 'assistant',
        content: '都建好了。',
        status: 'done',
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
        AppTooltip: { template: '<div><slot /></div>' }
      }
    }
  })
}

describe('MiniMessage 朗读按钮', () => {
  beforeEach(() => {
    toggle.mockClear()
    stop.mockClear()
    active.value = false
  })

  it('落定的回复才有朗读按钮，还在打字的没有', () => {
    expect(mountMessage({}).find('.read-aloud-tool').exists()).toBe(true)
    expect(mountMessage({ status: 'typing' }).find('.read-aloud-tool').exists()).toBe(false)
  })

  it('点一下念最终答复那一段，以这条消息的 id 为主人', async () => {
    const wrapper = mountMessage({
      content: '我先摸清工程情况。建好了，一共三个资产。',
      agentProcess: [
        { type: 'text', data: { text: '我先摸清工程情况。' }, timestamp: 1 },
        { type: 'tool-call', data: { toolName: 'listAssets' }, timestamp: 2 },
        { type: 'text', data: { text: '建好了，一共三个资产。' }, timestamp: 3 }
      ]
    } as Partial<ChatMessage>)
    await wrapper.find('.read-aloud-tool').trigger('click')
    expect(toggle).toHaveBeenCalledExactlyOnceWith('建好了，一共三个资产。', 'm1')
  })

  it('挂着「接着跑」时不念那句错误提示，念崩之前说到的', async () => {
    const wrapper = mountMessage({
      content: '错误: Connection error.',
      agentProcess: [{ type: 'text', data: { text: '正在建资产。' }, timestamp: 1 }],
      actionButtons: [{ label: '接着跑', action: AGENT_RESUME_ACTION, data: {} }]
    } as Partial<ChatMessage>)
    await wrapper.find('.read-aloud-tool').trigger('click')
    expect(toggle).toHaveBeenCalledExactlyOnceWith('正在建资产。', 'm1')
  })

  it('正在念的时候按钮显示成停止', () => {
    active.value = true
    const button = mountMessage({}).find('.read-aloud-tool')
    expect(button.classes()).toContain('read-aloud-active')
    expect(button.attributes('aria-pressed')).toBe('true')
  })

  it('这一条重跑了就掐掉正在念的上一版', async () => {
    const wrapper = mountMessage({})
    await wrapper.setProps({
      message: { id: 'm1', role: 'assistant', content: '', status: 'typing' } as ChatMessage
    })
    expect(stop).toHaveBeenCalledOnce()
  })
})
