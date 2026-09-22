/**
 * 把 Agent 的过程时间线切成「一段过程 → 一段正文 → 一段过程 → …」。
 *
 * 界面原来的排法是：所有工具调用和思考塞进顶部一个折叠框，模型说的所有话
 * 拼成一坨挂在下面。那一坨里的句子其实分属不同步骤（「我先摸清工程情况」
 * 「我再多探几下」「现在我把资产建出来」），挤在一起之后读的人对不上
 * 哪句话在说哪一步 —— 而这恰恰是过程日志唯一有价值的信息。
 *
 * 这里按发生顺序切开，让每段解说紧跟着它解释的那几步。
 */
import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import type { AgentQuestionItem } from '@core/shared/agentQuestion'

export interface AgentTimelineProcessBlock {
  kind: 'process'
  key: string
  items: AgentProcessItem[]
}

export interface AgentTimelineTextBlock {
  kind: 'text'
  key: string
  text: string
}

/**
 * 用户在运行途中插的那句话。
 *
 * 单独成块，不并进相邻的过程框 —— 它是**用户说的**，混在工具调用列表里
 * 会被读成 agent 自己的一步。
 */
export interface AgentTimelineSteerBlock {
  kind: 'steer'
  key: string
  text: string
  /** 内核已经把这句话读进上下文（收到它的 message_end 才置位） */
  applied: boolean
  /** 用户点了撤回，而且内核确认它没进上下文 */
  cancelled: boolean
  /**
   * 撤回这条要用的号和会话。缺任何一个就不给撤回按钮 ——
   * 画一个点了必然失败的按钮，比没有按钮更糟。
   */
  steerId?: string
  sessionId?: string
  /** 随这句话一起插进去的图。发完输入框就清空了，这里是它唯一的去处 */
  images?: string[]
}

/**
 * agent 反问用户的那张选项卡片。
 *
 * 和 `steer` 一样单独成块，理由也一样 —— 它不是 agent 的一步，是一次
 * **人机之间的往返**，混进工具调用列表里读不出来。而且它必须留在原地：
 * 答完之后用户回头看，「当时问了什么、我选了什么」是他确认
 * 「为什么做成这样」时唯一的凭据。
 */
export interface AgentTimelineQuestionBlock {
  kind: 'question'
  key: string
  question: AgentQuestionItem
}

export type AgentTimelineBlock =
  | AgentTimelineProcessBlock
  | AgentTimelineTextBlock
  | AgentTimelineSteerBlock
  | AgentTimelineQuestionBlock

function readTimelineText(item: AgentProcessItem): string {
  const text = (item.data as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : ''
}

/**
 * 切块。
 *
 * key 里带块序号而不是随机数：流式过程中块只会**往后追加**，前面的 key 不变，
 * Vue 才不会每来一个增量就把已经画好的块整个重建（重建会丢掉折叠状态和滚动位置）。
 */
export function splitAgentTimeline(items: AgentProcessItem[]): AgentTimelineBlock[] {
  const blocks: AgentTimelineBlock[] = []
  let pendingText = ''
  let pendingTextAt = 0

  const flushText = (): void => {
    const text = pendingText
    const at = pendingTextAt
    pendingText = ''
    pendingTextAt = 0

    // 只有空白的正文段不占一个块：模型在两次工具调用之间常常只吐一个换行，
    // 给它一个块就是在界面上凭空多开一道空隙
    if (!text.trim()) return

    blocks.push({ kind: 'text', key: `text:${at}:${blocks.length}`, text })
  }

  for (const item of items) {
    if (item.type === 'text') {
      const text = readTimelineText(item)
      if (!text) continue
      if (!pendingText) pendingTextAt = item.timestamp
      pendingText += text
      continue
    }

    flushText()

    if (item.type === 'user-steer') {
      const text = readTimelineText(item)
      if (!text.trim()) continue
      const data = item.data as
        | {
            applied?: unknown
            cancelled?: unknown
            steerId?: unknown
            sessionId?: unknown
            images?: unknown
          }
        | undefined
      const images = Array.isArray(data?.images)
        ? data.images.filter((url): url is string => typeof url === 'string' && url.length > 0)
        : []
      blocks.push({
        kind: 'steer',
        key: `steer:${item.timestamp}:${blocks.length}`,
        text,
        applied: data?.applied === true,
        cancelled: data?.cancelled === true,
        ...(typeof data?.steerId === 'string' ? { steerId: data.steerId } : {}),
        ...(typeof data?.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
        ...(images.length > 0 ? { images } : {})
      })
      continue
    }

    if (item.type === 'question') {
      const question = item.data as AgentQuestionItem | undefined
      // 没有 toolCallId 就没法把答案送回去，画一张点了没反应的卡片更糟
      if (!question?.toolCallId) continue
      blocks.push({
        // key 里带 toolCallId 而不是块序号：用户答完之后这一条会**就地改**
        // （从待答变成只读），key 跟着变的话 Vue 会把整张卡片重建一遍，
        // 展开状态和滚动位置一起丢。
        kind: 'question',
        key: `question:${question.toolCallId}`,
        question
      })
      continue
    }

    const last = blocks[blocks.length - 1]
    if (last && last.kind === 'process') {
      last.items.push(item)
      continue
    }

    blocks.push({
      kind: 'process',
      key: `process:${item.timestamp}:${blocks.length}`,
      items: [item]
    })
  }

  flushText()
  return blocks
}

/**
 * 流式刷新会带来一个新的数组壳，但完成的时间线区块没有变化。
 *
 * 保住那些区块及其 `items` 数组的引用，Vue 就不会把所有历史的
 * `AgentProcessLog` 都重新计算一遍；只有正在增长的最后一段会更新。
 */
export function reconcileAgentTimeline(
  previous: AgentTimelineBlock[],
  items: AgentProcessItem[]
): AgentTimelineBlock[] {
  const previousByKey = new Map(previous.map((block) => [block.key, block]))

  return splitAgentTimeline(items).map((next) => {
    const prior = previousByKey.get(next.key)
    return prior && isSameTimelineBlock(prior, next) ? prior : next
  })
}

function isSameTimelineBlock(previous: AgentTimelineBlock, next: AgentTimelineBlock): boolean {
  if (previous.kind !== next.kind) return false

  if (previous.kind === 'text' && next.kind === 'text') {
    return previous.text === next.text
  }

  if (previous.kind === 'process' && next.kind === 'process') {
    return (
      previous.items.length === next.items.length &&
      previous.items.every((item, index) => item === next.items[index])
    )
  }

  if (previous.kind === 'steer' && next.kind === 'steer') {
    return (
      previous.text === next.text &&
      previous.applied === next.applied &&
      previous.cancelled === next.cancelled
    )
  }

  return (
    previous.kind === 'question' && next.kind === 'question' && previous.question === next.question
  )
}

/** 时间线里所有正文段拼起来的全文 */
export function joinTimelineText(items: AgentProcessItem[]): string {
  let text = ''
  for (const item of items) {
    if (item.type !== 'text') continue
    text += readTimelineText(item)
  }
  return text
}

/**
 * 消息 `content` 里**超出时间线**的那部分。
 *
 * 正常情况下 content 就是时间线正文的拼接，这时返回空串 —— 再整段渲染一遍
 * 就成了重影。但 content 会被别处覆盖（报错信息、「用户已停止」的追加、
 * 老消息压根没有时间线），那些内容一个字都不能吞掉。
 *
 * 流式过程中 content 比时间线慢半拍（写回有节流），此时 content 是时间线的
 * 前缀，同样返回空串 —— 否则会闪出一段重复的文字。
 *
 * 多出来的那部分也可能长在**前面**：曾经有一次刷新重连把「正在思考…」占位符
 * 当成模型说过的话留在了 content 开头，于是两边谁也不是谁的前缀 ——
 * 兜底分支把整条 content 又画了一遍，屏幕上一模一样的回复出现两次。
 * 那个 bug 已经修在源头（`utils/typingPlaceholder.ts`），这里留一道：
 * 认得出「多余的在前面」就只补那一截，而不是整段重影。
 *
 * 比对前两边都去掉首尾空白：收尾写进 content 的是 trim 过的全文，时间线里存的是
 * 原始增量 —— 模型在工具调用之后开口常带着一个换行。不去的话两边谁也不是
 * 谁的前缀，整条 content 被当成「多出来的」退回去，气泡里重影一段，自动朗读把
 * 最终答复念两遍。
 */
export function resolveTrailingContent(content: string, timelineText: string): string {
  const timeline = timelineText.trim()
  if (!timeline) return content
  const body = content.trim()
  if (!body) return ''
  if (timeline.startsWith(body)) return ''
  if (body.startsWith(timeline)) return body.slice(timeline.length)
  if (body.endsWith(timeline)) return body.slice(0, -timeline.length)
  return content
}
