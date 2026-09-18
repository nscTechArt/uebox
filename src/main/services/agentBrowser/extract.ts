import * as cheerio from 'cheerio'
import type TurndownService from 'turndown'

/**
 * HTML → 正文 Markdown。
 *
 * 这段逻辑原本长在 `webReader.ts` 里，只服务「把网页存进知识库」那条线：
 * 主进程 fetch 静态 HTML，cheerio 剥噪声，turndown 转 Markdown。
 *
 * Agent 浏览器要的是同一件事，只是输入不同 —— 它给的是 Chromium **渲染之后**
 * 的 DOM，正好补上 fetch 那条路拿不到前端渲染内容的短板。两条路共用这一份，
 * 好处不只是省代码：正文质量规则只有一套，改一次两边都跟着变。
 *
 * 不引 `@mozilla/readability`：cheerio 和 turndown 已经是生产依赖，
 * 而 AGENTS.md 明写不新增依赖（§「No new dependencies」）。
 */

/**
 * 一定不属于正文的元素。
 *
 * **噪音只在这里按名字剔。** 下面 `pickContentHtml` 的打分不负责这件事 ——
 * 靠「字少一点」判噪音等价于允许自己丢正文，而正文和噪音的字数关系没有下界。
 * 所以真实站点的评论区、相关阅读要在这份名单里写全，用前缀匹配而不是精确类名：
 * `.comment` 匹配不到 `class="comment-list"`，那正是漏掉一整块评论的原因。
 */
const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '.advertisement',
  '.ads',
  '.sidebar',
  // 前缀匹配：comment / comments / comment-list / comments-area / commentBox 一并覆盖
  '[class*="comment" i]',
  '[id*="comment" i]',
  // 「相关阅读 / 推荐 / 猜你喜欢」这类推荐位，常常带着整段摘要，字数不输正文
  '[class*="related" i]',
  '[class*="recommend" i]'
]

/** 正文容器的候选，按可信度从高到低 */
const CONTENT_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#content',
  '.content',
  '.post-content',
  '.article-content',
  '.markdown-body',
  // 微信公众号。它不用任何语义标签，正文就挂在这个 id 上
  '#js_content'
]

/**
 * 笔记本路径的默认上限：避免把整站塞进一条笔记。
 *
 * 它是**参数**而不是常量的原因见 `extractWebContentFromHtml` 的 `maxChars`。
 */
export const NOTEBOOK_MAX_CONTENT_CHARS = 200_000

export interface WebReadResult {
  success: boolean
  title?: string
  content?: string
  description?: string
  url?: string
  /** 失败原因。**写给用户看**：不出现工具名、参数名、内部术语 */
  error?: string
  /**
   * 写给模型的下一步建议，只有 AI 工具那条路会把它拼给模型。
   *
   * 这两句话的受众不一样，所以必须分开字段。原先合成一句
   * 「这个站点挡住了自动请求…**改用 browser_open 打开它** —— 那是真浏览器…」，
   * 而知识库「添加来源」失败时同一个字段直接显示在来源条下
   * （`NoteSourcePanel.vue`）—— 用户读到一句让他去调用一个他根本看不见的工具的话。
   */
  agentHint?: string
}

export interface ExtractOptions {
  /**
   * 正文最大保留字符数。
   *
   * 必须由调用方给，不能写死：Agent 浏览器按 `offset / maxChars` 分页读，
   * 上游先截一刀的话 `totalChars` 和 `nextOffset` 就是在骗模型 ——
   * 它以为读完了，而后半页从来没进入过这条链路。
   */
  maxChars?: number
}

async function createTurndown(): Promise<TurndownService> {
  // 懒加载：只有真的要转 Markdown 时才需要它，不该进启动路径
  const TurndownService = (await import('turndown')).default
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
  })

  // 表格 turndown 默认会拍平成一行，文档站里表格往往是关键信息，原样保留 HTML
  service.addRule('keepTables', {
    filter: ['table'],
    replacement: (_content, node) => `\n\n${(node as unknown as Element).outerHTML}\n\n`
  })

  /*
   * 划掉的文字要**留着，并且看得出是划掉的**。
   *
   * turndown 默认把 `<del>` / `<s>` 当普通文字处理 —— 删除线一丢，「这条建议
   * 已经作废」就变成了「这条建议仍然成立」，意思正好反过来。
   *
   * 这不是假设。2026-09-07 真机验收上就栽在这儿：SQLite 官方 WAL 页面
   * （https://sqlite.org/wal.html）Overview 第 8 条把「大于约 100MB 的事务建议
   * 改用回滚日志」整段划掉了，后面紧跟着说明从 3.11.0 起 WAL 处理大事务同样高效。
   * 我们抓回来的 Markdown 里两段都是正文，模型于是把作废的旧建议当成现行结论
   * 写进了报告，还在被追问时继续为它辩护。
   *
   * 用 `~~` 标记而不是丢弃：读者（模型）需要知道**原文说过这句、但划掉了**，
   * 那正是判断「哪个版本才算数」的依据。同理保留 `<ins>`——它常常就是那句
   * 划掉内容的替代说法。
   */
  service.addRule('keepStrikethrough', {
    // 用函数而不是标签名数组：`strike` 是废弃标签，不在 TS 的
    // `HTMLElementTagNameMap` 里，写进数组过不了类型检查 —— 但老页面上它还在
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => (content.trim() ? `~~${content}~~` : '')
  })

  service.addRule('keepInsertions', {
    filter: ['ins'],
    replacement: (content) => content
  })

  return service
}

/**
 * 挑出正文容器。
 *
 * 先按语义选择器找；都没有就退化成打分。
 *
 * ## 打分为什么不能只数直接子段落
 *
 * 上一版的回退是「直接子 `<p>` 文字最多的那个块」。它对付得了「外层容器天然赢过
 * 真正正文块」这个问题，但对**层层嵌套**的排版是灾难性的：微信公众号的编辑器
 * 把每一段都包进自己的 `<section>`，于是 `#js_content` 的直接子 `<p>` 文字是
 * **0 字**，赢家变成中间某个只装了三段的 `<section>`。
 *
 * 实测那篇 Unreal Fest 征集：整篇 828 字，这条规则只捞回 239 字 —— 报名截止时间
 * 就在没捞到的那部分里。用户看到的是「怎么只有这么一点」。
 *
 * 现在改成：按**全部后代文字**打分，但要扣掉链接文字。
 *
 * ## 为什么不能「得分接近满分就挑更深的」
 *
 * 上一版是「在得分 ≥ 满分 90% 的候选里挑最深的」。那等于给自己留了 10% 的丢字额度：
 * `<div id="main"><p>导语…</p><section id="post-body">正文</section></div>` 这种排版里，
 * `#post-body` 只要有外层 90% 的字数就赢，导语那段直接没了 —— 跟上面那个 239/828
 * 的 bug 是同一类，只是被压到 10% 以内，更不容易被发现。
 *
 * 「不把导航页脚、评论、相关阅读卷进来」这件事**不在这里做**，靠的是打分之前的
 * `NOISE_SELECTORS`：按名字把那些块整段删掉。放在这里做一定是错的 —— 想靠字数少
 * 一点就判它是噪音，等价于允许自己丢掉正文，而正文和噪音的字数关系没有下界。
 *
 * 这里只做一件事：在剩下的内容里挑**装得最全**的那个容器。
 *
 * 打分是「后代文字减去链接文字」：外层容器比正文容器多出来的那部分多半是链接
 * （面包屑、推荐位），扣掉之后正文容器才比得过它。
 *
 * ## 破平为什么必须同时看原始字数
 *
 * 净分相同不代表装的东西一样多：`<div id="wrap"><div class="toc">四十个链接</div>
 * <div class="notice">340 字</div></div>` 里，`#wrap` 和 `.notice` 的净分都是 340
 * （链接被扣掉了），但 `#wrap` 还装着那四十个链接。这时候「同分取深的」会把整份
 * 目录扔掉 —— 而对目录页、索引页、标题列表来说，链接就是正文。
 *
 * 所以只有**净分和原始字数都相等**时才认为深的那个装着同一批东西、可以取深的。
 * 父节点只要多一个字（哪怕是链接里的字），它就赢 —— 永远不丢内容。
 */
function pickContentHtml($: cheerio.CheerioAPI): string {
  for (const selector of CONTENT_SELECTORS) {
    const node = $(selector).first()
    if (node.length && node.text().trim().length > 200) {
      return node.html() ?? ''
    }
  }

  interface Candidate {
    html: string
    score: number
    textLength: number
    depth: number
  }

  /*
    只数实打实的字：缩进和换行不算内容。不去掉的话，外层容器会凭「子元素之间那几个
    换行」凭空比正文块高出几分，于是下面的同分判深永远轮不到，相关阅读又被卷回来。
  */
  const contentLength = (text: string): number => text.replace(/\s+/g, '').length

  const candidates: Candidate[] = []
  $('body')
    .find('div, section')
    .each((_, element) => {
      const node = $(element)
      const textLength = contentLength(node.text())
      if (textLength <= 200) return
      // 扣掉链接文字：外层容器比正文容器多出来的那部分基本都是链接。
      // 不因为净分为 0 就把这个候选扔掉 —— 目录页整块都是链接，那也是它的正文
      const score = textLength - contentLength(node.find('a').text())
      candidates.push({
        html: node.html() ?? '',
        score,
        textLength,
        depth: node.parents().length
      })
    })

  if (candidates.length === 0) return $('body').html() ?? ''

  // 取最高净分；净分和原始字数都相等才用更深的破平（那说明装的是同一批东西）
  let best = candidates[0]
  for (const candidate of candidates) {
    if (candidate.score > best.score) {
      best = candidate
    } else if (
      candidate.score === best.score &&
      candidate.textLength === best.textLength &&
      candidate.depth > best.depth
    ) {
      best = candidate
    }
  }

  return best.html
}

function extractTitle($: cheerio.CheerioAPI, targetUrl: string): string {
  const candidates = [
    $('meta[property="og:title"]').attr('content'),
    $('title').first().text(),
    $('h1').first().text()
  ]
  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (value) return value
  }
  try {
    return new URL(targetUrl).hostname
  } catch {
    return targetUrl
  }
}

/**
 * 从一段 HTML 提取正文。
 *
 * 纯函数：不发网络请求、不碰 Electron，输入 HTML 输出 Markdown。
 * 网络抓取留在 `webReader.ts`，浏览器窗口留在 `agentBrowser/index.ts`。
 */
export async function extractWebContentFromHtml(
  html: string,
  targetUrl: string,
  options: ExtractOptions = {}
): Promise<WebReadResult> {
  const maxChars = options.maxChars ?? NOTEBOOK_MAX_CONTENT_CHARS
  const $ = cheerio.load(html)

  const title = extractTitle($, targetUrl)
  const description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    undefined

  $(NOISE_SELECTORS.join(',')).remove()
  const markdown = (await createTurndown()).turndown(pickContentHtml($)).trim()

  if (!markdown) {
    return {
      success: false,
      error: '没有提取到正文。该页面可能由前端脚本渲染，本地读取取不到内容。'
    }
  }

  return {
    success: true,
    title,
    description: description?.trim() || undefined,
    content: markdown.slice(0, maxChars),
    url: targetUrl
  }
}
