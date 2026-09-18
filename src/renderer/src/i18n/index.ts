import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'
// 导入ant-design-vue语言包
import antdZhCN from 'ant-design-vue/es/locale/zh_CN'
import antdEnUS from 'ant-design-vue/es/locale/en_US'

const LOCALE_STORAGE_KEY = 'locale'

/** 用户是否已选择界面语言。 */
export const hasExplicitLocale = (): boolean => {
  return Boolean(localStorage.getItem(LOCALE_STORAGE_KEY))
}

/**
 * 启动时的初始语言。
 *
 * 只在用户已显式选过时读取；未选过一律先按中文渲染，
 * 但此时 LanguageGate 会挡在前面，用户看不到未选择状态下的业务界面。
 */
const getInitialLocale = (): string => {
  return localStorage.getItem(LOCALE_STORAGE_KEY) || 'zh-CN'
}

const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS
  },
  // 禁用警告，避免控制台被刷屏
  missingWarn: false,
  fallbackWarn: false,
  warnHtmlMessage: false
})

export default i18n

// ant-design-vue语言包映射
export const antdLocaleMap = {
  'zh-CN': antdZhCN,
  'en-US': antdEnUS
}

/**
 * 切换界面语言。
 *
 * **同时推给主进程。** 托盘菜单、系统文件对话框、启动失败的错误框都是 Electron
 * 交给操作系统画的，渲染进程碰不到，它们的文案由主进程那张表出
 * （`main/i18n.ts`），而那张表的语言只来自 `appSettingsManager`。
 *
 * 推送原来写在调用方：设置页推了，**首次启动的语言门没推**。后果是新用户在语言门
 * 选了 English，整个第一次会话里托盘还是「显示窗口 / 最小化 / 退出」、原生选文件
 * 对话框的标题是中文 —— 而那恰恰是他最可能开托盘、最可能点「导入工程」的一次。
 * 挪进来之后，任何人调 setLocale 都不会再漏。
 */
export const setLocale = (locale: string) => {
  i18n.global.locale.value = locale as 'zh-CN' | 'en-US'
  localStorage.setItem(LOCALE_STORAGE_KEY, locale)

  // 主进程那张表跟着走。失败不该拦住界面切语言 —— 最坏的结果是托盘暂时还是旧语言
  window.api?.appSettings?.setLanguage?.(locale as 'zh-CN' | 'en-US').catch((error: Error) => {
    console.warn('[i18n] 语言没能推给主进程，托盘/原生对话框会暂时保持旧语言:', error)
  })

  // 设置ant-design-vue语言包
  const antdLocale = antdLocaleMap[locale as keyof typeof antdLocaleMap]
  if (antdLocale) {
    // ConfigProvider.config({
    //   locale: antdLocale
    // })
  }
}

// 导出获取当前语言的方法
export const getLocale = () => {
  return i18n.global.locale.value
}

// 导出获取当前ant-design-vue语言包的方法
export const getCurrentAntdLocale = () => {
  const currentLocale = getLocale()
  return antdLocaleMap[currentLocale as keyof typeof antdLocaleMap] || antdZhCN
}

// 导出支持的语言列表
export const supportedLocales = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en-US', label: 'English' }
]
