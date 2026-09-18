import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import { joinTimelineText, resolveTrailingContent, splitAgentTimeline } from './agentTimeline'

/**
 * 一条回复里**该被念出来**的那部分：最终答复那一段，不含过程里的解说。
 *
 * agent 干长活时一路都在说话（「我先摸清工程情况」「现在把资产建出来」），那些话
 * 和结论一样都躺在时间线里。整条念出来的话，用户要听十分钟才能听到结果 ——
 * 过程是给人看的，结论才是给人听的。自动朗读和手动点小喇叭念的是同一份：
 * 一条回复只有一种「念法」，两份会让用户说不清自己刚才听到的是哪一份。
 *
 * 时间线把连续的正文合成一块、遇到工具调用就切开（见 `agentTimeline`），所以
 * 「最后一块正文」就是最后一次工具调用之后模型说的那段话。
 *
 * 取最后一块而不是「最后一次工具调用之后的全部正文」：那一轮要是停在工具调用上、
 * 后面一个字都没说，后者是空的 —— 而「没有结论」和「不该朗读」不是一回事，
 * 宁可念上一段解说，也好过用户等到的是静默。
 *
 * `failed` 是「这一轮崩了、气泡上挂着接着跑」。这时 content 已经被错误信息整个
 * 盖掉，而正文还留在时间线里 —— 念的该是模型崩之前说到哪了，不是一句
 * 「错误: Connection error.」。
 */
export function finalReplyText(
  content: string,
  items: AgentProcessItem[] = [],
  failed = false
): string {
  const trailing = resolveTrailingContent(content, joinTimelineText(items)).trim()
  const errorOnly = failed && /^(?:错误|error)\s*[:：]/i.test(trailing)
  let last = ''
  for (const block of splitAgentTimeline(items)) {
    if (block.kind === 'text') last = block.text
  }
  return [last.trim(), errorOnly ? '' : trailing].filter(Boolean).join('\n\n')
}
