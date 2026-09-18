import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import type {
  AgentModeHandlersDeps,
  NotifyUsersEvent,
  StepEvent,
  ToolCallEvent,
  ToolResultEvent
} from './agentHandlerShared'
import {
  getLastAssistantMessage,
  normalizeToolCalls,
  resolveTargetChatSid
} from './agentHandlerShared'

export function createAgentStreamHandlers(
  deps: AgentModeHandlersDeps,
  helpers: {
    replaceLastAssistant: (
      targetChatSid: string,
      content: string,
      done: boolean,
      extra?: Record<string, unknown>
    ) => void
  }
) {
  const { replaceLastAssistant } = helpers
  const {
    sid,
    chatStore,
    chatMsgStore,
    scrollToBottomIfNeeded,
    currentAgentProcess,
    currentSessionId,
    currentText,
    agentStreamStore,
    shouldDedupNotify,
    t
  } = deps

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let deltaBuffer = ''
  let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 取这一条对话的过程时间线。
   *
   * Store 是权威来源 —— 正文段由 `agentStreamStore.appendText` 直接记在那儿，
   * 本地那份 `currentAgentProcess` 镜像看不到它们。只有还没起流（拿不到 Store
   * 状态）时才退回镜像。
   */
  function getProcessItems(targetChatSid: string): AgentProcessItem[] {
    const fromStore = agentStreamStore.getAgentProcess(targetChatSid)
    if (fromStore.length > 0) return [...fromStore]
    return targetChatSid === sid.value ? [...currentAgentProcess.value] : []
  }

  function appendProcessItem(
    targetChatSid: string,
    item: AgentProcessItem,
    sessionId?: string
  ): AgentProcessItem[] {
    const processSessionId =
      sessionId || (targetChatSid === sid.value ? currentSessionId.value : undefined)

    if (!processSessionId) {
      // 没有会话可写，Store 里不会有这条时间线，只能自己记
      if (targetChatSid !== sid.value) return getProcessItems(targetChatSid)
      currentAgentProcess.value.push(item)
      return [...currentAgentProcess.value]
    }

    agentStreamStore.addAgentProcess(processSessionId, item)

    const items = getProcessItems(targetChatSid)
    if (targetChatSid === sid.value) {
      // 镜像整份换成 Store 的，把中间流进来的正文段一起带上
      currentAgentProcess.value = items
    }
    return [...items]
  }

  function flushDeltaBuffer(): void {
    if (deltaFlushTimer) {
      clearTimeout(deltaFlushTimer)
      deltaFlushTimer = null
    }

    if (deltaBuffer && currentSessionId.value) {
      agentStreamStore.appendText(currentSessionId.value, deltaBuffer)
      deltaBuffer = ''
    }
  }

  function handleAgentTextDelta(delta: string): void {
    deltaBuffer += delta

    if (!deltaFlushTimer) {
      deltaFlushTimer = setTimeout(flushDeltaBuffer, 100)
    }

    if (saveTimer) {
      clearTimeout(saveTimer)
    }

    saveTimer = setTimeout(() => {
      chatStore.setAgentCurrentText(sid.value, currentText.value)
      saveTimer = null
    }, 500)
  }

  function handleAgentText(_event: unknown, data: { delta: string; sessionId?: string }): void {
    if (data.sessionId && data.sessionId !== currentSessionId.value) {
      return
    }

    handleAgentTextDelta(data.delta)
  }

  function handleAgentToolCall(_event: unknown, data: ToolCallEvent): void {
    const targetChatSid = resolveTargetChatSid(agentStreamStore, sid.value, data.sessionId)
    if (!targetChatSid) {
      console.warn('[AgentMode] Missing chatSid for tool call', data.sessionId)
      return
    }

    if (data.sessionId) {
      agentStreamStore.flushBuffer(data.sessionId)
    }

    for (const toolCall of normalizeToolCalls(data)) {
      appendProcessItem(
        targetChatSid,
        {
          type: 'tool-call',
          data: {
            ...toolCall,
            messages: data.messages
          },
          timestamp: Date.now()
        },
        data.sessionId
      )
    }

    const targetMessages = chatMsgStore.getMessages(targetChatSid)
    const lastAssistant = getLastAssistantMessage(targetMessages)
    if (!lastAssistant) {
      return
    }

    chatMsgStore.replaceTyping(
      targetChatSid,
      lastAssistant.id,
      String(lastAssistant.content || ''),
      lastAssistant.status === 'done',
      {
        agentProcess: getProcessItems(targetChatSid)
      }
    )

    if (targetChatSid === sid.value) {
      scrollToBottomIfNeeded()
    }
  }

  function handleAgentToolResult(_event: unknown, data: ToolResultEvent): void {
    const targetChatSid = resolveTargetChatSid(agentStreamStore, sid.value, data.sessionId)
    if (!targetChatSid) {
      console.warn('[AgentMode] Missing chatSid for tool result', data.sessionId)
      return
    }

    if (data.sessionId) {
      agentStreamStore.flushBuffer(data.sessionId)
    }

    appendProcessItem(
      targetChatSid,
      {
        type: 'tool-result',
        data: {
          toolName: data.toolName,
          ...(data.toolCallId ? { toolCallId: data.toolCallId } : {}),
          // 「本轮改动」要靠它区分「改了」和「想改但失败了」
          isError: data.isError === true,
          result: data.result
        },
        timestamp: Date.now()
      },
      data.sessionId
    )

    replaceLastAssistant(
      targetChatSid,
      String(getLastAssistantMessage(chatMsgStore.getMessages(targetChatSid))?.content || ''),
      false,
      {
        agentProcess: getProcessItems(targetChatSid)
      }
    )
  }

  function handleAgentNotifyUsers(_event: unknown, data: NotifyUsersEvent): void {
    const targetChatSid = resolveTargetChatSid(agentStreamStore, sid.value, data.sessionId)
    if (!targetChatSid) {
      console.warn('[AgentMode] Missing chatSid for notify event', data.sessionId)
      return
    }

    const notifyType = data.type || 'info'
    const normalizedNotifyType = notifyType === 'thinking-update' ? 'thinking' : notifyType
    const notifyTimestamp = data.timestamp || Date.now()

    if (
      shouldDedupNotify(
        normalizedNotifyType,
        data.message || '',
        data.specialist,
        notifyTimestamp,
        data.toolCallId
      )
    ) {
      return
    }

    const processItems = appendProcessItem(
      targetChatSid,
      {
        type: 'notify-users',
        data: {
          message: data.message,
          notifyType: normalizedNotifyType,
          specialist: data.specialist,
          // 并行子任务的进度靠它归位；不是工具进度的通知不带这两个字段
          ...(data.toolCallId ? { toolCallId: data.toolCallId } : {}),
          ...(data.toolName ? { toolName: data.toolName } : {})
        },
        timestamp: notifyTimestamp
      },
      data.sessionId
    )

    const targetMessages = chatMsgStore.getMessages(targetChatSid)
    const lastAssistant = getLastAssistantMessage(targetMessages)
    if (!lastAssistant) {
      return
    }

    if (normalizedNotifyType === 'thinking') {
      chatMsgStore.replaceTyping(
        targetChatSid,
        lastAssistant.id,
        String(lastAssistant.content || ''),
        lastAssistant.status === 'done',
        { agentProcess: processItems }
      )
      if (targetChatSid === sid.value) {
        scrollToBottomIfNeeded()
      }
      return
    }

    chatMsgStore.replaceTyping(
      targetChatSid,
      lastAssistant.id,
      String(lastAssistant.content || ''),
      lastAssistant.status === 'done',
      {
        agentProcess: processItems
      }
    )

    if (targetChatSid === sid.value) {
      scrollToBottomIfNeeded()
    }
  }

  function handleAgentStep(_event: unknown, data: StepEvent): void {
    const targetChatSid = resolveTargetChatSid(agentStreamStore, sid.value, data.sessionId)
    if (!targetChatSid) {
      console.warn('[AgentMode] Missing chatSid for step event', data.sessionId)
      return
    }

    // 不再往过程日志里塞 'step' 条目：它没有可显示的内容（见
    // AgentProcessLog 里的说明），存了也只是永远不会被渲染的死数据。
    // 这一轮结束时仍然刷一次消息，让本轮累积的真实条目落进气泡。
    replaceLastAssistant(
      targetChatSid,
      String(getLastAssistantMessage(chatMsgStore.getMessages(targetChatSid))?.content || ''),
      false,
      {
        agentProcess: getProcessItems(targetChatSid)
      }
    )
  }

  return {
    flushDeltaBuffer,
    handleAgentTextDelta,
    handleAgentText,
    handleAgentToolCall,
    handleAgentToolResult,
    handleAgentNotifyUsers,
    handleAgentStep
  }
}
