import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@renderer/api/ai', () => ({ aiAPI: {} }))
vi.mock('@renderer/api/agentV3', () => ({ agentV3API: {} }))

import { useChatFlow } from './useChatFlow'

function makeFlow(): ReturnType<typeof useChatFlow> {
  return useChatFlow({
    sid: ref(''),
    chatStore: {},
    chatMsgStore: {},
    tabsStore: {},
    route: {},
    isImageGenerationMode: ref(false),
    executeAgent: async () => {},
    scrollToBottom: () => {},
    updateContextChips: () => {},
    pushUser: () => {},
    pushAssistantTyping: () => 'typing'
  })
}

describe('useChatFlow 的 normalizeSid', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(['existing', '  existing  '])('已有 sid「%s」原样返回且不碰随机源', (raw) => {
    const nowSpy = vi.spyOn(Date, 'now')
    const randomSpy = vi.spyOn(Math, 'random')

    expect(makeFlow().normalizeSid(raw)).toBe('existing')
    expect(nowSpy).not.toHaveBeenCalled()
    expect(randomSpy).not.toHaveBeenCalled()
  })

  it.each(['', '   '])('空 sid「%s」才生成新 id，两个随机源各调一次', (raw) => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)

    expect(makeFlow().normalizeSid(raw)).toBe('rsi')
    expect(nowSpy).toHaveBeenCalledTimes(1)
    expect(randomSpy).toHaveBeenCalledTimes(1)
  })
})
