/**
 * 重发之前，把内核 transcript 倒回到重发那一刻该有的样子。
 *
 * ## 为什么「重新生成」不倒回去就是错的
 *
 * 一段对话在这个应用里有**两份**记录：界面那份（`chatMessages` store，气泡）
 * 和内核那份（`agent-v3-sessions/*.jsonl`，主进程每轮 execute 都从盘上恢复）。
 * 点「重新生成」只删了气泡，内核那份原封不动 —— 于是模型看着自己刚被用户丢掉
 * 的那个答案，被要求再答一遍同一个问题。用户以为是重来，对模型而言是追问，
 * 答出来常常是「如前所述……」。编辑消息同理。
 *
 * ## 对齐靠「第几个用户回合」
 *
 * 两边的下标对不上：界面一轮是一条用户气泡加一条回复气泡，内核一轮是 1 条 user
 * 加 n 条 assistant/toolResult（n 随这一轮调了几次工具变）。能对上的只有
 * 「这是第几个用户回合」，所以两边都按它切 —— 内核那半在
 * `main/agent-v3/core/transcriptStore.ts` 的 `sliceToUserTurns`。
 *
 * 同一套对齐也撑着会话分支（`sessionFork.ts`）：retry 每污染一次 transcript，
 * 这个数就错一位，分支就会截错地方。
 */

/** 内核截断的结果，与 `agentV3API.truncateSession` 的返回一致 */
export interface TruncateTranscriptResult {
  success: boolean
  messageCount?: number
  dropped?: number
  reason?: 'busy' | 'missing'
  error?: string
}

/**
 * 数出 `messages[0 .. before - 1]` 里有几条用户消息。
 *
 * `before` 传的是**要重发的那条用户消息的下标** —— 它本身不算，因为重发会把它
 * 作为新的一轮再发一次；算进去的话内核里就会出现两条一样的提问。
 */
export function countUserTurnsBefore(messages: { role: string }[], before: number): number {
  if (before <= 0) return 0
  return messages.slice(0, before).filter((m) => m.role === 'user').length
}

/**
 * 把内核 transcript 截回 `keepUserTurns` 个用户回合。
 *
 * **失败不拦重发。** 截断是为了让这一轮问得干净，不是重发的前置条件；
 * 因为它没成而把用户点的「重新生成」按下不动，比多带一轮旧上下文糟得多。
 * 所以这里只在出问题时留一条日志，返回值给测试和调用方参考。
 *
 * 没有 agentSessionId 的会话（普通对话、知识库聊天）根本没有内核那份历史，
 * 直接跳过。
 */
export async function rewindTranscript(
  agentSessionId: string | null | undefined,
  keepUserTurns: number,
  truncate: (sessionId: string, keepUserTurns: number) => Promise<TruncateTranscriptResult>
): Promise<TruncateTranscriptResult | undefined> {
  if (!agentSessionId) return undefined

  try {
    const result = await truncate(agentSessionId, keepUserTurns)
    // 'missing' 是正常的：这条会话还没落过盘（第一轮就点了重新生成），
    // 本来就没有多余的历史要截
    if (!result.success && result.reason !== 'missing') {
      console.warn(
        `[会话回退] transcript 截断失败（${result.reason ?? result.error}），` +
          '这一轮模型可能还带着被丢弃的上下文'
      )
    }
    return result
  } catch (error) {
    console.error('[会话回退] transcript 截断异常:', error)
    return { success: false, error: (error as Error).message }
  }
}
