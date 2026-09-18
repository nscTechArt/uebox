import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

import { openSideChat, type SideChatDeps } from './sideChat'

function setupDeps(overrides: Partial<SideChatDeps> = {}): SideChatDeps {
  return {
    chatStore: useChatSessionsStore(),
    fork: vi
      .fn()
      .mockResolvedValue({ success: true, sessionId: 'agent-side', messageCount: 12, live: true }),
    open: vi.fn(),
    ...overrides
  }
}

function seedAgentChat(): void {
  const chatStore = useChatSessionsStore()
  chatStore.createSession('chat-a', '做个呼吸发光材质')
  chatStore.setAgentSessionId('chat-a', 'agent-a')
}

describe('openSideChat', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('把复制出来的上下文交给小窗口', async () => {
    seedAgentChat()
    const deps = setupDeps()

    const outcome = await openSideChat('chat-a', deps)

    expect(deps.fork).toHaveBeenCalledWith('agent-a')
    expect(outcome).toEqual({
      ok: true,
      context: {
        agentSessionId: 'agent-side',
        messageCount: 12,
        sourceTitle: '做个呼吸发光材质',
        live: true
      }
    })
    expect(deps.open).toHaveBeenCalledWith(outcome.ok ? outcome.context : undefined)
  })

  it('没有内核会话时不开窗口 —— 空窗口会让人以为它知道些什么', async () => {
    const chatStore = useChatSessionsStore()
    chatStore.createSession('chat-plain', '知识库聊天')
    const deps = setupDeps()

    const outcome = await openSideChat('chat-plain', deps)

    expect(outcome).toEqual({ ok: false, reason: 'no-agent-session' })
    expect(deps.fork).not.toHaveBeenCalled()
    expect(deps.open).not.toHaveBeenCalled()
  })

  it('一轮都还没跑完时如实说没有上下文可借', async () => {
    seedAgentChat()
    const deps = setupDeps({ fork: vi.fn().mockResolvedValue({ success: false, reason: 'empty' }) })

    expect(await openSideChat('chat-a', deps)).toEqual({ ok: false, reason: 'empty' })
    expect(deps.open).not.toHaveBeenCalled()
  })

  it('复制炸了就不开窗口，把原文带回去打日志', async () => {
    seedAgentChat()
    const deps = setupDeps({ fork: vi.fn().mockRejectedValue(new Error('磁盘满了')) })

    expect(await openSideChat('chat-a', deps)).toEqual({
      ok: false,
      reason: 'error',
      error: '磁盘满了'
    })
    expect(deps.open).not.toHaveBeenCalled()
  })

  it('主对话没在跑时 live 是 false —— 界面据此决定要不要说「这是快照」', async () => {
    seedAgentChat()
    const deps = setupDeps({
      fork: vi.fn().mockResolvedValue({ success: true, sessionId: 'agent-side', messageCount: 3 })
    })

    const outcome = await openSideChat('chat-a', deps)

    expect(outcome.ok && outcome.context.live).toBe(false)
  })
})
