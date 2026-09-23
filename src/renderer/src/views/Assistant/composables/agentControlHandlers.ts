import { message } from '@renderer/utils/messageManager'
import { isCurrentRun, unregisterAgentHandler } from './agentEventDispatcher'
import type { AgentModeHandlersDeps, ErrorEvent, StoppedEvent } from './agentHandlerShared'
import {
  AGENT_RESUME_ACTION,
  resolveAssistantMessage,
  resolveTargetChatSid
} from './agentHandlerShared'
import { creatorPlanErrorInfo, isCreatorPlanChatErrorCode } from './creatorPlanChatError'

const NETWORK_ERROR_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'CONNECTION_FAILED',
  'MAX_RETRIES_EXCEEDED',
  'SOCKET_HANGUP',
  'TIMEOUT',
  'NETWORK_ERROR'
]

const NETWORK_ERROR_MESSAGES = [
  'connection error',
  'network error',
  'failed to fetch',
  'fetch failed',
  'socket hang up',
  'timed out',
  'timeout',
  'econnreset',
  'econnrefused',
  'enotfound'
]

export function isAgentNetworkError(data: { message: string; code?: string }): boolean {
  const message = String(data.message || '').toLowerCase()
  return (
    (!!data.code && NETWORK_ERROR_CODES.includes(data.code)) ||
    NETWORK_ERROR_MESSAGES.some((fragment) => message.includes(fragment))
  )
}

/**
 * 主进程回的启动失败码 → 界面文案。
 *
 * 这条路（`agent-v3:execute` 直接回 `success: false`）不经过 `getErrorInfo`，
 * 原来是把主进程那句原样显示 —— 于是用户在对话里读到
 * 「会话 3f2a-… 正在执行中。要改方向请用 agent-v3:steer。」：一个 uuid
 * 加一个 IPC 通道名，而界面上「改方向」就是在输入框里继续打字。
 */
const STARTUP_ERROR_COPY: Record<string, string> = {
  SESSION_BUSY: 'assistant.agentMode.sessionBusy'
}

/**
 * 启动失败该跟用户说什么。
 *
 * 认识的码查文案；不认识的（主进程还没来得及改成回码的那些）退回原文 ——
 * 难看但不丢信息。
 */
export function describeStartupError(
  error: { message?: string; code?: string } | null | undefined,
  t: (key: string) => string,
  fallback: string
): string {
  const key = error?.code ? STARTUP_ERROR_COPY[error.code] : undefined
  if (key) {
    const copy = t(key)
    if (copy !== key) return copy
  }
  return error?.message || fallback
}

export function createAgentControlHandlers(deps: AgentModeHandlersDeps) {
  const {
    sid,
    chatMsgStore,
    currentAgentProcess,
    currentSessionId,
    currentAgentController,
    currentText,
    agentStreamStore,
    t,
    clearWikiRagState
  } = deps

  /**
   * 这一轮的摊子收掉：注销处理器、清流式状态、清引用、放开控制器。
   *
   * 带上轮次号的调用会先问一句「这条会话还归我管吗」：401 那条路要等刷新令牌，
   * 回来时同一条 agent 会话上可能已经开跑下一轮（语音把排队的第二件活派回同一条
   * 会话就是这样），照拆的话新那一轮的事件从此没人接。
   */
  function teardownRun(
    agentSessionId: string | undefined,
    runId: number | undefined,
    targetChatSid: string
  ): void {
    if (agentSessionId && !isCurrentRun(agentSessionId, runId)) return

    if (!agentSessionId || currentSessionId.value === agentSessionId) {
      currentAgentController.value = null
    }
    if (agentSessionId) {
      unregisterAgentHandler(agentSessionId, runId)
      agentStreamStore.cleanupStream(agentSessionId)
      clearWikiRagState(agentSessionId)
    }
    if (targetChatSid === sid.value) {
      currentAgentProcess.value = []
    }
  }

  function getErrorInfo(data: {
    message: string
    code?: string
    statusCode?: number
    status?: number
    detail?: string
    planError?: string
  }): {
    toast: string
    display: string
    type: 'error' | 'warning'
    recoveryTitle?: string
    recoveryReason?: string
    /** 不修配置就一定会再失败的错（余额、鉴权）。据此不挂「接着跑」按钮 */
    fatal?: boolean
    /** 代替「接着跑」挂在气泡上的按钮（套餐错误的「管理订阅」「去重新连接」） */
    actionButtons?: Array<{ label: string; action: string }>
  } {
    // 套餐来源的错误先认：402 在下面会被当成「服务商余额不足」，401 会被当成「密钥不对」，
    // 而用户要做的是去管理订阅、重新连接
    if (isCreatorPlanChatErrorCode(data.planError)) {
      return creatorPlanErrorInfo(data.planError, t)
    }

    const statusCode = data.statusCode || data.status
    const messageStr = String(data.message || '').toLowerCase()

    /**
     * 余额不足 —— 指的是**用户自己那家模型服务商**的余额。
     *
     * 公开核心没有应用内钱包，模型一律由用户自带 Key 直连，所以这里只做
     * 说明，不再弹本应用的充值窗。判据要覆盖各家不同的措辞：DeepSeek 回
     * `Insufficient Balance`、OpenAI 回 `insufficient_quota`、一批国内厂商
     * 直接回中文「余额不足」。
     */
    const isInsufficientBalance =
      data.code === 'INSUFFICIENT_BALANCE' ||
      data.code === 'insufficient_quota' ||
      statusCode === 402 ||
      messageStr.includes('insufficient balance') ||
      messageStr.includes('insufficient_quota') ||
      messageStr.includes('余额不足')

    if (isInsufficientBalance) {
      return {
        toast: t('assistant.agentMode.providerOutOfCredit'),
        display: `**${t('assistant.agentMode.providerOutOfCreditTitle')}**\n\n${t(
          'assistant.agentMode.providerOutOfCreditDesc'
        )}`,
        type: 'warning',
        fatal: true
      }
    }

    if (statusCode === 401) {
      return {
        toast: t('assistant.agentMode.providerAuthFailed'),
        display: `**${t('assistant.agentMode.providerAuthFailedTitle')}**\n\n${t(
          'assistant.agentMode.providerAuthFailedDesc'
        )}`,
        type: 'error',
        fatal: true
      }
    }

    if (statusCode === 429 || data.code === 'RATE_LIMIT_EXCEEDED') {
      const title = t('assistant.agentMode.rateLimitTitle')
      const reason = t('assistant.agentMode.rateLimitDesc')
      return {
        toast: t('assistant.agentMode.rateLimitExceeded'),
        display: `**${title}**\n\n${reason}`,
        type: 'warning',
        recoveryTitle: title,
        recoveryReason: reason
      }
    }

    if (statusCode === 503 || statusCode === 502 || statusCode === 500) {
      const title = t('assistant.agentMode.serviceUnavailableTitle')
      const reason = t('assistant.agentMode.serviceUnavailableDesc')
      return {
        toast: t('assistant.agentMode.serviceUnavailable'),
        display: `**${title}**\n\n${reason}`,
        type: 'error',
        recoveryTitle: title,
        recoveryReason: reason
      }
    }

    if (isAgentNetworkError(data)) {
      const title = t('assistant.agentMode.networkErrorTitle')
      const reason = t('assistant.agentMode.networkErrorDesc')
      return {
        toast: t('assistant.agentMode.networkError'),
        // 先给能照做的那句（查网络/VPN/代理/来源地址），再把原文附在后面。
        // 只留前者的话，本机跑 Ollama 没启动时用户读到的是「检查网络和代理」——
        // 对 `connect ECONNREFUSED 127.0.0.1:11434` 来说这条建议是错的，
        // 而那个端口号恰恰是唯一能指出真因的东西
        display: `**${title}**\n\n${reason}${data.message ? `\n\n\`${data.message}\`` : ''}`,
        type: 'error',
        recoveryTitle: title,
        recoveryReason: reason
      }
    }

    /*
     * 没有对应友好文案的状态码走这里（400 说模型名不对、上下文超长，403 说地区不支持…）。
     *
     * 显示 `detail` 而不是 `message`：前者是主进程从错误体里剥出来的那一句
     * （「This model's maximum context length is 128000 tokens…」），后者是整串
     * `401: {"error":{"message":…,"type":…,"param":null,"code":…}}`。抠不出来时
     * `detail` 为空，退回原文 —— 难看但不丢信息，总比显示一句空话强。
     */
    const readable = data.detail || data.message
    return {
      toast: `${t('assistant.agentMode.agentError')}: ${readable}`,
      display: `${t('assistant.agentMode.errorPrefix')}: ${readable}`,
      type: 'error',
      recoveryTitle: t('assistant.agentMode.agentExecFailed'),
      // 复盘给模型看，用原文：状态码和错误码对它是有用的线索
      recoveryReason: data.message
    }
  }

  async function handleAgentError(_event: unknown, data: ErrorEvent): Promise<void> {
    const targetChatSid = resolveTargetChatSid(agentStreamStore, sid.value, data.sessionId)
    if (!targetChatSid) {
      return
    }

    const errorInfo = getErrorInfo(data)

    if (errorInfo.type === 'error') {
      message.error(errorInfo.toast)
    } else {
      message.warning(errorInfo.toast)
    }

    const trackedTypingId = data.sessionId
      ? agentStreamStore.getStreamByAgentSession(data.sessionId)?.currentTypingId
      : agentStreamStore.getTypingId(targetChatSid)
    const lastAssistant = resolveAssistantMessage(
      chatMsgStore.getMessages(targetChatSid),
      trackedTypingId
    )
    if (lastAssistant?.status === 'typing') {
      // 挂一个「接着跑」：报错停在半路时，重发一遍会让这一轮已经探测出的
      // 资产路径、已创建的节点全部作废重来，而续跑保留全部上下文，
      // 模型接着上次的位置往下走。
      //
      // 余额不足 / 认证失败这类**不修就一定再失败**的错不挂 ——
      // 给一个点了必然再报一次的按钮，比不给更让人火大。
      const resumable = !errorInfo.fatal && data.statusCode !== 401 && !!data.sessionId
      const resumeButtons = resumable
        ? [
            {
              label: t('assistant.agentMode.resume'),
              action: AGENT_RESUME_ACTION,
              data: {
                sessionId: data.sessionId,
                recoveryTitle: errorInfo.recoveryTitle || errorInfo.toast,
                recoveryReason: errorInfo.recoveryReason || data.message
              }
            }
          ]
        : undefined
      chatMsgStore.replaceTyping(targetChatSid, lastAssistant.id, errorInfo.display, true, {
        outcome: 'error',
        // 套餐错误挂的是「管理订阅」「去重新连接」，不是「接着跑」
        actionButtons: errorInfo.actionButtons ?? resumeButtons
      })
    }

    teardownRun(data.sessionId, data.runId, targetChatSid)
  }

  function handleAgentStopped(_event: unknown, data?: StoppedEvent): void {
    const targetChatSid = resolveTargetChatSid(agentStreamStore, sid.value, data?.sessionId)
    if (!targetChatSid) {
      return
    }

    const trackedTypingId = data?.sessionId
      ? agentStreamStore.getStreamByAgentSession(data.sessionId)?.currentTypingId
      : agentStreamStore.getTypingId(targetChatSid)
    const lastAssistant = resolveAssistantMessage(
      chatMsgStore.getMessages(targetChatSid),
      trackedTypingId
    )
    if (lastAssistant) {
      const targetText =
        targetChatSid === sid.value
          ? currentText.value
          : agentStreamStore.getCurrentText(targetChatSid)
      const stoppedText = targetText.trim()
        ? `${targetText.trim()}\n\n---\n*${t('assistant.agentMode.stoppedByUser')}*`
        : `*${t('assistant.agentMode.stoppedByUser')}*`

      chatMsgStore.replaceTyping(targetChatSid, lastAssistant.id, stoppedText, true, {
        outcome: 'stopped'
      })
    }

    teardownRun(data?.sessionId, data?.runId, targetChatSid)
  }

  return {
    handleAgentError,
    handleAgentStopped
  }
}
