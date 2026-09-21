import { aiAPI } from '../../../api/ai'
import { isCurrentRun, unregisterAgentHandler } from './agentEventDispatcher'
import type {
  ChatMessage,
  ResponseMetadata,
  ResponseMetadataSkill
} from '../../../store/modules/chatMessages'
import type { AgentModeHandlersDeps, DoneEvent } from './agentHandlerShared'
import { resolveAssistantMessage, resolveTargetChatSid } from './agentHandlerShared'
import { collectGeneratedMediaFromAgentArtifacts } from './agentGeneratedMedia'
import { autoNameSession } from './sessionAutoTitle'
import { retitleSession } from '../../../composables/sessionRetitle'
import { shouldMarkTaskDone } from './sessionTaskDone'
import { summarizeChanges } from './changeSummary'
import { loadToolRiskTable } from './toolRiskTable'

function extractReferencedCitationIds(text: string): Set<string> {
  const referencedIds = new Set<string>()

  for (const match of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    const rawIds = match[1]
    if (!rawIds) continue

    for (const rawId of rawIds.split(',')) {
      const normalizedId = rawId.trim()
      if (normalizedId) {
        referencedIds.add(normalizedId)
      }
    }
  }

  return referencedIds
}

function buildUsedSkillsMetadata(
  toolResults: Array<{ toolName: string; result: any }>
): ResponseMetadataSkill[] {
  const seenSkills = new Map<string, ResponseMetadataSkill>()

  for (const toolResult of toolResults) {
    if (toolResult.toolName !== 'loadSkill' || toolResult.result?.success !== true) {
      continue
    }

    const skillName = String(toolResult.result?.skillName || '').trim()
    if (!skillName) {
      continue
    }

    const skillSource =
      toolResult.result?.skillSource === 'user' || toolResult.result?.skillSource === 'builtin'
        ? toolResult.result.skillSource
        : undefined
    const skillDirectory =
      typeof toolResult.result?.skillDirectory === 'string' &&
      toolResult.result.skillDirectory.trim().length > 0
        ? toolResult.result.skillDirectory.trim()
        : undefined

    const key = `${skillSource || 'unknown'}:${skillName.toLowerCase()}`
    if (!seenSkills.has(key)) {
      seenSkills.set(key, {
        name: skillName,
        source: skillSource,
        directory: skillDirectory
      })
    }
  }

  return [...seenSkills.values()]
}

export function createAgentCompletionHandlers(
  deps: AgentModeHandlersDeps,
  helpers: {
    flushDeltaBuffer: () => void
  }
) {
  const { flushDeltaBuffer } = helpers
  const {
    sid,
    messages,
    route,
    tabsStore,
    chatStore,
    chatMsgStore,
    aiConfigStore,
    scrollToBottomIfNeeded,
    currentAgentProcess,
    currentSessionId,
    currentAgentController,
    fullConversationHistory,
    currentText,
    agentStreamStore,
    t,
    clearWikiRagState,
    getWikiRagCitations
  } = deps

  async function generateFeedbackFromToolCalls(messagesData: any[]): Promise<string> {
    try {
      const toolCalls: any[] = []
      const toolResults: any[] = []

      for (const msg of messagesData) {
        if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
          toolCalls.push(...msg.tool_calls)
        }
        if (msg.role === 'tool') {
          toolResults.push(msg)
        }
      }

      if (toolCalls.length === 0) {
        return t('assistant.agentMode.noResult')
      }

      let description = t('assistant.agentMode.executedOperations')

      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i]
        const toolName = toolCall.function?.name || t('assistant.agentMode.unknownTool')
        const toolArgs = toolCall.function?.arguments || '{}'
        const result = toolResults.find((item) => item.tool_call_id === toolCall.id)

        description += `${i + 1}. ${t('assistant.agentMode.callTool')}: ${toolName}\n`
        description += `   ${t('assistant.agentMode.params')}: ${toolArgs}\n`

        if (result) {
          const resultContent =
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
          description += `   ${t('assistant.agentMode.result')}: ${resultContent.slice(0, 500)}\n`
        }

        description += '\n'
      }

      const response = await aiAPI.chat({
        maxTokens: 12800,
        messages: [
          {
            role: 'system',
            content: t('assistant.agentMode.feedbackPrompt')
          },
          {
            role: 'user',
            content: description
          }
        ]
      })

      const responseData = response as any
      const feedback =
        responseData?.choices?.[0]?.message?.content ||
        responseData?.content ||
        t('assistant.agentMode.feedbackDefault')

      return String(feedback).trim() || t('assistant.agentMode.feedbackDefault')
    } catch (error) {
      console.error('[AgentMode] Failed to generate tool feedback:', error)
      return t('assistant.agentMode.feedbackFailed')
    }
  }

  /**
   * 这一轮的摊子收掉：注销处理器、清流式状态、清引用、放开控制器。
   *
   * **过期的收尾什么都不做。** 收尾走到这里时可能已经过了好几秒（补反馈那一步
   * 要问模型），这条 agent 会话上很可能已经开跑下一轮 —— 语音把排队的第二件活
   * 派回同一条会话正是如此。照拆的话新那一轮的事件从此没人接：屏幕上像是断了，
   * 后台却还在干活。
   */
  function teardownRun(agentSessionId: string, runId?: number): void {
    if (!isCurrentRun(agentSessionId, runId)) return

    unregisterAgentHandler(agentSessionId, runId)
    agentStreamStore.cleanupStream(agentSessionId)
    clearWikiRagState(agentSessionId)
    if (currentSessionId.value === agentSessionId) {
      currentAgentController.value = null
      currentAgentProcess.value = []
    }
  }

  async function handleAgentDone(_event: unknown, data?: DoneEvent): Promise<string> {
    flushDeltaBuffer()

    const agentSessionId = data?.sessionId
    if (!agentSessionId) {
      return ''
    }

    const targetChatSid = agentStreamStore.getChatSidByAgentSession(agentSessionId)
    if (!targetChatSid) {
      return ''
    }

    const finalStreamText = agentStreamStore.getCurrentText(targetChatSid)
    const targetMessages = chatMsgStore.getMessages(targetChatSid)
    let updatedHistory =
      targetChatSid === sid.value
        ? [...fullConversationHistory.value]
        : [...(chatStore.getAgentHistory(targetChatSid) || [])]

    const responseMessages = data?.messages && Array.isArray(data.messages) ? data.messages : []
    const responseIncludesConversation = responseMessages.some((msg) => msg.role === 'user')

    if (responseIncludesConversation) {
      updatedHistory = [...responseMessages]
    } else if (finalStreamText.trim()) {
      updatedHistory.push({
        role: 'assistant',
        content: finalStreamText.trim()
      })
    }

    if (targetChatSid === sid.value) {
      fullConversationHistory.value = updatedHistory
    }

    chatStore.setAgentHistory(targetChatSid, updatedHistory)
    chatStore.setAgentCurrentText(
      targetChatSid,
      targetChatSid === sid.value ? currentText.value : finalStreamText
    )

    let finalText = finalStreamText.trim()

    if (!finalText && data?.messages && Array.isArray(data.messages)) {
      let lastUserIndex = -1
      for (let i = data.messages.length - 1; i >= 0; i--) {
        if (data.messages[i].role === 'user') {
          lastUserIndex = i
          break
        }
      }

      for (let i = data.messages.length - 1; i > lastUserIndex; i--) {
        const msg = data.messages[i]
        if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
          finalText = msg.content.trim()
          break
        }
      }
    }

    if (!finalText && data?.messages && Array.isArray(data.messages)) {
      for (let i = data.messages.length - 1; i >= 0; i--) {
        const msg = data.messages[i]
        if (msg.role === 'tool' && msg.content) {
          try {
            const toolResult =
              typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content
            if (toolResult.message && typeof toolResult.message === 'string') {
              finalText = toolResult.message
              break
            }
          } catch {
            // Keep scanning.
          }
        }
      }
    }

    const trackedTypingId =
      agentStreamStore.getStreamByAgentSession(agentSessionId)?.currentTypingId ||
      agentStreamStore.getTypingId(targetChatSid)
    const lastAssistant = resolveAssistantMessage(targetMessages, trackedTypingId)
    if (!lastAssistant) {
      teardownRun(agentSessionId, data?.runId)
      return ''
    }

    /*
     * 流式状态在这里先拍成快照。
     *
     * 下面几步是**异步**的（可能要让模型补一句反馈、要等工具风险表），而同一条
     * agent 会话紧接着就可能开跑下一轮 —— 语音把排队的第二件活派回同一条会话正是
     * 如此。等回来再去 store 里取，取到的是**下一轮**的过程日志和用量，会被写进
     * 这一轮的气泡里。
     */
    const finalAgentProcess = getProcessItems(targetChatSid)
    const executionContext = agentStreamStore.getExecutionContext(agentSessionId)
    // 本轮花掉的 token：主进程按次报，流式状态里已经加好了。
    // 落进消息而不是留在流式状态 —— 后者马上会被 cleanupStream 删掉，
    // 而且不持久化，重开应用后历史回复下面会空一片。
    const turnUsage = agentStreamStore.getTurnUsage(agentSessionId)

    if (!finalText && data?.messages && Array.isArray(data.messages)) {
      chatMsgStore.replaceTyping(
        targetChatSid,
        lastAssistant.id,
        t('assistant.agentMode.generatingFeedback'),
        false
      )

      finalText = await generateFeedbackFromToolCalls(data.messages)
    }

    const toolResults: Array<{ toolName: string; result: any }> = []

    if (data?.messages && Array.isArray(data.messages)) {
      for (const msg of data.messages) {
        if (msg.role !== 'tool') continue

        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'tool-result' && item.toolName) {
              toolResults.push({
                toolName: item.toolName,
                result: item.result
              })

              if (
                item.toolName === 'route_to_specialist' &&
                item.result?.success &&
                item.result?.data
              ) {
                const specialistToolCalls = item.result.toolCalls as
                  | Array<{ toolName: string; result?: unknown }>
                  | undefined
                if (Array.isArray(specialistToolCalls)) {
                  for (const toolCall of specialistToolCalls) {
                    if (toolCall.toolName && toolCall.result) {
                      toolResults.push({
                        toolName: toolCall.toolName,
                        result: toolCall.result
                      })
                    }
                  }
                }
              }
            }
          }
          continue
        }

        if (msg.name) {
          try {
            toolResults.push({
              toolName: msg.name,
              result: typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content
            })
          } catch (error) {
            console.error('[AgentMode] Failed to parse legacy tool result', msg.name, error)
          }
        }
      }
    }

    const mediaResults = collectGeneratedMediaFromAgentArtifacts({
      toolResults,
      agentProcess: finalAgentProcess
    })

    /*
     * 视频写成链接而不是 `![]()`：markdown 的图片语法出的是 `<img>`，
     * mp4 塞进去只有一个破图。链接会被 `markdownMediaPreview` 认出来，
     * 在下面补一个播放器 —— 与模型自己写路径时是同一条渲染路径。
     */
    const mediaMarkdown = [
      ...mediaResults.images.map(
        (imageUrl) => `![${t('assistant.agentMode.generatedImageAlt')}](${imageUrl})`
      ),
      ...mediaResults.videos.map(
        (videoUrl) => `[${t('assistant.agentMode.generatedVideoLabel')}](${videoUrl})`
      )
    ].join('\n\n')

    if (mediaMarkdown) {
      finalText = finalText.replace(/\{\s*"tool_code"\s*:\s*"[^"]*"\s*\}/g, '')
      finalText = finalText.replace(/\{\s*"tool_code"\s*:\s*`[^`]*`\s*\}/g, '')
      finalText = finalText.trim()
      finalText = finalText ? `${finalText}\n\n${mediaMarkdown}` : mediaMarkdown
    }

    const displayText = finalText || t('assistant.agentMode.noContent')
    const availableCitations = getWikiRagCitations(agentSessionId)
    const referencedCitationIds = extractReferencedCitationIds(displayText)
    const usedCitations =
      referencedCitationIds.size > 0
        ? availableCitations.filter((citation) => referencedCitationIds.has(citation.id))
        : []
    const usedSkills = buildUsedSkillsMetadata(toolResults)
    // 本轮改动：从过程日志里挑出真的动了东西的调用，风险表来自主进程注册表
    const changes = summarizeChanges(finalAgentProcess || [], await loadToolRiskTable())
    const responseMetadata: ResponseMetadata | undefined =
      usedSkills.length > 0 || changes.length > 0 || turnUsage
        ? {
            ...(usedSkills.length > 0 ? { usedSkills } : {}),
            ...(changes.length > 0 ? { changes } : {}),
            ...(turnUsage ? { usage: turnUsage } : {})
          }
        : undefined

    chatMsgStore.replaceTyping(targetChatSid, lastAssistant.id, displayText, true, {
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      agentProcess: finalAgentProcess,
      citations: usedCitations.length > 0 ? [...usedCitations] : undefined,
      executionContext,
      responseMetadata
    })

    // Ensure no stale typing placeholder keeps the UI in "generating" state.
    for (const message of chatMsgStore.getMessages(targetChatSid)) {
      if (
        message.role !== 'assistant' ||
        message.status !== 'typing' ||
        message.id === lastAssistant.id
      ) {
        continue
      }

      chatMsgStore.replaceTyping(
        targetChatSid,
        message.id,
        String(message.content || displayText),
        true
      )
    }

    let userContent = ''
    const targetMessagesAfterReplace = chatMsgStore.getMessages(targetChatSid)
    const lastAssistantIndex = targetMessagesAfterReplace.findLastIndex(
      (msg: ChatMessage) => msg.id === lastAssistant.id
    )
    for (let i = lastAssistantIndex - 1; i >= 0; i--) {
      if (targetMessagesAfterReplace[i].role !== 'user') continue
      const content = targetMessagesAfterReplace[i].content
      if (typeof content === 'string') {
        userContent = content
      } else if (Array.isArray(content)) {
        userContent = content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('\n')
      }
      break
    }

    if (userContent && displayText && aiConfigStore.followUpSuggestionsEnabled) {
      ;(async () => {
        try {
          chatMsgStore.setSuggestionsLoading(targetChatSid, lastAssistant.id, true)
          const suggestions = await aiAPI.getFollowUpSuggestions({
            userMessage: userContent,
            assistantMessage: displayText.slice(0, 500)
          })
          chatMsgStore.setSuggestionsLoading(targetChatSid, lastAssistant.id, false)
          if (suggestions && suggestions.length > 0) {
            chatMsgStore.setSuggestions(targetChatSid, lastAssistant.id, suggestions)
          }
        } catch (error) {
          console.error('[AgentMode] Failed to load follow-up suggestions:', error)
          chatMsgStore.setSuggestionsLoading(targetChatSid, lastAssistant.id, false)
        }
      })()
    }

    if (finalText) {
      chatStore.appendMessage(targetChatSid, finalText)
    }

    // 任务跑完时用户没在看这条会话：侧边栏点个蓝点，他回头才知道哪条出结果了
    if (shouldMarkTaskDone(route?.path || '', route?.query?.sid, targetChatSid)) {
      chatStore.markTaskDone(targetChatSid)
    }

    teardownRun(agentSessionId, data?.runId)
    if (targetChatSid === sid.value) {
      scrollToBottomIfNeeded()
    }

    const routePath = route?.path || ''
    const isAssistantRoute =
      routePath === '/dev-assistant' || routePath.startsWith('/dev-assistant/')
    const canRetitleTab = isAssistantRoute && targetChatSid === sid.value

    const session = chatStore.sessionById(targetChatSid)
    const defaultTitle = !session || session.title === t('assistant.agentMode.unnamedSession')
    if (defaultTitle && updatedHistory.length > 1) {
      const firstUserMsg = updatedHistory.find((item) => item.role === 'user')
      if (firstUserMsg) {
        const firstMessage = String(firstUserMsg.content || '')
        const autoTitle =
          firstMessage.replace(/\s+/g, ' ').slice(0, 20) || t('assistant.agentMode.unnamedSession')
        chatStore.updateTitle(targetChatSid, autoTitle)
        if (canRetitleTab) {
          tabsStore.updateTabTitleByPath(
            route.fullPath,
            chatStore.sessionById(targetChatSid)?.title || t('assistant.agentMode.unnamedSession')
          )
        }
        // 走到这里说明这条会话没经过 `ensureSessionWithTitle`（从别处起的 Agent 跑）。
        // 起名的规矩和那边一份：截断的先顶上，轻量模型再换一版
        autoNameSession(targetChatSid, firstMessage, autoTitle, {
          getTitle: (id) => chatStore.sessionById(id)?.title,
          applyTitle: (id, title) => {
            chatStore.updateTitle(id, title)
            if (canRetitleTab) {
              tabsStore.updateTabTitleByPath(route.fullPath, title)
            }
          }
        })
      }
    } else if (aiConfigStore.autoRetitleEnabled) {
      // 「自动生成新标题」：每轮结束按刚聊完的这一轮重起名。
      //
      // 只走 else 分支 —— 上面那条路本来就在给一条还没名字的会话取名，两边一起
      // 发就是同一轮对话打两次模型，还会互相盖。不 await：标题晚几秒到没关系，
      // 这一轮的收尾不该等它。
      void retitleSession(targetChatSid, chatMsgStore.getMessages(targetChatSid), (title) => {
        chatStore.updateTitle(targetChatSid, title)
        if (canRetitleTab) {
          tabsStore.updateTabTitleByPath(route.fullPath, title)
        }
      })
    }

    return displayText
  }

  function getProcessItems(targetChatSid: string) {
    return targetChatSid === sid.value
      ? currentAgentProcess.value.length > 0
        ? [...currentAgentProcess.value]
        : undefined
      : (() => {
          const process = agentStreamStore.getAgentProcess(targetChatSid)
          return process.length > 0 ? [...process] : undefined
        })()
  }

  return {
    handleAgentDone
  }
}
