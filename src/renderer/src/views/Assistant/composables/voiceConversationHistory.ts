import type { ChatMessage, ChatMessageContent } from '@renderer/store/modules/chatMessages'
import { joinTimelineText, resolveTrailingContent, splitAgentTimeline } from './agentTimeline'
import { AGENT_RESUME_ACTION } from './agentHandlerShared'

interface ConversationText {
  role: 'user' | 'assistant'
  text: string
}

function textOf(content: ChatMessageContent): string {
  if (typeof content === 'string') return content.trim()
  const text = content
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n')
    .trim()
  const media = content.some((part) => part.type !== 'text')
    ? '[此消息含非文本附件；附件内容未传入语音历史。]'
    : ''
  return [text, media].filter(Boolean).join('\n')
}

/** User conversation only: no tool payloads, reasoning or raw runtime errors. */
export function voiceConversationHistory(messages: ChatMessage[]): ConversationText[] {
  const result: ConversationText[] = []
  for (const message of messages) {
    const content = textOf(message.content)
    if (message.role === 'user') {
      if (content) result.push({ role: 'user', text: content })
      continue
    }
    const blocks = splitAgentTimeline(message.agentProcess || [])
    for (const block of blocks) {
      if (block.kind === 'steer' && !block.cancelled) {
        result.push({ role: 'user', text: block.text })
      }
    }
    if (message.status === 'typing') continue
    const failed =
      message.outcome === 'error' ||
      message.actionButtons?.some((button) => button.action === AGENT_RESUME_ACTION)
    if (failed || message.outcome === 'stopped') {
      result.push({
        role: 'assistant',
        text: failed
          ? '[会话状态：本轮执行失败，尚未完成。原始错误详情未传入语音。]'
          : '[会话状态：本轮已停止，不能视为完成。]'
      })
      continue
    }
    const body = joinTimelineText(message.agentProcess || [])
    const trailing = resolveTrailingContent(content, body).trim()
    let finalText = ''
    for (const block of blocks) {
      if (block.kind === 'text') finalText += block.text
      if (
        block.kind === 'process' &&
        block.items.some((item) => item.type === 'tool-call' || item.type === 'tool-result')
      )
        finalText = ''
    }
    const text = [finalText.trim(), trailing].filter(Boolean).join('\n\n')
    if (text) result.push({ role: 'assistant', text })
  }
  return result
}
