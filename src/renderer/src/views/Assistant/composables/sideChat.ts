import type { SideChatContext } from '@core/shared/sideChat'

import type { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

/**
 * 侧边问一句：把当前对话的上下文借给 MiniChat 小窗口，在那边只读地问一句。
 *
 * ## 它解决的是哪一刻
 *
 * agent 跑了二十步，屏幕上滚过一堆工具调用，用户想问的是「它现在到底在干嘛」、
 * 「刚才那个材质为什么建了两次」。在主对话里问这句有两个代价：得等它停下来，
 * 而且这句闲聊会永久留在上下文里，之后每一轮都带着它去发请求。
 *
 * 侧边窗口两个都没有 —— 复制一份上下文出去，问完关掉，主对话一个字都不知道。
 *
 * ## 为什么是只读
 *
 * 主对话正跑着的时候，让第二个 agent 也去改同一个工程，等于两个人抢一支笔。
 * 小窗口固定走 `ask` 模式（内核只注册只读工具，见 `createAgent.ts` 的
 * `resolveTools`），它能看能查能解释，但动不了工程。
 */

/** `agentV3API.forkForSideChat` 的返回 */
export interface SideChatForkResult {
  success: boolean
  sessionId?: string
  messageCount?: number
  live?: boolean
  reason?: 'empty' | 'error'
  error?: string
}

export type SideChatOutcome =
  | { ok: true; context: SideChatContext }
  | { ok: false; reason: 'no-agent-session' | 'empty' | 'error'; error?: string }

export interface SideChatDeps {
  chatStore: ReturnType<typeof useChatSessionsStore>
  /** 复制内核 transcript，返回新的 agentSessionId */
  fork: (agentSessionId: string) => Promise<SideChatForkResult>
  /** 把上下文交给小窗口并打开它 */
  open: (context: SideChatContext) => void
}

export async function openSideChat(chatSid: string, deps: SideChatDeps): Promise<SideChatOutcome> {
  const source = deps.chatStore.sessionById(chatSid)
  const agentSessionId = source?.agentSessionId

  // 没有内核会话就没有上下文可借。这时候开侧边窗口，模型手上和新开一个
  // 对话没有区别 —— 不如直说，别让用户对着一个空窗口以为它知道些什么
  if (!source || !agentSessionId) {
    return { ok: false, reason: 'no-agent-session' }
  }

  let forked: SideChatForkResult
  try {
    forked = await deps.fork(agentSessionId)
  } catch (error) {
    return { ok: false, reason: 'error', error: (error as Error).message }
  }

  if (!forked.success || !forked.sessionId) {
    return {
      ok: false,
      reason: forked.reason === 'empty' ? 'empty' : 'error',
      error: forked.error
    }
  }

  const context: SideChatContext = {
    agentSessionId: forked.sessionId,
    messageCount: forked.messageCount ?? 0,
    sourceTitle: source.title,
    live: forked.live === true
  }

  deps.open(context)
  return { ok: true, context }
}
