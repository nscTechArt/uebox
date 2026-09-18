import { describe, expect, it } from 'vitest'
import { selectConversationHistory, REALTIME_HISTORY_MAX_CHARS } from './conversationHistory'
import type { RealtimeConversationMessage } from './types'

const pair = (text: string): RealtimeConversationMessage[] => [
  { role: 'user', text: `question ${text.slice(0, 10)}` },
  { role: 'assistant', text }
]

describe('voice history budget', () => {
  it('keeps complete long answers including details in the middle', () => {
    const input = pair('开始' + 'a'.repeat(700) + '关键限定' + 'b'.repeat(700) + '下一步问题')
    expect(selectConversationHistory(input)).toEqual({ messages: input, omitted: false })
  })
  it('keeps a contiguous suffix of whole turns within the shared budget', () => {
    const old = pair('o'.repeat(4000))
    const middle = pair('m'.repeat(4000))
    const recent = pair('r'.repeat(2000))
    const result = selectConversationHistory([...old, ...middle, ...recent])
    expect(result).toEqual({ messages: [...middle, ...recent], omitted: true })
    expect(result.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(
      REALTIME_HISTORY_MAX_CHARS
    )
  })
  it('does not fall back to stale history when the newest turn exceeds the budget', () => {
    expect(selectConversationHistory([...pair('old'), ...pair('x'.repeat(8001))])).toEqual({
      messages: [],
      omitted: true
    })
  })
  it('limits complete turns instead of individual messages', () => {
    const input = Array.from({ length: 12 }, (_, i) => pair(String(i))).flat()
    expect(selectConversationHistory(input)).toEqual({ messages: input.slice(4), omitted: true })
  })
  it('filters invalid messages without discarding short valid text', () => {
    expect(selectConversationHistory(null)).toEqual({ messages: [], omitted: false })
    expect(
      selectConversationHistory([
        null,
        { role: 'system', text: 'secret' },
        { role: 'user', text: 1 },
        { role: 'user', text: ' ' },
        ...pair('valid')
      ]).messages
    ).toEqual(pair('valid'))
  })
  it('merges consecutive utterances without losing the final paragraph', () => {
    expect(
      selectConversationHistory([
        { role: 'user', text: '需求' },
        { role: 'user', text: '限制' },
        { role: 'assistant', text: '结果' },
        { role: 'assistant', text: '后续问题' }
      ]).messages
    ).toEqual([
      { role: 'user', text: '需求\n\n限制' },
      { role: 'assistant', text: '结果\n\n后续问题' }
    ])
  })
  it('includes an unfinished request without inventing completion', () => {
    const result = selectConversationHistory([{ role: 'user', text: '正在执行的请求' }])
    expect(result.messages[0].text).toBe('正在执行的请求')
    expect(result.messages[1].text).toContain('尚无最终答复')
  })
})
