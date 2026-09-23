import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { usePendingApprovalsStore } from '@renderer/store/modules/pendingApprovals'
import type { AgentTurnUsage } from '@core/shared/agentUsage'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'
type Dispatcher = typeof import('./agentEventDispatcher')

/**
 * 分发器是模块级单例（`initialized` 标志 + Store 实例缓存）。
 *
 * 直接 import 的话第二个用例开始 `initAgentEventDispatcher()` 会 no-op，
 * 新装的事件桩一个订阅都收不到；而缓存住的 Store 还指向上一个 pinia。
 * 所以每个用例都重置模块重新 import。
 */
async function freshDispatcher(): Promise<Dispatcher> {
  vi.resetModules()
  return import('./agentEventDispatcher')
}

/**
 * 假的 `window.api.on`：把订阅记下来，让测试能手动投事件。
 *
 * 注意订阅的是 `window.api.on` 而不是 `window.electron.ipcRenderer.on` ——
 * 两者白名单不同，用错的话真机上整个订阅链路会抛异常挂掉，
 * 而且界面只表现为「收不到任何事件」，没有别的线索。这里也一并锁住。
 */
function installApiMock(): {
  emit: (channel: string, data: unknown) => void
  channels: () => string[]
  replyQuestion: ReturnType<typeof vi.fn>
  cancelSteer: ReturnType<typeof vi.fn>
} {
  const listeners = new Map<string, Array<(data: unknown) => void>>()

  const on = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    const list = listeners.get(channel) ?? []
    list.push(listener as (data: unknown) => void)
    listeners.set(channel, list)
  })

  // 反问用户那条路会往回发（answerAgentQuestion / 落不了地时的兜底取消），
  // 没有这个桩它会在 `window.api.agentV3` 上炸
  const replyQuestion = vi.fn()
  // 撤回插话那条路同样往回发；默认按「撤掉了」回，用例可以自己改
  const cancelSteer = vi.fn(async () => ({ success: true }))

  window.api = {
    on,
    off: vi.fn(),
    agentV3: { replyQuestion, cancelSteer }
  } as unknown as typeof window.api
  // 用错通道的话，这个会被调用
  window.electron = {
    ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), invoke: vi.fn() }
  } as unknown as typeof window.electron

  return {
    emit: (channel, data) => {
      for (const listener of listeners.get(channel) ?? []) listener(data)
    },
    channels: () => [...listeners.keys()],
    replyQuestion,
    cancelSteer
  }
}

const SID = 'session-a'
const CHAT = 'chat-a'

describe('agentEventDispatcher', () => {
  let bus: ReturnType<typeof installApiMock>
  let registerAgentHandler: Dispatcher['registerAgentHandler']
  let unregisterAgentHandler: Dispatcher['unregisterAgentHandler']

  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    bus = installApiMock()

    const dispatcher = await freshDispatcher()
    registerAgentHandler = dispatcher.registerAgentHandler
    unregisterAgentHandler = dispatcher.unregisterAgentHandler
    dispatcher.initAgentEventDispatcher()
  })

  /**
   * 每个用例都换一份新的模块实例，但**节流重画是 120ms 之后才落地的真定时器** ——
   * 用例结束时它还挂在事件循环里，会在后面某个用例跑到一半时醒来。
   *
   * 醒来时它属于上一份模块实例，那份实例的 Store 缓存往往还是空的，
   * `useChatMessagesStore()` 于是取到**当前**这个 pinia，把上一个用例的正文/推理
   * 写进这一个用例的气泡里。表现就是这一组用例按执行顺序随机互相打架：
   * 单跑全绿，整文件跑就轮流挂一条。
   *
   * 收一次尾把它撤掉（`unregisterAgentHandler` 里的 `cancelRepaint`），
   * 和真机上每一轮结束走的是同一条路。
   */
  afterEach(() => {
    unregisterAgentHandler(SID)
    vi.useRealTimers()
  })

  it('只订阅 agent-v3:* —— V2 的 agent:* 契约已经删掉了', () => {
    expect(bus.channels().length).toBeGreaterThan(0)
    expect(bus.channels().every((c) => c.startsWith('agent-v3:'))).toBe(true)
    expect(window.electron.ipcRenderer.on).not.toHaveBeenCalled()
  })

  describe('文本与推理', () => {
    beforeEach(() => {
      const chatMsgStore = useChatMessagesStore()
      const typingId = chatMsgStore.pushAssistantTyping(CHAT)
      useAgentStreamStore().initStream(CHAT, SID, typingId)
    })

    it('文本增量写进 Store', () => {
      bus.emit('agent-v3:text', { sessionId: SID, text: '已创建材质' })
      const store = useAgentStreamStore()
      store.flushBuffer(SID)
      expect(store.getStreamByAgentSession(SID)?.currentText).toBe('已创建材质')
    })

    // V2 没有独立的推理事件，只能靠 <think> 标签从正文里切
    it('推理内容进 thinking 区，不混进正文', () => {
      bus.emit('agent-v3:thinking', { sessionId: SID, text: '先看看图表' })
      bus.emit('agent-v3:text', { sessionId: SID, text: '正文' })

      const state = useAgentStreamStore().getStreamByAgentSession(SID)
      expect(state?.currentThinking).toBe('先看看图表')
      expect(state?.currentText).not.toContain('先看看图表')
    })

    it('没有 sessionId 的事件直接丢弃，不抛异常', () => {
      expect(() => bus.emit('agent-v3:text', { text: '孤儿事件' })).not.toThrow()
    })

    /**
     * 增量只写进 Store 是不够的 —— 屏幕上那条气泡读的是消息，不是 Store。
     *
     * 原来这一步没人做：正文在 Store 里越积越多，界面上一直是「思考中」，
     * 要等下一个工具调用或者整轮结束才一次性冒出来。模型想两分钟，用户就
     * 盯着一个转圈的点等两分钟，不知道它在干什么、有没有卡死。
     */
    it('正文增量会刷进正在打字的那条气泡', () => {
      vi.useFakeTimers()
      try {
        bus.emit('agent-v3:text', {
          sessionId: SID,
          text: '正在读取工程里的资产清单，稍等一下。'
        })
        vi.advanceTimersByTime(200)

        // 末尾几个字还压在 `<think>` 标签的前瞻缓冲里，等下一段增量或收尾时补上
        const content = String(useChatMessagesStore().getMessages(CHAT).at(-1)?.content ?? '')
        expect(content).toContain('正在读取工程里的资产')
      } finally {
        vi.useRealTimers()
      }
    })

    it('推理增量也会刷进气泡，且不把正文占位抹成空白', () => {
      vi.useFakeTimers()
      try {
        const before = String(useChatMessagesStore().getMessages(CHAT).at(-1)?.content ?? '')
        bus.emit('agent-v3:thinking', { sessionId: SID, text: '先确认工程连上了没有' })
        vi.advanceTimersByTime(200)

        const last = useChatMessagesStore().getMessages(CHAT).at(-1)
        expect(last?.thinking).toBe('先确认工程连上了没有')
        expect(String(last?.content ?? '')).toBe(before)
      } finally {
        vi.useRealTimers()
      }
    })

    // 一秒钟几十条增量，每条都重画会把主线程占满
    it('连续增量只重画一次，不是每条一次', () => {
      vi.useFakeTimers()
      try {
        const chatMsgStore = useChatMessagesStore()
        const spy = vi.spyOn(chatMsgStore, 'replaceTyping')

        for (let i = 0; i < 20; i++) {
          bus.emit('agent-v3:text', { sessionId: SID, text: `第 ${i} 段增量文本内容。` })
        }
        vi.advanceTimersByTime(200)

        expect(spy).toHaveBeenCalledTimes(1)
        spy.mockRestore()
      } finally {
        vi.useRealTimers()
      }
    })

    it('每批流式重画只请求一次当前会话滚动', () => {
      vi.useFakeTimers()
      try {
        const onStreamPaint = vi.fn()
        registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStreamPaint })

        for (let i = 0; i < 20; i++) {
          bus.emit('agent-v3:text', { sessionId: SID, text: `第 ${i} 段增量文本内容。` })
        }
        vi.advanceTimersByTime(200)

        expect(onStreamPaint).toHaveBeenCalledTimes(1)
        expect(onStreamPaint).toHaveBeenCalledWith(CHAT)
      } finally {
        vi.useRealTimers()
      }
    })

    it('纯思考增量只在思考栏首次出现时请求滚动', () => {
      vi.useFakeTimers()
      try {
        const onStreamPaint = vi.fn()
        registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStreamPaint })

        bus.emit('agent-v3:thinking', { sessionId: SID, text: '先分析问题。' })
        vi.advanceTimersByTime(200)
        expect(onStreamPaint).toHaveBeenCalledTimes(1)

        bus.emit('agent-v3:thinking', { sessionId: SID, text: '再检查工程。' })
        vi.advanceTimersByTime(200)
        expect(onStreamPaint).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('工具事件', () => {
    it('工具调用按界面认得的 OpenAI 形状派发', () => {
      // 过渡层发的是 { toolCallId, toolName, args }，而界面的 getToolName()
      // 只认 function.name 或 name —— 于是每条工具调用的名字都是空的。
      const onToolCall = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolCall })

      bus.emit('agent-v3:tool-call', {
        sessionId: SID,
        toolCallId: 'c1',
        toolName: 'material_create',
        args: { material_name: 'M_Test' }
      })

      expect(onToolCall).toHaveBeenCalledWith({
        sessionId: SID,
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'material_create',
              arguments: JSON.stringify({ material_name: 'M_Test' })
            }
          }
        ]
      })
      unregisterAgentHandler(SID)
    })

    it('工具结果优先给结构化 details，没有才退回文本', () => {
      const onToolResult = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolResult })

      bus.emit('agent-v3:tool-result', {
        sessionId: SID,
        toolCallId: 'call-a',
        toolName: 'material_create',
        isError: false,
        text: '已创建',
        details: { path: '/Game/M_Test' }
      })
      expect(onToolResult).toHaveBeenLastCalledWith(
        // toolCallId 一路带到界面：并行的子任务靠它把结果对回发起它的那一路
        expect.objectContaining({ toolCallId: 'call-a', result: { path: '/Game/M_Test' } })
      )

      bus.emit('agent-v3:tool-result', {
        sessionId: SID,
        toolName: 'x',
        isError: true,
        text: '失败了',
        details: {}
      })
      expect(onToolResult).toHaveBeenLastCalledWith(
        expect.objectContaining({ result: '失败了', isError: true })
      )
      unregisterAgentHandler(SID)
    })
  })

  describe('会话隔离', () => {
    // 这条职责以前散在 executeAgent 里，且和分发器的过滤规则不一致。
    // 现在只有这一处，测试也钉在这一处。
    it('别的会话的事件不会派发给本会话的处理器', () => {
      const onToolCall = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolCall })

      bus.emit('agent-v3:tool-call', {
        sessionId: 'session-b',
        toolCallId: 'c1',
        toolName: 'x',
        args: {}
      })

      expect(onToolCall).not.toHaveBeenCalled()
      unregisterAgentHandler(SID)
    })

    it('注销后不再收到事件', () => {
      const onToolCall = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolCall })
      unregisterAgentHandler(SID)

      bus.emit('agent-v3:tool-call', {
        sessionId: SID,
        toolCallId: 'c1',
        toolName: 'x',
        args: {}
      })
      expect(onToolCall).not.toHaveBeenCalled()
    })
  })

  /**
   * 同一条 agent 会话连着跑两轮：语音把排队的第二件活派回同一条会话就是这样。
   *
   * 真机上的表现：第二件活的界面一动不动（气泡像是断了或做完了），后台却在改工程。
   * 成因是第一轮的收尾**是异步的**（要等工具风险表，正文空时还要让模型补一句反馈），
   * 走到「注销处理器」时第二轮已经开跑，注销掉的是第二轮那份。
   */
  describe('连着跑两轮（同一条会话）', () => {
    it('上一轮迟到的收尾不拆新那一轮的处理器和流式状态', () => {
      const chatMsgStore = useChatMessagesStore()
      const streamStore = useAgentStreamStore()

      const firstRun = registerAgentHandler({ sessionId: SID, chatSid: CHAT })
      streamStore.initStream(CHAT, SID, chatMsgStore.pushAssistantTyping(CHAT))

      // 第一轮结束、第二轮开跑（第一轮的收尾还卡在补反馈那一步）
      const onToolCall = vi.fn()
      const secondRun = registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolCall })
      streamStore.initStream(CHAT, SID, chatMsgStore.pushAssistantTyping(CHAT))
      expect(secondRun).not.toBe(firstRun)

      unregisterAgentHandler(SID, firstRun)

      bus.emit('agent-v3:tool-call', {
        sessionId: SID,
        toolCallId: 'c1',
        toolName: 'material_create',
        args: {}
      })
      expect(onToolCall).toHaveBeenCalled()
      expect(streamStore.getChatSidByAgentSession(SID)).toBe(CHAT)

      // 自己那一轮的收尾照拆不误
      unregisterAgentHandler(SID, secondRun)
      expect(streamStore.getChatSidByAgentSession(SID)).toBeUndefined()
    })

    // 界面上手动停、页面卸载这类收尾和具体某一轮无关，不带号，照旧一律拆掉
    it('不带轮次号的注销照旧生效', () => {
      registerAgentHandler({ sessionId: SID, chatSid: CHAT })
      useAgentStreamStore().initStream(CHAT, SID, useChatMessagesStore().pushAssistantTyping(CHAT))

      unregisterAgentHandler(SID)

      expect(useAgentStreamStore().getChatSidByAgentSession(SID)).toBeUndefined()
    })
  })

  describe('轮次计数', () => {
    it('step 序号由界面自己累加 —— V3 的事件不带序号', () => {
      const onStep = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStep })

      bus.emit('agent-v3:step', { sessionId: SID })
      bus.emit('agent-v3:step', { sessionId: SID })

      expect(onStep).toHaveBeenNthCalledWith(1, expect.objectContaining({ step: 1 }))
      expect(onStep).toHaveBeenNthCalledWith(2, expect.objectContaining({ step: 2 }))
      /**
       * **不带 maxSteps。** V3 不设步数上限，编一个分母出来
       * （原来是常量 999）会让界面显示「第 1/999 步」这种假进度。
       */
      expect(onStep).toHaveBeenLastCalledWith({ sessionId: SID, step: 2 })
      unregisterAgentHandler(SID)
    })

    it('新会话从 1 重新数', () => {
      const onStep = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStep })
      bus.emit('agent-v3:step', { sessionId: SID })
      unregisterAgentHandler(SID)

      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStep })
      bus.emit('agent-v3:step', { sessionId: SID })
      expect(onStep).toHaveBeenLastCalledWith(expect.objectContaining({ step: 1 }))
      unregisterAgentHandler(SID)
    })
  })

  describe('结束', () => {
    beforeEach(() => {
      const chatMsgStore = useChatMessagesStore()
      chatMsgStore.pushUser(CHAT, '干活')
      const typingId = chatMsgStore.pushAssistantTyping(CHAT)
      useAgentStreamStore().initStream(CHAT, SID, typingId)
    })

    it('done 收尾并回调', () => {
      const onDone = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onDone })

      bus.emit('agent-v3:text', { sessionId: SID, text: '做完了' })
      bus.emit('agent-v3:done', { sessionId: SID })

      expect(onDone).toHaveBeenCalled()
      expect(useAgentStreamStore().isStreaming(CHAT)).toBe(false)
      const last = useChatMessagesStore().getMessages(CHAT).at(-1)
      expect(last?.content).toBe('做完了')
    })

    // 用户按停止走 stopped 而不是 error —— 点了停止反被弹报错很莫名其妙
    it('stopped 走停止回调，不走错误回调', () => {
      const onStopped = vi.fn()
      const onError = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStopped, onError })

      bus.emit('agent-v3:stopped', { sessionId: SID })

      expect(onStopped).toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      expect(useAgentStreamStore().isStreaming(CHAT)).toBe(false)
    })

    it('error 把原因交给回调', () => {
      const onError = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onError })

      bus.emit('agent-v3:error', { sessionId: SID, message: '模型未配置' })
      expect(onError).toHaveBeenCalledWith('模型未配置', expect.anything())
    })

    /**
     * 状态码必须一路带到处理器。
     *
     * 处理器那边整套「401 说什么、429 说什么、哪些错不该挂『接着跑』」的判断
     * 全靠这几个字段（`agentControlHandlers.getErrorInfo`）。分发器少传就等于
     * 那套判断不存在 —— 用户看到的是
     * `错误: 401: {"error":{"message":"Incorrect API key…"}}`，
     * 下面还挂着一个点一次报一次的「接着跑」。
     */
    it('error 把状态码和错误码一起交给回调', () => {
      const onError = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onError })

      bus.emit('agent-v3:error', {
        sessionId: SID,
        message: '401: {"error":{"message":"Incorrect API key","code":"invalid_api_key"}}',
        statusCode: 401,
        code: 'invalid_api_key',
        detail: 'Incorrect API key'
      })

      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('401'),
        expect.objectContaining({
          statusCode: 401,
          code: 'invalid_api_key',
          detail: 'Incorrect API key'
        })
      )
    })

    it('套餐错误的 planError 也交给回调；没有时不凭空加上', () => {
      const onError = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onError })

      bus.emit('agent-v3:error', {
        sessionId: SID,
        message: '402 {"error":{"code":"quota_exhausted"}}',
        statusCode: 402,
        code: 'quota_exhausted',
        planError: 'quota_exhausted'
      })
      expect(onError).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ planError: 'quota_exhausted' })
      )

      bus.emit('agent-v3:error', { sessionId: SID, message: 'x', statusCode: 402 })
      expect(onError.mock.lastCall![1]).not.toHaveProperty('planError')
    })

    /**
     * 刷新后重连、而且这个对话没开着的那条路径。
     *
     * 消息里停在刷新前的半截，流式状态是「半截 + 刷新后新说的」。收尾时要是
     * 无条件用消息里那份，刷新之后模型说的每一句都会被扔掉。
     */
    it('收尾取多的那份：刷新后接着生成的正文不会被旧的半截盖掉', () => {
      const chatMsgStore = useChatMessagesStore()
      const streamStore = useAgentStreamStore()
      const typingId = chatMsgStore.getMessages(CHAT).at(-1)!.id

      chatMsgStore.replaceTyping(CHAT, typingId, '刷新前说了一半', false)
      streamStore.initStream(CHAT, SID, typingId, { text: '刷新前说了一半' })

      bus.emit('agent-v3:text', { sessionId: SID, text: '，刷新后接着说完' })
      bus.emit('agent-v3:done', { sessionId: SID })

      expect(chatMsgStore.getMessages(CHAT).at(-1)?.content).toBe('刷新前说了一半，刷新后接着说完')
    })
  })

  describe('V3 新增的过程提示', () => {
    beforeEach(() => {
      const typingId = useChatMessagesStore().pushAssistantTyping(CHAT)
      useAgentStreamStore().initStream(CHAT, SID, typingId)
    })

    it.each([false, true])('复核提示在完整回复之后显示（前台处理器：%s）', (foreground) => {
      const store = useAgentStreamStore()
      if (foreground) {
        registerAgentHandler({
          sessionId: SID,
          chatSid: CHAT,
          onNotifyUsers: (data) => {
            store.addAgentProcess(SID, {
              type: 'notify-users',
              data: { message: data.message },
              timestamp: Date.now()
            })
          }
        })
      }
      const reply = '检查已完成，没有修改任何工程。'
      bus.emit('agent-v3:text', { sessionId: SID, text: reply })
      bus.emit('agent-v3:goal', { sessionId: SID, message: '正在复核', level: 'info' })
      bus.emit('agent-v3:done', { sessionId: SID })
      expect(store.getAgentProcess(CHAT)).toMatchObject([
        { type: 'text', data: { text: reply } },
        { type: 'notify-users', data: { message: '正在复核' } }
      ])
      expect(store.getAgentProcess(CHAT)).toHaveLength(2)
    })

    // 压缩要停几秒，不说一声用户会以为卡住了
    it('压缩时给出提示', () => {
      const onNotifyUsers = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })

      bus.emit('agent-v3:compacting', { sessionId: SID })

      expect(onNotifyUsers).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('压缩') })
      )
      unregisterAgentHandler(SID)
    })

    it('工具进度带上工具名', () => {
      const onNotifyUsers = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })

      bus.emit('agent-v3:tool-progress', {
        sessionId: SID,
        toolName: 'asset_import',
        partial: { content: [{ type: 'text', text: '12/50' }] }
      })

      expect(onNotifyUsers).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'asset_import：12/50' })
      )
      unregisterAgentHandler(SID)
    })

    /**
     * `task` 是子 agent 工具，它推的进度是**另一个 agent** 在干活。
     * 直接显示 `task：…` 用户不知道那是什么。
     */
    it('子 agent 的进度说成「子任务」', () => {
      const onNotifyUsers = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })

      bus.emit('agent-v3:tool-progress', {
        sessionId: SID,
        toolName: 'task',
        partial: { content: [{ type: 'text', text: '调用 material_get_graph' }] }
      })

      expect(onNotifyUsers).toHaveBeenCalledWith(
        expect.objectContaining({ message: '子任务：调用 material_get_graph' })
      )
      unregisterAgentHandler(SID)
    })

    /**
     * 并行的几路子任务进度文本长得一模一样，界面靠 `toolCallId` 才分得清
     * 谁在说话（见 `agentSubtasks.ts`）。丢了它，两路会并成一条。
     */
    it('工具进度带上是哪一次调用', () => {
      const onNotifyUsers = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })

      bus.emit('agent-v3:tool-progress', {
        sessionId: SID,
        toolCallId: 'call-b',
        toolName: 'task',
        partial: { content: [{ type: 'text', text: '调用 ue_get_actor' }] }
      })

      expect(onNotifyUsers).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'call-b', toolName: 'task' })
      )
      unregisterAgentHandler(SID)
    })

    it('进度没有可显示文本时不发通知', () => {
      const onNotifyUsers = vi.fn()
      registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })

      bus.emit('agent-v3:tool-progress', { sessionId: SID, toolName: 'x', partial: {} })
      expect(onNotifyUsers).not.toHaveBeenCalled()
      unregisterAgentHandler(SID)
    })

    // 切了 Tab 又切回来时没有处理器，事件不该丢
    it('没有处理器时通知落进 Store', () => {
      bus.emit('agent-v3:compacting', { sessionId: SID })

      const process = useAgentStreamStore().getStreamByAgentSession(SID)?.agentProcess ?? []
      expect(process.at(-1)).toMatchObject({ type: 'notify-users' })
    })
  })

  /**
   * 界面原来那个「上下文 ~N tokens」是渲染层按屏幕上的消息估的，
   * 算不到系统提示词、77 个工具的定义、工具返回值和压缩摘要 ——
   * 和模型真正看到的差着数量级。真数由内核推过来。
   */
  describe('上下文用量', () => {
    beforeEach(() => {
      // 用量存在**会话**上，所以这个会话得先存在
      useChatSessionsStore().sessions = [
        { id: CHAT, title: '', createdAt: 0, updatedAt: 0 }
      ] as unknown as typeof useChatSessionsStore.prototype.sessions
      const typingId = useChatMessagesStore().pushAssistantTyping(CHAT)
      useAgentStreamStore().initStream(CHAT, SID, typingId)
    })

    it('按 chatSid 存下内核推来的用量', () => {
      bus.emit('agent-v3:context-usage', { sessionId: SID, tokens: 12_000, contextWindow: 128_000 })

      expect(useChatSessionsStore().getContextUsage(CHAT)).toEqual({
        tokens: 12_000,
        contextWindow: 128_000
      })
    })

    /**
     * 用量必须**活过这一轮**。
     *
     * 它一度存在流式状态里，而 `cleanupStream` 每轮结束都会把那份状态整个
     * 删掉、还不落盘 —— 表现就是刷新页面、切走再切回来、重开应用之后，
     * 指示器全空了：用户明明有一屋子历史，却要再发一条消息才知道用了多少。
     * 存在会话上（持久化）才对。
     */
    it('本轮结束后用量还在', () => {
      bus.emit('agent-v3:context-usage', { sessionId: SID, tokens: 900, contextWindow: 8_000 })
      useAgentStreamStore().cleanupStream(SID)

      expect(useChatSessionsStore().getContextUsage(CHAT)).toEqual({
        tokens: 900,
        contextWindow: 8_000
      })
    })

    // 用量每轮都更新，跟着动 updatedAt 会让侧边栏因为「没说话」而重排
    it('不碰 updatedAt，避免侧边栏无故重排', () => {
      const store = useChatSessionsStore()
      const before = store.sessions[0].updatedAt
      bus.emit('agent-v3:context-usage', { sessionId: SID, tokens: 900, contextWindow: 8_000 })
      expect(store.sessions[0].updatedAt).toBe(before)
    })

    // 认不出是哪个对话的用量，宁可不记，也不要记到别的对话头上
    it('会话没登记时丢弃', () => {
      bus.emit('agent-v3:context-usage', {
        sessionId: 'unknown-session',
        tokens: 1,
        contextWindow: 2
      })

      expect(useChatSessionsStore().getContextUsage(CHAT)).toBeUndefined()
    })
  })

  /**
   * 本轮计费用量，和上面的上下文用量是两回事：
   * 上下文是「模型现在看得见多大」（压缩会让它变小），这个是「这一轮实际花了多少」
   * （只增不减）。一轮里模型往返很多次，主进程按次报，界面负责加起来。
   */
  describe('本轮 token 用量', () => {
    beforeEach(() => {
      const typingId = useChatMessagesStore().pushAssistantTyping(CHAT)
      useAgentStreamStore().initStream(CHAT, SID, typingId)
    })

    const usage = (
      input: number,
      output: number,
      cost: number
    ): { sessionId: string } & AgentTurnUsage => ({
      sessionId: SID,
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      total: input + output,
      cost
    })

    it('把一轮里每次往返的用量累加起来', () => {
      bus.emit('agent-v3:turn-usage', usage(1000, 100, 0.25))
      bus.emit('agent-v3:turn-usage', usage(2000, 200, 0.5))

      expect(useAgentStreamStore().getTurnUsage(SID)).toMatchObject({
        input: 3000,
        output: 300,
        total: 3300,
        cost: 0.75
      })
    })

    // 全 0 时返回 undefined：界面据此整段不显示，而不是画一个「0 tokens」
    it('没收到任何用量时不返回空壳', () => {
      expect(useAgentStreamStore().getTurnUsage(SID)).toBeUndefined()
    })

    it('会话没登记时丢弃，不记到别的对话头上', () => {
      bus.emit('agent-v3:turn-usage', { ...usage(10, 10, 0), sessionId: 'unknown-session' })

      expect(useAgentStreamStore().getTurnUsage(SID)).toBeUndefined()
    })
  })

  describe('agent 反问用户', () => {
    const QUESTIONS = [
      {
        header: '用在哪',
        question: '先给谁用？',
        multiSelect: false,
        options: [
          { label: '补适配层', description: '只加能力位' },
          { label: '改音频概览', description: '改动面更大' }
        ]
      }
    ]

    beforeEach(() => {
      const typingId = useChatMessagesStore().pushAssistantTyping(CHAT)
      useAgentStreamStore().initStream(CHAT, SID, typingId)
    })

    const emitQuestion = (toolCallId = 'q1'): void => {
      bus.emit('agent-v3:question-required', { sessionId: SID, toolCallId, questions: QUESTIONS })
    }

    const questionItems = (): AgentProcessItem[] =>
      useAgentStreamStore()
        .getStreamByAgentSession(SID)!
        .agentProcess.filter((item) => item.type === 'question')

    it('提问进时间线，并带上回传要用的 sessionId', () => {
      emitQuestion()

      expect(questionItems()).toHaveLength(1)
      expect(questionItems()[0].data).toMatchObject({ toolCallId: 'q1', sessionId: SID })
    })

    /**
     * 侧边栏那颗「有问题等你回答」的标记就长在这个判据上。
     *
     * `ask_user` 没有超时（主进程 `host/questionChannel.ts`），没人答就一直等 ——
     * 而时间线上那张卡片是唯一的提示，用户切到别的会话就看不见了。
     * 判据按 chatSid 查，因为侧边栏手上只有它。
     */
    it('有没答的提问时，侧边栏据以标记的判据为真', () => {
      const store = useAgentStreamStore()
      expect(store.hasPendingQuestion(CHAT)).toBe(false)

      emitQuestion()
      expect(store.hasPendingQuestion(CHAT)).toBe(true)
    })

    it('用户答完就不再标记', () => {
      const store = useAgentStreamStore()
      emitQuestion()

      store.resolveQuestion(SID, 'q1', 'accept', ['补适配层'])

      expect(store.hasPendingQuestion(CHAT)).toBe(false)
    })

    /** 会话收尾会把还挂着的卡片按 cancel 封掉，标记要跟着灭 —— 否则它会一直亮着 */
    it('会话收尾封掉卡片后不再标记', () => {
      const store = useAgentStreamStore()
      emitQuestion()

      store.closePendingQuestions(SID)

      expect(store.hasPendingQuestion(CHAT)).toBe(false)
    })

    it('没有这条流时不标记，也不炸', () => {
      expect(useAgentStreamStore().hasPendingQuestion('no-such-chat')).toBe(false)
    })

    /**
     * 刷新页面之后主进程会**补发**一遍还挂着的提问。不去重的话时间线上会长出
     * 两张一模一样的卡片，用户答了其中一张，另一张还在那儿等。
     */
    it('补发的同一条提问不会长出第二张卡片', () => {
      emitQuestion()
      emitQuestion()

      expect(questionItems()).toHaveLength(1)
    })

    /**
     * 落不了地也要有交代。
     *
     * 主进程这会儿正阻塞在 `ask_user` 里，而那边**没有超时** —— 不回一句的话
     * 它会一直等下去，用户看到的是「agent 卡住不动」。
     */
    it('没有可落地的流时按取消回复，不让主进程干等', () => {
      bus.emit('agent-v3:question-required', {
        sessionId: 'no-such-session',
        toolCallId: 'q-orphan',
        questions: QUESTIONS
      })

      expect(bus.replyQuestion).toHaveBeenCalledWith({
        toolCallId: 'q-orphan',
        action: 'cancel'
      })
    })

    it('缺 toolCallId 的事件直接丢弃，不抛异常', () => {
      expect(() =>
        bus.emit('agent-v3:question-required', { sessionId: SID, questions: QUESTIONS })
      ).not.toThrow()
      expect(questionItems()).toHaveLength(0)
    })

    it('提问立刻刷进气泡，不等节流', () => {
      emitQuestion()

      const message = useChatMessagesStore().getMessages(CHAT).at(-1)
      expect(message?.agentProcess?.some((item) => item.type === 'question')).toBe(true)
    })

    /**
     * 会话结束时还挂着的卡片要封掉。
     *
     * 不封的话屏幕上会永远留着一张「等你回答」、点了没反应的卡片 —— 而主进程
     * 那次提问其实早就结束了（超时、按停止、模型自己收手）。更糟的是它会带着
     * 「待回答」的状态落盘，下次打开应用还是那副样子。
     */
    it('会话结束时把还挂着的提问按「没有回答」封掉', () => {
      emitQuestion()
      bus.emit('agent-v3:done', { sessionId: SID })

      const painted = useChatMessagesStore()
        .getMessages(CHAT)
        .at(-1)
        ?.agentProcess?.find((item) => item.type === 'question')
      expect(painted?.data).toMatchObject({ action: 'cancel' })
    })

    it('已经答过的不会被收尾改掉', () => {
      emitQuestion()
      useAgentStreamStore().resolveQuestion(SID, 'q1', 'accept', ['补适配层'])
      bus.emit('agent-v3:done', { sessionId: SID })

      const painted = useChatMessagesStore()
        .getMessages(CHAT)
        .at(-1)
        ?.agentProcess?.find((item) => item.type === 'question')
      expect(painted?.data).toMatchObject({ action: 'accept', answers: ['补适配层'] })
    })
  })
  // 审批必须由**全局**分发器接住：确认框长在助手页里，而助手页没有 keep-alive，
  // 监听器跟着组件走的话，切个标签页这次审批就收不到、也显示不出来，
  // 主进程只能干等到五分钟超时按拒绝处理
  describe('工具审批', () => {
    it('审批请求进队列，不依赖确认框组件挂没挂着', () => {
      bus.emit('agent-v3:approval-required', {
        sessionId: SID,
        toolCallId: 'call-1',
        toolName: 'delete_asset',
        namespace: 'asset',
        risk: 'destructive',
        args: { path: '/Game/Foo' },
        allowAlways: true
      })

      expect(usePendingApprovalsStore().current?.toolCallId).toBe('call-1')
    })

    it('别处落定了就把卡片收掉', () => {
      bus.emit('agent-v3:approval-required', {
        sessionId: SID,
        toolCallId: 'call-1',
        toolName: 'delete_asset',
        namespace: 'asset',
        risk: 'destructive',
        args: {},
        allowAlways: true
      })

      bus.emit('agent-v3:approval-settled', { toolCallId: 'call-1' })

      expect(usePendingApprovalsStore().current).toBeNull()
    })

    it('没有 allowAlways 字段时按「可以本次会话都允许」算', () => {
      bus.emit('agent-v3:approval-required', {
        sessionId: SID,
        toolCallId: 'call-1',
        toolName: 'write_file',
        namespace: 'fs',
        risk: 'mutating',
        args: {}
      })

      expect(usePendingApprovalsStore().current?.allowAlways).toBe(true)
    })
  })
})

describe('answerAgentQuestion', () => {
  const CHAT_Q = 'chat-q'
  const SID_Q = 'session-q'

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  /**
   * 三件事一起做：回传、改状态、重画。
   *
   * 少了回传，主进程干等到超时；少了改状态，卡片一直是可点的，用户会以为
   * 自己没点上然后再点一次 —— 而第二次的回复主进程已经不认了。
   */
  it('回传答案并把卡片就地改成只读', async () => {
    const bus = installApiMock()
    const dispatcher = await freshDispatcher()

    const typingId = useChatMessagesStore().pushAssistantTyping(CHAT_Q)
    const store = useAgentStreamStore()
    store.initStream(CHAT_Q, SID_Q, typingId)
    store.pushQuestion(SID_Q, { toolCallId: 'q1', questions: [] })

    dispatcher.answerAgentQuestion(SID_Q, 'q1', 'accept', ['补适配层'])

    expect(bus.replyQuestion).toHaveBeenCalledWith({
      toolCallId: 'q1',
      action: 'accept',
      answers: ['补适配层']
    })

    const item = store
      .getStreamByAgentSession(SID_Q)!
      .agentProcess.find((entry) => entry.type === 'question')
    expect(item?.data).toMatchObject({ action: 'accept', answers: ['补适配层'] })

    // 屏幕上那条气泡读的是消息，不是 Store —— 不重画的话卡片还是可点的
    const painted = useChatMessagesStore()
      .getMessages(CHAT_Q)
      .at(-1)
      ?.agentProcess?.find((entry) => entry.type === 'question')
    expect(painted?.data).toMatchObject({ action: 'accept' })
  })

  /** decline 不带答案 —— 主进程据此让模型带着假设继续，而不是照着空答案做 */
  it('decline 不带答案', async () => {
    const bus = installApiMock()
    const dispatcher = await freshDispatcher()

    const typingId = useChatMessagesStore().pushAssistantTyping(CHAT_Q)
    const store = useAgentStreamStore()
    store.initStream(CHAT_Q, SID_Q, typingId)
    store.pushQuestion(SID_Q, { toolCallId: 'q1', questions: [] })

    dispatcher.answerAgentQuestion(SID_Q, 'q1', 'decline')

    expect(bus.replyQuestion).toHaveBeenCalledWith({ toolCallId: 'q1', action: 'decline' })
  })
})

describe('cancelUserSteer', () => {
  const CHAT_S = 'chat-s'
  const SID_S = 'session-s'

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('内核确认撤掉了，时间线就地改成已撤回并重画', async () => {
    const bus = installApiMock()
    const dispatcher = await freshDispatcher()

    const typingId = useChatMessagesStore().pushAssistantTyping(CHAT_S)
    const store = useAgentStreamStore()
    store.initStream(CHAT_S, SID_S, typingId)
    store.pushUserSteer(SID_S, '算了别改了', 'steer-1')

    await expect(dispatcher.cancelUserSteer(SID_S, 'steer-1')).resolves.toBe(true)
    expect(bus.cancelSteer).toHaveBeenCalledWith({ sessionId: SID_S, steerId: 'steer-1' })

    // 屏幕上那条气泡读的是消息，不是 Store —— 不重画的话它还写着「排队中」
    const painted = useChatMessagesStore()
      .getMessages(CHAT_S)
      .at(-1)
      ?.agentProcess?.find((entry) => entry.type === 'user-steer')
    expect(painted?.data).toMatchObject({ cancelled: true })
  })

  /**
   * 撤晚了不能在界面上装作撤成功。
   *
   * 那句话已经进了模型的上下文，标成「已撤回」之后用户会看到一条写着已撤回的话
   * 被照做了 —— 比没有撤回按钮更坏。
   */
  it('内核说晚了一步时不改界面，返回 false', async () => {
    const bus = installApiMock()
    bus.cancelSteer.mockResolvedValueOnce({ success: false, reason: 'already-sent' })
    const dispatcher = await freshDispatcher()

    const typingId = useChatMessagesStore().pushAssistantTyping(CHAT_S)
    const store = useAgentStreamStore()
    store.initStream(CHAT_S, SID_S, typingId)
    store.pushUserSteer(SID_S, '算了别改了', 'steer-1')

    await expect(dispatcher.cancelUserSteer(SID_S, 'steer-1')).resolves.toBe(false)

    const item = store
      .getStreamByAgentSession(SID_S)!
      .agentProcess.find((entry) => entry.type === 'user-steer')
    expect(item?.data.cancelled).toBe(false)
  })
})

describe('finalizeSessionCompletionForUI', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('把还在 typing 的消息收尾成最终回复', async () => {
    const { finalizeSessionCompletionForUI } = await freshDispatcher()
    const chatSid = 'chat-fallback'
    const agentSessionId = 'session-fallback'

    const chatMsgStore = useChatMessagesStore()
    const agentStreamStore = useAgentStreamStore()

    chatMsgStore.pushUser(chatSid, 'Explain the fix')
    const typingId = chatMsgStore.pushAssistantTyping(chatSid)

    agentStreamStore.initStream(chatSid, agentSessionId, typingId)
    agentStreamStore.appendText(agentSessionId, 'The task is complete.')
    agentStreamStore.flushBuffer(agentSessionId)

    finalizeSessionCompletionForUI(agentSessionId)

    const assistantMessage = chatMsgStore
      .getMessages(chatSid)
      .find((message) => message.id === typingId)

    expect(assistantMessage?.status).toBe('done')
    expect(assistantMessage?.content).toBe('The task is complete.')
    expect(agentStreamStore.isStreaming(chatSid)).toBe(false)
  })
})
