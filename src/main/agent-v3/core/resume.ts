/**
 * 断点续跑的前置处理。
 *
 * ## 为什么需要这一层
 *
 * pi 的 `agent.continue()` 要求 transcript 的最后一条能转成 user 或 toolResult，
 * 否则直接抛 `Cannot continue from message role: assistant`。
 *
 * 问题在于：**模型调用失败时，pi 会往 transcript 里塞一条 assistant 消息** ——
 * `stopReason: 'error'`、内容为空、只带一个 errorMessage（见 agent.js 的
 * `processEvents`：`message_end` 无条件 push 进 `state.messages`）。
 * 用户按停止走的 `aborted` 也一样。
 *
 * 于是「上一轮报错了，接着跑」这个**续跑最主要的场景**必然失败：
 * 最后一条正是那个失败标记，`continue()` 拒绝执行。
 *
 * 这里在续跑前把尾部的失败标记摘掉。它们不是对话内容，是「这一轮没说成话」
 * 的记号 —— 留在上下文里还会多一个空的 assistant 轮次，反过来影响下一次请求。
 *
 * ## 没有覆盖的情况
 *
 * 工具**执行到一半**被中断时，transcript 里可能留下有 toolCall 却没有对应
 * toolResult 的 assistant 消息。厂商要求两者配对，这种请求会被拒。
 * 修那个要判断配对关系并决定丢弃哪些，风险比收益大 —— 目前让它照常失败，
 * 用户重发一遍即可。常见的三种中断（模型报错、网络断开、流式中按停止）
 * 都不会产生这种残留，因为那时工具还没开始执行。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'

import { ASK_USER_TOOL_NAME } from '../tools/toolNames'

/**
 * 这次停下来是不是用户自己要的。
 *
 * 定义搬到了 `tools/abortable.ts` —— 那条判断是关于**中止**的，不是关于续跑的，
 * 而 `runAbortable` 也要用它。这里保留转出口，调用方（`ipc/agentV3.ts`）不必改。
 */
export { isUserAbort } from '../tools/abortable'

interface MessageLike {
  role?: string
  stopReason?: string
}

/**
 * 这条 assistant 消息是不是「没说成话」的失败标记。
 *
 * 只认 error / aborted 两种 stopReason。正常收尾（endTurn、toolUse…）
 * 的 assistant 消息是真实回复，绝不能摘。
 */
function isFailureMarker(message: AgentMessage): boolean {
  const m = message as MessageLike
  return m?.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted')
}

/**
 * 摘掉尾部的失败标记。
 *
 * 从尾部连续摘：一次续跑又失败会再压一条，不循环摘的话第二次续跑还是卡住。
 * 没有可摘的就原样返回同一个数组引用 —— 调用方据此判断要不要重写盘上的文件。
 */
export function trimForResume(messages: AgentMessage[]): AgentMessage[] {
  let end = messages.length
  while (end > 0 && isFailureMarker(messages[end - 1])) end--
  return end === messages.length ? messages : messages.slice(0, end)
}

/**
 * 截到最后一个「上下文自洽」的位置。
 *
 * ## 什么叫不自洽
 *
 * 厂商要求 toolCall 和 toolResult 配对出现。而**正在跑的会话**任何时刻都可能
 * 停在中间：模型刚发出 `material_add_node` 的调用，工具还没执行完，此刻的
 * messages 尾部就是一条带着 toolCall、没有对应结果的 assistant 消息。
 * 拿这份消息去发请求，厂商直接拒。
 *
 * 文件头里说的「没有覆盖的情况」就是这个 —— 对续跑来说修它得害用户丢一步进度，
 * 不值当；但**侧边问一句**必须要它：那个功能的整个用处就是在 agent 跑着的时候
 * 问「它现在在干嘛」，那一刻的尾部十有八九正卡在半截工具调用上。
 *
 * ## 为什么是「截」而不是「补一条假结果」
 *
 * 补假结果等于往上下文里写一句没发生过的话，模型会照着它往下推理。
 * 侧边对话是只读的旁支，少看见半步工具调用没有任何损失。
 */
export function trimDanglingToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const pending = new Set<string>()
  // 空数组天然自洽
  let lastComplete = 0

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as {
      role?: string
      content?: unknown
      toolCallId?: unknown
    }

    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; id?: string }>) {
        if (part?.type === 'toolCall' && typeof part.id === 'string') pending.add(part.id)
      }
    } else if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      pending.delete(message.toolCallId)
    }

    if (pending.size === 0) lastComplete = i + 1
  }

  return lastComplete === messages.length ? messages : messages.slice(0, lastComplete)
}

/** 补出来的那条结果说的话。写清「不知道」，别让模型以为用户默许了什么 */
export const UNANSWERED_ON_RESTART =
  '用户没有回答这次提问（应用中途重启了）。不要假设他同意了任何一个选项 —— ' +
  '需要的话重新问一次，或者按最保守的方案继续并说明你的假设。'

/**
 * 给崩溃时挂在半路的提问补一条「没人回答」的结果。
 *
 * ## 为什么非补不可
 *
 * `ask_user` 的**正常状态就是挂着等人**。用户点开卡片、去吃个饭，期间应用被关掉
 * 或者崩了 —— 盘上的 transcript 最后一条就是一个带 toolCall、没有 toolResult 的
 * assistant 消息。厂商要求两者配对，于是：
 *
 *   - 接着发新消息（`execute`）→ 这份上下文被厂商直接拒，对话彻底聊不下去；
 *   - 点「从断点继续」（`continue`）→ `trimForResume` 摘不掉它（它的 stopReason
 *     是 toolUse，不是 error/aborted），`planResume` 看见末尾是 assistant，
 *     回一句「上一轮已正常结束，没有可续跑的断点」—— 而它明明没结束。
 *
 * 文件头里那句「常见的三种中断都不会产生这种残留」，在这个工具进来之后就不成立了。
 *
 * ## 为什么是「补」而不是「截」
 *
 * `trimDanglingToolCalls` 那条路（截掉半截调用）对侧边对话是对的：那是只读旁支，
 * 少看半步没有损失。但这里截掉等于把「我问过用户」这一步从历史里抹掉，模型会
 * 重新走一遍推理、再问一次同样的问题。补一条如实说明「没人回答」的结果，
 * 它才知道自己问过、也知道没得到答案。
 *
 * **只补 `ask_user`。** 别的工具挂在半路是意外，不是常态，照原样让它失败 ——
 * 给一个真跑了一半的写操作补假结果，模型会以为那一步做完了。
 */
export function repairPendingQuestions(messages: AgentMessage[]): AgentMessage[] {
  const answered = new Set<string>()
  for (const message of messages) {
    const m = message as { role?: string; toolCallId?: unknown }
    if (m?.role === 'toolResult' && typeof m.toolCallId === 'string') answered.add(m.toolCallId)
  }

  const repaired: AgentMessage[] = []
  let added = 0

  for (const message of messages) {
    repaired.push(message)

    const m = message as { role?: string; content?: unknown }
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue

    for (const part of m.content as Array<{ type?: string; id?: string; name?: string }>) {
      if (part?.type !== 'toolCall') continue
      if (part.name !== ASK_USER_TOOL_NAME) continue
      if (typeof part.id !== 'string' || answered.has(part.id)) continue

      // 紧跟在发起调用的那条 assistant 后面，而不是一律追加到末尾 ——
      // 厂商要求 toolResult 挨着它的 toolCall，追到末尾在多轮场景下会错位。
      repaired.push({
        role: 'toolResult',
        toolCallId: part.id,
        toolName: ASK_USER_TOOL_NAME,
        content: [{ type: 'text', text: UNANSWERED_ON_RESTART }],
        isError: false,
        timestamp: Date.now()
      } as unknown as AgentMessage)
      answered.add(part.id)
      added += 1
    }
  }

  return added === 0 ? messages : repaired
}

export type ResumePlan =
  | { ok: true; messages: AgentMessage[]; trimmed: number }
  | { ok: false; reason: string }

/**
 * 判断这个 transcript 能不能续跑，能的话给出续跑用的消息数组。
 *
 * 判定放在构造 agent **之前** —— 构造要解析模型、可能触发凭据解密，
 * 为一个注定失败的请求付这份代价没有必要。
 */
export function planResume(previous: AgentMessage[]): ResumePlan {
  if (previous.length === 0) {
    return { ok: false, reason: '没有可恢复的历史，请先发一条消息开始对话' }
  }

  const messages = trimForResume(previous)

  if (messages.length === 0) {
    // 整个 transcript 只有失败标记：第一轮就没调通，没有"断点"可言
    return { ok: false, reason: '这个对话还没有成功跑过一轮，请重新发送消息' }
  }

  // 摘完之后最后一条仍是 assistant，说明那是一条**正常收尾**的回复 ——
  // 上一轮好好结束了，没有断点。
  if ((messages[messages.length - 1] as MessageLike).role === 'assistant') {
    return { ok: false, reason: '上一轮已正常结束，没有可续跑的断点' }
  }

  return { ok: true, messages, trimmed: previous.length - messages.length }
}
