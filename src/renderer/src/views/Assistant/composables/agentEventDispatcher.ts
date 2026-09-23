/**
 * Agent 事件全局分发器（单例）。
 *
 * 应用启动时注册一次全局监听，按 sessionId 派发给注册的处理器。
 * 文本/推理增量直接写 `agentStreamStore` 而不走回调 —— 回调会在 Tab 切换时
 * 闭包捕获到过期状态，那是 V2 时代反复出问题的地方。
 *
 * ## 通道来源
 *
 * 只监听 `agent-v3:*`。V2 的 `agent:*` 契约和它的兼容投影层（`host/legacyBridge.ts`）
 * 已经一起删除。
 *
 * 这不只是清理。过渡层是按 V2 的 payload 形状硬凑的，其中工具调用那条
 * **凑错了**：它发 `toolCalls: [{ toolCallId, toolName, args }]`，
 * 而界面的 `getToolName()` 只认 `data.function.name` 或 `data.name`，
 * 两个都没有 —— 于是聊天界面里每一条工具调用的名字都是空的。
 * 直连之后按界面真正认的 OpenAI 形状发，名字就回来了。
 *
 * ## 订阅方式
 *
 * 用 `window.api.on` 而不是 `window.electron.ipcRenderer.on`：
 * 前者的白名单是 `GENERIC_EVENT_CHANNELS`，`agent-v3:*` 登记在那里。
 * 用错的话 `assertChannelAllowed` 会抛异常，**整个订阅链路一起挂掉**，
 * 表现是界面完全收不到事件却没有任何报错线索。
 */

import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { usePendingApprovalsStore } from '@renderer/store/modules/pendingApprovals'
import type { AgentTurnUsage } from '@core/shared/agentUsage'
import type { AgentQuestion, AgentQuestionAction } from '@core/shared/agentQuestion'
import { agentV3API } from '@renderer/api/agentV3'
import { isTypingPlaceholder } from '@renderer/utils/typingPlaceholder'

/**
 * 事件处理器。
 *
 * 只保留 V3 真会发出的回调。V2 时代的 `onQueueStatus` / `onRoutingTrace` /
 * `onHeartbeat` / `onTimeout` / `onStepFinish` / `onExecutionContext` 全部移除 ——
 * 那些是官方网关排队、Router 路由、specialist 心跳的产物，V3 没有这些东西，
 * 留着只会让人以为还有事件会来。
 */
export interface AgentEventHandler {
  /** Agent Session ID */
  sessionId: string
  /** Chat Session ID */
  chatSid: string
  /** 工具调用回调 */
  onToolCall?: (data: ToolCallData) => void
  /** 工具结果回调 */
  onToolResult?: (data: ToolResultData) => void
  /** 步骤回调 */
  onStep?: (data: StepData) => void
  /** 完成回调 */
  onDone?: (data: DoneData) => void
  /** 用户主动停止回调 */
  onStopped?: () => void
  /** 错误回调。`error` 是 provider 原文，`data` 是从原文里抠出来的事实（见主进程 `providerError.ts`） */
  onError?: (error: string, data?: { statusCode?: number; code?: string; detail?: string }) => void
  /** 过程通知回调（推理、压缩提示等，显示在过程日志里） */
  onNotifyUsers?: (data: NotifyUsersData) => void
  /** 一批流式内容已经写进气泡；当前可见会话可据此合并一次滚动 */
  onStreamPaint?: (chatSid: string) => void
}

interface ToolCallData {
  toolCalls: Array<{
    id?: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  sessionId?: string
}

interface ToolResultData {
  toolName: string
  /** 哪一次调用的结果。并行的 `task` 靠它把结果对回发起它的那一路 */
  toolCallId?: string
  result: unknown
  isError?: boolean
  sessionId?: string
}

interface StepData {
  /** 第几轮模型往返。**没有总数** —— V3 不设步数上限 */
  step: number
  sessionId?: string
}

interface DoneData {
  sessionId?: string
}

interface NotifyUsersData {
  sessionId?: string
  [key: string]: unknown
}

/**
 * 注册的处理器：sessionId -> handler。
 *
 * `runId` 是**这一轮**的身份。同一条 agent 会话会被连着跑好几轮（语音把排队的
 * 第二件活派回同一条会话就是这样），而收尾是异步的 —— 上一轮的收尾很可能在
 * 下一轮已经开跑之后才走到「注销处理器」那一步。没有这个号的话它注销的是
 * **新那一轮**的处理器，界面从此收不到任何事件：气泡停在半截、过程日志不动，
 * 而后台还在干活。
 */
type RegisteredHandler = AgentEventHandler & { runId: number }

const handlers = new Map<string, RegisteredHandler>()

/** 全局自增的轮次号。跨会话共用一根计数器就够，只要求「新的比旧的大且不相等」 */
let runSeq = 0

/** 每个会话的累计步数。V3 的 step 事件不带序号，序号是界面自己数的 */
const stepCounters = new Map<string, number>()

let initialized = false

/** Store 实例引用（延迟获取，避免循环依赖） */
let streamStore: ReturnType<typeof useAgentStreamStore> | null = null
let chatMessagesStore: ReturnType<typeof useChatMessagesStore> | null = null
let chatSessionsStore: ReturnType<typeof useChatSessionsStore> | null = null
let pendingApprovalsStore: ReturnType<typeof usePendingApprovalsStore> | null = null

function getStreamStore(): ReturnType<typeof useAgentStreamStore> {
  if (!streamStore) {
    streamStore = useAgentStreamStore()
  }
  return streamStore
}

function getPendingApprovalsStore(): ReturnType<typeof usePendingApprovalsStore> {
  if (!pendingApprovalsStore) {
    pendingApprovalsStore = usePendingApprovalsStore()
  }
  return pendingApprovalsStore
}

function getChatMessagesStore(): ReturnType<typeof useChatMessagesStore> {
  if (!chatMessagesStore) {
    chatMessagesStore = useChatMessagesStore()
  }
  return chatMessagesStore
}

function getChatSessionsStore(): ReturnType<typeof useChatSessionsStore> {
  if (!chatSessionsStore) {
    chatSessionsStore = useChatSessionsStore()
  }
  return chatSessionsStore
}

/**
 * 增量到达后重画气泡的节流器：sessionId -> 待触发的定时器。
 *
 * 增量按 token 来，一秒钟几十条。每条都重画一次消息，Vue 的响应式开销会把
 * 主线程占满 —— 攒一小段一起画，肉眼看着仍然是连续在打字。
 */
const repaintTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 每秒约 8 次刷新足以保持连续打字感，还能给 Markdown 渲染和输入事件留出主线程时间。
 */
const REPAINT_INTERVAL_MS = 120

/**
 * 把流式状态里的正文/推理刷进正在打字的那条气泡。
 *
 * 不刷的话，正文和推理只会累积在 store 里，**屏幕上什么都不变** ——
 * 要等下一个工具调用或者这一轮结束才一次性冒出来。用户看到的就是
 * 一个转了两分钟的「思考中」，然后突然出现一整段话。
 */
function paintStreamingMessage(sessionId: string): void {
  const state = getStreamStore().getStreamByAgentSession(sessionId)
  if (!state?.isStreaming) return

  const chatMsgStore = getChatMessagesStore()
  const typing = chatMsgStore
    .getMessages(state.chatSid)
    .find((item) => item.role === 'assistant' && item.status === 'typing')
  if (!typing) return

  const previousContent = String(typing.content || '')
  const previousThinking = typing.thinking || ''
  const previousProcessLength = typing.agentProcess?.length ?? 0

  // 正文还是空的（模型在推理阶段）就别把占位文案抹掉 —— 抹了气泡会整个空掉，
  // 比「思考中」更让人以为卡死了
  const content = state.currentText || previousContent

  chatMsgStore.replaceTyping(state.chatSid, typing.id, content, false, {
    thinking: state.currentThinking,
    agentProcess: [...state.agentProcess]
  })
  /**
   * 收起的思考正文增长不会改变页面高度，不应该每 120ms 重启一次平滑滚动。
   * 只有正文、过程时间线或思考栏首次出现时，才通知页面贴底。
   */
  const visibleContentGrew =
    content !== previousContent ||
    state.agentProcess.length !== previousProcessLength ||
    (!previousThinking && !!state.currentThinking)
  if (visibleContentGrew) {
    handlerFor(sessionId)?.onStreamPaint?.(state.chatSid)
  }
}

function scheduleRepaint(sessionId: string): void {
  if (repaintTimers.has(sessionId)) return

  repaintTimers.set(
    sessionId,
    setTimeout(() => {
      repaintTimers.delete(sessionId)
      paintStreamingMessage(sessionId)
    }, REPAINT_INTERVAL_MS)
  )
}

function cancelRepaint(sessionId: string): void {
  const timer = repaintTimers.get(sessionId)
  if (!timer) return
  clearTimeout(timer)
  repaintTimers.delete(sessionId)
}

export function finalizeSessionCompletionForUI(sessionId: string): void {
  // 收尾要画的是终稿，别让攒着的那次节流重画在后面把它盖回去
  cancelRepaint(sessionId)

  const store = getStreamStore()
  store.flushBuffer(sessionId)
  // 还挂着的提问卡片在这里封掉。主进程那次提问已经结束了（超时、按停止、
  // 模型自己收手），不封的话屏幕上会永远留着一张「等你回答」、点了没反应的卡片，
  // 而且它会带着这个状态落盘，下次打开应用还是那副样子。
  store.closePendingQuestions(sessionId)
  const state = store.endStream(sessionId)
  const chatSid = state?.chatSid || store.getChatSidByAgentSession(sessionId)
  if (!chatSid) {
    return
  }

  const chatMsgStore = getChatMessagesStore()
  const finalText = state?.currentText?.trim() || ''
  const finalThinking = state?.currentThinking
  const finalAgentProcess =
    state?.agentProcess && state.agentProcess.length > 0 ? [...state.agentProcess] : undefined

  for (const message of chatMsgStore.getMessages(chatSid)) {
    if (message.role !== 'assistant' || message.status !== 'typing') {
      continue
    }

    const currentContent = typeof message.content === 'string' ? message.content : ''
    /**
     * 屏幕上已经有的正文 vs 流式状态里累积的正文，取**多的那个**。
     *
     * 平时两者一样（屏幕上的就是从流式状态写下去的）。不一样的是刷新后重连
     * 那条会话、而且这个对话没开着的时候：消息里停在刷新前的半截，流式状态
     * 是「半截 + 刷新后新生成的」。原来这里无条件优先用消息里那份，等于把
     * 刷新之后模型说的每一句都扔了。
     */
    const onScreen = isTypingPlaceholder(currentContent) ? '' : currentContent.trim()
    const nextContent =
      finalText.length >= onScreen.length ? finalText || currentContent : currentContent

    chatMsgStore.replaceTyping(chatSid, message.id, nextContent || '', true, {
      thinking: finalThinking,
      agentProcess: finalAgentProcess
    })
  }
}

/**
 * 带类型的事件订阅。
 *
 * `window.api.on` 的签名是 `(...args: unknown[]) => void`（白名单校验层不关心
 * 各通道的 payload 形状），每个订阅点各写一次断言太吵，收敛到这里一处。
 */
function on<T>(channel: string, listener: (data: T) => void): void {
  window.api.on(channel, ((data: unknown) => listener(data as T)) as (...args: unknown[]) => void)
}

/** 取回处理器。所有 V3 事件都带 sessionId，拿不到就是这个会话没人管，直接丢弃 */
function handlerFor(sessionId?: string): RegisteredHandler | undefined {
  return sessionId ? handlers.get(sessionId) : undefined
}

/**
 * 把过程通知写进界面。
 *
 * 有处理器就走回调（组件能立刻重绘），没有就直接落进 store ——
 * 后者发生在切了 Tab 又切回来的时候，事件不该丢。
 */
function notify(
  sessionId: string,
  message: string,
  notifyType: string,
  /**
   * 这条通知归谁。工具进度带上 `toolCallId` / `toolName`，界面才分得清
   * 同时在跑的几路子任务 —— 光看文本它们一模一样。
   */
  origin?: { toolCallId?: string; toolName?: string }
): void {
  const handler = handlers.get(sessionId)
  if (handler?.onNotifyUsers) {
    handler.onNotifyUsers({
      sessionId,
      message,
      type: notifyType,
      timestamp: Date.now(),
      ...(origin ?? {})
    })
    return
  }

  getStreamStore().addAgentProcess(sessionId, {
    type: 'notify-users',
    data: { message, notifyType, ...(origin ?? {}) },
    timestamp: Date.now()
  })
}

/**
 * 初始化全局 Agent 事件监听器。只应调用一次，通常在应用启动时。
 */
export function initAgentEventDispatcher(): void {
  if (initialized) {
    console.log('[AgentEventDispatcher] 已初始化，跳过')
    return
  }

  console.log('[AgentEventDispatcher] 初始化全局 Agent V3 事件监听器')
  initialized = true

  // ── 文本与推理：直接写 Store，再节流重画气泡 ─────────────────────────
  // 主进程按 token 发增量（`message_update`），这两条通道因此是**边生成边到**的
  on('agent-v3:text', (data: { sessionId: string; text: string }) => {
    if (!data?.sessionId) return
    getStreamStore().appendText(data.sessionId, data.text)
    scheduleRepaint(data.sessionId)
  })

  // V2 没有这个能力 —— 推理内容混在正文里靠 <think> 标签切。
  // V3 是独立事件类型，直接进 thinking 区。
  on('agent-v3:thinking', (data: { sessionId: string; text: string }) => {
    if (!data?.sessionId) return
    getStreamStore().appendThinking(data.sessionId, data.text)
    scheduleRepaint(data.sessionId)
  })

  // ── 工具调用 ────────────────────────────────────────────────────────
  on(
    'agent-v3:tool-call',
    (data: { sessionId: string; toolCallId: string; toolName: string; args: unknown }) => {
      const handler = handlerFor(data?.sessionId)
      if (!handler?.onToolCall) return

      // 界面的 getToolName() 只认 function.name 或 name。
      // 过渡层发的 { toolCallId, toolName } 两个都不满足，工具名一直是空的。
      handler.onToolCall({
        sessionId: data.sessionId,
        toolCalls: [
          {
            id: data.toolCallId,
            type: 'function',
            function: {
              name: data.toolName,
              arguments: JSON.stringify(data.args ?? {})
            }
          }
        ]
      })
    }
  )

  // V3 新增：长任务边跑边推进度，V2 只能干等
  on(
    'agent-v3:tool-progress',
    (data: { sessionId: string; toolCallId?: string; toolName: string; partial: unknown }) => {
      if (!data?.sessionId) return
      const text = extractProgressText(data.partial)
      if (!text) return
      notify(data.sessionId, `${progressLabel(data.toolName)}：${text}`, 'progress', {
        toolCallId: data.toolCallId,
        toolName: data.toolName
      })
    }
  )

  on(
    'agent-v3:tool-result',
    (data: {
      sessionId: string
      toolCallId?: string
      toolName: string
      isError: boolean
      text: string
      details: unknown
    }) => {
      const handler = handlerFor(data?.sessionId)
      if (!handler?.onToolResult) return

      handler.onToolResult({
        sessionId: data.sessionId,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        isError: data.isError,
        // 界面优先展示结构化结果；工具没给 details 时退回文本，至少有东西可显示
        result: data.isError ? data.text || data.details : (data.details ?? data.text)
      })
    }
  )

  // ── 轮次 ────────────────────────────────────────────────────────────
  on('agent-v3:step', (data: { sessionId: string }) => {
    if (!data?.sessionId) return
    const step = (stepCounters.get(data.sessionId) ?? 0) + 1
    stepCounters.set(data.sessionId, step)
    handlerFor(data.sessionId)?.onStep?.({ sessionId: data.sessionId, step })
  })

  // ── 插话回执 ────────────────────────────────────────────────────────
  // 内核把排队的插话注入对话时会为它发一条用户消息事件，那才是「模型真看见了」
  // 的时刻 —— steer 那个 IPC 返回的 success 只代表入队成功。
  // 对不上任何待生效插话的（本轮最初的 prompt）会被 markSteerApplied 忽略。
  on('agent-v3:user-message', (data: { sessionId: string; text: string }) => {
    if (!data?.sessionId || !data.text) return
    getStreamStore().markSteerApplied(data.sessionId, data.text)
  })

  // ── agent 反问用户 ──────────────────────────────────────────────────
  //
  // 卡片长在时间线上、**不弹模态**：它是对话的一部分，滚上去还应该能看到
  // 「当时问了什么、我选了什么」。审批那种模态是对的（阻断性、危险动作），
  // 提问不是。
  //
  // 主进程这会儿正阻塞在 `ask_user` 里等回复，所以放不进去也要有交代：
  // 流不在（这条会话已经收尾了、或者刚刷新过页面）就直接按取消回复。
  // **提问那边没有超时**（见主进程 `host/questionChannel.ts`），不回这一句的话
  // 它会一直等下去，而用户根本看不到有卡片在等他。
  on(
    'agent-v3:question-required',
    (data: { sessionId: string; toolCallId: string; questions: AgentQuestion[] }) => {
      if (!data?.sessionId || !data.toolCallId) return

      const placed = getStreamStore().pushQuestion(data.sessionId, {
        toolCallId: data.toolCallId,
        questions: Array.isArray(data.questions) ? data.questions : []
      })

      if (!placed) {
        console.warn('[AgentEventDispatcher] 提问没有可落地的流，按取消回复:', data.toolCallId)
        agentV3API.replyQuestion(data.toolCallId, 'cancel')
        return
      }

      // 不走节流：用户正在等着这张卡片出现，攒 80ms 没有意义，
      // 而且提问之后模型不会再有增量来触发下一次重画
      paintStreamingMessage(data.sessionId)
    }
  )

  // ── 工具审批 ────────────────────────────────────────────────────────
  //
  // 监听挂在这里而不是确认框组件里：助手页没开 keep-alive，切个标签页组件就
  // 卸载了。监听器跟着没的话，切走期间到达的审批**根本收不到**；组件内的状态
  // 跟着没的话，切回来确认框是空的 —— 两种都是「主进程等到五分钟超时按拒绝
  // 处理」，而用户没点过拒绝。所以状态进 store，组件只当它的视图。
  on(
    'agent-v3:approval-required',
    (data: {
      sessionId: string
      toolCallId: string
      toolName: string
      namespace: string
      risk: string
      args: unknown
      allowAlways?: boolean
    }) => {
      if (!data?.toolCallId) return
      getPendingApprovalsStore().enqueue({
        sessionId: data.sessionId,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        namespace: data.namespace,
        risk: data.risk,
        args: data.args,
        allowAlways: data.allowAlways !== false
      })
    }
  )

  // 这次审批在别处落定了（语音口头批的、会话被中止、或者超时）：把卡片收掉。
  // 不收的话用户再点一下，等于对一个已经不存在的审批表态
  on('agent-v3:approval-settled', (data: { toolCallId?: string }) => {
    if (!data?.toolCallId) return
    getPendingApprovalsStore().settle(data.toolCallId)
  })

  // ── 上下文用量：内核算的真数 ─────────────────────────────────────────
  // 界面上原本那个计数是渲染层按屏幕上的消息估的，算不到系统提示词、
  // 工具定义、工具返回值和压缩摘要 —— 和模型真正看到的差着数量级。
  on(
    'agent-v3:context-usage',
    (data: { sessionId: string; tokens: number; contextWindow: number }) => {
      if (!data?.sessionId) return
      // 存进**会话**而不是流式状态：流式状态每轮结束就被 cleanupStream 删掉，
      // 而且不落盘 —— 刷新页面或重开应用之后指示器会空着，用户得再发一条
      // 消息才知道自己用了多少上下文。会话是持久化的，正好。
      const chatSid = getStreamStore().getChatSidByAgentSession(data.sessionId)
      if (!chatSid) return
      getChatSessionsStore().setContextUsage(chatSid, {
        tokens: data.tokens,
        contextWindow: data.contextWindow
      })
    }
  )

  // ── 本轮计费用量：每次模型往返来一条，界面按轮累加 ────────────────────
  // 和 context-usage 分开存：那个是「上下文现在多大」（压缩会让它变小），
  // 这个是「这一轮实际花了多少」（只增不减）。存进流式状态而不是会话，
  // 因为它属于**这一条回复**，最后会随 responseMetadata 落进消息里。
  on('agent-v3:turn-usage', (data: { sessionId: string } & AgentTurnUsage) => {
    if (!data?.sessionId) return
    getStreamStore().addTurnUsage(data.sessionId, {
      input: data.input,
      output: data.output,
      cacheRead: data.cacheRead,
      cacheWrite: data.cacheWrite,
      total: data.total,
      cost: data.cost
    })
  })

  // ── 上下文压缩：V2 没有的提示 ────────────────────────────────────────
  // 压缩要停几秒，不说一声用户会以为卡住了
  on('agent-v3:compacting', (data: { sessionId: string }) => {
    if (!data?.sessionId) return
    notify(data.sessionId, '对话变长了，正在压缩上下文…', 'info')
  })

  // ── /goal 目标模式：复核进度与裁决 ──────────────────────────────────
  // 主进程把话都拼好了，这里只负责放进时间线。同压缩那条的道理：
  // 目标模式会自己又跑一轮，不说一声用户不知道为什么还在动
  on('agent-v3:goal', (data: { sessionId: string; message: string; level: string }) => {
    if (!data?.sessionId || !data.message) return
    // 复核发生在回复结束后，先补齐流式缓冲的句尾，避免通知把一句话截成两段。
    getStreamStore().flushBuffer(data.sessionId)
    notify(data.sessionId, data.message, data.level || 'info')
  })

  // ── 开跑前的准备（音视频传对象存储）───────────────────────────────
  on('agent-v3:notice', (data: { sessionId: string; message: string; level: string }) => {
    if (!data?.sessionId || !data.message) return
    notify(data.sessionId, data.message, data.level || 'info')
  })

  // ── 结束 ────────────────────────────────────────────────────────────
  on('agent-v3:done', (data: { sessionId: string }) => {
    if (!data?.sessionId) return
    finalizeSessionCompletionForUI(data.sessionId)
    handlerFor(data.sessionId)?.onDone?.(data)
  })

  // 用户按停止走这条，不是 error —— 点了停止反被弹一个报错很莫名其妙
  on('agent-v3:stopped', (data: { sessionId: string }) => {
    if (!data?.sessionId) return
    finalizeSessionCompletionForUI(data.sessionId)
    handlerFor(data.sessionId)?.onStopped?.()
  })

  on(
    'agent-v3:error',
    (data: {
      sessionId: string
      message: string
      statusCode?: number
      code?: string
      detail?: string
    }) => {
      if (!data?.sessionId) return
      // 状态码和错误码要一路带到处理器 —— 那边整套「401 说什么、429 说什么、
      // 哪些错不该挂『接着跑』」的判断全靠它们，少传就等于那套判断不存在
      handlerFor(data.sessionId)?.onError?.(data.message || '未知错误', {
        statusCode: data.statusCode,
        code: data.code,
        detail: data.detail
      })
    }
  )
}

/**
 * 用户答完一张提问卡片。
 *
 * 三件事必须一起做，而且顺序要紧：**先回传**（主进程还阻塞在 `ask_user` 里，
 * 早一刻放它走就早一刻继续干活），再改状态，最后立刻重画把卡片变成只读。
 *
 * 收在这里而不是让卡片组件直接调 API：卡片只知道自己那点数据，
 * 而「答完之后时间线要怎么变」是分发器的职责。
 */
export function answerAgentQuestion(
  sessionId: string,
  toolCallId: string,
  action: AgentQuestionAction,
  answers?: string[]
): void {
  agentV3API.replyQuestion(toolCallId, action, answers)
  getStreamStore().resolveQuestion(sessionId, toolCallId, action, answers)
  paintStreamingMessage(sessionId)
}

/**
 * 把一句插话记进目标对话的时间线，并立刻重画。
 *
 * 页面无关 —— 语音插话时用户往往正看着别的界面，没有哪个页面能代劳。
 * 少了这一步，插话只进了内核，任务对话上一个字都不会多：用户听见语音说
 * 「已经调整了」，切过去看却和原来一模一样，只能怀疑根本没插上。
 *
 * 返回 false 表示这个会话没有正在跑的流，调用方据此退回普通用户气泡。
 *
 * `steerId` 是主进程给这条插话的号，时间线上的撤回按钮拿它指认要撤哪一条。
 */
export function recordUserSteer(agentSessionId: string, text: string, steerId?: string): boolean {
  const store = getStreamStore()
  // 先把缓冲区里的正文放出来，插话才会落在它真正发生的位置之后
  store.flushBuffer(agentSessionId)
  if (!store.pushUserSteer(agentSessionId, text, steerId)) return false
  paintStreamingMessage(agentSessionId)
  return true
}

/**
 * 用户点掉了时间线上一条还排着的插话。
 *
 * **先问内核再改界面**：那句话早就交出去了，「排队中」只是我们这边的说法，
 * 内核可能刚好已经把它读进上下文。先把界面改成「已撤回」再去问，撞上这种时候
 * 用户会看到一条标着「已撤回」的话被模型照做了 —— 那比没有撤回按钮更坏。
 *
 * 返回撤回到底成没成，调用方据此决定要不要跟用户交代一句。
 */
export async function cancelUserSteer(agentSessionId: string, steerId: string): Promise<boolean> {
  const result = await agentV3API.cancelSteer(agentSessionId, steerId)
  if (!result?.success) return false

  getStreamStore().markSteerCancelled(agentSessionId, steerId)
  paintStreamingMessage(agentSessionId)
  return true
}

/**
 * 进度行的前缀。
 *
 * `task` 是子 agent 工具，它推的进度是**另一个 agent** 在干活。
 * 直接显示 `task：调用 material_get_graph` 用户不知道那是什么，
 * 说成「子任务」才对得上他看到的现象：主对话停着不动，底下有东西在跑。
 */
function progressLabel(toolName: string): string {
  return toolName === 'task' ? '子任务' : toolName
}

/** 从工具的局部结果里抽一行能显示的文本 */
function extractProgressText(partial: unknown): string {
  const content = (partial as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => {
      const x = b as { type?: string; text?: unknown }
      return x.type === 'text' && typeof x.text === 'string'
    })
    .map((b) => b.text)
    .join(' ')
    .trim()
}

/**
 * 登记这一轮的处理器，返回**轮次号**。
 *
 * 收尾时把它带回来（`unregisterAgentHandler` / `isCurrentRun`），
 * 这样迟到的收尾拆不掉后来那一轮的摊子。
 */
export function registerAgentHandler(handler: AgentEventHandler): number {
  const runId = ++runSeq
  console.log(
    '[AgentEventDispatcher] 注册处理器:',
    handler.sessionId,
    '-> chatSid:',
    handler.chatSid,
    'run:',
    runId
  )
  handlers.set(handler.sessionId, { ...handler, runId })
  stepCounters.set(handler.sessionId, 0)
  return runId
}

/**
 * 这条会话现在还归 `runId` 那一轮管吗。
 *
 * 不给轮次号的调用（界面上手动停、页面卸载这类和具体某一轮无关的收尾）一律算数。
 * 给了但对不上，说明这条会话上已经换了新的一轮 —— 那一摊是新那轮的，别碰。
 */
export function isCurrentRun(sessionId: string, runId?: number): boolean {
  if (runId === undefined) return true
  return handlers.get(sessionId)?.runId === runId
}

export function unregisterAgentHandler(sessionId: string, runId?: number): void {
  if (!isCurrentRun(sessionId, runId)) {
    console.log('[AgentEventDispatcher] 跳过过期收尾:', sessionId, 'run:', runId)
    return
  }
  console.log('[AgentEventDispatcher] 注销处理器:', sessionId)
  handlers.delete(sessionId)
  stepCounters.delete(sessionId)
  // 攒着的那次重画要撤掉：流式状态马上就没了，它只会白跑一趟
  cancelRepaint(sessionId)
  getStreamStore().cleanupStream(sessionId)
}

/** 当前注册的处理器数量（用于调试） */
export function getHandlerCount(): number {
  return handlers.size
}

export function isDispatcherInitialized(): boolean {
  return initialized
}

export function hasActiveHandler(sessionId: string): boolean {
  return handlers.has(sessionId)
}

export function findActiveSessionByChatSid(chatSid: string): string | null {
  for (const [sessionId, handler] of handlers) {
    if (handler.chatSid === chatSid) {
      return sessionId
    }
  }
  return null
}
