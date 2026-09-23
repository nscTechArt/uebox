/**
 * Box Plan 的网页检索：`POST {base}/search`（协议 08-search）。
 *
 * 由 `services/webSearch.ts` 在「网页检索」绑的是套餐来源时调用。地址从参数拿，
 * 不写域名（官方端点门禁）。结果字段与我们的 `WebSearchItem` 几乎一一对应：
 * `snippet` 直接用，`published_at` → `publishedAt`，`score` 不要（我们自己做回读校验）。
 */

import { planCallError } from './callError'

export interface PlanSearchItem {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

export interface PlanSearchRequest {
  baseUrl: string
  apiKey: string
  model: string
  query: string
  /** 超过清单 max_results 服务端按上限给，不报错 */
  limit: number
  /** BCP 47，如 `zh-CN` / `en`。影响结果语言偏好 */
  language?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** 协议限定查询不超过 400 字符。超了截断而不是整次失败：前 400 字足够表达一次检索 */
const MAX_QUERY_CHARS = 400

/**
 * 搜一次。**会抛**：网络失败、非 2xx、响应形状不对。
 * 套餐那几种错误（402 / 403 / 401）抛 `CreatorPlanCallError`，文案说清下一步。
 */
export async function searchViaPlan(request: PlanSearchRequest): Promise<PlanSearchItem[]> {
  const fetchImpl = request.fetchImpl ?? fetch
  const response = await fetchImpl(`${request.baseUrl.replace(/\/+$/, '')}/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN'
    },
    body: JSON.stringify({
      model: request.model,
      query: Array.from(request.query).slice(0, MAX_QUERY_CHARS).join(''),
      limit: request.limit,
      ...(request.language ? { language: request.language } : {})
    }),
    signal: AbortSignal.timeout(request.timeoutMs ?? 15_000)
  })
  const raw = await response.text()
  let body: unknown = null
  try {
    body = JSON.parse(raw)
  } catch {
    body = null
  }
  if (!response.ok) {
    const planError = planCallError(response.status, body, response.headers)
    if (planError) throw planError
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message
    throw new Error(`HTTP ${response.status}${typeof message === 'string' ? `：${message}` : ''}`)
  }
  const results = (body as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) throw new Error('响应里没有 results')
  return results
    .map((item) => item as Record<string, unknown>)
    .filter((item) => typeof item?.url === 'string' && item.url)
    .map((item) => ({
      title: String(item.title ?? ''),
      url: String(item.url),
      snippet: String(item.snippet ?? ''),
      ...(typeof item.published_at === 'string' ? { publishedAt: item.published_at } : {})
    }))
}
