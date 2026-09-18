/**
 * 删除一条会话 —— 把它在**所有**地方的痕迹一起清掉。
 *
 * ## 为什么要单独一个文件
 *
 * 一条会话的数据散在三个地方，各有各的主人：
 *
 * | 存的是什么 | 存在哪 | 谁写 |
 * |---|---|---|
 * | 界面上的气泡 | localStorage | `chatMessages` store |
 * | 会话本身（标题、置顶、归属工程） | localStorage | `chatSessions` store |
 * | 内核的记忆 | 主进程 `agent-v3-sessions/*.jsonl` | `TranscriptStore` |
 *
 * 原来侧边栏的删除只做了中间那一件事（`removeSession` 就是一句 splice），
 * 结果是：列表里不见了，消息还在 localStorage 里，JSONL 还在盘上。用户以为
 * 删掉了，实际没有 —— 涉及隐私的时候这不是「不够干净」，是删除功能不成立。
 *
 * 同一个道理在「清空对话」那条路径上早就写明白了（见 useAgentMode 的
 * `clearConversationHistory`：只清界面的话，用户看到屏幕空了，模型却还记得
 * 刚才说的每一句），删除这条路漏了。
 *
 * ## 顺序
 *
 * 先删盘上的，再清界面。反过来的话，万一中间应用崩了，留下的是一个**看不见
 * 但还在**的 JSONL；按现在的顺序，最坏也只是列表里留一条没有内核记忆的空会话
 * —— 用户看得见，还能再删一次。
 */

import { isSessionTab } from '@renderer/common/chatRoute'

export interface ChatSessionTab {
  key: string
  path: string
}

export interface DeleteChatSessionDeps {
  sessionId: string
  /** 会话绑定的内核会话 id。没有表示这条会话从没跑过 Agent，盘上没有 JSONL */
  agentSessionId?: string
  deleteTranscript: (agentSessionId: string) => Promise<{ success?: boolean; error?: string }>
  dropMessages: (sessionId: string) => void
  removeSession: (sessionId: string) => void
  listTabs: () => ChatSessionTab[]
  closeTab: (tabKey: string) => void
}

/** 批量删除的一个目标 */
export interface ChatSessionDeleteTarget {
  sessionId: string
  agentSessionId?: string
}

export interface DeleteChatSessionsDeps {
  targets: ChatSessionDeleteTarget[]
  deleteTranscript: (agentSessionId: string) => Promise<{ success?: boolean; error?: string }>
  /** 一次性清掉这组会话的界面消息 —— 每个 store 只许变更一次 */
  dropSessions: (sessionIds: string[]) => void
  removeSessions: (sessionIds: string[]) => void
  listTabs: () => ChatSessionTab[]
  closeTab: (tabKey: string) => void
}

export interface DeleteChatSessionResult {
  /** 内核记忆删失败时的原因；成功或本来就没有则为空 */
  transcriptError?: string
  /** 顺带关掉的标签页数量 */
  closedTabs: number
}

export interface DeleteChatSessionsResult {
  /** 内核记忆删失败的会话的原因列表；成功或本来都没有则为空 */
  transcriptErrors: string[]
  /** 顺带关掉的标签页数量 */
  closedTabs: number
}

/**
 * 批量删除一组会话 —— 把它们在**所有**地方的痕迹一起清掉。
 *
 * 清的东西和单条版一样（内核记忆、界面消息、会话本身、遗留标签页），但
 * **界面那几处必须一次清完**：消息和会话两个 store 每次变更都会把整个库
 * 序列化进 localStorage，逐条删的话 N 条会话就是 N 次全量写盘压在主线程上，
 * 几百条会话能把界面卡住一分钟。
 *
 * ## 顺序
 *
 * 先删盘上的（并行），再清界面。反过来的话，万一中间应用崩了，留下的是
 * 一批**看不见但还在**的 JSONL；按现在的顺序，最坏也只是列表里留几条没有
 * 内核记忆的空会话 —— 用户看得见，还能再删一次。
 */
export async function deleteChatSessions(
  deps: DeleteChatSessionsDeps
): Promise<DeleteChatSessionsResult> {
  const targets = deps.targets.filter((target) => target.sessionId)
  if (targets.length === 0) return { transcriptErrors: [], closedTabs: 0 }

  // 内核记忆先删。个别删失败也继续往下走 —— 会话已经在用户眼里"删了"，
  // 把它留在列表里只会让人以为点击没生效；失败原因由返回值交给调用方去说。
  const transcriptErrors: string[] = []
  await Promise.all(
    targets.map(async (target) => {
      if (!target.agentSessionId) return

      try {
        const result = await deps.deleteTranscript(target.agentSessionId)
        if (result?.error) transcriptErrors.push(result.error)
      } catch (error) {
        transcriptErrors.push(error instanceof Error ? error.message : String(error))
      }
    })
  )

  // 每个 store 只动一次：这是这条函数和「循环调单条版」的全部区别
  const sessionIds = targets.map((target) => target.sessionId)
  deps.dropSessions(sessionIds)
  deps.removeSessions(sessionIds)

  // 留着的标签页会**把会话复活**：那条 URL 还带着 `?sid=`，一点开就
  // ensureSession 出一条同名空会话，看起来像是删除没生效。
  const staleTabs = deps
    .listTabs()
    .filter((tab) => sessionIds.some((id) => isSessionTab(tab.path, id)))
  staleTabs.forEach((tab) => deps.closeTab(tab.key))

  return { transcriptErrors, closedTabs: staleTabs.length }
}

/**
 * 单条删除 = 批量删除的 target 只有一个。
 *
 * 界面 store 的逐条回调在批量版内部本来就是一次调用的，行为和契约
 * （返回值、调用顺序）与直接实现完全一致。
 */
export async function deleteChatSession(
  deps: DeleteChatSessionDeps
): Promise<DeleteChatSessionResult> {
  const result = await deleteChatSessions({
    targets: [{ sessionId: deps.sessionId, agentSessionId: deps.agentSessionId }],
    deleteTranscript: deps.deleteTranscript,
    dropSessions: (ids) => ids.forEach((id) => deps.dropMessages(id)),
    removeSessions: (ids) => ids.forEach((id) => deps.removeSession(id)),
    listTabs: deps.listTabs,
    closeTab: deps.closeTab
  })

  return { transcriptError: result.transcriptErrors[0], closedTabs: result.closedTabs }
}
