import type { RealtimeConversationMessage } from './types'

// Preserve the previous worst-case text budget, but spend it on complete recent turns.
export const REALTIME_HISTORY_MAX_CHARS = 8000
export const REALTIME_HISTORY_MAX_PAIRS = 10

/** Keep consecutive utterances together, including follow-up paragraphs and unfinished turns. */
export function pairConversationHistory(
  messages: RealtimeConversationMessage[]
): RealtimeConversationMessage[][] {
  const groups: RealtimeConversationMessage[] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (last?.role === message.role) last.text += `\n\n${message.text}`
    else groups.push({ ...message })
  }
  if (groups[0]?.role === 'assistant') {
    groups.unshift({ role: 'user', text: '[历史传递状态：此答复对应的用户消息未提供。]' })
  }
  if (groups.at(-1)?.role === 'user') {
    groups.push({ role: 'assistant', text: '[历史传递状态：此轮尚无最终答复，不能视为完成。]' })
  }
  const pairs: RealtimeConversationMessage[][] = []
  for (let i = 0; i < groups.length; i += 2) pairs.push(groups.slice(i, i + 2))
  return pairs
}

export function selectConversationHistory(value: unknown): {
  messages: RealtimeConversationMessage[]
  omitted: boolean
} {
  const valid = Array.isArray(value)
    ? value
        .filter(
          (item): item is RealtimeConversationMessage =>
            !!item &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.text === 'string'
        )
        .map((item) => ({ role: item.role, text: item.text.trim() }))
        .filter((item) => item.text)
    : []
  const pairs = pairConversationHistory(valid)
  const selected: RealtimeConversationMessage[][] = []
  let chars = 0
  for (let i = pairs.length - 1; i >= 0; i--) {
    const size = pairs[i].reduce((sum, message) => sum + message.text.length, 0)
    // Never skip a recent oversized turn and pretend older turns are the latest context.
    if (chars + size > REALTIME_HISTORY_MAX_CHARS || selected.length >= REALTIME_HISTORY_MAX_PAIRS)
      break
    selected.unshift(pairs[i])
    chars += size
  }
  return { messages: selected.flat(), omitted: selected.length < pairs.length }
}
