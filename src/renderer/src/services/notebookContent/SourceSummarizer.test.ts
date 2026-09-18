import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamedChatParams } from '@renderer/api/ai'

const aiMocks = vi.hoisted(() => ({ chatText: vi.fn() }))
vi.mock('@renderer/api/ai', () => ({ aiAPI: { chatText: aiMocks.chatText } }))

const budgetMocks = vi.hoisted(() => ({ getModelLimits: vi.fn() }))
vi.mock('@renderer/services/notebook/contextBudget', () => ({
  getModelLimits: budgetMocks.getModelLimits
}))

import { cleanWebContent, condenseSource, shouldCleanWebContent } from './SourceSummarizer'

beforeEach(() => {
  aiMocks.chatText.mockReset()
  budgetMocks.getModelLimits.mockReset()
  budgetMocks.getModelLimits.mockResolvedValue({ contextWindow: 128_000, maxOutputTokens: 8192 })
})

describe('shouldCleanWebContent', () => {
  it('太短的页面不值得花一次调用', () => {
    expect(shouldCleanWebContent('短', 'https://example.com')).toBe(false)
  })

  it('YouTube 是字幕，没有页面噪音', () => {
    expect(shouldCleanWebContent('x'.repeat(5000), 'https://youtube.com/watch?v=1')).toBe(false)
    expect(shouldCleanWebContent('x'.repeat(5000), 'https://youtu.be/abc')).toBe(false)
  })

  it('公众号页面也要清洗 —— 上一版因为类型不叫 link 从来没清过', () => {
    expect(shouldCleanWebContent('x'.repeat(5000), 'https://mp.weixin.qq.com/s/abc')).toBe(true)
  })

  it('没有 URL 的长内容照样清洗', () => {
    expect(shouldCleanWebContent('x'.repeat(5000))).toBe(true)
  })
})

describe('cleanWebContent', () => {
  it('成功时把清洗后的正文交回去', async () => {
    // 去噪只删掉噪音，长度和原文同量级
    const cleaned = '清洗后的正文'.repeat(700)
    aiMocks.chatText.mockResolvedValue(`  ${cleaned}  `)

    await expect(cleanWebContent('x'.repeat(5000))).resolves.toEqual({
      ok: true,
      content: cleaned
    })
  })

  it('模型一次写不下整篇就根本不开始 —— 截一半回来会当成清洗成功覆盖原文', async () => {
    budgetMocks.getModelLimits.mockResolvedValue({ contextWindow: 32_000, maxOutputTokens: 4096 })

    const outcome = await cleanWebContent('中'.repeat(50_000))

    expect(outcome.ok).toBe(false)
    expect(aiMocks.chatText).not.toHaveBeenCalled()
  })

  it('写得下的时候正常发，maxTokens 在模型上限之内', async () => {
    aiMocks.chatText.mockResolvedValue('清洗后的正文'.repeat(200))
    budgetMocks.getModelLimits.mockResolvedValue({ contextWindow: 32_000, maxOutputTokens: 4096 })

    await cleanWebContent('中'.repeat(2000))

    const params = aiMocks.chatText.mock.calls[0][0] as StreamedChatParams
    expect(params.maxTokens).toBeLessThanOrEqual(4096)
    expect(params.maxTokens).toBeGreaterThan(0)
  })

  it('结果短得离谱当成写到一半停了，不拿去覆盖原文', async () => {
    // 模型只回了原文十分之一 —— 去噪不该删掉这么多
    aiMocks.chatText.mockResolvedValue('短'.repeat(200))

    const outcome = await cleanWebContent('中'.repeat(5000))

    expect(outcome.ok).toBe(false)
  })

  it('不绑厂商：不传 provider / model，只按角色走用户配的模型', async () => {
    aiMocks.chatText.mockResolvedValue('清洗后的正文')

    await cleanWebContent('x'.repeat(5000))

    const params = aiMocks.chatText.mock.calls[0][0] as StreamedChatParams
    expect(params.provider).toBeUndefined()
    expect(params.model).toBeUndefined()
    expect(params.level).toBe('fast')
  })

  it('模型回空时说清楚是没清成，不假装成功', async () => {
    aiMocks.chatText.mockResolvedValue('   ')

    const outcome = await cleanWebContent('x'.repeat(5000))
    expect(outcome.ok).toBe(false)
    expect(outcome).toHaveProperty('reason')
  })

  it('调用抛错时带上原因，而不是静默返回原文', async () => {
    aiMocks.chatText.mockRejectedValue(new Error('余额不足'))

    const outcome = await cleanWebContent('x'.repeat(5000))
    expect(outcome).toEqual({ ok: false, reason: '余额不足' })
  })
})

describe('condenseSource', () => {
  it('太短的正文压了也省不下什么，直接不压', async () => {
    await expect(condenseSource('短内容')).resolves.toBeNull()
    expect(aiMocks.chatText).not.toHaveBeenCalled()
  })

  it('读多少正文按模型窗口算，不是写死的 6 万字', async () => {
    aiMocks.chatText.mockResolvedValue('压'.repeat(500))
    budgetMocks.getModelLimits.mockResolvedValue({ contextWindow: 8_000, maxOutputTokens: 2048 })

    await condenseSource('中'.repeat(100_000))

    const params = aiMocks.chatText.mock.calls[0][0] as StreamedChatParams
    const userText = String(params.messages[1].content)
    // 8k 窗口的模型只该收到几千字，而不是 6 万
    expect(userText.length).toBeLessThan(8000)
  })

  it('压完比原文还长就丢掉 —— 留着只会更费钱', async () => {
    aiMocks.chatText.mockResolvedValue('长'.repeat(9000))
    await expect(condenseSource('中'.repeat(3000))).resolves.toBeNull()
  })

  it('只回一句寒暄当没生成', async () => {
    aiMocks.chatText.mockResolvedValue('好的')
    await expect(condenseSource('中'.repeat(3000))).resolves.toBeNull()
  })

  it('失败返回 null，不抛异常打断用户切档位', async () => {
    aiMocks.chatText.mockRejectedValue(new Error('没配模型'))
    await expect(condenseSource('中'.repeat(3000))).resolves.toBeNull()
  })
})
