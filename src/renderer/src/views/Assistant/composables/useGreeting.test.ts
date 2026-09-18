import { describe, expect, it } from 'vitest'
import enUS from '../../../i18n/locales/en-US'
import zhCN from '../../../i18n/locales/zh-CN'
import { getGreetingTranslationKey } from './useGreeting'

describe('getGreetingTranslationKey', () => {
  it.each([
    [5, 'assistant.greeting.morning'],
    [11, 'assistant.greeting.morning'],
    [12, 'assistant.greeting.afternoon'],
    [17, 'assistant.greeting.afternoon'],
    [18, 'assistant.greeting.evening'],
    [4, 'assistant.greeting.evening']
  ] as const)('returns the expected greeting at %i:00', (hours, expected) => {
    expect(getGreetingTranslationKey(hours)).toBe(expected)
  })
})

describe('welcome greeting copy', () => {
  it('uses one polite sentence without a user name in Chinese', () => {
    expect(zhCN.assistant.welcome.greetingPrompt).toBe('{greeting}，有什么可以帮您？')
  })

  it('keeps the English greeting in one sentence', () => {
    expect(enUS.assistant.welcome.greetingPrompt).toBe('{greeting}, how can I help you?')
  })
})
