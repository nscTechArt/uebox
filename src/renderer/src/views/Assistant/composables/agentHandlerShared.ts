import type { ComputedRef, Ref } from 'vue'
import type { AgentRunController } from '../../../api/ai'
import type { ChatMessage } from '../../../store/modules/chatMessages'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import type { NotebookRagCitation } from './notebookRagContext'

export interface ToolCallEvent {
  toolCalls?: Array<{ name?: string; function?: { name?: string; arguments?: string } }>
  toolName?: string
  args?: Record<string, unknown>
  toolCallId?: string
  sessionId?: string
  messages?: unknown[]
  /** 主进程按这次参数算的风险，见 changeSummary.summarizeChanges */
  risk?: string
}

export interface ToolResultEvent {
  toolName: string
  /** 哪一次调用的结果。并行的 `task` 靠它把结果对回发起它的那一路 */
  toolCallId?: string
  result: any
  /** 工具是否执行失败；「本轮改动」靠它区分「改了」和「想改但失败了」 */
  isError?: boolean
  sessionId?: string
}

export interface NotifyUsersEvent {
  message: string
  type?: string
  sessionId?: string
  timestamp?: number
  specialist?: string
  /**
   * 这条通知来自哪次工具调用。并行的几路子任务进度文本长得一模一样，
   * 没有它就分不出谁在说话（见 `agentSubtasks.ts`）。
   */
  toolCallId?: string
  toolName?: string
}

export interface StepEvent {
  /** 第几轮模型往返。**没有总数** —— V3 不设步数上限 */
  step: number
  sessionId?: string
}

export interface DoneEvent {
  messages?: any[]
  sessionId?: string
  /**
   * 哪一轮结束了（`registerAgentHandler` 返回的号）。
   *
   * 收尾是异步的（要等工具风险表、可能还要让模型补一句反馈），而同一条 agent
   * 会话紧接着就可能开跑下一轮 —— 语音把排队的第二件活派回同一条会话正是如此。
   * 带上这个号，迟到的收尾才知道「这条会话已经不归我管了」，不去拆新那一轮的摊子。
   */
  runId?: number
}

export interface StoppedEvent {
  sessionId?: string
  /** 同 `DoneEvent.runId` */
  runId?: number
}

/**
 * 一轮 Agent 任务最终给调用方的结果。
 *
 * 聊天界面自己消费流式事件；实时语音这类外部入口只需要在收尾时拿到一句
 * 可交回模型的结果，不应该另开一条执行链路。
 */
export interface AgentRunOutcome {
  status: 'done' | 'error' | 'stopped'
  text: string
}

export interface ErrorEvent {
  message: string
  code?: string
  statusCode?: number
  status?: number
  /**
   * 错误体里那句写给人看的话，已经剥掉外面的 JSON（主进程 `providerError.ts` 抠的）。
   *
   * 没有对应友好文案的状态码（400 说模型名不对、上下文超长…）走通用分支，
   * 那里显示这一句而不是整串 `{"error":{"message":…,"type":…,"param":null}}`。
   */
  detail?: string
  /**
   * 调的是创作者 Token Plan、服务端回了套餐类错误（主进程 eventBridge.ts 判的）。
   * 有它就给「管理订阅」「去重新连接」的提示，不走通用文案。别的来源永远没有。
   */
  planError?: string
  sessionId?: string
  /** 同 `DoneEvent.runId` */
  runId?: number
}

export interface AgentModeHandlersDeps {
  sid: Ref<string>
  messages: ComputedRef<ChatMessage[]>
  route: any
  tabsStore: any
  chatStore: any
  chatMsgStore: any
  aiConfigStore: any
  scrollToBottomIfNeeded: () => void
  currentAgentProcess: Ref<AgentProcessItem[]>
  currentSessionId: Ref<string>
  currentAgentController: Ref<AgentRunController | null>
  fullConversationHistory: Ref<any[]>
  currentText: ComputedRef<string>
  currentThinking: ComputedRef<string>
  currentTypingId: ComputedRef<string | null>
  agentStreamStore: any
  t: (key: string) => string
  clearWikiRagState: (sessionId?: string) => void
  getWikiRagCitations: (sessionId?: string) => NotebookRagCitation[]
  shouldDedupNotify: (
    notifyType: string,
    message: string,
    specialist?: string,
    timestamp?: number,
    /** 同一路子任务才算重复；并行的几路进度文本相同但不是重复 */
    toolCallId?: string
  ) => boolean
}

/**
 * 报错气泡上「接着跑」按钮的动作名。
 *
 * 错误处理器负责挂上按钮、页面负责响应，两边都得认同一个字符串 ——
 * 各写各的字面量迟早会有一边改了另一边没改，而那种 bug 表现为"点了没反应"。
 */
export const AGENT_RESUME_ACTION = 'agent-resume'

export function resolveTargetChatSid(
  agentStreamStore: any,
  sid: string,
  sessionId?: string
): string | undefined {
  return sessionId ? agentStreamStore.getChatSidByAgentSession(sessionId) : sid
}

export function getLastAssistantMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return messages[i]
    }
  }
  return undefined
}

export function resolveAssistantMessage(
  messages: ChatMessage[],
  typingId?: string | null
): ChatMessage | undefined {
  if (typingId) {
    const trackedMessage = messages.find((message) => message.id === typingId)
    if (trackedMessage?.role === 'assistant') {
      return trackedMessage
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].status === 'typing') {
      return messages[i]
    }
  }

  return getLastAssistantMessage(messages)
}

export function normalizeToolCalls(data: ToolCallEvent): Array<any> {
  if (Array.isArray(data.toolCalls)) {
    return data.toolCalls
  }

  if (data.toolName) {
    return [
      {
        id: data.toolCallId,
        type: 'function',
        function: {
          name: data.toolName,
          arguments: JSON.stringify(data.args ?? {})
        },
        ...(data.risk ? { risk: data.risk } : {})
      }
    ]
  }

  return []
}
