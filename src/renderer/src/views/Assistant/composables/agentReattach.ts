/**
 * 刷新页面之后，把界面重新接回还在跑的会话。
 *
 * ## 为什么需要这一步
 *
 * agent 活在**主进程**（`main/ipc/agentV3.ts` 的 `activeAgents`），渲染层只是
 * 「显示器」：发一次 `agent-v3:execute`，然后听事件把字画上去。`location.reload()`
 * 重启的只有显示器 —— 模型还在推理，工具还在执行，transcript 还在往盘上写。
 *
 * 但渲染层丢了三样东西：invoke 的返回 Promise、「哪条消息正在打字」的内存状态、
 * 以及 sessionId ↔ 对话的对应关系。以前的做法是**猜**：恢复缓存时把所有残留的
 * typing 消息一律标成「会话已中断（页面刷新）」。猜错的那一半后台还在跑，甚至
 * 还在改用户的工程；而 `activeAgents` 里那个位置还占着，用户刷新后立刻再说一句，
 * 会被顶回来一句「会话正在执行中」。
 *
 * 这里补上那次缺失的询问：报上界面记得的会话，主进程回哪些真的活着。
 *
 * ## 收尾保证
 *
 * 问不到主进程（IPC 挂了、非 Electron 环境跑起来的界面）时退回老行为 ——
 * 全部标中断。宁可多贴一次「已中断」，也不能留下永远转圈的气泡。
 */

import {
  takeHydratedTypingMessages,
  useChatMessagesStore,
  type ChatMessage,
  type HydratedTypingMessage
} from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { agentV3API } from '@renderer/api/agentV3'
import { isTypingPlaceholder } from '@renderer/utils/typingPlaceholder'

/**
 * 接回来时从哪儿续写。
 *
 * 占位符**不是模型说过的话**，一个字都不能带进 `currentText`：带进去之后
 * 刷新后的正文会接在它后面继续累积，而过程时间线里没有这个前缀 ——
 * 两边一旦对不上，界面就会在时间线下面把整条回复重新画一遍
 * （见 `agentTimeline.ts` 的 `resolveTrailingContent`）。
 *
 * 这一步曾经拿硬写的 `'正在思考...'` 去比，而 agent 那条路写进消息的是
 * 翻译过的那一句，比不中，重影就是这么来的。判定统一交给
 * `isTypingPlaceholder`，它认全部语言的写法。
 */
export function resolveReattachSeed(message?: Pick<ChatMessage, 'content'>): string {
  const content = message?.content
  if (typeof content !== 'string') return ''
  return isTypingPlaceholder(content) ? '' : content
}

export interface ReattachedSession {
  chatSid: string
  agentSessionId: string
  /** 这条会话正在写的那条回复 */
  messageId: string
}

export interface ReconcileDeps {
  /** 恢复缓存时发现的、还挂在 typing 上的回复 */
  pending: HydratedTypingMessage[]
  /** 这条对话记着的 agent 会话 id；空字符串表示它不是 agent 跑出来的 */
  agentSessionIdOf: (chatSid: string) => string
  /** 问主进程：这些会话里哪些还活着 */
  fetchRunning: (sessionIds: string[]) => Promise<string[]>
  /** 接回来：把流式状态重新建起来，让后续事件有地方落 */
  reattach: (session: ReattachedSession) => void
  /** 确认死了才标中断 */
  markInterrupted: (chatSid: string, messageId: string) => void
}

export interface ReconcileResult {
  reattached: ReattachedSession[]
  interrupted: HydratedTypingMessage[]
}

/**
 * 逐条裁决刷新时残留的回复。
 *
 * 同一个对话里出现多条 typing 时，只有**最后一条**可能是活的（会话一次只跑一轮），
 * 前面那些是更早的刷新留下的尸体，一律标中断 —— 否则它们会永远转圈。
 */
export async function reconcileTypingMessages(deps: ReconcileDeps): Promise<ReconcileResult> {
  const result: ReconcileResult = { reattached: [], interrupted: [] }
  if (deps.pending.length === 0) return result

  // 每个对话只保留最后一条 typing 作为候选
  const candidateByChat = new Map<string, HydratedTypingMessage>()
  const stale: HydratedTypingMessage[] = []
  for (const item of deps.pending) {
    const previous = candidateByChat.get(item.sid)
    if (previous) stale.push(previous)
    candidateByChat.set(item.sid, item)
  }

  const sessionIdByChat = new Map<string, string>()
  for (const chatSid of candidateByChat.keys()) {
    const agentSessionId = deps.agentSessionIdOf(chatSid)
    if (agentSessionId) sessionIdByChat.set(chatSid, agentSessionId)
  }

  let running = new Set<string>()
  if (sessionIdByChat.size > 0) {
    try {
      running = new Set(await deps.fetchRunning([...sessionIdByChat.values()]))
    } catch (error) {
      // 问不到就按「都停了」处理：贴一次「已中断」比留下转圈的气泡好交代
      console.warn('[AgentReattach] 查询运行中的会话失败，按全部中断处理:', error)
    }
  }

  for (const [chatSid, item] of candidateByChat) {
    const agentSessionId = sessionIdByChat.get(chatSid)
    if (agentSessionId && running.has(agentSessionId)) {
      result.reattached.push({ chatSid, agentSessionId, messageId: item.messageId })
      continue
    }
    stale.push(item)
  }

  for (const item of stale) {
    deps.markInterrupted(item.sid, item.messageId)
    result.interrupted.push(item)
  }
  for (const session of result.reattached) {
    deps.reattach(session)
  }

  return result
}

type ReattachListener = (session: ReattachedSession) => void

const listeners = new Set<ReattachListener>()

/**
 * 订阅「某条对话被接回来了」。
 *
 * 存在的理由是时序：重连要等一次 IPC 往返，而聊天界面通常在那之前就挂载完了。
 * 界面挂载时自己查一遍流式状态（`useAgentMode` 里做的），加上这个回调兜住
 * 「先挂载、后接回」的那一半，两边合起来才不会漏。
 */
export function onAgentReattached(listener: ReattachListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 应用启动时跑一次。必须在 `app.use(pinia)` 之后 —— 这里第一次取 store，
 * 顺带触发缓存恢复，`takeHydratedTypingMessages()` 才拿得到东西。
 */
export async function initAgentReattach(): Promise<void> {
  // Spotlight 是同一份界面的另一个窗口，它不显示对话，却和主窗口共用 localStorage。
  // 让它也来裁决的话，它问主进程只会得到「你名下没有会话」（事件是往主窗口发的），
  // 于是把主窗口正在跑的那条判死，再顺手写回盘上。这个判断不归它做。
  if (window.location.hash.includes('spotlight')) return

  const chatMsgStore = useChatMessagesStore()
  const chatStore = useChatSessionsStore()
  const streamStore = useAgentStreamStore()

  const pending = takeHydratedTypingMessages()
  if (pending.length === 0) return

  const result = await reconcileTypingMessages({
    pending,
    agentSessionIdOf: (chatSid) => chatStore.getAgentSessionId(chatSid),
    fetchRunning: async (sessionIds) => (await agentV3API.reattach(sessionIds)).sessionIds,
    markInterrupted: (chatSid, messageId) => chatMsgStore.markTypingInterrupted(chatSid, messageId),
    reattach: ({ chatSid, agentSessionId, messageId }) => {
      const message = chatMsgStore.getMessages(chatSid).find((item) => item.id === messageId)
      const written = resolveReattachSeed(message)

      // 带着刷新前那半截正文和时间线起步，否则后续增量会把它们整段盖掉
      streamStore.initStream(chatSid, agentSessionId, messageId, {
        text: written,
        thinking: message?.thinking,
        agentProcess: message?.agentProcess
      })
      // 接回来的这条**本来就还占着**主进程那边的位子 —— 刷新只重启了界面。
      // 不标的话它收到 `done` 之后、`released` 之前会被当成空闲，
      // 那个空档里排队投递发出去会被顶回来，而消息已经出队了
      streamStore.markAwaitingRelease(chatSid, agentSessionId)

      for (const listener of listeners) {
        listener({ chatSid, agentSessionId, messageId })
      }
    }
  })

  console.log(
    `[AgentReattach] 接回 ${result.reattached.length} 条运行中的会话，` +
      `标记中断 ${result.interrupted.length} 条`
  )
}
