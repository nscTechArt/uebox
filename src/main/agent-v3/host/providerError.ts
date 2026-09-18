/**
 * 把 pi 给的那一行错误文本拆成「状态码 + 错误码 + 人话」。
 *
 * ## 为什么要拆
 *
 * 渲染层**早就**写好了按状态码分类的友好文案：401 说「密钥不对，去设置里换一个」，
 * 429 说「太频繁了，等一会」，5xx 说「服务商那边的事，跟你的配置无关」；401/402
 * 这类「不改配置就一定再失败」的还会把「接着跑」按钮撤掉。
 * 那一整套判断在 `agentControlHandlers.getErrorInfo` 里，读的是 `data.statusCode`。
 *
 * 而 `agent-v3:error` 这条通道**只发了一个 message 字符串**。于是那套分类在 V3 路径上
 * 一次都没命中过，用户看到的是：
 *
 *     错误: 401: {"error":{"message":"Incorrect API key provided: sk-xxx…","code":"invalid_api_key"}}
 *
 * 下面还挂着一个「接着跑」—— 点一次报一次，因为密钥不会自己变对。
 *
 * ## 为什么是从字符串里抠，不是把 error 对象传上来
 *
 * 抠不到更上游了：pi 在 provider 的 catch 里就把 SDK 的 error 对象压成了一个字符串
 * （`utils/error-body.js` 的 `formatProviderError`），`AssistantMessage` 上只剩
 * `errorMessage?: string` 这一个字段。状态码**确实还在字符串里**，而且位置是 pi 自己
 * 排的，就这四种形状（见该文件的 `formatProviderError`）：
 *
 *   - `"401: {body}"`            —— pi 拼的「状态码 + 体」
 *   - `"OpenAI (429): {body}"`   —— pi 拼的「前缀 + 状态码 + 体」
 *   - `"401 {body}"`             —— SDK 自己就把状态码折进了 message（openai / anthropic）
 *   - `"413 <html>…"`            —— 网关直接吐 HTML，体根本不是 JSON
 *
 * 抠不出来就什么都不填，渲染层退回今天的通用文案 —— 比猜一个错的状态码安全。
 */

/** 从一行 provider 错误文本里读出来的事实。抠不到的字段就不填 */
export interface ProviderErrorFacts {
  /** HTTP 状态码 */
  statusCode?: number
  /** 服务商给的错误码，如 `invalid_api_key` / `insufficient_quota` */
  code?: string
  /** 错误体里那句写给人看的话，剥掉外面的 JSON */
  detail?: string
}

/**
 * 四种形状统一成一条：可选前缀 → 状态码（裸的或括号里的）→ 分隔符。
 *
 * 最后一条是网关直接吐 HTML 那种 —— **错误体不是 JSON**。真机上撞到过：
 * openresty 的 `413 <html>…413 Request Entity Too Large…</html>`。前三条都要求
 * 状态码后面跟着 `{` 或 `[`，于是这一类一个都匹配不上，状态码抠不出来，
 * 渲染层那套分类全部落空，用户看到的是**聊天框里渲染出来的半张网页**。
 *
 * 第四条后面跟的可能是 HTML（`413 <html>…`），也可能根本没有体 —— SDK 这时
 * 自己拼一句，`413 status code (no body)` / `413 Payload Too Large`。**这两种
 * 都要认**：认不出来的话，界面退回通用文案，出口闸也再学不到这家的上限
 * （它只在状态码等于 413 时才记）。
 *
 * 但也不能写成「跟着任何非空白」：那样 `500 tokens remaining in your quota`
 * 会被读成一次 HTTP 500，而 `413 characters is over the field limit` 会被出口闸
 * 当成真的 413，把那家厂商的预算永久调低。
 *
 * 分界线是**后面那截像不像 HTTP 的原因短语**：原因短语是 Title Case
 * （`Payload Too Large`），或者 SDK 那句固定的 `status code`，或者一个体的开头
 * （`<` / `{` / `[`）。计数后面接名词的英文句子是小写的，正好落在外面。
 */
const STATUS_PATTERNS = [
  /^\s*(\d{3})\s*[::]\s/, // "401: {...}"
  /^\s*[^()\n]{0,40}\((\d{3})\)\s*[::]\s/, // "OpenAI (429): {...}"
  /^\s*(\d{3})\s+[{[]/, // "401 {...}"
  /^\s*(\d{3})\s+(?=[<{[]|status code\b|[A-Z])/ // "413 <html>…" / "413 Payload Too Large"
]

/** HTTP 状态码的取值范围。`200` 这种不可能出现在错误里，但拦住它比放过去便宜 */
function isHttpStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 400 && value <= 599
}

/**
 * 从 JSON 体里挑出「错误码」和「那句人话」。
 *
 * 各家的形状不一样，但都逃不出这两层：
 *   - OpenAI / DeepSeek / 硅基流动：`{"error":{"message":"…","code":"invalid_api_key"}}`
 *   - Anthropic：`{"type":"error","error":{"type":"authentication_error","message":"…"}}`
 *   - 少数网关直接平铺：`{"message":"…","code":"…"}`
 */
function readBody(body: unknown): Pick<ProviderErrorFacts, 'code' | 'detail'> {
  if (typeof body !== 'object' || body === null) return {}
  const outer = body as Record<string, unknown>
  const inner = (typeof outer.error === 'object' && outer.error !== null ? outer.error : outer) as
    | Record<string, unknown>
    | undefined
  if (!inner) return {}

  // code 优先于 type：`invalid_api_key` 比 `invalid_request_error` 具体
  const rawCode = inner.code ?? inner.type ?? outer.code
  const rawDetail = inner.message ?? outer.message

  return {
    code: typeof rawCode === 'string' && rawCode ? rawCode : undefined,
    detail: typeof rawDetail === 'string' && rawDetail.trim() ? rawDetail.trim() : undefined
  }
}

/** 从第一个 `{` / `[` 起当 JSON 解，解不动就算了 —— 后面还有整串原文兜着 */
function parseTrailingJson(text: string): unknown {
  const start = text.search(/[{[]/)
  if (start === -1) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

/**
 * 网关直吐的 HTML 里，那句人话。
 *
 * 取 `<title>`，没有就退回第一个非空的纯文本行。**必须剥成一行**：渲染层
 * 把 `detail` 当 markdown 显示，整段 HTML 原样送上去会在聊天框里渲染出
 * 一张完整的网页（标题、横线、`openresty` 落款一应俱全），
 * 用户完全看不出发生了什么。
 */
/** 剥标签时最多看这么长。见 `readHtmlBody` 里的说明 */
const HTML_SCAN_LIMIT = 16 * 1024

/** 交给界面的那句话最多这么长 —— 再长就不是「一句人话」了 */
const DETAIL_MAX_CHARS = 200

function readHtmlBody(text: string): string | undefined {
  // 只认**整个体就是一页 HTML**的那种。
  //
  // 前缀有两种形状，都要跳过：pi 拼的 `413: ` 和带厂商名的 `OpenAI API error (413): `
  // （`utils/error-body.js` 的 `formatProviderError`，和上面 STATUS_PATTERNS 的
  // 第二条对应）。只认前一种的话，openai-responses / azure 这些带前缀的厂商
  // 一个都进不来，`detail` 为空，渲染层退回原文 —— 聊天框里又是半张网页。
  //
  // 但也不能退回当初的 `indexOf('<')`：那样 `502: {"code":"x","detail":"<html>"}`
  // 也会走进来，从体里那个尖括号一路切到末尾，剥完标签得到 `"}`。
  const start = /^\s*(?:[^()\n]{0,40}\(\d{3}\)|\d{3})\s*[::]?\s*(?=<)/.exec(text)?.[0].length
  const html = start === undefined ? undefined : text.slice(start)
  if (!html || !/^<\s*(!doctype|html|head|body|h1|title)\b/i.test(html)) return undefined

  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1]
  const heading = title ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]

  // 退到纯文本这条路只在页面既没 title 也没 h1 时才走，而那种页面往往是
  // 坏掉的或者被人做过手脚的。两道闸：
  //   1. 先截断再剥。`<(style|script)\b[\s\S]*?<\/\1>` 遇到**没有闭合**的开标签
  //      会让惰性量词一路展开到末尾，每个开标签展开一次 —— 实测 2 万个裸
  //      `<script` 加 500KB 尾巴要 1.9 秒，6 万个加 1MB 要 13 秒，而这是在
  //      主进程上，整个应用连 IPC 一起卡住。
  //   2. 标签换**空格**不换换行。换换行的话 `…too large: <b>4700000</b> bytes`
  //      会在第一个内联标签处断掉，只剩「too large:」—— 数字和单位正是唯一
  //      有用的部分。换空格整页塌成一行，再按长度截断。
  const line = (heading ?? html.slice(0, HTML_SCAN_LIMIT))
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return undefined
  return line.length > DETAIL_MAX_CHARS ? `${line.slice(0, DETAIL_MAX_CHARS)}…` : line
}

export function classifyProviderError(errorMessage: string): ProviderErrorFacts {
  const text = String(errorMessage ?? '')
  if (!text) return {}

  let statusCode: number | undefined
  for (const pattern of STATUS_PATTERNS) {
    const hit = pattern.exec(text)
    if (!hit) continue
    const value = Number(hit[1])
    // 这个形状匹配上了但数字不像状态码（`200: {...}`），接着试下一个形状 ——
    // 在这里 break 的话，后面几个形状就永远轮不到
    if (!isHttpStatus(value)) continue
    statusCode = value
    break
  }

  const body = parseTrailingJson(text)
  const { code, detail } = readBody(body)
  // 体解得出 JSON 就只认它 —— 解得出来却没有 message，那是这家没给人话，
  // 不是「可以退回去当 HTML 读」。退的话会从 JSON 里那个尖括号开始乱剥一气。
  const readable = detail ?? (body === undefined ? readHtmlBody(text) : undefined)

  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(code ? { code } : {}),
    ...(readable ? { detail: readable } : {})
  }
}
