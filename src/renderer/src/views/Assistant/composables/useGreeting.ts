import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ComputedRef } from 'vue'

export type GreetingTranslationKey =
  | 'assistant.greeting.morning'
  | 'assistant.greeting.afternoon'
  | 'assistant.greeting.evening'

export function getGreetingTranslationKey(hours: number): GreetingTranslationKey {
  if (hours >= 5 && hours < 12) return 'assistant.greeting.morning'
  if (hours >= 12 && hours < 18) return 'assistant.greeting.afternoon'
  return 'assistant.greeting.evening'
}

/**
 * 问候语 Composable
 * 提供基于时间的完整问候语
 */
export function useGreeting(): {
  greetingMessage: ComputedRef<string>
} {
  const { t } = useI18n()

  /**
   * 根据当前时间返回完整问候语
   * @returns 本地化后的单行问候语
   */
  const greetingMessage = computed(() => {
    const hours = new Date().getHours()
    const greeting = t(getGreetingTranslationKey(hours))
    return t('assistant.welcome.greetingPrompt', { greeting })
  })

  return {
    greetingMessage
  }
}
