import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@renderer/utils/messageManager', () => ({
  message: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('@renderer/store/modules/globalAudio', () => ({
  useGlobalAudioStore: vi.fn(() => ({
    playAudio: vi.fn()
  }))
}))

vi.mock('../../../api/ai', () => ({
  aiAPI: {
    chat: vi.fn(),
    getFollowUpSuggestions: vi.fn(async () => [])
  }
}))

vi.mock('./agentEventDispatcher', () => ({
  unregisterAgentHandler: vi.fn(),
  isCurrentRun: vi.fn(() => true)
}))

import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { createAgentCompletionHandlers } from './agentCompletionHandlers'
import { createAgentControlHandlers } from './agentControlHandlers'
import { isCurrentRun, unregisterAgentHandler } from './agentEventDispatcher'
import { aiAPI } from '../../../api/ai'
import type { AgentModeHandlersDeps } from './agentHandlerShared'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import { createAgentStreamHandlers } from './agentStreamHandlers'

function createAgentDeps() {
  setActivePinia(createPinia())
  localStorage.clear()

  const chatStore = useChatSessionsStore()
  const chatMsgStore = useChatMessagesStore()
  const agentStreamStore = useAgentStreamStore()

  const chatA = 'chat-a'
  const chatB = 'chat-b'
  const sessionA = 'session-a'
  const sessionB = 'session-b'

  chatStore.createSession(chatA, 'assistant.agentMode.unnamedSession')
  chatStore.createSession(chatB, 'Current Chat')

  const sid = ref(chatB)
  const currentSessionId = ref(sessionB)
  const currentAgentProcess = ref<any[]>([])
  const currentAgentController = ref<{ stop: () => Promise<void> } | null>({
    stop: vi.fn(async () => undefined)
  })
  const fullConversationHistory = ref<any[]>([{ role: 'user', content: 'Current chat message' }])

  const scrollToBottomIfNeeded = vi.fn()
  const clearWikiRagState = vi.fn()
  const tabsStore = {
    updateTabTitleByPath: vi.fn()
  }
  const aiConfigStore = {
    followUpSuggestionsEnabled: false
  }
  const route = {
    path: '/dev-assistant',
    fullPath: '/dev-assistant/chat-b'
  }
  const t = (key: string) => key

  const deps = {
    sid,
    messages: computed(() => chatMsgStore.getMessages(sid.value)),
    route,
    tabsStore,
    chatStore,
    chatMsgStore,
    aiConfigStore,
    scrollToBottomIfNeeded,
    currentAgentProcess,
    currentSessionId,
    currentAgentController,
    fullConversationHistory,
    currentText: computed(() => agentStreamStore.getCurrentText(sid.value)),
    currentThinking: computed(() => agentStreamStore.getCurrentThinking(sid.value)),
    currentTypingId: computed(() => agentStreamStore.getTypingId(sid.value)),
    agentStreamStore,
    t,
    clearWikiRagState,
    getWikiRagCitations: vi.fn(() => []),
    shouldDedupNotify: vi.fn(() => false)
  }

  function startBackgroundSession(userContent: string) {
    chatMsgStore.pushUser(chatA, userContent)
    const typingId = chatMsgStore.pushAssistantTyping(chatA)
    agentStreamStore.initStream(chatA, sessionA, typingId)
    return typingId
  }

  return {
    deps,
    chatStore,
    chatMsgStore,
    agentStreamStore,
    currentAgentProcess,
    currentAgentController,
    fullConversationHistory,
    clearWikiRagState,
    tabsStore,
    chatA,
    chatB,
    sessionA,
    sessionB,
    startBackgroundSession
  }
}

describe('agent session isolation handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks 不还原实现，上一个用例设的「这条会话已经换人了」会漏到下一个
    vi.mocked(isCurrentRun).mockImplementation(() => true)
  })

  it('persists background tool calls into the stream store without mutating the current chat process log', () => {
    const ctx = createAgentDeps()
    vi.mocked(unregisterAgentHandler).mockImplementation(() => undefined)

    ctx.startBackgroundSession('Create a spaceship poster')

    const handlers = createAgentStreamHandlers(ctx.deps as any, {
      replaceLastAssistant: vi.fn()
    })

    handlers.handleAgentToolCall(null, {
      sessionId: ctx.sessionA,
      toolName: 'generate_image',
      toolCallId: 'tool-1',
      args: {
        prompt: 'Create a spaceship poster'
      }
    })

    expect(ctx.agentStreamStore.getAgentProcess(ctx.chatA)).toHaveLength(1)
    expect(ctx.currentAgentProcess.value).toEqual([])

    const messages = ctx.chatMsgStore.getMessages(ctx.chatA)
    const lastAssistant = messages[messages.length - 1]
    expect(lastAssistant.agentProcess).toHaveLength(1)
    expect(lastAssistant.status).toBe('typing')
  })

  it('stops a background session without clearing the current session controller or process log', () => {
    const ctx = createAgentDeps()
    vi.mocked(unregisterAgentHandler).mockImplementation(() => undefined)
    ctx.currentAgentProcess.value = [
      {
        type: 'step',
        data: { text: 'keep current chat log' },
        timestamp: 1
      }
    ]

    ctx.startBackgroundSession('Stop the background ship task')
    ctx.agentStreamStore.appendText(ctx.sessionA, 'Partial background output')
    ctx.agentStreamStore.flushBuffer(ctx.sessionA)

    const handlers = createAgentControlHandlers(ctx.deps as any)
    handlers.handleAgentStopped(null, { sessionId: ctx.sessionA })

    const messages = ctx.chatMsgStore.getMessages(ctx.chatA)
    const lastAssistant = messages[messages.length - 1]

    expect(lastAssistant.status).toBe('done')
    expect(String(lastAssistant.content)).toContain('Partial background output')
    expect(String(lastAssistant.content)).toContain('assistant.agentMode.stoppedByUser')
    expect(ctx.currentAgentController.value).not.toBeNull()
    expect(ctx.currentAgentProcess.value).toHaveLength(1)
    expect(ctx.agentStreamStore.getChatSidByAgentSession(ctx.sessionA)).toBeUndefined()
    expect(vi.mocked(unregisterAgentHandler)).toHaveBeenCalledWith(ctx.sessionA, undefined)
    expect(ctx.clearWikiRagState).toHaveBeenCalledWith(ctx.sessionA)
  })

  it('finalizes a background session against its own chat state instead of the currently open chat', async () => {
    const ctx = createAgentDeps()
    vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {
      ctx.agentStreamStore.cleanupStream(sessionId)
    })
    ctx.currentAgentProcess.value = [
      {
        type: 'step',
        data: { text: 'current chat process' },
        timestamp: 1
      }
    ]

    ctx.startBackgroundSession('Build me a frigate blueprint')
    ctx.chatStore.setAgentHistory(ctx.chatA, [
      { role: 'user', content: 'Build me a frigate blueprint' }
    ])
    ctx.agentStreamStore.appendText(ctx.sessionA, 'Background final answer')
    ctx.agentStreamStore.flushBuffer(ctx.sessionA)
    ctx.agentStreamStore.addAgentProcess(ctx.sessionA, {
      type: 'step',
      data: {
        step: 1,
        maxSteps: 1
      },
      timestamp: 2
    } as any)

    const handlers = createAgentCompletionHandlers(ctx.deps as any, {
      flushDeltaBuffer: vi.fn()
    })

    const finalText = await handlers.handleAgentDone(null, { sessionId: ctx.sessionA })

    const messages = ctx.chatMsgStore.getMessages(ctx.chatA)
    const lastAssistant = messages[messages.length - 1]

    expect(lastAssistant.content).toBe('Background final answer')
    expect(lastAssistant.status).toBe('done')
    expect(finalText).toBe('Background final answer')
    // 正文和过程记在同一根时间线上（界面要按发生顺序交替显示），
    // 所以这里是「一段正文 + 一条 step」两条
    expect(lastAssistant.agentProcess).toHaveLength(2)
    expect(lastAssistant.agentProcess?.map((item) => item.type)).toEqual(['text', 'step'])
    expect(ctx.chatStore.getAgentHistory(ctx.chatA)).toEqual([
      { role: 'user', content: 'Build me a frigate blueprint' },
      { role: 'assistant', content: 'Background final answer' }
    ])
    expect(ctx.chatStore.getAgentCurrentText(ctx.chatA)).toBe('Background final answer')
    expect(ctx.fullConversationHistory.value).toEqual([
      { role: 'user', content: 'Current chat message' }
    ])
    expect(ctx.currentAgentController.value).not.toBeNull()
    expect(ctx.currentAgentProcess.value).toHaveLength(1)
    expect(ctx.tabsStore.updateTabTitleByPath).not.toHaveBeenCalled()
    expect(vi.mocked(unregisterAgentHandler)).toHaveBeenCalledWith(ctx.sessionA, undefined)
    expect(ctx.agentStreamStore.getChatSidByAgentSession(ctx.sessionA)).toBeUndefined()
    expect(ctx.clearWikiRagState).toHaveBeenCalledWith(ctx.sessionA)
  })

  it('keeps prior user history when done only returns assistant response messages', async () => {
    const ctx = createAgentDeps()
    vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {
      ctx.agentStreamStore.cleanupStream(sessionId)
    })

    ctx.startBackgroundSession('Are you Gemini?')
    ctx.chatStore.setAgentHistory(ctx.chatA, [{ role: 'user', content: 'Are you Gemini?' }])
    ctx.agentStreamStore.appendText(ctx.sessionA, 'No, I am powered by UEBOX.AI.')
    ctx.agentStreamStore.flushBuffer(ctx.sessionA)

    const handlers = createAgentCompletionHandlers(ctx.deps as any, {
      flushDeltaBuffer: vi.fn()
    })

    await handlers.handleAgentDone(null, {
      sessionId: ctx.sessionA,
      messages: [{ role: 'assistant', content: 'No, I am powered by UEBOX.AI.' }]
    })

    expect(ctx.chatStore.getAgentHistory(ctx.chatA)).toEqual([
      { role: 'user', content: 'Are you Gemini?' },
      { role: 'assistant', content: 'No, I am powered by UEBOX.AI.' }
    ])
  })

  it('finalizes the tracked typing message even if a newer assistant message exists', async () => {
    const ctx = createAgentDeps()
    vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {
      ctx.agentStreamStore.cleanupStream(sessionId)
    })

    const typingId = ctx.startBackgroundSession('Explain GAS for beginners')
    ctx.chatMsgStore.pushAssistant(ctx.chatA, 'A stale assistant message')
    ctx.agentStreamStore.appendText(ctx.sessionA, 'The real final answer')
    ctx.agentStreamStore.flushBuffer(ctx.sessionA)

    const handlers = createAgentCompletionHandlers(ctx.deps as any, {
      flushDeltaBuffer: vi.fn()
    })

    await handlers.handleAgentDone(null, { sessionId: ctx.sessionA })

    const messages = ctx.chatMsgStore.getMessages(ctx.chatA)
    const trackedAssistant = messages.find((message) => message.id === typingId)

    expect(trackedAssistant?.content).toBe('The real final answer')
    expect(trackedAssistant?.status).toBe('done')
    expect(
      messages.some((message) => message.role === 'assistant' && message.status === 'typing')
    ).toBe(false)
  })

  /**
   * 同一条 agent 会话连着跑两轮 —— 语音把排队的第二件活派回同一条会话就是这样。
   *
   * 真机上的表现：第二件活的界面一动不动，看着像断了，后台却还在改工程。
   * 成因是这份收尾**是异步的**（正文空时要让模型补一句反馈），走到最后那步时
   * 第二轮已经开跑，它却照着「这条会话归我」把处理器和流式状态一起拆了。
   */
  it('上一轮迟到的收尾不拆下一轮的摊子', async () => {
    const ctx = createAgentDeps()
    vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {
      ctx.agentStreamStore.cleanupStream(sessionId)
    })
    // 这条会话现在归第二轮（runId 2）管
    vi.mocked(isCurrentRun).mockImplementation(
      (_sessionId: string, runId?: number) => runId === undefined || runId === 2
    )

    ctx.startBackgroundSession('把主灯调暗')
    ctx.agentStreamStore.appendText(ctx.sessionA, '灯调好了')
    ctx.agentStreamStore.flushBuffer(ctx.sessionA)

    const handlers = createAgentCompletionHandlers(ctx.deps as unknown as AgentModeHandlersDeps, {
      flushDeltaBuffer: vi.fn()
    })

    await handlers.handleAgentDone(null, { sessionId: ctx.sessionA, runId: 1 })

    expect(vi.mocked(unregisterAgentHandler)).not.toHaveBeenCalled()
    expect(ctx.clearWikiRagState).not.toHaveBeenCalled()
    // 第二轮的流式状态还在，它的事件才有地方落
    expect(ctx.agentStreamStore.getChatSidByAgentSession(ctx.sessionA)).toBe(ctx.chatA)
  })

  /**
   * 收尾等模型补反馈的那几秒里，下一轮已经在往同一条时间线上写。
   * 去 store 里现取的话，取到的是**下一轮**的过程日志，会被写进上一轮的气泡里。
   */
  it('收尾写进气泡的是这一轮的过程日志，不是等回来时 store 里那份', async () => {
    const ctx = createAgentDeps()
    vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {
      ctx.agentStreamStore.cleanupStream(sessionId)
    })

    const toolCall = (name: string, timestamp: number): AgentProcessItem => ({
      type: 'tool-call',
      data: { function: { name, arguments: '{}' } },
      timestamp
    })

    ctx.startBackgroundSession('编译蓝图')
    ctx.agentStreamStore.addAgentProcess(ctx.sessionA, toolCall('blueprint_compile', 1))

    // 补反馈那一步：模型还没答上来，下一轮已经开跑并写进了同一条时间线
    vi.mocked(aiAPI.chat).mockImplementation(async () => {
      ctx.agentStreamStore.addAgentProcess(ctx.sessionA, toolCall('level_light_set', 2))
      return { id: 'r1', model: 'gpt-test', content: '编译完成' }
    })

    const handlers = createAgentCompletionHandlers(ctx.deps as unknown as AgentModeHandlersDeps, {
      flushDeltaBuffer: vi.fn()
    })

    await handlers.handleAgentDone(null, {
      sessionId: ctx.sessionA,
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', function: { name: 'blueprint_compile', arguments: '{}' } }]
        }
      ]
    })

    const lastAssistant = ctx.chatMsgStore.getMessages(ctx.chatA).at(-1)
    expect(
      lastAssistant?.agentProcess?.map((item: AgentProcessItem) => item.data?.function?.name)
    ).toEqual(['blueprint_compile'])
  })
})
