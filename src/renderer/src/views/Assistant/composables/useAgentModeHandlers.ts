import { createAgentStreamHandlers } from './agentStreamHandlers'
import { createAgentCompletionHandlers } from './agentCompletionHandlers'
import { createAgentControlHandlers } from './agentControlHandlers'
import type { AgentModeHandlersDeps } from './agentHandlerShared'
import { resolveAssistantMessage } from './agentHandlerShared'

export type {
  AgentModeHandlersDeps,
  DoneEvent,
  ErrorEvent,
  NotifyUsersEvent,
  StepEvent,
  ToolCallEvent,
  ToolResultEvent
} from './agentHandlerShared'

export function createAgentModeHandlers(deps: AgentModeHandlersDeps) {
  const { sid, chatMsgStore, scrollToBottomIfNeeded } = deps

  function replaceLastAssistant(
    targetChatSid: string,
    content: string,
    done: boolean,
    extra?: Record<string, unknown>
  ): void {
    const targetMessages = chatMsgStore.getMessages(targetChatSid)
    const lastAssistant = resolveAssistantMessage(
      targetMessages,
      targetChatSid === sid.value ? deps.currentTypingId.value : null
    )
    if (!lastAssistant) {
      return
    }

    chatMsgStore.replaceTyping(targetChatSid, lastAssistant.id, content, done, extra)
    if (targetChatSid === sid.value) {
      scrollToBottomIfNeeded()
    }
  }

  const streamHandlers = createAgentStreamHandlers(deps, {
    replaceLastAssistant
  })

  const completionHandlers = createAgentCompletionHandlers(deps, {
    flushDeltaBuffer: streamHandlers.flushDeltaBuffer
  })

  const controlHandlers = createAgentControlHandlers(deps)

  return {
    ...streamHandlers,
    ...completionHandlers,
    ...controlHandlers
  }
}
