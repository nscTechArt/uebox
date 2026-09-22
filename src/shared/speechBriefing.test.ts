/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPEECH_BRIEFING_STYLE,
  SPEECH_BRIEFING_SKIP_UNDER,
  SPEECH_BRIEFING_STYLES,
  normalizeSpeechBriefingStyle,
  shouldBriefForSpeech
} from './speechBriefing'

describe('normalizeSpeechBriefingStyle', () => {
  it('认识的档位原样返回', () => {
    for (const style of SPEECH_BRIEFING_STYLES) {
      expect(normalizeSpeechBriefingStyle(style)).toBe(style)
    }
  })

  /** 老配置里没有这个字段：必须回「原文照念」，老用户听到的东西不能变 */
  it.each([undefined, null, '', 'short', 42, {}])('认不出的 %s 回默认档', (value) => {
    expect(normalizeSpeechBriefingStyle(value)).toBe(DEFAULT_SPEECH_BRIEFING_STYLE)
    expect(DEFAULT_SPEECH_BRIEFING_STYLE).toBe('full')
  })
})

describe('shouldBriefForSpeech', () => {
  it('原文照念永远不走模型', () => {
    expect(shouldBriefForSpeech('full', 0)).toBe(false)
    expect(shouldBriefForSpeech('full', 100_000)).toBe(false)
  })

  /** 一两句话的回复压一遍只会让音频晚开始，不压 */
  it('简洁与详细各有门槛，短于门槛不压', () => {
    for (const style of ['concise', 'detailed'] as const) {
      const under = SPEECH_BRIEFING_SKIP_UNDER[style]
      expect(shouldBriefForSpeech(style, under - 1)).toBe(false)
      expect(shouldBriefForSpeech(style, under)).toBe(true)
    }
    expect(SPEECH_BRIEFING_SKIP_UNDER.concise).toBeLessThan(SPEECH_BRIEFING_SKIP_UNDER.detailed)
  })
})
