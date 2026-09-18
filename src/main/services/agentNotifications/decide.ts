/**
 * 「这条信号该不该弹通知，弹什么」—— 纯逻辑，不碰 Electron。
 *
 * 单独拆出来是为了可测。判定里最容易错的两处都不会抛任何异常：
 * 弹多了是骚扰（用户会把整个功能关掉），弹少了是**用户在等一个永远不来的提醒**
 * ——而审批超时五分钟按拒绝算，那五分钟里他完全不知道有个确认框在等他。
 */

import type { AgentRunSignal } from '../../agent-v3/host/runObserver'
import type { TurnCompleteNotification } from '../../appSettingsManager'

export interface NotificationPrefs {
  turnComplete: TurnCompleteNotification
  approvalRequired: boolean
  questionRequired: boolean
}

export interface NotificationDecisionInput {
  signal: AgentRunSignal
  prefs: NotificationPrefs
  /** 主窗口此刻在不在前台 */
  windowFocused: boolean
  /** 这条会话攒下的助手正文，用来当通知正文。见 `TextBuffer` */
  text?: string
  language: 'zh-CN' | 'en-US'
}

/** 要弹的那条通知。`key` 用来去重和事后收掉 */
export interface NotificationPlan {
  key: string
  title: string
  body: string
  /**
   * 用户不点也会自己消失吗。
   *
   * 审批和提问是 `false`（Windows 上会一直留在通知中心）：它们是**挡着活的**，
   * 用户回来必须看见。轮次完成是 `true`，看不看无所谓。
   */
  silent: boolean
  requireInteraction: boolean
}

/** 这条信号会让某条待办落定，落定的话要把之前那条通知收掉 */
export function settledKey(signal: AgentRunSignal): string | null {
  switch (signal.type) {
    case 'approval-settled':
      return `approval:${signal.sessionId}:${signal.toolCallId}`
    case 'question-settled':
      return `question:${signal.sessionId}:${signal.toolCallId}`
    default:
      return null
  }
}

const TEXT = {
  'zh-CN': {
    doneTitle: '任务完成',
    doneBody: '这一轮跑完了',
    errorTitle: '任务失败',
    approvalTitle: '需要你确认',
    approvalBody: (tool: string) => `Agent 要执行「${tool}」，等你点头`,
    approvalRiskyBody: (tool: string) => `Agent 要执行高风险操作「${tool}」，等你点头`,
    questionTitle: 'Agent 在问你',
    questionBody: '它卡在一个问题上，等你回答'
  },
  'en-US': {
    doneTitle: 'Task finished',
    doneBody: 'This turn is done',
    errorTitle: 'Task failed',
    approvalTitle: 'Waiting for your approval',
    approvalBody: (tool: string) => `The agent wants to run "${tool}"`,
    approvalRiskyBody: (tool: string) => `The agent wants to run a high-risk step: "${tool}"`,
    questionTitle: 'The agent has a question',
    questionBody: "It's blocked on a question and waiting for you"
  }
} as const

/** 通知正文最多这么长。再长 Windows 自己会截，截得比我们难看 */
const BODY_LIMIT = 120

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > BODY_LIMIT ? `${flat.slice(0, BODY_LIMIT - 1)}…` : flat
}

/**
 * 判定。不该弹的返回 null。
 *
 * `stopped` 永远不弹：那是用户自己按的停止，他就在屏幕前面，
 * 再告诉他一遍「停了」等于复述他刚做过的动作。
 */
export function decideNotification(input: NotificationDecisionInput): NotificationPlan | null {
  const { signal, prefs, windowFocused, language } = input
  const copy = TEXT[language] ?? TEXT['zh-CN']

  switch (signal.type) {
    case 'done':
    case 'error': {
      if (prefs.turnComplete === 'off') return null
      if (prefs.turnComplete === 'unfocused' && windowFocused) return null
      const isError = signal.type === 'error'
      return {
        key: `turn:${signal.sessionId}`,
        title: isError ? copy.errorTitle : copy.doneTitle,
        // 报错时用错误原文；跑完时用它最后说的那几句 —— 一条只写着「完成了」
        // 的通知，用户还是得切回来才知道它到底干了什么
        body: clip(isError ? signal.message : input.text || copy.doneBody) || copy.doneBody,
        silent: false,
        requireInteraction: false
      }
    }

    /*
     * 审批和提问只在窗口不在前台时弹，不受 `turnComplete` 那一档影响。
     *
     * 不给它们单独的「始终提醒」档：窗口在前台时，确认框就在用户眼前，
     * 系统通知只是把同一件事说第二遍。
     */
    case 'approval': {
      if (!prefs.approvalRequired || windowFocused) return null
      // `destructive` = 不可逆（删除、覆盖、批量改写），见 `tools/defineTool.ts`。
      // 值得在通知这一行里就说清楚：用户可能只看一眼通知就决定要不要切回来
      const risky = signal.risk === 'destructive'
      return {
        key: `approval:${signal.sessionId}:${signal.toolCallId}`,
        title: copy.approvalTitle,
        body: risky ? copy.approvalRiskyBody(signal.toolName) : copy.approvalBody(signal.toolName),
        silent: false,
        requireInteraction: true
      }
    }

    case 'question': {
      if (!prefs.questionRequired || windowFocused) return null
      const first = signal.questions[0]
      return {
        key: `question:${signal.sessionId}:${signal.toolCallId}`,
        title: copy.questionTitle,
        body: clip(first?.question || copy.questionBody) || copy.questionBody,
        silent: false,
        requireInteraction: true
      }
    }

    default:
      return null
  }
}

/**
 * 每条会话攒一小段助手正文，只留结尾。
 *
 * 只留结尾是因为通知要回答的是「它干完了什么」，那句话在最后；
 * 而且不留上限的话，一次长任务能攒出几十 KB 文本，只为了显示 120 个字。
 */
export class TextBuffer {
  private readonly tails = new Map<string, string>()

  /** 保留的字符数。取通知上限的两倍，够裁掉半个词后还剩满一条 */
  private static readonly KEEP = BODY_LIMIT * 2

  append(sessionId: string, text: string): void {
    const next = (this.tails.get(sessionId) ?? '') + text
    this.tails.set(sessionId, next.slice(-TextBuffer.KEEP))
  }

  take(sessionId: string): string {
    return this.tails.get(sessionId) ?? ''
  }

  clear(sessionId: string): void {
    this.tails.delete(sessionId)
  }
}
