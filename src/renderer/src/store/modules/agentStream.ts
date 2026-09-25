import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { AgentProcessItem } from '@renderer/views/Assistant/components/AgentProcessLog.types'
import type { ExcelFileInfo, ExecutionContext } from '@renderer/store/modules/chatMessages'
import {
  EMPTY_TURN_USAGE,
  hasTurnUsage,
  mergeTurnUsage,
  type AgentTurnUsage
} from '@core/shared/agentUsage'
import type { AgentQuestionAction, AgentQuestionItem } from '@core/shared/agentQuestion'
import { snapshotAgentProcess } from '@renderer/utils/agentProcessSnapshot'

/**
 * Agent 流式状态接口
 * 每个 chatSid 对应一个独立的流式状态
 */
export interface AgentStreamState {
  /** Chat Session ID */
  chatSid: string
  /** Agent Session ID (用于事件路由) */
  agentSessionId: string
  /** 累积的正文文本 */
  currentText: string
  /** 累积的思考内容 */
  currentThinking: string
  /** 当前 typing 消息的 ID */
  currentTypingId: string | null
  /** 流式缓冲区 (用于解析 <think> 标签) */
  buffer: string
  /** 是否在 thinking 块内 */
  inThinkingBlock: boolean
  /** Agent 处理过程日志 */
  agentProcess: AgentProcessItem[]
  /** 是否正在生成中 */
  isStreaming: boolean
  /** 执行上下文（用于历史注入） */
  executionContext?: ExecutionContext
  /**
   * 本轮累计的计费用量。
   *
   * 一轮里模型会往返很多次（每次工具调用之后都是一次新请求），主进程按次发
   * `agent-v3:turn-usage`，这里把它们加起来 —— 用户想知道的是「我刚才那句话
   * 一共花了多少」，不是「最后一次往返花了多少」。
   */
  turnUsage: AgentTurnUsage
}

/**
 * 创建初始流式状态
 */
function createInitialState(chatSid: string, agentSessionId: string): AgentStreamState {
  return {
    chatSid,
    agentSessionId,
    currentText: '',
    currentThinking: '',
    currentTypingId: null,
    buffer: '',
    inThinkingBlock: false,
    agentProcess: [],
    isStreaming: true,
    executionContext: undefined,
    turnUsage: { ...EMPTY_TURN_USAGE }
  }
}

/**
 * Agent 流式状态 Store
 *
 * 核心设计原则：
 * 1. 按 chatSid 隔离存储每个会话的流式状态
 * 2. 事件分发器直接更新 Store，不依赖组件闭包
 * 3. 组件通过 computed 从 Store 读取状态
 *
 * 这解决了 Tab 切换时流式状态被错误修改的问题：
 * - 之前：处理器闭包捕获的 `messages` computed 依赖当前 `sid.value`
 * - 现在：处理器通过固定的 `chatSid` 直接更新 Store 中的状态
 */
export const useAgentStreamStore = defineStore('agentStream', () => {
  // ==================== 状态 ====================

  /**
   * 活跃的流式状态映射：chatSid -> AgentStreamState
   */
  const streams = reactive(new Map<string, AgentStreamState>())

  /**
   * Agent Session ID 到 Chat SID 的映射
   * 用于事件分发器通过 agentSessionId 快速定位 chatSid
   */
  const sessionToChatSid = reactive(new Map<string, string>())

  // ==================== Getters ====================

  /**
   * 获取指定会话的流式状态
   */
  function getStream(chatSid: string): AgentStreamState | undefined {
    return streams.get(chatSid)
  }

  /**
   * 检查指定会话是否正在流式生成
   */
  function isStreaming(chatSid: string): boolean {
    const state = streams.get(chatSid)
    return state?.isStreaming ?? false
  }

  /**
   * 这条会话**在后台还没被释放**：已经发出去了，但主进程那边还没说「空出来了」。
   *
   * 独立于 `streams` 存，因为两头都靠不住：`isStreaming` 在收到 `done` 那一刻就
   * 变 false，而 `cleanupStream` 会把整份状态删掉 —— 释放信号可能比它们晚。
   *
   * 键是 agentSessionId（`released` 带的是它），值是 chatSid（判忙要按它）。
   */
  const awaitingRelease = reactive(new Map<string, string>())

  /**
   * 界面停了 ≠ 后台空出来了。
   *
   * 主进程收尾的顺序是：发 `done`（事件流最后一条）→ `prompt()` 返回 →
   * `finally` 里 `activeAgents.release()` → 发 `released`。这中间的间隙里再
   * `execute`，会被 `reserveRun` 以「会话正在执行中」顶回来 —— 而排队投递是
   * **先出队再发**的，被顶回来的那条话就没了，用户什么也不会看到。
   *
   * 所以「能不能发下一条」只认这个：流还在跑，**或者**跑完了还没等到释放。
   */
  function isBusy(chatSid: string): boolean {
    if (isStreaming(chatSid)) return true
    for (const pending of awaitingRelease.values()) {
      if (pending === chatSid) return true
    }
    return false
  }

  /** 发起一轮（execute / continue）之前叫一声。释放信号到了才算完 */
  function markAwaitingRelease(chatSid: string, agentSessionId: string): void {
    awaitingRelease.set(agentSessionId, chatSid)
  }

  /**
   * 后台真的空出来了。
   *
   * 除了 `released`，**启动失败也要叫**：那一轮压根没跑起来，主进程不会发释放，
   * 不清的话这条对话会永远显示「忙」，后面排的话一条都发不出去。
   */
  function clearAwaitingRelease(agentSessionId: string): void {
    awaitingRelease.delete(agentSessionId)
  }

  /**
   * 根据 Agent Session ID 获取对应的 Chat SID
   */
  function getChatSidByAgentSession(agentSessionId: string): string | undefined {
    return sessionToChatSid.get(agentSessionId)
  }

  /**
   * 根据 Agent Session ID 获取流式状态
   */
  function getStreamByAgentSession(agentSessionId: string): AgentStreamState | undefined {
    const chatSid = sessionToChatSid.get(agentSessionId)
    if (!chatSid) return undefined
    return streams.get(chatSid)
  }

  // ==================== Actions ====================

  /**
   * 初始化流式状态（开始新的流式生成时调用）。
   *
   * `seed` 只有**刷新页面后重新接管一条还在跑的会话**时才传：那时正文和过程
   * 时间线已经有半截了（落在消息里），不带着它们起步的话，后面的增量会从空
   * 开始累积，而界面写回消息时用的就是这根累积字符串 —— 刷新前说过的话会被
   * 后半截整段覆盖掉。
   */
  function initStream(
    chatSid: string,
    agentSessionId: string,
    typingId: string,
    seed?: { text?: string; thinking?: string; agentProcess?: AgentProcessItem[] }
  ): void {
    console.log('[AgentStreamStore] 初始化流式状态:', { chatSid, agentSessionId, typingId })

    // 创建新的流式状态
    const state = createInitialState(chatSid, agentSessionId)
    state.currentTypingId = typingId
    if (seed?.text) state.currentText = seed.text
    if (seed?.thinking) state.currentThinking = seed.thinking
    if (seed?.agentProcess?.length) state.agentProcess = snapshotAgentProcess(seed.agentProcess)

    streams.set(chatSid, state)
    sessionToChatSid.set(agentSessionId, chatSid)
  }

  /**
   * 追加推理，同时在时间线上记下这一段推理落在哪儿。
   *
   * 一次回答里模型会想好几轮（想 → 调工具 → 再想），全文只有一根累积字符串的话，
   * 界面只能把所有推理挤进顶部一个框。时间线上记的是这一段在 `currentThinking`
   * 里的起止位置，不是再存一份正文 —— 推理动辄几万字，存两份会把落盘的聊天记录撑大一倍。
   * 连续的推理并进同一段，段与段之间天然被工具调用和正文切开。
   */
  function appendThinkingTo(state: AgentStreamState, delta: string): void {
    if (!delta) return
    const start = state.currentThinking.length
    state.currentThinking += delta
    const end = state.currentThinking.length

    const last = state.agentProcess[state.agentProcess.length - 1]
    if (last && last.type === 'thinking') {
      last.data.end = end
      return
    }
    state.agentProcess.push({ type: 'thinking', data: { start, end }, timestamp: Date.now() })
  }

  /**
   * 把正文增量记进过程时间线。
   *
   * `currentText` 那根累积字符串仍然是正文的全文（复制、落库、发回模型都用它），
   * 但它记不住**这句话是在第几步之后说的**。界面要按发生顺序显示，就得有段落
   * 边界：连续的正文并进同一段，段与段之间天然被工具调用切开。
   */
  function appendTimelineText(state: AgentStreamState, text: string): void {
    if (!text) return

    const last = state.agentProcess[state.agentProcess.length - 1]
    if (last && last.type === 'text') {
      last.data.text = `${last.data.text ?? ''}${text}`
      return
    }

    state.agentProcess.push({ type: 'text', data: { text }, timestamp: Date.now() })
  }

  /**
   * 追加文本到缓冲区并处理 <think> 标签
   */
  function appendText(agentSessionId: string, delta: string): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) {
      console.warn('[AgentStreamStore] 找不到流式状态:', agentSessionId)
      return
    }

    // 将新内容添加到缓冲区
    state.buffer += delta

    // 处理缓冲区中的内容，解析 <think> 标签
    let processedContent = ''
    let i = 0

    while (i < state.buffer.length) {
      if (!state.inThinkingBlock) {
        // 查找 <think> 开始标签
        const thinkStart = state.buffer.indexOf('<think>', i)
        if (thinkStart === -1) {
          // 没有找到开始标签，保留最后可能不完整的部分
          const safeEnd = Math.max(i, state.buffer.length - 7)
          processedContent += state.buffer.slice(i, safeEnd)
          state.buffer = state.buffer.slice(safeEnd)
          break
        } else {
          // 找到开始标签，提取标签前的正文内容
          processedContent += state.buffer.slice(i, thinkStart)
          state.inThinkingBlock = true
          i = thinkStart + 7
          state.buffer = state.buffer.slice(i)
          i = 0
        }
      } else {
        // 在 thinking 块内，查找 </think> 结束标签
        const thinkEnd = state.buffer.indexOf('</think>', i)
        if (thinkEnd === -1) {
          // 没有找到结束标签，保留最后可能不完整的部分
          const safeEnd = Math.max(i, state.buffer.length - 8)
          appendThinkingTo(state, state.buffer.slice(i, safeEnd))
          state.buffer = state.buffer.slice(safeEnd)
          break
        } else {
          // 找到结束标签，提取 thinking 内容
          appendThinkingTo(state, state.buffer.slice(i, thinkEnd))
          state.inThinkingBlock = false
          i = thinkEnd + 8
          state.buffer = state.buffer.slice(i)
          i = 0
        }
      }
    }

    // 累积正文内容
    if (processedContent) {
      state.currentText += processedContent
      appendTimelineText(state, processedContent)
    }
  }

  /**
   * 追加推理内容。
   *
   * `appendText` 里那套 `<think>` 标签解析是给**文本流**准备的 ——
   * 模型把推理混在正文里发出来，只能靠标签切开。
   * Agent V3 走 pi 内核，推理是**独立的事件类型**（`agent-v3:thinking`），
   * 不需要也不该再绕一圈标签：直接进 currentThinking。
   */
  function appendThinking(agentSessionId: string, delta: string): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) {
      console.warn('[AgentStreamStore] 找不到流式状态:', agentSessionId)
      return
    }
    appendThinkingTo(state, delta)
  }

  /**
   * 添加 Agent 处理过程项
   */
  function addAgentProcess(agentSessionId: string, item: AgentProcessItem): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return

    state.agentProcess.push(item)
  }

  /**
   * 把用户的插话记进时间线。
   *
   * 记在**当前位置**而不是消息列表末尾：插话发生在某两步之间，挂到最后的话
   * 后面 agent 又干了十件事，那句话却永远浮在屏幕最下方，看起来像是没被处理。
   *
   * 返回 false 表示这个会话没有正在跑的流 —— 调用方据此退回普通用户气泡。
   *
   * `steerId` 是主进程给的号，撤回时要拿它指认是哪一条。没有它（主进程那版
   * 还没返回号、或者这条是别处补记的）时间线上就不给撤回按钮 ——
   * 画一个点了必然失败的按钮，比没有按钮更糟。
   *
   * `images` 是随这句话一起插进去的图。记在这里是为了让时间线上看得见 ——
   * 输入框那边发完就清空了，不记的话用户回头看只有一句「照着这张改」，
   * 而「这张」是哪张再也说不清。
   */
  function pushUserSteer(
    agentSessionId: string,
    text: string,
    steerId?: string,
    images?: readonly string[],
    files?: readonly ExcelFileInfo[]
  ): boolean {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return false

    state.agentProcess.push({
      type: 'user-steer',
      data: {
        text,
        applied: false,
        cancelled: false,
        steerId,
        sessionId: agentSessionId,
        ...(images?.length ? { images: [...images] } : {}),
        ...(files?.length ? { files: files.map((file) => ({ ...file })) } : {})
      },
      timestamp: Date.now()
    })
    return true
  }

  /**
   * 用户把这条插话撤回了，内核也确认它没进上下文。
   *
   * 不把这条从时间线上删掉：他确实打了这句话、确实按了发送，
   * 记录里凭空少一段之后没人说得清当时发生过什么，文字本身也一起没了。
   * 就地改成「已撤回」，看得见、拷得走，也不会被误读成还在等生效。
   */
  function markSteerCancelled(agentSessionId: string, steerId: string): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state || !steerId) return

    for (const item of state.agentProcess) {
      if (item.type !== 'user-steer') continue
      if (item.data?.steerId !== steerId) continue
      item.data.cancelled = true
      return
    }
  }

  /**
   * 标记某条插话已经被内核读进上下文。
   *
   * pi 在把排队的插话注入对话时会为它发一条 `message_end`（role=user），
   * 那是「真的进去了」的唯一确凿信号 —— IPC 那个 success 只代表**入队成功**。
   *
   * 按文本匹配最早一条还没生效的插话：同一句话连插两次时，先进的先生效。
   * 撤回掉的跳过 —— 同一句话插两次撤了头一条时，生效的必须记在还留着的那条上。
   */
  function markSteerApplied(agentSessionId: string, text: string): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return

    const target = text.trim()
    if (!target) return

    for (const item of state.agentProcess) {
      if (item.type !== 'user-steer') continue
      if (item.data?.applied || item.data?.cancelled) continue
      if (String(item.data?.text ?? '').trim() !== target) continue
      item.data.applied = true
      return
    }
  }

  /**
   * 把 agent 的一次反问记进时间线。
   *
   * 按 toolCallId 去重：刷新页面之后主进程会**补发**一遍还挂着的提问
   * （见 `host/questionChannel.ts` 的 `resendPendingQuestions`），不去重的话
   * 时间线上会长出两张一模一样的卡片，用户答了其中一张，另一张还在那儿等。
   *
   * 返回 false 表示这个会话没有正在跑的流 —— 调用方据此知道这张卡片没地方放。
   */
  function pushQuestion(agentSessionId: string, item: AgentQuestionItem): boolean {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return false

    const existing = state.agentProcess.some(
      (entry) => entry.type === 'question' && entry.data?.toolCallId === item.toolCallId
    )
    if (existing) return true

    // 把 sessionId 一起存进条目：卡片渲染自消息里的 agentProcess，
    // 那份数据不带会话上下文，而用户点「提交」时必须有它才能把答案送回去
    state.agentProcess.push({
      type: 'question',
      data: { ...item, sessionId: agentSessionId },
      timestamp: Date.now()
    })
    return true
  }

  /**
   * 记下用户对某次反问的处置。
   *
   * 就地改那一条，卡片因此**留在原地**变成只读态 —— 用户回头能看到自己当初
   * 选了什么。挪走或者删掉的话，他后来想确认「为什么做成这样」时就没有凭据了。
   */
  function resolveQuestion(
    agentSessionId: string,
    toolCallId: string,
    action: AgentQuestionAction,
    answers?: string[]
  ): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return

    for (const entry of state.agentProcess) {
      if (entry.type !== 'question' || entry.data?.toolCallId !== toolCallId) continue
      entry.data = { ...entry.data, action, ...(answers ? { answers } : {}) }
      return
    }
  }

  /**
   * 这条会话有没有一张还没答的提问卡片。**按 chatSid 查**，给侧边栏用。
   *
   * 为什么需要它：`ask_user` 没有超时（见主进程 `host/questionChannel.ts`），
   * 没人回答就一直等着。那是有意的 —— 宁可卡着也不替用户做关键选择。代价是
   * 一次没被注意到的提问会让会话无声占着不放，而**唯一的提示是时间线上那张卡片**，
   * 用户切到别的会话就再也看不见。
   *
   * 判据是「有 question 条目且还没有 action」：`resolveQuestion` 在用户答完时写上
   * action，`closePendingQuestions` 在会话收尾时按 cancel 封掉 —— 两条路都会让
   * 这里自然变回 false，不需要额外的清理点。
   */
  function hasPendingQuestion(chatSid: string): boolean {
    const state = streams.get(chatSid)
    if (!state) return false
    return state.agentProcess.some((entry) => entry.type === 'question' && !entry.data?.action)
  }

  /**
   * 会话收尾时，把还挂着的提问卡片按「没有回答」封掉。
   *
   * 不封的话有两个后果，而且都发生在用户看不见原因的时候：
   *
   *   1. 主进程那边这次提问其实已经结束了（超时、用户按停止、模型自己收手），
   *      而屏幕上的卡片还写着「等你回答」，点了没有任何反应；
   *   2. 这条消息会带着「待回答」的状态落盘，下次打开应用还是那副样子 ——
   *      而那次对话早就结束了。
   *
   * 返回封掉了几条，调用方用来写日志。
   */
  function closePendingQuestions(agentSessionId: string): number {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return 0

    let closed = 0
    for (const entry of state.agentProcess) {
      if (entry.type !== 'question' || entry.data?.action) continue
      entry.data = { ...entry.data, action: 'cancel' }
      closed += 1
    }
    return closed
  }

  /**
   * 更新最后一个 Agent 处理过程项
   */
  function updateLastAgentProcess(
    agentSessionId: string,
    updates: Partial<AgentProcessItem>
  ): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state || state.agentProcess.length === 0) return

    const lastItem = state.agentProcess[state.agentProcess.length - 1]
    Object.assign(lastItem, updates)
  }

  /**
   * 处理流式结束前的缓冲区内容
   */
  function flushBuffer(agentSessionId: string): string {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return ''

    // 处理剩余的缓冲区内容
    if (state.buffer.length > 0) {
      const flushed = state.buffer
      state.buffer = ''
      if (!state.inThinkingBlock) {
        state.currentText += flushed
        // 时间线也要收到这一截。flushBuffer 正是在工具调用**之前**被调的，
        // 漏掉的话这句话会被记到下一段里，显示成「先调工具后说话」——顺序反了
        appendTimelineText(state, flushed)
      } else {
        appendThinkingTo(state, flushed)
      }
      return flushed
    }
    return ''
  }

  /**
   * 标记流式结束
   */
  function endStream(agentSessionId: string): AgentStreamState | undefined {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return undefined

    state.isStreaming = false
    console.log('[AgentStreamStore] 流式结束:', {
      chatSid: state.chatSid,
      agentSessionId,
      textLength: state.currentText.length
    })

    return state
  }

  /**
   * 清理流式状态（流式完全结束后调用）
   */
  function cleanupStream(agentSessionId: string): void {
    const chatSid = sessionToChatSid.get(agentSessionId)
    if (chatSid) {
      streams.delete(chatSid)
      console.log('[AgentStreamStore] 清理流式状态:', { chatSid, agentSessionId })
    }
    sessionToChatSid.delete(agentSessionId)
  }

  /**
   * 获取当前文本（用于UI显示）
   */
  function getCurrentText(chatSid: string): string {
    return streams.get(chatSid)?.currentText ?? ''
  }

  /**
   * 获取当前思考内容（用于UI显示）
   */
  function getCurrentThinking(chatSid: string): string {
    return streams.get(chatSid)?.currentThinking ?? ''
  }

  /**
   * 获取 Agent 处理过程（用于UI显示）
   */
  function getAgentProcess(chatSid: string): AgentProcessItem[] {
    return streams.get(chatSid)?.agentProcess ?? []
  }

  /**
   * 获取 typing 消息 ID
   */
  function getTypingId(chatSid: string): string | null {
    return streams.get(chatSid)?.currentTypingId ?? null
  }

  /**
   * 设置执行上下文（用于历史注入）
   */
  function setExecutionContext(
    agentSessionId: string,
    context: ExecutionContext | undefined
  ): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) {
      console.warn('[AgentStreamStore] setExecutionContext: 找不到流式状态:', agentSessionId)
      return
    }

    // 合并上下文（如果已有内容，追加而非替换）
    if (context && state.executionContext) {
      // 合并资产
      if (context.searchedAssets) {
        state.executionContext.searchedAssets = [
          ...(state.executionContext.searchedAssets || []),
          ...context.searchedAssets
        ].slice(0, 10) // 限制最多10个
      }
      // 覆盖项目信息（使用最新的）
      if (context.projectInfo) {
        state.executionContext.projectInfo = context.projectInfo
      }
      // 合并创建的对象
      if (context.createdObjects) {
        state.executionContext.createdObjects = [
          ...(state.executionContext.createdObjects || []),
          ...context.createdObjects
        ].slice(0, 10)
      }
      // 合并工具摘要
      if (context.toolSummary) {
        state.executionContext.toolSummary = [
          ...(state.executionContext.toolSummary || []),
          ...context.toolSummary
        ].slice(0, 20)
      }
    } else {
      state.executionContext = context
    }

    console.log('[AgentStreamStore] 执行上下文已更新:', {
      agentSessionId,
      searchedAssets: state.executionContext?.searchedAssets?.length || 0,
      hasProjectInfo: !!state.executionContext?.projectInfo,
      createdObjects: state.executionContext?.createdObjects?.length || 0,
      toolSummary: state.executionContext?.toolSummary?.length || 0
    })
  }

  /**
   * 获取执行上下文
   */
  function getExecutionContext(agentSessionId: string): ExecutionContext | undefined {
    return getStreamByAgentSession(agentSessionId)?.executionContext
  }

  /**
   * 累加一次模型往返的用量。
   *
   * 流式状态没了就丢弃：这只发生在事件比 `initStream` 早到、或者会话已经清理
   * 之后还有零星事件的时候，为了一个统计数字硬造一份状态不值得。
   */
  function addTurnUsage(agentSessionId: string, usage: AgentTurnUsage): void {
    const state = getStreamByAgentSession(agentSessionId)
    if (!state) return
    state.turnUsage = mergeTurnUsage(state.turnUsage, usage)
  }

  /** 本轮累计用量。全 0 时返回 undefined —— 调用方据此决定要不要显示 */
  function getTurnUsage(agentSessionId: string): AgentTurnUsage | undefined {
    const usage = getStreamByAgentSession(agentSessionId)?.turnUsage
    return hasTurnUsage(usage) ? { ...(usage as AgentTurnUsage) } : undefined
  }

  return {
    // State
    streams,
    sessionToChatSid,

    // Getters
    getStream,
    isStreaming,
    isBusy,
    markAwaitingRelease,
    clearAwaitingRelease,
    getChatSidByAgentSession,
    getStreamByAgentSession,
    getCurrentText,
    getCurrentThinking,
    getAgentProcess,
    getTypingId,

    // Actions
    initStream,
    appendText,
    appendThinking,
    addAgentProcess,
    pushUserSteer,
    markSteerApplied,
    markSteerCancelled,
    pushQuestion,
    hasPendingQuestion,
    resolveQuestion,
    closePendingQuestions,
    updateLastAgentProcess,
    flushBuffer,
    endStream,
    cleanupStream,
    setExecutionContext,
    getExecutionContext,
    addTurnUsage,
    getTurnUsage
  }
})
