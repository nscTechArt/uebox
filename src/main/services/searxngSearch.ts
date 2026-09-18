import type { WebSearchItem } from './webSearch'

/**
 * 自建 SearXNG 实例。
 *
 * ## 为什么值得单独接一条
 *
 * 实测下来它是质量最好的一条：同一台机器、同一个出口 IP，6 个基准用例全中
 * （真浏览器 5 个、Jina 5 个），而且是**唯一一个对无意义查询老实返回 0 条**的
 * 后端 —— 另外两条都还会塞几条无关内容进来。速度也最快，0.5～2.6 秒。
 *
 * 代价是它要用户自己跑一个实例，所以只能是可选项，不能是默认。
 *
 * ## 两个必须说清楚的前提
 *
 * 1. **实例要打开 JSON 输出。** SearXNG 默认只开 html，`settings.yml` 里得写
 *    `search.formats: [html, json]`。实测 10 个公共实例**没有一个**开着 ——
 *    所以这条路实质上只对自建实例有意义，界面文案也要这么讲。
 * 2. **它的好成绩依赖上游引擎。** SearXNG 自己不抓网页，是转发给 Google / Brave
 *    这些。上游被限流时它会**如实报告哪个引擎挂了**（`unresponsive_engines`），
 *    这一点比另外两条强 —— 所以那个字段要带进错误信息里，别丢掉。
 */

/** 和其它检索路径同一个超时。这是交互动作，不该让用户干等 */
const SEARCH_TIMEOUT_MS = 15_000

export interface SearxngSearchResult {
  success: boolean
  items?: WebSearchItem[]
  error?: string
}

interface SearxngRow {
  title?: unknown
  url?: unknown
  content?: unknown
  publishedDate?: unknown
}

interface SearxngBody {
  results?: SearxngRow[]
  /** 每项是 `[引擎名, 原因]` 或一个字符串，两种形状都出现过 */
  unresponsive_engines?: unknown[]
}

function describeDownEngines(raw: unknown[] | undefined): string {
  if (!raw || raw.length === 0) return ''
  const listed = raw
    .map((item) => (Array.isArray(item) ? item.filter(Boolean).join('：') : String(item)))
    .filter(Boolean)
  return listed.length > 0 ? `（挂掉的上游引擎：${listed.join('；')}）` : ''
}

/**
 * 向一个 SearXNG 实例查一次。
 *
 * `baseUrl` 是用户在设置里填的实例地址，形如 `http://localhost:8080`。
 */
export async function searchViaSearxng(
  baseUrl: string,
  query: string,
  limit: number
): Promise<SearxngSearchResult> {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmedBase) {
    return { success: false, error: 'SearXNG 地址是空的，到 设置 → 模型 里把实例地址填上。' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const response = await fetch(
      `${trimmedBase}/search?q=${encodeURIComponent(query)}&format=json`,
      { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'follow' }
    )

    // 只认 200。实例没开 JSON 输出时最常见的回应正是 403 / 429 加一个 HTML 页面
    if (response.status !== 200) {
      return {
        success: false,
        error:
          `SearXNG 返回 HTTP ${response.status}。` +
          '最常见的原因是实例没有打开 JSON 输出 —— ' +
          '在它的 settings.yml 里把 `search.formats` 写成 `[html, json]` 再重启。'
      }
    }

    const body = (await response.json()) as SearxngBody
    const items: WebSearchItem[] = (body.results ?? []).slice(0, limit).map((row) => ({
      title: String(row.title ?? ''),
      url: String(row.url ?? ''),
      snippet: String(row.content ?? ''),
      ...(row.publishedDate ? { publishedAt: String(row.publishedDate) } : {})
    }))

    if (items.length === 0) {
      // 上游引擎全挂和「真的没有结果」要分得开，不然没法排查
      return {
        success: false,
        error: `SearXNG 没有返回结果${describeDownEngines(body.unresponsive_engines)}。`
      }
    }

    return { success: true, items }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      success: false,
      error: aborted
        ? `SearXNG 超时（${SEARCH_TIMEOUT_MS / 1000} 秒）。`
        : `连不上 SearXNG：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    clearTimeout(timer)
  }
}
