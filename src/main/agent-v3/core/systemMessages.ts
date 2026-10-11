/**
 * 对话记录里的 system 消息：只活在这一轮，不落盘、不跨轮。
 *
 * pi 1.0 起，系统提示词和工具清单不再挂在请求参数上，而是写成 transcript 里的
 * `role: 'system'` 消息：`Agent` 构造时按 `initialState` 在开头放一条，之后工具
 * 清单每变一次，循环自己在中间插一条增量（`toolsAdded` / `toolsRemoved`）。
 *
 * 我们的规矩是**这些消息只属于当前这一轮**：
 * - 不写进会话文件（`TranscriptStore` 过滤掉）。提示词里有环境块、引擎状态，
 *   每轮现算；存下来再读回去，就是拿上一轮的旧环境冒充这一轮。
 * - 恢复历史时**保住 Agent 自己开头那条**。`agent.state.messages = x` 是整份替换，
 *   直接赋值会把构造时放进去的提示词冲掉 —— 模型照样能跑，只是不知道自己是谁，
 *   类型检查和大部分测试都看不出来。所以一律走 `restoreTranscript`。
 *
 * 代价：中途加载的工具每轮开头重新声明一次，部分原生支持中途加工具的厂商
 * （Claude 官方、OpenAI Responses）在新加载工具后的下一轮会多一次缓存未命中。
 * 换来的是会话文件格式不变，压缩、续跑、子 agent 都不用认识 system 消息。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SystemMessage } from '@earendil-works/pi-ai'

export function isSystemMessage(message: AgentMessage): boolean {
  return (message as { role?: unknown }).role === 'system'
}

/** 去掉所有 system 消息；一条都没有时原样返回同一个数组 */
export function withoutSystemMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.some(isSystemMessage)
    ? messages.filter((message) => !isSystemMessage(message))
    : messages
}

/**
 * 把历史对话装进 agent，开头保留它这一轮自己的提示词。
 *
 * 传进来的历史里如果带着 system 消息（来自父 agent、或者老代码误存的），一并丢掉：
 * 别人的提示词、上一轮的工具增量都不该冒充这一轮的。
 */
export function restoreTranscript(
  agent: { state: { messages: AgentMessage[] } },
  messages: readonly AgentMessage[]
): void {
  const head = agent.state.messages[0]
  const history = withoutSystemMessages([...messages])
  agent.state.messages = head && isSystemMessage(head) ? [head, ...history] : history
}

/**
 * 换掉开头那条的提示词正文，工具声明不动（工具的变化交给 pi 自己比对、写增量）。
 *
 * 一轮里引擎状态变了要换环境块，以前是整份替换 `systemPrompt`；pi 1.0 里后加的
 * system 消息只能「追加说明」不能替换正文，所以直接换开头那条，效果和以前一样：
 * 前缀变了、缓存重算一次。
 */
export function withSystemPrompt(messages: AgentMessage[], prompt: string): AgentMessage[] {
  const head = messages[0]
  const replacement: SystemMessage =
    head && isSystemMessage(head)
      ? { ...(head as SystemMessage), content: prompt }
      : { role: 'system', content: prompt, timestamp: 0 }
  return head && isSystemMessage(head)
    ? [replacement, ...messages.slice(1)]
    : [replacement, ...messages]
}
