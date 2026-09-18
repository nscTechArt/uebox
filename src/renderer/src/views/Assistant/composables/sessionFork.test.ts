import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { forkSession, type SessionForkDeps } from './sessionFork'

/**
 * 会话分支要复制的不是一份历史，是两份：内核 transcript（主进程，这里用
 * 假的 forkTranscript 代表）和界面消息（chatMessages store）。
 * 这些测试验证两边对得上、失败时不留半个分支。
 */
function setupDeps(overrides: Partial<SessionForkDeps> = {}): SessionForkDeps {
  const chatStore = useChatSessionsStore()
  const chatMsgStore = useChatMessagesStore()
  const navigate = vi.fn()

  return {
    chatStore,
    chatMsgStore,
    forkTranscript: vi.fn().mockResolvedValue({ success: true, sessionId: 'agent-branch' }),
    newChatSid: () => 'chat-branch',
    branchTitle: (title: string) => `${title}（分支）`,
    navigate,
    ...overrides
  }
}

/** 一条跑过 Agent 的会话：有 agentSessionId、有消息、有工程归属 */
function seedAgentChat(): void {
  const chatStore = useChatSessionsStore()
  const chatMsgStore = useChatMessagesStore()

  chatStore.createSession('chat-a', '蓝图怎么做')
  chatStore.setAgentSessionId('chat-a', 'agent-a')
  chatStore.setProject('chat-a', { projectName: 'ShooterGame', projectPath: 'D:/UE/Shooter' })
  chatStore.setContextUsage('chat-a', { tokens: 1200, contextWindow: 128000 })

  chatMsgStore.pushUser('chat-a', '蓝图怎么做')
  const typingId = chatMsgStore.pushAssistantTyping('chat-a')
  chatMsgStore.replaceTyping('chat-a', typingId, '可以用接口做', true, {
    agentProcess: [{ type: 'tool-call', data: { toolName: 'ue.bp.get' }, timestamp: 0 }]
  })
}

/** 再追一轮问答，返回这一轮那条回复的 id（分叉点用） */
function appendTurn(question: string, answer: string): string {
  const chatMsgStore = useChatMessagesStore()
  chatMsgStore.pushUser('chat-a', question)
  const typingId = chatMsgStore.pushAssistantTyping('chat-a')
  chatMsgStore.replaceTyping('chat-a', typingId, answer, true)
  return typingId
}

describe('forkSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('复制两份历史并切换到新会话', async () => {
    seedAgentChat()
    const deps = setupDeps()

    const outcome = await forkSession('chat-a', deps)

    expect(outcome).toEqual({ ok: true, chatSid: 'chat-branch', agentSessionId: 'agent-branch' })

    // 新会话带着分支标题、原工程归属和新的内核会话身份
    const created = deps.chatStore.sessionById('chat-branch')
    expect(created?.title).toBe('蓝图怎么做（分支）')
    expect(deps.chatStore.getProject('chat-branch')).toMatchObject({ projectName: 'ShooterGame' })
    expect(deps.chatStore.getAgentSessionId('chat-branch')).toBe('agent-branch')
    expect(deps.chatStore.getContextUsage('chat-branch')).toEqual({
      tokens: 1200,
      contextWindow: 128000
    })

    // 界面消息整份跟过去
    expect(deps.chatMsgStore.getMessages('chat-branch').map((m) => m.role)).toEqual([
      'user',
      'assistant'
    ])
    expect(deps.navigate).toHaveBeenCalledWith('chat-branch')
  })

  it('分支里的消息是深拷贝 —— 之后改一边不影响另一边', async () => {
    seedAgentChat()
    const deps = setupDeps()

    await forkSession('chat-a', deps)
    deps.chatMsgStore.getMessages('chat-branch')[1].content = '分支里改掉的回复'

    expect(deps.chatMsgStore.getMessages('chat-a')[1].content).not.toBe('分支里改掉的回复')
  })

  it('源会话原地不动', async () => {
    seedAgentChat()
    const deps = setupDeps()
    const before = deps.chatStore.getAgentSessionId('chat-a')

    await forkSession('chat-a', deps)

    expect(deps.chatStore.getAgentSessionId('chat-a')).toBe(before)
    expect(deps.chatStore.sessions.filter((s) => s.id === 'chat-a')).toHaveLength(1)
    expect(deps.chatMsgStore.getMessages('chat-a')).toHaveLength(2)
  })

  it('没有 agentSessionId 的会话（普通对话、知识库聊天）拒绝分支', async () => {
    const chatStore = useChatSessionsStore()
    chatStore.createSession('chat-plain', '普通会话')
    const deps = setupDeps()

    const outcome = await forkSession('chat-plain', deps)

    expect(outcome).toEqual({ ok: false, reason: 'no-agent-session' })
    expect(deps.forkTranscript).not.toHaveBeenCalled()
    expect(deps.chatStore.sessions).toHaveLength(1)
    expect(deps.navigate).not.toHaveBeenCalled()
  })

  it('内核分支失败（正在跑 / 没有 transcript）时不建界面会话', async () => {
    seedAgentChat()

    for (const reason of ['busy', 'missing'] as const) {
      const deps = setupDeps({
        forkTranscript: vi.fn().mockResolvedValue({ success: false, reason })
      })

      const outcome = await forkSession('chat-a', deps)

      expect(outcome).toEqual({ ok: false, reason })
      expect(deps.chatStore.sessions).toHaveLength(1)
      expect(deps.navigate).not.toHaveBeenCalled()
    }
  })

  it('内核分支抛错时原样带出，不建界面会话', async () => {
    seedAgentChat()
    const deps = setupDeps({
      forkTranscript: vi.fn().mockRejectedValue(new Error('disk full'))
    })

    const outcome = await forkSession('chat-a', deps)

    expect(outcome).toEqual({ ok: false, reason: 'error', error: 'disk full' })
    expect(deps.chatStore.sessions).toHaveLength(1)
  })
})

/**
 * 「从这条往后砍掉」。两份历史（界面消息、内核 transcript）要截在同一处，
 * 只截一边的话用户看到的和模型记得的对不上 —— 那就等于没分支。
 */
describe('forkSession 的分叉点', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('从中间那条回复分支：它之后的问答不跟过来', async () => {
    seedAgentChat()
    const cutId = appendTurn('那用组件呢', '组件也行')
    appendTurn('第三轮', '第三答')
    const deps = setupDeps()

    await forkSession('chat-a', deps, cutId)

    expect(deps.chatMsgStore.getMessages('chat-branch').map((m) => m.content)).toEqual([
      '蓝图怎么做',
      '可以用接口做',
      '那用组件呢',
      '组件也行'
    ])
    // 内核那边按用户回合数截在同一处
    expect(deps.forkTranscript).toHaveBeenCalledWith('agent-a', 2)
    // 源会话原地不动
    expect(deps.chatMsgStore.getMessages('chat-a')).toHaveLength(6)
  })

  it('从最后一条分支：不用截，整份复制', async () => {
    seedAgentChat()
    const lastId = appendTurn('那用组件呢', '组件也行')
    const deps = setupDeps()

    await forkSession('chat-a', deps, lastId)

    expect(deps.forkTranscript).toHaveBeenCalledWith('agent-a', undefined)
    expect(deps.chatMsgStore.getMessages('chat-branch')).toHaveLength(4)
  })

  it('id 对不上任何一条消息时退回整份复制，而不是报错', async () => {
    seedAgentChat()
    const deps = setupDeps()

    const outcome = await forkSession('chat-a', deps, '已经被删掉的消息')

    expect(outcome.ok).toBe(true)
    expect(deps.forkTranscript).toHaveBeenCalledWith('agent-a', undefined)
    expect(deps.chatMsgStore.getMessages('chat-branch')).toHaveLength(2)
  })

  it('agentHistory 跟着截在同一处，上下文用量不抄源会话的', async () => {
    seedAgentChat()
    const cutId = appendTurn('那用组件呢', '组件也行')
    appendTurn('第三轮', '第三答')
    const chatStore = useChatSessionsStore()
    chatStore.setAgentHistory('chat-a', [
      { role: 'user', content: '蓝图怎么做' },
      { role: 'assistant', content: '可以用接口做' },
      { role: 'user', content: '那用组件呢' },
      { role: 'assistant', content: '组件也行' },
      { role: 'user', content: '第三轮' },
      { role: 'assistant', content: '第三答' }
    ])
    const deps = setupDeps()

    await forkSession('chat-a', deps, cutId)

    expect(deps.chatStore.getAgentHistory('chat-branch')).toHaveLength(4)
    // 截过的分支上下文更短，抄源会话那个数字只会显示一个虚高的百分比
    expect(deps.chatStore.getContextUsage('chat-branch')).toBeFalsy()
  })
})
