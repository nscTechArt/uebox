import { checkNavigationUrl } from './urlPolicy'

/** 地址栏里不是网址的输入拿去搜。必应在国内外都打得开 */
export const SEARCH_URL = 'https://www.bing.com/search?q='

export function searchUrl(query: string): string {
  return SEARCH_URL + encodeURIComponent(query.trim())
}

/**
 * 像不像网址：带协议、`//` 开头，或者没有空格且有点号 / 是 localhost / 带端口。
 * 都不像就当搜索词 —— 和现代浏览器的地址栏一样。
 */
function looksLikeAddress(input: string): boolean {
  if (/\s/.test(input)) return false
  if (input.startsWith('//')) return true
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return true
  const host = input.split(/[/?#]/, 1)[0]
  return host.includes('.') || /^localhost(?::\d+)?$/i.test(host) || /:\d+$/.test(host)
}

/** 地址栏允许省略协议；所有入口仍遵守同一 URL 策略。 */
export function normalizeBrowserAddress(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid browser address')
  const input = value.trim()
  if (!looksLikeAddress(input) && !/^[a-z][a-z\d+.-]*:/i.test(input)) return searchUrl(input)
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[\w.-]+:\d+(?:[/#?]|$)/.test(input)
  const url = hasScheme ? input : input.startsWith('//') ? `https:${input}` : `https://${input}`
  const checked = checkNavigationUrl(url)
  if (!checked.ok) throw new Error(checked.reason)
  return checked.url.toString()
}
