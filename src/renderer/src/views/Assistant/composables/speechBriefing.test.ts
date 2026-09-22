import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_BRIEFING_SKIP_UNDER } from '@core/shared/speechBriefing'
import {
  briefForSpeech,
  clearSpeechBriefingCacheForTest,
  clipBriefingInput,
  MAX_BRIEFING_INPUT_CHARS
} from './speechBriefing'

/**
 * 念之前压一遍这件事的三条规矩：该不该压、压坏了退回原文、同一条不压两次。
 * 模型调用本身注入进来，这里不碰 `api/ai`。
 */

const longReply = `## 结果\n\n${'已经把资产建好了，路径在 Content/Test。'.repeat(30)}`
const shortReply = '好的，已经建好了。'

beforeEach(() => clearSpeechBriefingCacheForTest())

describe('briefForSpeech', () => {
  it('「完整」不走模型，原文照念', async () => {
    const condense = vi.fn(async () => '压过的')
    expect(await briefForSpeech(longReply, 'full', { condense })).toBe(longReply)
    expect(condense).not.toHaveBeenCalled()
  })

  /** 一句话的回复压一遍只会让音频晚两秒开始 */
  it('短于门槛不压，按去掉 Markdown 之后的字数算', async () => {
    const condense = vi.fn(async () => '压过的')
    expect(await briefForSpeech(shortReply, 'concise', { condense })).toBe(shortReply)
    // Markdown 符号堆出来的长度不算数
    const decorated = `<!-- ${'x'.repeat(SPEECH_BRIEFING_SKIP_UNDER.concise)} -->
${shortReply}`
    expect(await briefForSpeech(decorated, 'concise', { condense })).toBe(decorated)
    expect(condense).not.toHaveBeenCalled()
  })

  it('够长就交给模型，喂的是原文 Markdown，回的是口播稿', async () => {
    const condense = vi.fn(async () => '资产建好了，在 Content 下的 Test 目录。')
    expect(await briefForSpeech(longReply, 'concise', { condense })).toBe(
      '资产建好了，在 Content 下的 Test 目录。'
    )
    expect(condense).toHaveBeenCalledWith(longReply, 'concise')
  })

  /** 朗读不能因为一个装饰性的调用而没声音；原因报给调用方，模型没配这种事该提示一次 */
  it('模型没配 / 抛错 / 回空话或只回标点，一律退回念原文，并报出原因', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onFallback = vi.fn()
    expect(
      await briefForSpeech(longReply, 'detailed', {
        condense: async () => {
          throw new Error('TTS_NOT_CONFIGURED')
        },
        onFallback
      })
    ).toBe(longReply)
    expect(onFallback).toHaveBeenLastCalledWith('error')
    expect(
      await briefForSpeech(longReply, 'detailed', { condense: async () => '   ', onFallback })
    ).toBe(longReply)
    expect(onFallback).toHaveBeenLastCalledWith('empty')
    expect(
      await briefForSpeech(longReply, 'detailed', { condense: async () => '---', onFallback })
    ).toBe(longReply)
    expect(onFallback).toHaveBeenLastCalledWith('empty')
  })

  /** 厂商那头挂住了，音频不能跟着一直不响 */
  it('模型迟迟不回，超时后改念原文', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onFallback = vi.fn()
    const pending = briefForSpeech(longReply, 'concise', {
      condense: () => new Promise(() => {}),
      timeoutMs: 1000,
      onFallback
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(longReply)
    expect(onFallback).toHaveBeenCalledWith('error')
    vi.useRealTimers()
  })

  it('同一条同一档只压一次；换档要重压', async () => {
    const condense = vi.fn(async (_text: string, style: string) => `${style} 稿`)
    await briefForSpeech(longReply, 'concise', { condense })
    await briefForSpeech(longReply, 'concise', { condense })
    expect(condense).toHaveBeenCalledTimes(1)
    expect(await briefForSpeech(longReply, 'detailed', { condense })).toBe('detailed 稿')
    expect(condense).toHaveBeenCalledTimes(2)
  })

  it('压失败、压出来念不出声的都不进缓存，下次还会再试', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const condense = vi
      .fn<(text: string, style: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('---')
      .mockResolvedValueOnce('稿')
    expect(await briefForSpeech(longReply, 'concise', { condense })).toBe(longReply)
    expect(await briefForSpeech(longReply, 'concise', { condense })).toBe(longReply)
    expect(await briefForSpeech(longReply, 'concise', { condense })).toBe('稿')
    expect(condense).toHaveBeenCalledTimes(3)
  })

  /** 调用方多半已经算过纯文本，传进来就不再 lexer 一遍 */
  it('传了 plainText 就按它判门槛', async () => {
    const condense = vi.fn(async () => '稿')
    expect(await briefForSpeech(longReply, 'concise', { condense, plainText: '短' })).toBe(
      longReply
    )
    expect(condense).not.toHaveBeenCalled()
  })
})

describe('clipBriefingInput', () => {
  /** 结论多半在尾巴上，开头说的是这轮在干什么；中间的过程才是要扔的 */
  it('超长时掐头去尾各留一半，不超时原样', () => {
    expect(clipBriefingInput('abc', 10)).toBe('abc')
    expect(clipBriefingInput('0123456789ABCDEF', 8)).toBe('0123\n…\nCDEF')
    const huge = 'x'.repeat(MAX_BRIEFING_INPUT_CHARS * 2)
    expect(clipBriefingInput(huge).length).toBeLessThan(MAX_BRIEFING_INPUT_CHARS + 8)
  })
})
