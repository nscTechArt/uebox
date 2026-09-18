/**
 * 「这一轮带没带图」—— Agent 链路的视觉角色路由判据。
 *
 * ## 为什么需要它
 *
 * `resolveRoleForRequest` 负责「这一轮要不要换个看得懂图的模型」——
 * Agent 模型自己支持图片输入就继续用它，是纯文本模型才换「视觉」角色兜底。
 * 但它要先知道这一轮**带没带图**，而 V3 的两个入口（execute / continue）
 * 都把 `modelRequest` 写死成 `{ role: 'agent' }`，于是这条判断从来没生效过。
 *
 * 后果不是报错，是**静默降级**：pi 在发请求前会按 `model.input` 过滤内容，
 * 文本模型收到的图片被替换成字面量
 * `(image omitted: model does not support images)`。模型照着这句话回答
 * 「我看不到你发的图片（当前模型不支持看图）」—— 用户在界面上明明看到图发出去了。
 *
 * ## 为什么只看这一轮，而不是整个 transcript
 *
 * pi 每次请求都会把整条 transcript 发出去，所以「历史里任何位置有图」都会
 * 触发上面那个占位符。但据此把整条会话永久钉在视觉模型上是过度反应：
 * 视觉模型未必是用户挑来跑工具的那个。五轮之前那张图早就被回答过了，
 * 退化成一句占位符是可接受的代价；**正在问的这张**不能丢。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'

interface MessageLike {
  role?: string
  content?: unknown
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(
    (part) => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'image'
  )
}

/**
 * 从 transcript 尾部往前扫，判断「即将发起的这一轮」输入里有没有图片。
 *
 * 扫到上一条 assistant 就停 —— 那之前的内容属于已经答过的轮次。
 * user 和 toolResult 都要看：截图类工具会把图片直接塞进 toolResult。
 */
export function currentTurnHasImages(messages: AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageLike
    if (message?.role === 'assistant') return false
    if (contentHasImage(message?.content)) return true
  }
  return false
}
