/**
 * 出口闸：发给厂商之前，把这一轮请求压进「这家网关吃得下」的字节数。
 *
 * ## 为什么必须有这一道
 *
 * 真机上炸过一次：`read_local_file` 把一张 3.5MB 的 UV 图原样 base64 塞进
 * 请求体（4.7MB），厂商网关（openresty）按它的请求体上限退回一页 413 的
 * HTML。逐个工具补压缩当然要做，但**指望每个接入点自己记得压，必然漏** ——
 * 那次一口气查出三个忘了压的（读本地文件、MCP 返回的图、anim_preview）。
 *
 * 更要命的是这类失误不可恢复：pi 每次请求都重发整条 transcript，那 4.7MB
 * 一直钉在历史里，「继续尝试」只是再 413 一次，整个会话报废。
 *
 * 所以在**唯一的必经之路**上卡一道。这是 harness 相对普通应用的结构优势：
 * 内容来源（用户磁盘、第三方 MCP server、UE 插件、网页）我们管不着，
 * 但所有东西都要从这里出去。
 *
 * DeepSeek Harness 和 Codex 都是这么做的：前者在 `llm/content.ts` 里按路线预算
 * 把最老的图换成占位文字，后者在 `guardian/request_budget.rs` 里把完整请求
 * 装配出来再数一遍、超了本地就拦。两家都不靠工具自觉。
 *
 * ## 为什么是「投影」不是「报错」
 *
 * 超预算时丢掉**最老的**图、换成一句占位文字，而不是让这一轮失败。理由：
 * 老图早就被回答过了，正在问的那张才是这一轮的重点；而报错的代价是用户
 * 什么都拿不到。这份投影是**临时的**，只作用于发出去的那一份，本地存的
 * transcript 一个字节都不动 —— 换了个上限更宽的模型，那些图照样回来。
 *
 * ## 为什么要「多丢一点」
 *
 * 丢到刚好压线的话，下一轮多一张图就又超，于是每轮丢的前缀都在变 ——
 * 而变动的前缀会把厂商的 prompt 缓存整段打掉。所以一旦要丢就丢到低水位
 * （预算的 60%），让这个前缀在随后几轮里保持不变。DeepSeek 用的是 64MB 一个
 * 量子成批丢，同一个道理。
 *
 * ## 预算从哪来
 *
 * 各家网关的上限不一样，而且**不公开**。所以给一个保守默认值，并且**从
 * 413 里学**：某家退过 413，就按那次的实际大小把这家的预算调下来，
 * 下一次请求自动投影到新预算之内。一次 413 只会发生一次。
 *
 * 只记在内存里，不落盘：重启后一次 413 就能重新学到，而落盘要动配置结构、
 * 还要考虑用户换了网关之后怎么忘掉旧值 —— 代价和收益不成比例。
 */

import type { Context, ImageContent, Message, TextContent } from '@earendil-works/pi-ai'

import { onSettingsChanged } from '../../ai/store'

/**
 * 默认请求体预算。
 *
 * 取 3MB 的依据：我们实际撞到 413 的那次请求体是 4.7MB；而压过之后单张图
 * 约 240KB（base64），3MB 装得下十几张图加上正文，日常够用。比这更严只会
 * 让正常会话平白丢图，更宽则起不到兜底作用 —— 真比 3MB 还严的网关，
 * 靠下面那套「从 413 里学」收敛。
 */
export const DEFAULT_REQUEST_MAX_BYTES = 3 * 1024 * 1024

/** 触发投影后丢到哪个水位。留出余量，免得每轮都要重丢一次，见文件头 */
const LOW_WATER_RATIO = 0.6

/**
 * 观测到的厂商上限。某家退过 413 就把它记下来，之后按 `安全系数 × 实测值`
 * 当预算 —— 413 只说明「这么大不行」，不说明上限具体是多少，所以往下留一档。
 */
const SAFETY_RATIO = 0.8
const observedLimits = new Map<string, number>()

/**
 * 预算的下限。
 *
 * 学到的值再小也压到这为止。**不能因此就不投影**：那样连 3MB 的默认保护
 * 也一起没了，下一张 3.5MB 的图照样原样发出去，正是这个模块要防的事故。
 *
 * 压到下限还过不去，说明这家网关严到丢图也救不了。那时投影已经尽力，
 * 厂商的真实报错会照常回到用户面前 —— 代价只是每轮少几张老图，
 * 比「保护整个关掉」便宜得多。
 */
const MIN_BUDGET_BYTES = 256 * 1024

/** 这一家的请求体预算。没撞过 413 就是默认值 */
export function budgetFor(providerId: string): number {
  const observed = observedLimits.get(providerId)
  if (observed === undefined) return DEFAULT_REQUEST_MAX_BYTES
  return Math.max(MIN_BUDGET_BYTES, Math.min(DEFAULT_REQUEST_MAX_BYTES, observed * SAFETY_RATIO))
}

/**
 * 记下一次「这么大被拒了」。
 *
 * 取历次最小值：同一家可能在不同大小上都失败过，能通过的上限只可能比
 * **最小的那次失败**还小。
 */
export function noteOversizedRequest(providerId: string, attemptedBytes: number): void {
  if (!Number.isFinite(attemptedBytes) || attemptedBytes <= 0) return
  const previous = observedLimits.get(providerId)
  if (previous !== undefined && previous <= attemptedBytes) {
    // 已经压到下限还在 413：投影帮不上忙了，但也别悄悄地帮不上忙 ——
    // 用户看到的是一次次失败，日志里得说清楚是这家网关严到丢图也不够
    if (budgetFor(providerId) <= MIN_BUDGET_BYTES) {
      console.warn(
        `[requestBudget] ${providerId} 在已压到下限（${MIN_BUDGET_BYTES} 字节）之后仍然 413，` +
          '这家网关的上限低于丢完图能达到的大小，出口闸帮不上忙了'
      )
    }
    return
  }
  observedLimits.set(providerId, attemptedBytes)
  console.warn(
    `[requestBudget] ${providerId} 在 ${attemptedBytes} 字节上退回 413，` +
      `之后这家的预算按 ${Math.round(budgetFor(providerId))} 字节算`
  )
}

/** 忘掉学到的上限 */
export function resetObservedLimits(): void {
  observedLimits.clear()
}

/**
 * AI 配置一变就忘掉学到的上限。
 *
 * 同一个 provider id 背后的 baseUrl 可能已经换了一家网关，或者用户刚把
 * `client_max_body_size` 调大。不忘的话旧上限会跟着整个进程，表现是
 * 「图莫名其妙不进上下文」，而且除了重启应用没有任何办法清掉。
 *
 * 挂在 `onSettingsChanged` 上而不是 `invalidateProviderCache` 里：后者只有
 * `agent-v3:invalidate-providers` 这一个入口，而那个 IPC **界面上没有任何地方
 * 调用** —— 挂在那儿等于没挂。`onSettingsChanged` 是写配置的必经之路，
 * 连用户在外部直接改文件都盖得住。`tools/registry.ts` 早就用的是这个口子。
 */
onSettingsChanged(() => {
  resetObservedLimits()
})

type ImageOrText = TextContent | ImageContent

function isImage(block: unknown): block is ImageContent {
  return (block as { type?: unknown })?.type === 'image'
}

/**
 * 一段内容里的图片块。
 *
 * pi 的图片只出现在 user 和 toolResult 两种消息的 content 数组里，不嵌套
 * （见 pi-ai 的 `UserMessage` / `ToolResultMessage`）。字符串形式的 content
 * 一定是纯文本。
 */
function imageBlocksOf(content: Message['content']): ImageContent[] {
  if (!Array.isArray(content)) return []
  return content.filter(isImage)
}

/** 每个内容块在请求体里的固定开销（`{"type":"image","data":"…","mimeType":"…"}` 这类外壳） */
const BLOCK_OVERHEAD_BYTES = 48

/**
 * 估算这一份 context 发出去有多少字节。
 *
 * **只数真正会上线的东西**：系统提示词、工具定义、每条消息的文本和图片。
 *
 * 原来是 `JSON.stringify(context)` 一把梭，那会把 `ToolResultMessage.details`
 * 也算进去 —— 而 `details` 是给界面用的，**厂商那边一个字节都收不到**
 * （各家 provider 只序列化 `content`）。本仓库又特意把完整结果列表放在 details 里，
 * 于是工具用得多的会话量出来的数远大于真实请求体：出口闸会为了抵消这些
 * 根本不上线的字节，去丢那些**真的在上线**的图；一次 413 记下来的也是个虚高的数，
 * 让学习收敛得比看上去慢。
 *
 * 顺带解决两件事：不再碰任意工具塞进 details 的值（循环引用、BigInt 都伤不到
 * 这里），所以序列化不会再抛；也不用再为了瘦身去改 MCP 的 details。
 */
export function measureContextBytes(context: Context): number {
  let total = context.systemPrompt ? Buffer.byteLength(context.systemPrompt, 'utf8') : 0
  if (context.tools) total += Buffer.byteLength(JSON.stringify(context.tools), 'utf8')

  for (const message of context.messages) {
    const content = message.content
    if (typeof content === 'string') {
      total += Buffer.byteLength(content, 'utf8')
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{
      type?: string
      text?: string
      data?: string
      arguments?: unknown
      thinking?: string
      thinkingSignature?: string
    }>) {
      total += BLOCK_OVERHEAD_BYTES
      // base64 是纯 ASCII，长度即字节数；文本按 UTF-8 实算
      if (typeof block?.data === 'string') total += block.data.length
      if (typeof block?.text === 'string') total += Buffer.byteLength(block.text, 'utf8')
      // Tool arguments and preserved reasoning are sent back to providers; details are not.
      if (block?.type === 'toolCall' && block.arguments !== undefined)
        total += Buffer.byteLength(JSON.stringify(block.arguments), 'utf8')
      if (typeof block?.thinking === 'string') total += Buffer.byteLength(block.thinking, 'utf8')
      if (typeof block?.thinkingSignature === 'string')
        total += Buffer.byteLength(block.thinkingSignature, 'utf8')
    }
  }
  return total
}

/** 被丢掉的图换成这句话。说清楚发生了什么、以及还能怎么拿到它 */
function offloadedImageText(): string {
  return (
    '[这张较早的图已从本轮请求里移除，以便整轮请求不超过服务商的大小上限，你现在看不到它。' +
    '还需要看的话，用工具重新取一次（截图 / 读文件），新取的那张会在最近一轮里。]'
  )
}

export interface ProjectedContext {
  context: Context
  /** 投影之后的实际字节数 */
  bytes: number
  /** 丢掉了几张图。0 表示原样透传 */
  droppedImages: number
}

/**
 * 把 context 投影到预算之内：超了就从最老的图开始换成占位文字。
 *
 * 不超预算时**原样返回同一个对象**（不复制），这样绝大多数轮次里下游拿到的
 * 引用不变，也不会平白产生垃圾。
 */
export function projectWithinBudget(context: Context, maxBytes: number): ProjectedContext {
  const bytes = measureContextBytes(context)
  if (bytes <= maxBytes) return { context, bytes, droppedImages: 0 }

  // 每张图按它的 base64 长度算。丢一张省下来的就是这么多
  const sizes: number[] = []
  for (const message of context.messages) {
    for (const image of imageBlocksOf(message.content)) sizes.push(image.data.length)
  }

  // 占位文字是中文，一个字三个字节 —— 按 `.length` 算会把「丢一张能省多少」
  // 高估，丢得比实际需要的少
  const placeholder = Buffer.byteLength(offloadedImageText(), 'utf8')

  // **只有比占位文字大的图才值得丢。** 状态小图标、1×1 像素这种，换成占位文字
  // 之后请求反而更大 —— 真机上 MCP server 返这种图很常见，而原来那版会因此
  // 一路「丢」到底：`remaining` 每轮反向增长，永远到不了预算，最后报告
  // 「全都要丢」，把每一张图都换成了更长的一段话。
  const order = dropOrder(sizes).filter((index) => sizes[index] > placeholder)
  if (order.length === 0) {
    // 没有能省下东西的图 —— 纯文本撑爆的，这一层无能为力。
    // 照常发出去，让厂商的报错带着真实原因回来，别在这里编一个。
    console.warn(`[requestBudget] 请求 ${bytes} 字节超出 ${maxBytes} 预算，但里面没有图可丢`)
    return { context, bytes, droppedImages: 0 }
  }

  const plan = (limit: number): { drop: number[]; remaining: number } => {
    let remaining = bytes
    const drop: number[] = []
    for (const index of order) {
      if (remaining <= limit) break
      remaining -= sizes[index] - placeholder
      drop.push(index)
    }
    return { drop, remaining }
  }

  // 图全丢光都到不了预算，说明撑爆的是文本。那就一张都别丢 —— 丢了照样 413，
  // 只是白白搭上模型正在看的那几张图。
  const required = plan(maxBytes)
  if (required.remaining > maxBytes) {
    console.warn(
      `[requestBudget] 请求 ${bytes} 字节超出 ${maxBytes} 预算，` +
        '但把图全丢光也压不下来（文本本身就超了），原样发出去'
    )
    return { context, bytes, droppedImages: 0 }
  }

  // 低水位是为了少丢几次（见文件头），**不是为了多丢一张**。所以按低水位丢，
  // 但最新那张留着 —— 那是模型这一轮正在看的东西，除非它本来就在必丢名单里。
  const newest = Math.max(...order)
  const dropped = new Set(
    plan(Math.floor(maxBytes * LOW_WATER_RATIO)).drop.filter(
      (index) => index !== newest || required.drop.includes(index)
    )
  )
  if (dropped.size === 0) return { context, bytes, droppedImages: 0 }

  let seen = -1
  const messages = context.messages.map((message) => {
    if (!Array.isArray(message.content) || !message.content.some(isImage)) return message
    const content = (message.content as ImageOrText[]).map((block) => {
      if (!isImage(block)) return block
      seen += 1
      if (!dropped.has(seen)) return block
      return { type: 'text', text: offloadedImageText() } as TextContent
    })
    return { ...message, content } as Message
  })

  const projected: Context = { ...context, messages }
  return { context: projected, bytes: measureContextBytes(projected), droppedImages: dropped.size }
}

/**
 * 丢图的顺序：**大的先丢，一样大的从老到新**。
 *
 * 单纯按「从老到新」会护着错的那张：用户刚让模型看一张 1.8MB 的精灵图，
 * 而它恰好是最新的一张 —— 于是循环把之前两张 80KB 的截图挨个换成占位文字，
 * 刚好压线就停手，肇事的那张原封不动留着。模型丢掉的是它正在推理用的东西，
 * 留下的是它根本看不清的那张。
 *
 * 按大小排还有一个好处：**丢的张数最少**。原来用「超过预算一半才算大图」
 * 那种阈值，三张各占 40% 的图一张都算不上「大」，顺序退回从老到新，
 * 上面那个坑原样复现 —— 阈值挪一挪就漏，而「先丢大的」不需要任何常数。
 *
 * 「最新那张尽量留着」不在这里管，由 `required.drop` 那一层决定。
 */
function dropOrder(sizes: number[]): number[] {
  return sizes
    .map((_, index) => index)
    .sort((a, b) => (sizes[b] !== sizes[a] ? sizes[b] - sizes[a] : a - b))
}

export const __testing = {
  resetObservedLimits,
  offloadedImageText,
  LOW_WATER_RATIO,
  SAFETY_RATIO,
  MIN_BUDGET_BYTES
}
