import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { AGENT_RESUME_ACTION } from './agentHandlerShared'
import { useAutoReadAloud } from './autoReadAloud'
import { setVoiceCallActive } from './voiceCallState'

/**
 * 自动朗读挂在常驻布局上，不挂在气泡上。
 *
 * 这套用例的重点全在两件事：**没有助手页挂着的时候照样念**（长活跑着的时候用户
 * 多半切走了），以及**只念最终答复那一段**（过程里的解说不念）。
 */

const toggle = vi.hoisted(() => vi.fn())
const stop = vi.hoisted(() => vi.fn())
vi.mock('./useReadAloud', () => ({
  useReadAloud: (owner?: () => string) => ({
    active: { value: false },
    loading: { value: false },
    label: { value: '朗读回复' },
    toggle: (text: string) => toggle(text, owner?.()),
    stop
  }),
  // `voiceCallState` 接通时会调它掐掉正在念的那半句
  stopReadAloud: stop
}))

function mountHost(): ReturnType<typeof mount> {
  const Host = defineComponent({
    setup() {
      useAutoReadAloud()
      return () => h('div')
    }
  })
  return mount(Host)
}

/** 开跑一轮：推一条 typing 的回复，返回它的消息号 */
function startTurn(chatSid: string): string {
  return useChatMessagesStore().pushAssistantTyping(chatSid)
}

describe('回复落定后自动朗读', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    toggle.mockClear()
    stop.mockClear()
    setVoiceCallActive(false)
  })

  it('一个助手页都没挂着，跑完照样念', async () => {
    const chatMsgStore = useChatMessagesStore()
    useAIConfigStore().setVoiceAutoPlayEnabled(true)
    mountHost()

    const id = startTurn('chat-1')
    await nextTick()
    expect(toggle).not.toHaveBeenCalled()

    chatMsgStore.replaceTyping('chat-1', id, '都建好了。', true)
    await nextTick()
    expect(toggle).toHaveBeenCalledExactlyOnceWith('都建好了。', id)
  })

  it('只念最终答复那一段，过程里的解说不念', async () => {
    const chatMsgStore = useChatMessagesStore()
    useAIConfigStore().setVoiceAutoPlayEnabled(true)
    mountHost()

    const id = startTurn('chat-1')
    await nextTick()
    const agentProcess = [
      { type: 'text' as const, data: { text: '我先摸清工程情况。' }, timestamp: 1 },
      { type: 'tool-call' as const, data: { toolName: 'listAssets' }, timestamp: 2 },
      { type: 'text' as const, data: { text: '再多探几下。' }, timestamp: 3 },
      { type: 'tool-result' as const, data: { result: '一堆读不出来的东西' }, timestamp: 4 },
      { type: 'text' as const, data: { text: '建好了，一共三个资产。' }, timestamp: 5 }
    ]
    chatMsgStore.replaceTyping(
      'chat-1',
      id,
      '我先摸清工程情况。再多探几下。建好了，一共三个资产。',
      true,
      { agentProcess }
    )
    await nextTick()

    expect(toggle).toHaveBeenCalledExactlyOnceWith('建好了，一共三个资产。', id)
  })

  it('关着开关不念；开关中途关掉就停嘴', async () => {
    const chatMsgStore = useChatMessagesStore()
    const aiConfigStore = useAIConfigStore()
    mountHost()

    const id = startTurn('chat-1')
    await nextTick()
    chatMsgStore.replaceTyping('chat-1', id, '默认不该念。', true)
    await nextTick()
    expect(toggle).not.toHaveBeenCalled()

    aiConfigStore.setVoiceAutoPlayEnabled(true)
    await nextTick()
    // 开关一开不补播已经落定的那条
    expect(toggle).not.toHaveBeenCalled()

    aiConfigStore.setVoiceAutoPlayEnabled(false)
    await nextTick()
    expect(stop).toHaveBeenCalled()
  })

  it.each(['error', 'stopped'] as const)('%s 收场的那一轮不念', async (outcome) => {
    const chatMsgStore = useChatMessagesStore()
    useAIConfigStore().setVoiceAutoPlayEnabled(true)
    mountHost()

    const id = startTurn('chat-1')
    await nextTick()
    chatMsgStore.replaceTyping('chat-1', id, '错误: Connection error.', true, { outcome })
    await nextTick()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('挂着「接着跑」的那一轮不念 —— 它还没跑完', async () => {
    const chatMsgStore = useChatMessagesStore()
    useAIConfigStore().setVoiceAutoPlayEnabled(true)
    mountHost()

    const id = startTurn('chat-1')
    await nextTick()
    chatMsgStore.replaceTyping('chat-1', id, '断在一半。', true, {
      actionButtons: [{ label: '接着跑', action: AGENT_RESUME_ACTION, data: {} }]
    })
    await nextTick()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('通话中一律不念', async () => {
    const chatMsgStore = useChatMessagesStore()
    useAIConfigStore().setVoiceAutoPlayEnabled(true)
    setVoiceCallActive(true)
    mountHost()

    const id = startTurn('chat-1')
    await nextTick()
    chatMsgStore.replaceTyping('chat-1', id, '这句话语音自己已经说过了。', true)
    await nextTick()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('念的是落定的那条，不是别的对话里那条', async () => {
    const chatMsgStore = useChatMessagesStore()
    useAIConfigStore().setVoiceAutoPlayEnabled(true)
    mountHost()

    const first = startTurn('chat-1')
    const second = startTurn('chat-2')
    await nextTick()
    chatMsgStore.replaceTyping('chat-2', second, '第二条对话的结论。', true)
    await nextTick()

    expect(toggle).toHaveBeenCalledExactlyOnceWith('第二条对话的结论。', second)
    expect(chatMsgStore.getMessages('chat-1')[0].id).toBe(first)
  })
})
