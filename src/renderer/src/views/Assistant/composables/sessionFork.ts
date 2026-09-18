/**
 * 会话分支：从**被点的那条回复**分叉出一条新会话，之后两边各聊各的。
 *
 * ## 为什么要分支
 *
 * 一段对话聊到第五轮，想退回第三轮换个方向试（「这个蓝图用接口做」vs
 * 「用组件做」），不做分支只能新建会话重讲一遍背景。分支复制到分叉点为止：
 * 新会话带着那之前的全部来龙去脉，之后的问答不跟过来，旧会话原地不动。
 *
 * ## 两份历史要一起截、截在同一个位置
 *
 * 内核有一份（`agent-v3-sessions/*.jsonl`，主进程按 sessionId 恢复），界面
 * 有一份（`chatMessages` store，气泡、过程日志都在里面）。只截界面那份的话
 * 模型还记得被砍掉的那几轮 —— 用户看着干净的历史，模型张口就是「刚才说过」，
 * 分支等于没分。反过来只截内核那份则是用户看得见、模型不认账。
 *
 * 两边的下标对不上（界面一轮一个气泡，内核一轮是 1 条 user 加 n 条
 * assistant/toolResult），所以对齐用的是**第几个用户回合**，见
 * `main/agent-v3/core/transcriptStore.ts` 的 `sliceToUserTurns`。
 *
 * ## 会话跑着的时候
 *
 * 从**更早的一轮**分支照常可用，源会话继续输出（内核那边读内存里那份历史，
 * 见 `ipc/agentV3.ts` 的 `liveForkSource`）—— 「聊到第六轮发现第三轮就走错了」
 * 正是分支最该用的时刻，让用户先等这轮完等于功能在这一刻是关的。
 * 只有整份复制（点最后一条）和切点落在这一轮里才回 `busy`：那时截出来的历史
 * 和用户看见的对不上。
 */

import type { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import type { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

/** 内核 transcript 分支的结果，与 `agentV3API.forkSession` 的返回一致 */
export interface ForkTranscriptResult {
  success: boolean
  sessionId?: string
  messageCount?: number
  reason?: 'busy' | 'missing'
  error?: string
}

export type SessionForkOutcome =
  | { ok: true; chatSid: string; agentSessionId: string }
  | { ok: false; reason: 'no-agent-session' | 'busy' | 'missing' | 'error'; error?: string }

export interface SessionForkDeps {
  chatStore: ReturnType<typeof useChatSessionsStore>
  chatMsgStore: ReturnType<typeof useChatMessagesStore>
  /**
   * 复制内核 transcript，返回新 agentSessionId。
   * `keepUserTurns` 不给表示整份复制。
   */
  forkTranscript: (agentSessionId: string, keepUserTurns?: number) => Promise<ForkTranscriptResult>
  /** 新会话的 chatSid（crypto.randomUUID()） */
  newChatSid: () => string
  /** 分支会话的标题 */
  branchTitle: (sourceTitle: string) => string
  /** 分支建好后切换过去 */
  navigate: (chatSid: string) => void
}

/** 分叉点：界面消息切到哪一条，内核 transcript 留几个用户回合 */
interface ForkPoint {
  upToIndex?: number
  keepUserTurns?: number
}

/**
 * 把「点了哪条气泡」翻译成两边各自的截断位置。
 *
 * 找不到那条消息（id 没传、消息已被删）时**退回整份复制**而不是报错：
 * 分支这个动作本身没错，只是不知道该截在哪，全带过去总比什么都不给强。
 * 点的是最后一条时同样不截 —— 那时截和不截是同一个结果，少走一趟切片。
 */
function resolveForkPoint(messages: { id: string; role: string }[], messageId?: string): ForkPoint {
  if (!messageId) return {}

  const index = messages.findIndex((m) => m.id === messageId)
  if (index < 0 || index === messages.length - 1) return {}

  return {
    upToIndex: index,
    keepUserTurns: messages.slice(0, index + 1).filter((m) => m.role === 'user').length
  }
}

/**
 * 把 `agentHistory` 截到第 `keepUserTurns` 个用户回合结束。
 *
 * 和内核那边的 `sliceToUserTurns` 同一个规则、不同的数据 —— 这份是渲染层
 * 自己留的对话镜像（只有 user/assistant 两种角色），没有工具消息要配对。
 */
function sliceHistoryToUserTurns<T extends { role: string }>(
  history: T[],
  keepUserTurns: number
): T[] {
  let seen = 0
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== 'user') continue
    seen++
    if (seen > keepUserTurns) return history.slice(0, i)
  }
  return history
}

/**
 * 从 `messageId` 这条回复创建分支。
 *
 * `messageId` 不传就是整份复制（老行为，给没有分叉点概念的调用方留的）。
 *
 * 失败时**不碰会话列表**：内核分支成功之后才建界面会话，而界面这边的
 * 复制全在内存里，没有半途失败的可能。
 */
export async function forkSession(
  chatSid: string,
  deps: SessionForkDeps,
  messageId?: string
): Promise<SessionForkOutcome> {
  const source = deps.chatStore.sessionById(chatSid)
  const agentSessionId = source?.agentSessionId
  // 普通（非 Agent）会话没有 transcript 可复制 —— 知识库聊天等 chat-only
  // 界面走的正是这条路，它们天然分不出分支
  if (!source || !agentSessionId) {
    return { ok: false, reason: 'no-agent-session' }
  }

  const { upToIndex, keepUserTurns } = resolveForkPoint(
    deps.chatMsgStore.getMessages(chatSid),
    messageId
  )

  let forked: ForkTranscriptResult
  try {
    forked = await deps.forkTranscript(agentSessionId, keepUserTurns)
  } catch (error) {
    // IPC 抛出来的是意外故障（disk full、句柄泄漏……），不是可引导用户
    // 重试的业务状态 —— 归到 error，原文带回去打日志
    return { ok: false, reason: 'error', error: (error as Error).message }
  }
  if (!forked.success || !forked.sessionId) {
    return {
      ok: false,
      reason: forked.reason === 'busy' ? 'busy' : forked.reason === 'missing' ? 'missing' : 'error',
      error: forked.error
    }
  }

  const newChatSid = deps.newChatSid()
  deps.chatStore.createSession(newChatSid, deps.branchTitle(source.title))

  // 归属工程、Agent 模式、上下文用量跟着带过去 —— 分支不是新话题，
  // 「在哪个工程里聊」「用哪种模式」不该重置
  deps.chatStore.setProject(newChatSid, source.project ?? null)
  deps.chatStore.setAgentMode(newChatSid, source.agentMode ?? true)
  // 截过的分支上下文比源会话短，把源那个数字抄过来会虚高 —— 下一轮内核会报
  // 真实用量盖掉它，但在那之前用户看到的是个假的百分比。不如先不显示。
  if (source.contextUsage && keepUserTurns === undefined) {
    deps.chatStore.setContextUsage(newChatSid, source.contextUsage)
  }
  if (source.agentHistory && source.agentHistory.length > 0) {
    // JSON 往返深拷贝：agentHistory 是响应式代理，structuredClone 克隆不了。
    // 它和界面消息是同一段对话的两份记录，截也得截在同一处。
    const history = JSON.parse(JSON.stringify(source.agentHistory)) as { role: string }[]
    deps.chatStore.setAgentHistory(
      newChatSid,
      keepUserTurns === undefined ? history : sliceHistoryToUserTurns(history, keepUserTurns)
    )
  }
  deps.chatStore.setAgentSessionId(newChatSid, forked.sessionId)

  deps.chatMsgStore.copySessionMessages(chatSid, newChatSid, upToIndex)

  deps.navigate(newChatSid)
  return { ok: true, chatSid: newChatSid, agentSessionId: forked.sessionId }
}
