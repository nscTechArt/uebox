/**
 * 厂商用量过期时不能照它判「不用压」。
 *
 * 真机事故：队员重新派活时 agent 重建、检查点没了，要发的是 977 条完整历史，
 * 而最后那条 assistant 带的用量是上一轮压缩后视图的 9.4 万 —— 照它算远低于压缩线，
 * 原样发出，厂商回「input exceeds the context window」。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

const { generateSummary } = vi.hoisted(() => ({ generateSummary: vi.fn() }))
vi.mock('../vendor/pi-harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vendor/pi-harness')>()
  return { ...actual, generateSummary }
})

import { compactionThreshold, createAutoCompact, estimateOutgoingTokens } from './compaction'

const text = (role: 'user' | 'assistant', chars: number): AgentMessage =>
  ({
    role,
    content: role === 'user' ? 'x'.repeat(chars) : [{ type: 'text', text: 'x'.repeat(chars) }],
    timestamp: 0
  }) as unknown as AgentMessage

const withUsage = (message: AgentMessage, totalTokens: number): AgentMessage =>
  ({ ...message, stopReason: 'endTurn', usage: { totalTokens } }) as unknown as AgentMessage

/** 一条带大图的用户消息：图按字节很大，按 pi 的口径记 1200 token */
const image = (): AgentMessage =>
  ({
    role: 'user',
    content: [{ type: 'image', data: 'A'.repeat(4_000), mimeType: 'image/png' }],
    timestamp: 0
  }) as unknown as AgentMessage

/** 带大段思考的 assistant：好几家不把上一轮的思考再发一遍 */
const thinking = (chars: number): AgentMessage =>
  ({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'y'.repeat(chars) },
      { type: 'text', text: 'ok' }
    ],
    timestamp: 0
  }) as unknown as AgentMessage

describe('estimateOutgoingTokens', () => {
  it('正常会话照信厂商用量：它还含系统提示词和工具定义，比文字下限大', () => {
    const base = [
      text('user', 4_000),
      withUsage(text('assistant', 4_000), 30_000),
      text('user', 400)
    ]
    const result = estimateOutgoingTokens(base)
    expect(result.staleUsage).toBe(false)
    expect(result.tokens).toBe(30_000 + 100)
  })

  it('要发的这份比厂商报账时大得多：用量过期，改用文字下限', () => {
    // 盘上的完整历史：400 万字符 ≈ 100 万 token，而最后那条带的是压缩后视图的 9.4 万
    const base = [
      ...Array.from({ length: 100 }, (_, i) => text(i % 2 ? 'assistant' : 'user', 40_000)),
      withUsage(text('assistant', 400), 94_000),
      text('user', 400)
    ]
    const result = estimateOutgoingTokens(base)
    expect(result.staleUsage).toBe(true)
    expect(result.tokens).toBeGreaterThan(1_000_000)
  })

  it('图片不进下限：厂商如实报了低价的会话，不能被判成过期', () => {
    const base = [...Array.from({ length: 50 }, image), withUsage(text('assistant', 40), 5_000)]
    expect(estimateOutgoingTokens(base).staleUsage).toBe(false)
  })

  it('思考不进下限：上一轮的思考很多家不再发，不能被判成过期', () => {
    const base = [thinking(400_000), withUsage(text('assistant', 40), 5_000)]
    expect(estimateOutgoingTokens(base).staleUsage).toBe(false)
  })

  it('还没有厂商用量时就是逐条估算', () => {
    const result = estimateOutgoingTokens([text('user', 4_000)])
    expect(result).toEqual({ tokens: 1_000, lastUsageIndex: null, staleUsage: false })
  })
})

describe('createAutoCompact 遇到过期用量', () => {
  it('照文字下限判：该压就压，不再原样发出撞上限', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: '之前做了很多' })
    const contextWindow = 272_000
    const compact = createAutoCompact({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      models: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      summaryModel: { id: 'm', contextWindow } as any,
      contextWindow
    })
    // 约 150 万字符的历史，最后一条带着上一轮压缩后的用量
    const history = [
      ...Array.from({ length: 38 }, (_, i) => text(i % 2 ? 'assistant' : 'user', 40_000)),
      withUsage(text('assistant', 400), 94_000),
      text('user', '继续'.length)
    ]
    // 前提：照厂商用量算确实在线下 —— 修之前就是在这里放行的
    expect(94_000).toBeLessThan(compactionThreshold(contextWindow))

    const result = await compact(history)

    expect(generateSummary).toHaveBeenCalledTimes(1)
    expect(result.length).toBeLessThan(history.length)
  })
})
