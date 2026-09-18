import { app, BrowserWindow, session } from 'electron'

import { registerNonAppWindow, unregisterNonAppWindow } from '../appWindows'
import type { WebSearchItem } from './webSearch'

/**
 * 用真浏览器跑搜索页。
 *
 * ## 为什么要这么绕
 *
 * 直接用主进程 `fetch` 去请求搜索引擎，今天基本走不通了 —— 实测：
 *
 *   - DuckDuckGo：间隔 2 秒连发，**第 3 次**就是 HTTP 202 挑战页，等两分钟都不恢复；
 *   - Mojeek / Startpage / 公共 searx 实例：直接返回 JS 挑战页；
 *   - Bing：HTTP 200，但返回的是**和查询无关**的内容（查 UE 的 C++ API 回来银行官网）。
 *
 * 原因是同一个：那些请求不像浏览器发出来的。而这个应用里**本来就有一个真
 * Chromium**。用它去打开搜索页，上面三条全都不成立了 —— 同样的机器、同样的
 * 出口 IP，**连发 20 次一次没掉**，最难的那几条查询也都命中。
 *
 * 判据和 `web_read` 是同一条：**读不改变世界**。窗口不显示、只读、不点不填
 * 不下载，所以不弹审批。
 *
 * ## 为什么单开一个干净分区
 *
 * `agentBrowser` 那个 `persist:` 分区里带着用户在 Agent 浏览器里登过的账号。
 * 复用它等于**把用户的身份带进每一次搜索** —— 搜索引擎能认出这是谁。
 * 这里另开一个分区，搜索引擎看到的始终是一个匿名浏览器。
 *
 * ## 不做的事
 *
 * 撞上人机验证一律**如实报错**，绝不尝试去解那道题。挑战页只等它自己跑完
 * （那是浏览器自己的事），等不到就换下一家，还不行就说失败。
 */

/**
 * 和 Agent 浏览器**分开**的会话分区。
 *
 * 不带 `persist:`：进程退出就没了，等于每次都是全新的匿名浏览器。
 * 搜索不需要任何登录态，留着 cookie 只会让搜索引擎把多次搜索串成一个人。
 */
const PARTITION = 'unreal-box-search'

/** 页面加载后最多等多久出结果。搜索页是 SPA，DOM 到位有先后 */
const RESULT_TIMEOUT_MS = 8_000

/** 轮询间隔。固定 sleep 会在慢的时候拿到空页面 —— spike 里踩过 */
const POLL_INTERVAL_MS = 250

/** 导航本身的上限 */
const NAV_TIMEOUT_MS = 20_000

/** 闲置多久就把窗口关掉。一直留着等于白占一个 Chromium 渲染进程 */
const IDLE_CLOSE_MS = 5 * 60_000

const CHALLENGE_RE =
  /anomaly|captcha|challenge|just a moment|unusual traffic|verify you are|请输入验证码|安全验证|JavaScript is required/i

/**
 * 去哪儿搜，按优先级排。
 *
 * DuckDuckGo 在前是因为它给的是**干净的目标地址**；Bing 的结果链接包在
 * `bing.com/ck/a?...` 跳转壳里，`cite` 里的显示地址还被省略号截断，
 * 拿到手还得再解一层。两家质量实测相当（6 个用例各命中 5 个）。
 *
 * Mojeek 和 Startpage 试过了：前者的 altcha 挑战真浏览器也没跑完，
 * 后者过了挑战但取不到结果。不收。
 */
const ENGINES = [
  {
    id: 'duckduckgo',
    url: (query: string) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    // 在页面里跑，只能用页面自己的 API。`data-testid` 比 class 稳 ——
    // class 是构建产物，改版就变
    extract: `(() => {
      const out = []
      for (const node of document.querySelectorAll('a[data-testid="result-title-a"], a.result__a')) {
        const url = node.href || ''
        if (!/^https?:/.test(url) || /duckduckgo\\.com/.test(url)) continue
        const article = node.closest('article, .result')
        const snippet = article ? article.querySelector('[data-result="snippet"], .result__snippet') : null
        out.push({
          title: (node.innerText || '').trim(),
          url,
          snippet: snippet ? (snippet.innerText || '').trim() : ''
        })
        if (out.length >= 20) break
      }
      return out
    })()`
  },
  {
    id: 'bing',
    url: (query: string) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    /*
     * Bing 把目标地址包在 `bing.com/ck/a?...&u=a1<base64url>` 跳转壳里。
     * 原样交给模型等于给了一串没法读、没法引用的追踪链接，所以在页面里就解开。
     * 解不开就整条丢掉 —— 宁可少一条，也不给一个打不开的地址。
     *
     * 这段字符串里**别写反斜杠**：它是模板字面量，`\.` 会在编译期被吃成 `.`，
     * `/bing\.com\/ck\//` 编译出来是 `/bing.com/ck//` —— 语法错误，整段脚本
     * 直接抛异常。踩过一次了，所以下面一律用 includes / 字符类。
     */
    extract: `(() => {
      const unwrap = (href) => {
        const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href || '')
        if (!m) return href
        try {
          const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
          const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
          const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
          const decoded = new TextDecoder().decode(bytes)
          return decoded.startsWith('http') ? decoded : ''
        } catch (error) {
          return ''
        }
      }
      const out = []
      for (const li of document.querySelectorAll('li.b_algo')) {
        const link = li.querySelector('h2 a')
        if (!link) continue
        const title = (link.innerText || '').trim()
        // 标题还没填进来的先不算数，让上层继续轮询
        if (!title) continue
        const url = unwrap(link.href || '')
        if (!url.startsWith('http') || url.includes('/ck/')) continue
        const caption = li.querySelector('.b_caption p, .b_lineclamp2')
        out.push({ title, url, snippet: caption ? (caption.innerText || '').trim() : '' })
        if (out.length >= 20) break
      }
      return out
    })()`
  }
] as const

export interface BrowserSearchResult {
  success: boolean
  items?: WebSearchItem[]
  /** 实际是哪家给的结果。要让模型知道 */
  engine?: string
  error?: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 隐藏窗口是**复用**的。
 *
 * 冷启动（建窗 + 首次导航）实测 5～11 秒，之后每次 3～4 秒 —— 差的那一截全是
 * Chromium 起进程。一次搜索通常跟着好几次，每次重建等于把最贵的一步重复付。
 */
let sharedWindow: BrowserWindow | null = null
let idleTimer: NodeJS.Timeout | null = null

/** UA 里留着 `Electron/` 和应用名，等于自报家门是自动化客户端 */
function realisticUserAgent(): string {
  return app.userAgentFallback
    .replace(/\s?Electron\/[\d.]+/, '')
    .replace(new RegExp(`\\s?${app.getName()}/[\\d.]+`, 'i'), '')
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    closeSearchBrowser()
  }, IDLE_CLOSE_MS)
}

/**
 * 关掉常驻的隐藏窗口。退出流程和测试都要用。
 *
 * 没开过就是空操作 —— 这条路径要保持社区版的零网络承诺，不能因为「收尾」
 * 反而把窗口和 session 创建出来。
 */
export function closeSearchBrowser(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (sharedWindow && !sharedWindow.isDestroyed()) {
    unregisterNonAppWindow(sharedWindow.webContents.id)
    sharedWindow.destroy()
  }
  sharedWindow = null
}

function ensureWindow(): BrowserWindow {
  if (sharedWindow && !sharedWindow.isDestroyed()) return sharedWindow

  sharedWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: session.fromPartition(PARTITION),
      // 远程页面不给 preload，也不给 Node —— 它拿到的应该和普通浏览器一样多
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // 窗口本来就不显示，被后台节流的话页面会停在半路
      backgroundThrottling: false
    }
  })
  sharedWindow.webContents.setUserAgent(realisticUserAgent())
  // 搜索页会想开新窗口（点结果、点广告）。一个都不给
  sharedWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 登记成「不是盒子界面的窗口」。不登记的话，按「非置顶且足够大」找主窗口的
  // 那几处（深链接、二次实例激活、IPC 广播）会挑中这个装着远程页面的窗口
  registerNonAppWindow(sharedWindow.webContents.id)

  return sharedWindow
}

/**
 * 等结果节点出现，而不是死等固定时长。
 *
 * spike 里用固定 2.5 秒，同一条 `site:` 查询一次拿到 0 条、复核却是 10 条 ——
 * 搜索页是 SPA，慢一点就抓了个空壳。
 */
async function waitForResults(
  window: BrowserWindow,
  extract: string,
  timeoutMs: number
): Promise<{ items: WebSearchItem[]; challenged: boolean }> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const items = (await window.webContents.executeJavaScript(extract)) as WebSearchItem[]
    if (items.length > 0) return { items, challenged: false }

    if (Date.now() >= deadline) {
      // 一条都没有：是被挡住了，还是真的没结果？这两件事要分开报
      const text = (await window.webContents.executeJavaScript(
        'document.body.innerText.slice(0, 3000)'
      )) as string
      return { items: [], challenged: CHALLENGE_RE.test(text) }
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

async function searchOnEngine(
  window: BrowserWindow,
  engine: (typeof ENGINES)[number],
  query: string,
  timeoutMs: number
): Promise<{ items: WebSearchItem[]; challenged: boolean }> {
  await Promise.race([
    window.webContents.loadURL(engine.url(query)),
    sleep(NAV_TIMEOUT_MS).then(() => Promise.reject(new Error(`打开 ${engine.id} 超时`)))
  ])
  return await waitForResults(window, engine.extract, timeoutMs)
}

/**
 * 排队。**同一时刻只允许一次搜索在跑。**
 *
 * 隐藏窗口只有一个（上面那条复用是有意的），而搜索的两步——导航、读结果——
 * 中间隔着好几秒的轮询。两次搜索同时进来时，后一次的 `loadURL` 会把前一次
 * 正在等的页面**顶掉**，于是前一次读到的是别人那次的搜索结果页，
 * 而它自己毫不知情，照样 `success: true` 返回。
 *
 * 这正是这套检索最不能出的那种错：**一个看起来成功的错误答案**。
 * 谁会同时搜两次？`task` 派出去的并行子 agent 现在就会，以后一次研究要连搜
 * 好几轮更会。所以不是「以后再说」，是现在就得排队。
 *
 * 代价是排队的那次要多等一次搜索的时间（每次 3～4 秒）。这笔代价顺带买到一件
 * 好事：连发的搜索天然被拉开了间隔，而密集请求正是搜索站甩挑战页的诱因
 * 。
 *
 * 队尾**必须**吞掉失败：一次拒绝挂在链上，后面每一次搜索都会跟着一起挂。
 */
let queue: Promise<unknown> = Promise.resolve()

export async function searchViaBrowser(
  query: string,
  limit: number,
  options: { resultTimeoutMs?: number; preferEngine?: string } = {}
): Promise<BrowserSearchResult> {
  const run = queue.then(() => runSearch(query, limit, options))
  queue = run.catch(() => undefined)
  return await run
}

/**
 * 用真浏览器搜一次。
 *
 * 按 `ENGINES` 的顺序试，第一家给出结果就返回。**全部失败时要说清楚每一家
 * 分别是为什么挂的** —— 糊成一句「搜索失败」，下次排查等于从头再来。
 *
 * 只允许从 `searchViaBrowser` 进来 —— 它负责排队，见上面那段。
 */
async function runSearch(
  query: string,
  limit: number,
  options: { resultTimeoutMs?: number; preferEngine?: string }
): Promise<BrowserSearchResult> {
  const timeoutMs = options.resultTimeoutMs ?? RESULT_TIMEOUT_MS
  const window = ensureWindow()
  const failures: string[] = []

  // 用户在设置里挑了哪个搜索站就先试哪个，另一个仍然当兜底 ——
  // 「我选了 Bing」不该变成「Bing 挂了就什么都搜不到」
  const ordered = options.preferEngine
    ? [...ENGINES].sort((a, b) =>
        a.id === options.preferEngine ? -1 : b.id === options.preferEngine ? 1 : 0
      )
    : ENGINES

  try {
    for (const engine of ordered) {
      let outcome: { items: WebSearchItem[]; challenged: boolean }
      try {
        outcome = await searchOnEngine(window, engine, query, timeoutMs)
      } catch (error) {
        failures.push(`${engine.id}：${error instanceof Error ? error.message : String(error)}`)
        continue
      }

      if (outcome.items.length > 0) {
        return { success: true, engine: engine.id, items: outcome.items.slice(0, limit) }
      }
      // 挑战页和「真的没结果」是两回事，别混成一句
      failures.push(`${engine.id}：${outcome.challenged ? '被人机验证挡住' : '没有结果'}`)
    }

    return {
      success: false,
      error: `${ENGINES.length} 个搜索站都没拿到结果（${failures.join('；')}）。`
    }
  } finally {
    scheduleIdleClose()
  }
}
