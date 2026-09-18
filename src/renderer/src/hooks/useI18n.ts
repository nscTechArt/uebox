import { computed } from 'vue'
import { useI18n as useVueI18n } from 'vue-i18n'
import { setLocale, getLocale, supportedLocales } from '../i18n'
import type { Composer } from 'vue-i18n'

export interface UseI18nReturn {
  // 当前语言
  locale: Composer['locale']
  // 翻译函数
  t: Composer['t']
  // 切换语言
  changeLocale: (locale: string) => void
  // 获取当前语言
  getCurrentLocale: () => string
  // 支持的语言列表
  locales: typeof supportedLocales
  // 当前语言标签
  currentLocaleLabel: import('vue').ComputedRef<string>
}

/**
 * 国际化操作hook
 * @returns UseI18nReturn
 */
export const useI18n = (): UseI18nReturn => {
  const { locale, t } = useVueI18n()

  // 切换语言
  const changeLocale = (newLocale: string) => {
    if (supportedLocales.some((item) => item.value === newLocale)) {
      setLocale(newLocale)
      // 刷新页面以应用ant-design-vue的语言包
      window.location.reload()
    } else {
      console.warn(`Unsupported locale: ${newLocale}`)
    }
  }

  // 获取当前语言
  const getCurrentLocale = () => {
    return getLocale()
  }

  // 当前语言标签
  const currentLocaleLabel = computed(() => {
    const current = supportedLocales.find((item) => item.value === locale.value)
    return current?.label || locale.value
  })

  return {
    locale,
    t,
    changeLocale,
    getCurrentLocale,
    locales: supportedLocales,
    currentLocaleLabel
  }
}

export default useI18n
