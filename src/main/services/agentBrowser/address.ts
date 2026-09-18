import { checkNavigationUrl } from './urlPolicy'

/** 地址栏允许省略协议；所有入口仍遵守同一 URL 策略。 */
export function normalizeBrowserAddress(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid browser address')
  const input = value.trim()
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[\w.-]+:\d+(?:[/#?]|$)/.test(input)
  const url = hasScheme ? input : input.startsWith('//') ? `https:${input}` : `https://${input}`
  const checked = checkNavigationUrl(url)
  if (!checked.ok) throw new Error(checked.reason)
  return checked.url.toString()
}
