import {
  extractWebContentFromHtml,
  NOTEBOOK_MAX_CONTENT_CHARS,
  type WebReadResult
} from './agentBrowser/extract'

/**
 * 本地网页正文提取。
 *
 * 「把网页存进知识库」是笔记本的核心动线，此前它整条走官方网关的 Jina 代理 ——
 * 社区版没有服务端，等于这个功能不存在。
 *
 * 这里改成主进程自己抓：主进程的 fetch 不受 CORS 限制，抓回 HTML 后交给
 * `agentBrowser/extract.ts`（cheerio 剥噪声、turndown 转 Markdown）。两个包
 * 仓库里本来就有，不引入新依赖，也不需要任何密钥或联网服务。
 *
 * 与 Jina Reader 的差距要说清楚：它能跑 JS、能处理 PDF、有反爬绕过。这里只处理
 * 静态 HTML。对绝大多数文档站、博客、维基足够；对纯前端渲染的站点会拿到空壳 ——
 * 那种页面现在可以交给 Agent 浏览器（同一套提取规则，输入换成渲染后的 DOM）。
 */

/** 抓取超时。正文提取是交互动作，不该让用户干等 */
const FETCH_TIMEOUT_MS = 20_000

/**
 * 伪装成常见浏览器。
 *
 * 不少站点对没有 UA 的请求直接返回 403。这不是绕过反爬，只是让普通请求
 * 看起来像普通请求。
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

/**
 * 被挡住时重试几次。
 *
 * Cloudflare 这类防护是按 **IP 信誉和频率**随机下挑战的，不是看请求头 ——
 * 实测同一组请求头连发 8 次拿到 `200 403 403 403 403 200 200 200`。用代理
 * （共享出口 IP）的用户命中率更高。
 *
 * 所以隔一会儿重试是对的：这**不是**绕过挑战（我们没有、也不会去解那道
 * 挑战题），只是对抗随机性。重试 2 次能把「一次就死」的概率从约 50% 降到
 * 一成出头；再多就变成给对方添堵了，不做。
 */
const RETRY_STATUSES = new Set([403, 429, 503])
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1200

/** 这个响应是不是「防护墙」而不是真正的页面 */
function looksBlocked(status: number, html: string): boolean {
  if (RETRY_STATUSES.has(status)) return true
  // 有些站点用 200 返回挑战页，只能看内容特征
  return /cf_challenge|cf-browser-verification|Just a moment\.\.\.|Enable JavaScript and cookies to continue/i.test(
    html.slice(0, 4000)
  )
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type { WebReadResult }

/**
 * 抓取并提取网页正文。
 *
 * 只允许 http/https：URL 是从渲染层传进来的，不校验的话 `file://` 能把本机
 * 任意文件读成「网页内容」。
 */
export async function readWebPageLocally(targetUrl: string): Promise<WebReadResult> {
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return { success: false, error: `无效的网址：${targetUrl}` }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { success: false, error: '只支持 http/https 网址' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    let blockedStatus = 0

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS)

      const response = await fetch(parsed.toString(), {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          // 决定拿到哪种语言的页面。和过不过反爬无关 —— 实测加不加都一样
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        signal: controller.signal,
        redirect: 'follow'
      })

      const contentType = response.headers.get('content-type') || ''
      const isHtml = /text\/html|application\/xhtml/i.test(contentType)
      const html = isHtml ? await response.text() : ''

      if (looksBlocked(response.status, html)) {
        blockedStatus = response.status
        continue
      }

      if (!response.ok) {
        return { success: false, error: `读取网页失败：HTTP ${response.status}` }
      }

      if (!isHtml) {
        return {
          success: false,
          error: `暂不支持这种内容类型：${contentType || '未知'}（目前只处理 HTML 页面）`
        }
      }

      return await extractWebContentFromHtml(html, parsed.toString(), {
        maxChars: NOTEBOOK_MAX_CONTENT_CHARS
      })
    }

    // 重试完还是被挡。**要给出下一步**，不能只回一个 403 ——
    // 模型拿着「读取失败」只会换个渠道瞎猜，而这里有一条真能走通的路：
    // 有头浏览器是真 Chromium，会执行挑战脚本，通常能过。
    //
    // 但那条路是**模型**的下一步，不是用户的：知识库添加来源失败时，
    // `error` 原样显示在来源条下，「改用 browser_open 打开它」对用户是句天书。
    // 所以分成两句，各给各的受众（见 `WebReadResult.agentHint`）。
    return {
      success: false,
      error:
        `这个站点挡住了自动请求（HTTP ${blockedStatus || '挑战页'}）。` +
        '它按来访 IP 的信誉随机拦截，和请求内容无关，重试过仍然没过。' +
        '可以让 AI 助手用内置浏览器打开它，或者把正文复制下来手动添加。',
      agentHint: '改用 browser_open 打开它 —— 那是真浏览器，通常能通过；那一步会请用户确认。'
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      success: false,
      error: aborted
        ? `读取超时（${FETCH_TIMEOUT_MS / 1000} 秒）`
        : `读取网页失败：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    clearTimeout(timer)
  }
}
