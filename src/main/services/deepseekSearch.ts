import type { WebSearchItem } from './webSearch'

/**
 * DeepSeek 的网页检索接口（`POST /v1/tools/search`）。
 *
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search/
 *
 * 它不是对话模型的一个开关，是一个独立的 JSON 接口：给关键词，回一个结果列表
 * （标题、链接、摘要、日期）。形状和 `web_search` 的契约正好对得上，所以和
 * Jina、SearXNG 并列成一条可绑的路，而不是塞进对话请求里。
 *
 * 和另外几条比，它的长处是中文结果好、国内直连不用挂代理；代价是按次计费
 * （成功且有结果才计，每 1000 次 5 元），账号级 5 QPS。
 */

/** 和其它检索路径同一个超时。这是交互动作，不该让用户干等 */
const SEARCH_TIMEOUT_MS = 15_000

/** 接口要求 `query` 1～128 个字符，超了整个请求 400 */
const MAX_QUERY_CHARS = 128

/** 用户没填地址时用这个。目录里预置的也是它 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'

export interface DeepseekSearchResult {
  success: boolean
  items?: WebSearchItem[]
  error?: string
}

interface DeepseekRow {
  title?: unknown
  url?: unknown
  snippet?: unknown
  date?: unknown
}

/**
 * 状态码 → 用户下一步该做什么。
 *
 * 文档列的那几个各对应一件不同的事：401 换 Key、402 去充值、429 等一下。
 * 糊成一句「检索失败」用户改不到点子上。
 */
function describeStatus(status: number, message: string): string {
  const detail = message ? `（${message}）` : ''
  switch (status) {
    case 401:
      return `DeepSeek API Key 无效${detail}。请在「设置 → 模型」中检查 DeepSeek 的 Key。`
    case 402:
      return `DeepSeek 账户余额不足${detail}。充值后再试。`
    case 429:
      return `DeepSeek 检索超过频率限制（账号级每秒 5 次）${detail}。稍等再试。`
    case 403:
      return `DeepSeek 拒绝了这次检索${detail}。`
    default:
      return `DeepSeek 返回 HTTP ${status}${detail}。`
  }
}

/** 错误体是 OpenAI 兼容格式：`{ error: { message } }`。读不出来就不带 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    return typeof body.error?.message === 'string' ? body.error.message : ''
  } catch {
    return ''
  }
}

/** 按字符（不是 UTF-16 码元）截断，避免把一个汉字或表情劈成两半 */
function clampQuery(query: string): string {
  const chars = Array.from(query)
  return chars.length > MAX_QUERY_CHARS ? chars.slice(0, MAX_QUERY_CHARS).join('') : query
}

export async function searchViaDeepseek(
  baseUrl: string,
  apiKey: string,
  query: string,
  limit: number
): Promise<DeepseekSearchResult> {
  const base = (baseUrl.trim() || DEEPSEEK_DEFAULT_BASE_URL)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const response = await fetch(`${base}/v1/tools/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query: clampQuery(query), count: limit }),
      signal: controller.signal
    })

    if (response.status !== 200) {
      return {
        success: false,
        error: describeStatus(response.status, await readErrorMessage(response))
      }
    }

    const body = (await response.json()) as { results?: DeepseekRow[] }
    const items: WebSearchItem[] = (body.results ?? []).slice(0, limit).map((row) => ({
      title: String(row.title ?? ''),
      url: String(row.url ?? ''),
      snippet: String(row.snippet ?? ''),
      ...(row.date ? { publishedAt: String(row.date) } : {})
    }))

    if (items.length === 0) return { success: false, error: 'DeepSeek 检索没有返回结果。' }
    return { success: true, items }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      success: false,
      error: aborted
        ? `DeepSeek 检索超时（${SEARCH_TIMEOUT_MS / 1000} 秒）。`
        : `无法连接 DeepSeek：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    clearTimeout(timer)
  }
}
