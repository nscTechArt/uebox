import { JINA_KEY_MISSING_HINT, resolveJinaApiKey } from '../ai/jinaKey'
import { CreatorPlanCallError } from '../ai/creatorPlan/callError'
import { searchViaPlan } from '../ai/creatorPlan/search'
import { isPlanProvider } from '../../shared/creatorPlan'
import { judgeResults, type Relevance } from './searchRelevance'
import {
  BUILTIN_BROWSER_PROVIDER_ID,
  JINA_SEARCH_PROVIDER_ID,
  resolveSearchProvider,
  SEARXNG_PROVIDER_ID
} from './searchProvider'

/**
 * 网页检索。
 *
 * ## 免密钥那条路为什么被删了
 *
 * 这里原先默认走 Bing 的 RSS 输出（`?format=rss`），理由是「用户不该先申请一个
 * API Key 才能问『最近有什么 UE 新闻』」。理由本身没错，**但那条路实测是负资产**：
 *
 *   - 相当比例的查询返回 HTTP 200、格式完整、`<channel><title>` 还回显查询词，
 *     但 `<item>` 里装的是**和查询毫无关系**的内容；
 *   - 同一条查询连跑 4 次，拿到 4 批**各不相同**的垃圾；
 *   - Bing 的正常 HTML 搜索页有一模一样的毛病，所以不是 RSS 端点的问题 ——
 *     是这个客户端被判成了机器人，拿到的是降级结果。
 *
 * 关键在于**调用方分辨不出来**：没有任何字段能区分「真结果」和「降级结果」。
 * 一个看起来成功的错误答案，比一个诚实的失败坏得多 —— 模型会拿着它一路错下去。
 * 所以整条删掉，不留开关、不留兼容层。
 *
 * 详细的实测数据和后续方案（真浏览器跑 SERP、可选的 SearXNG / 第三方 key）
 *
 * ## 现在走哪条
 *
 * 由用户在 设置 → 模型 里绑定的 **`search` 角色**决定，和生图、视频、
 * 实时语音是同一套心智：一个 Provider = 一个地址 + 一套凭据 + 一种用途。
 * 这一档里的「模型」不是模型，是**去哪儿搜**：
 *
 *   - `builtin-browser` —— 真浏览器（`browserSearch.ts`）。零配置、免费、
 *     不绑任何厂商，每次 3～4 秒。模型 id 就是用哪个搜索站（duckduckgo / bing）。
 *   - `searxng` —— 自建实例（`searxngSearch.ts`）。质量最好也最快，但要用户
 *     自己跑一台，而且实例得打开 JSON 输出。
 *   - `jina-search` —— Jina 的搜索接口。约 0.5 秒，用用户自己的额度。
 *
 * **没绑就用内置浏览器。** 社区版的零配置承诺全靠这一条 —— 检索不能是一个
 * 「先去第三方申请点什么」才能用的功能。
 *
 * ## 不做的事
 *
 * 撞上验证码一律**如实报错**，绝不尝试绕过 —— 那是设计文档 §3.2 明写的红线。
 */

/** 检索超时。这是交互动作，不该让用户干等 */
const SEARCH_TIMEOUT_MS = 15_000

/** 一次最多回多少条。再多只是灌满上下文 */
export const MAX_SEARCH_RESULTS = 10

export interface WebSearchItem {
  title: string
  url: string
  /** 搜索引擎给的摘要。不是正文 —— 要正文用 web_read */
  snippet: string
  /** 有就带上，用于判断新鲜度 */
  publishedAt?: string
  /**
   * 回读校验的结论。`unclear` 表示这条和查询没有任何字面重合 ——
   * 不代表它一定没用，但呈现时必须标出来，见 `searchRelevance.ts`
   */
  relevance?: Relevance
}

export interface WebSearchResult {
  success: boolean
  /**
   * 这次检索**能用，但用户的配置有问题**时要说的话。
   *
   * 和 `error` 是两件事：`error` 是「这次没搜到」，`notice` 是「搜到了，但你那条
   * 绑定不对，去改一下」。它会被写进给模型看的正文 —— 只写日志的话，用户永远
   * 不会知道自己绑错了。
   */
  notice?: string
  /**
   * 实际用的是哪条路。要让模型和用户都知道结果是谁给的 ——
   * 真浏览器那条会带上具体是哪个搜索站，例如 `browser:duckduckgo`
   */
  provider?: string
  items?: WebSearchItem[]
  error?: string
}

async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
    // **只认 200。** `response.ok` 覆盖 200-299，而搜索站点常用 **202** 返回
    // 人机验证页 —— 那是一个「没给你结果」的响应，当成功解析只会得到 0 条，
    // 或者更糟，得到一个挑战页里的噪声
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 界面语言 → Jina 的 `hl` 参数。
 *
 * 不给这一位时，结果的语言跟着**出口 IP** 走 —— 挂代理的用户查中文，回来
 * 一串外语站点。这个现象在删掉的 Bing 那条路上就记过一次，换成 Jina 一样成立。
 *
 * `hl` 是 `s.jina.ai` 的 search 端点参数（见它自己的 OpenAPI：
 * `https://s.jina.ai/openapi.json`），校验方式是
 * `WORLD_LANGUAGES.some(l => l.code === v)` —— **精确匹配、区分大小写**，
 * 所以这里必须写 `zh-cn` 而不是 `zh-CN`。旁边那个 `gl`（国家）故意不发：
 * 它按地域筛结果，而「界面是中文」不等于「只要中国的网页」。
 */
const JINA_LANGUAGE: Readonly<Record<'zh-CN' | 'en-US', string>> = Object.freeze({
  'zh-CN': 'zh-cn',
  'en-US': 'en'
})

/**
 * 界面语言。
 *
 * **必须懒加载。** `appSettingsManager` 顶上 `import { logger } from './services'`，
 * 那个模块会把 WebSocket 服务、任务执行器一路拉到 better-sqlite3 的原生模块 ——
 * 检索经工具注册表被引用，静态引它等于让每一个 import 到注册表的测试都在
 * vitest 的 worker 线程里加载那个原生模块，后果是**整个测试进程段错误退出**。
 * 详见 AGENTS.md 的「已知陷阱」。
 */
async function uiLanguage(): Promise<'zh-CN' | 'en-US'> {
  try {
    const { appSettingsManager } = await import('../appSettingsManager')
    return appSettingsManager.getLanguage()
  } catch {
    return 'zh-CN'
  }
}

/** 配了 Jina Key 就走它：结果质量好，还带正文片段 */
async function searchViaJina(
  query: string,
  limit: number,
  apiKey: string
): Promise<WebSearchResult> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'X-Respond-With': 'no-content'
  }
  const base = `https://s.jina.ai/?q=${encodeURIComponent(query)}`
  const hl = JINA_LANGUAGE[await uiLanguage()]

  let raw: string
  try {
    raw = await fetchText(`${base}&hl=${hl}`, headers)
  } catch (error) {
    // `hl` 是拿**对方的**语言码表做精确匹配校验的，那张表我们看不见也管不住。
    // 它哪天改了名，带着这一位的请求会整个失败 —— 那等于中文用户完全搜不到。
    // 语言只是「更准」，不是「能不能用」，所以对不上就退回不带这一位再搜一次。
    const rejected = error instanceof Error && /HTTP 4\d\d/.test(error.message)
    if (!rejected) throw error
    console.warn(`[WebSearch] Jina 不接受 hl=${hl}（${error.message}），改用不指定语言重试`)
    raw = await fetchText(base, headers)
  }

  const parsed = JSON.parse(raw) as { data?: Array<Record<string, unknown>> }
  const items = (parsed.data ?? []).slice(0, limit).map((item) => ({
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.description ?? '')
  }))

  if (items.length === 0) return { success: false, error: 'Jina 搜索没有返回结果。' }
  return { success: true, provider: 'jina-search', items }
}

/** 内置浏览器那条。`preferEngine` 是用户在设置里挑的搜索站 */
async function runBuiltinBrowser(
  query: string,
  limit: number,
  preferEngine?: string
): Promise<WebSearchResult> {
  // 懒加载：这条要 import electron，而单测跑在裸 Node 里 ——
  // 顶层静态引它，连不碰检索的测试都得先把 electron 装进 worker
  const { searchViaBrowser } = await import('./browserSearch')
  const result = await searchViaBrowser(query, limit, preferEngine ? { preferEngine } : {})
  if (result.success && result.items) {
    return { success: true, provider: `browser:${result.engine}`, items: result.items }
  }
  return { success: false, error: result.error ?? '内置浏览器没有拿到结果。' }
}

/**
 * 按用户绑定的 `search` 角色决定走哪条路。
 *
 * 没绑就用内置浏览器 —— 社区版的零配置承诺全靠这一条。
 *
 * 失败要**说清楚是哪条路、为什么**：「Jina 的 Key 过期了」和「两个搜索站都被
 * 人机验证挡住」需要用户做的事完全不同，糊成一句「搜索失败」等于什么都没说。
 */
async function runProviders(query: string, limit: number): Promise<WebSearchResult> {
  const bound = await resolveSearchProvider()

  // 没绑定：默认那条
  if (!bound || bound.providerId === BUILTIN_BROWSER_PROVIDER_ID) {
    return await runBuiltinBrowser(query, limit, bound?.modelId)
  }

  if (bound.providerId === SEARXNG_PROVIDER_ID) {
    const { searchViaSearxng } = await import('./searxngSearch')
    const result = await searchViaSearxng(bound.baseUrl, query, limit)
    if (result.success && result.items) {
      return { success: true, provider: 'searxng', items: result.items }
    }
    return { success: false, error: `SearXNG：${result.error}` }
  }

  // Box Plan：`POST /search`（协议 08-search）。来源 id 固定以 creator-plan 开头
  if (isPlanProvider(bound.providerId)) {
    if (!bound.apiKey) {
      return {
        success: false,
        error: 'Box Plan 的 Key 取不出来了。到 设置 → 模型 的套餐卡片重新连接。'
      }
    }
    try {
      const language = (await uiLanguage()) === 'zh-CN' ? 'zh-CN' : 'en'
      const items = await searchViaPlan({
        baseUrl: bound.baseUrl,
        apiKey: bound.apiKey,
        model: bound.modelId,
        query,
        limit,
        language,
        timeoutMs: SEARCH_TIMEOUT_MS
      })
      if (items.length === 0) return { success: false, error: 'Box Plan 检索没有结果。' }
      return { success: true, provider: 'creator-plan', items }
    } catch (error) {
      // 套餐那几种错误的文案本身就是「下一步怎么办」，原样给
      if (error instanceof CreatorPlanCallError) return { success: false, error: error.message }
      const aborted =
        error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
      return {
        success: false,
        error: `Box Plan 检索失败：${aborted ? `超时（${SEARCH_TIMEOUT_MS / 1000} 秒）` : error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  if (bound.providerId === JINA_SEARCH_PROVIDER_ID) {
    // 目录里 Jina 有两条记录（向量化、网页检索），共用同一把 Key。
    // 用户只在向量化那条上填过密钥也该能用，所以取不到就回退到共享解析
    const apiKey = bound.apiKey || (await resolveJinaApiKey().catch(() => ''))
    if (!apiKey) {
      return { success: false, error: `Jina 网页检索缺少 API Key。${JINA_KEY_MISSING_HINT}` }
    }
    try {
      return await searchViaJina(query, limit, apiKey)
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        success: false,
        error: `Jina 检索失败：${aborted ? `超时（${SEARCH_TIMEOUT_MS / 1000} 秒）` : error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /*
   * 绑了一个我们不认识的 Provider —— **退回内置浏览器，但要说出来**。
   *
   * 这条以前是硬失败。区别在于故障的性质：Jina 的 Key 过期是**临时**故障，
   * 静默降级会把它埋掉，所以那条该硬失败；而绑错 Provider 是**结构性配置错误**，
   * 它不会自己好 —— 硬失败等于让一次误操作永久废掉网页检索，而用户看到的只是
   * 「AI 说搜索失败」，未必联想得到是自己那条设置。
   *
   * 最容易踩的一条路：新建 Provider 时「用途」选了「网页检索」，地址和模型却填的是
   * 某个对话厂商（比如百炼 + qwen）。那样它能通过角色下拉的过滤，直接落到这里。
   *
   * **不猜它是什么形状**：不去拿一个对话模型的地址当搜索接口试，猜错只会得到一串
   * 谁也看不懂的错误。用内置浏览器把这次搜完，把配置问题写进 notice 交给模型转达。
   */
  const notice =
    `注意：「网页检索」这一档绑的是不支持的服务商 «${bound.providerId}»，这次已改用内置浏览器。` +
    '这一档只支持内置浏览器（builtin-browser）、SearXNG（searxng）、Jina 网页检索（jina-search）—— ' +
    '到 设置 → 模型 里换一个，或者把这个角色清空（清空就是用内置浏览器）。'

  const fallback = await runBuiltinBrowser(query, limit)
  if (fallback.success) return { ...fallback, notice }

  // 连兜底也失败：两件事都要说，否则用户只会看见「搜索失败」，改不到点子上
  return {
    success: false,
    error: `${notice}
内置浏览器这次也没拿到结果：${fallback.error}`
  }
}

/**
 * 检索网页。
 *
 * 拿到结果之后**一定要过一遍回读校验**再决定是不是 success —— 这是这套能力
 * 上一版最大的教训：后端失手时不会自己承认，只有比对查询词才能发现。
 */
export async function searchWeb(
  query: string,
  options: { limit?: number } = {}
): Promise<WebSearchResult> {
  const trimmed = query.trim()
  if (!trimmed) return { success: false, error: '搜索词是空的。' }

  const limit = Math.min(Math.max(options.limit ?? 5, 1), MAX_SEARCH_RESULTS)

  const result = await runProviders(trimmed, limit)
  if (!result.success || !result.items) return result

  const report = judgeResults(trimmed, result.items)

  // 整批都对不上 —— 这正是「后端失手却报成功」的样子。**不许当 success 递出去**
  if (report.allUnclear) {
    return {
      success: false,
      error:
        `搜到了 ${report.items.length} 条，但没有一条和「${trimmed}」对得上 —— ` +
        '这通常说明检索后端这次没有正常工作，而不是这个问题没有答案。' +
        '换个说法再试，或者直接给我一个网址用 web_read 读。'
    }
  }

  return { ...result, items: report.items }
}
