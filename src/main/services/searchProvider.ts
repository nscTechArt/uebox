import { resolveApiKey } from '../ai/credentials'
import { readSettings } from '../ai/store'

/**
 * 「网页检索走哪条路」的解析。
 *
 * 检索和生图、视频、实时语音走同一套心智：用户在 设置 → 模型 里加一个
 * **用途是「网页检索」**的 Provider，再把 `search` 角色绑上去。这一档里的
 * 「模型」不是模型 —— 是**去哪儿搜**（哪个搜索站、哪个接口）。
 *
 * **没绑定不是错误。** 社区版承诺零配置，没绑就用内置浏览器 —— 所以这里
 * 返回 `null` 而不是抛异常，让调用方走默认那条。
 */

/** 目录里预置的三条。用户自定义的 Provider 会是别的 id */
export const BUILTIN_BROWSER_PROVIDER_ID = 'builtin-browser'
export const SEARXNG_PROVIDER_ID = 'searxng'
export const JINA_SEARCH_PROVIDER_ID = 'jina-search'

export interface ResolvedSearchProvider {
  providerId: string
  /** 「去哪儿搜」：duckduckgo / bing / web-search / s.jina.ai … */
  modelId: string
  /** 实例地址。内置浏览器这条是空的 —— 它不请求谁的 API */
  baseUrl: string
  /** 取出来的明文密钥。SearXNG 和内置浏览器都不需要 */
  apiKey?: string
}

/**
 * 读出用户绑在 `search` 角色上的那条路。
 *
 * 读不出来（没绑、Provider 被删了、密钥库打不开）一律返回 `null`，
 * 由调用方回落到内置浏览器 —— **检索不该因为配置问题整个不可用**。
 */
export async function resolveSearchProvider(): Promise<ResolvedSearchProvider | null> {
  try {
    const settings = await readSettings()
    const binding = settings.roles.search
    if (!binding) return null

    const provider = settings.providers.find((item) => item.id === binding.providerId)
    if (!provider) return null

    // 密钥取不出来不代表这条路不能走：SearXNG 和内置浏览器本来就没有密钥
    const apiKey = await resolveApiKey(provider.apiKey).catch(() => undefined)

    return {
      providerId: provider.id,
      modelId: binding.modelId,
      baseUrl: provider.baseUrl ?? '',
      ...(apiKey ? { apiKey } : {})
    }
  } catch {
    return null
  }
}
