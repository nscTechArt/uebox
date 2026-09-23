/**
 * 还没被内核读走的插话，按**这一轮**记一份影子队列。
 *
 * ## 为什么要影子队列
 *
 * pi 只给了 `clearSteeringQueue()` —— 整队清空，没有「撤回其中一条」。
 * 而用户在界面上点掉的是**某一条**：他连着插了三句，想收回中间那句，
 * 另外两句必须还在。所以撤回的做法是「清空内核队列 + 把剩下的按原序重排」，
 * 而重排需要一份我们自己留着的原件。
 *
 * ## 为什么挂在 run 上而不是全局 Map
 *
 * 挂全局表就得自己记得在五处 `release()` 里清干净，漏一处就会留下脏数据：
 * 用户点掉一条早就结束的旧插话，我们会拿**新一轮**的 agent 去 clear + 重排，
 * 把上一轮的话塞进这一轮。挂在 run 对象上，它跟着那一轮一起消失，
 * 这个 bug 没有存在的余地。
 *
 * ## 撤回为什么可能失败
 *
 * 「排队中」是界面上的说法，真相是这条已经交给内核了。内核什么时候把它读进
 * 上下文由它自己决定 —— 用户点 x 的那一刻它可能刚好已经读走了。读走了就撤不回来
 * （它已经在 transcript 里，抽掉等于篡改历史），这时如实回 `already-sent`，
 * 让界面告诉用户「晚了一步」，而不是画一个撤回成功的样子。
 */

/** 内核那一侧我们要用到的三件事。抽成接口是为了不用真 agent 也能测 */
export interface SteeringSink {
  steer(message: unknown): void
  clearSteeringQueue(): void
  /** 队列里还有没有货。撤回前用它判断这一批是不是已经被读走了 */
  hasQueuedMessages(): boolean
}

/** 一条排着的插话 */
export interface PendingSteer {
  id: string
  /**
   * 用户打的**原话**。
   *
   * 和送进内核那条不是一个东西：后者前面可能拼了闪存块。内核回执
   * （`agent-v3:user-message`）投出来的也是剥掉闪存块的原话，两边要对得上。
   */
  text: string
  /** 真正送进内核的整条消息，撤回时要按原样重排回去 */
  message: unknown
}

export type CancelSteerOutcome = 'cancelled' | 'already-sent'

let seq = 0

/** 队列内唯一就够 —— 它只用来「撤回这一条」，不落盘、不跨进程持久化 */
function nextId(): string {
  seq += 1
  return `steer-${seq}`
}

/**
 * 排一条进内核，并在影子队列里留底。返回撤回时要用的 id。
 *
 * 两件事在同一个函数里做，是因为它们必须同时发生：只送内核不留底，
 * 这条就撤不回来了；只留底不送内核，用户看着「排队中」而模型永远等不到。
 */
export function queueSteer(
  pending: PendingSteer[],
  sink: SteeringSink,
  text: string,
  message: unknown
): string {
  const item: PendingSteer = { id: nextId(), text, message }
  pending.push(item)
  sink.steer(message)
  return item.id
}

/**
 * 内核回执：这句原话已经被读进上下文了，影子队列里可以销号。
 *
 * 按文本匹配**最早**那条还排着的：同一句话连插两次时，先进的先生效 ——
 * 和界面上 `markSteerApplied` 的匹配规则保持一致，否则两边会认定不同的那一条
 * 已经生效，用户点 x 撤的是另一句。
 */
export function markSteerDelivered(pending: PendingSteer[], text: string): void {
  const target = text.trim()
  if (!target) return

  const index = pending.findIndex((item) => item.text.trim() === target)
  if (index < 0) return
  pending.splice(index, 1)
}

/**
 * 撤回一条还排着的插话。
 *
 * 两道关都过了才动手：
 * 1. **影子队列里还有它** —— 没有就是回执已经来过，它进上下文了。
 * 2. **内核队列还没空** —— 我们按 `steeringMode: 'all'` 跑，内核一次把队列
 *    全端走，所以「空」等于「这一批全被读走了，只是回执还在路上」。少了这一关，
 *    那个瞬间的撤回会把已经送出去的另外几条**再送一遍**，模型会把同一件事干两遍。
 */
export function cancelSteer(
  pending: PendingSteer[],
  sink: SteeringSink,
  id: string
): CancelSteerOutcome {
  const index = pending.findIndex((item) => item.id === id)
  if (index < 0) return 'already-sent'

  if (!sink.hasQueuedMessages()) {
    pending.length = 0
    return 'already-sent'
  }

  pending.splice(index, 1)
  const rest = [...pending]
  sink.clearSteeringQueue()
  for (const item of rest) sink.steer(item.message)
  return 'cancelled'
}

/** 插话附件块的开闭标签。拼和剥都从这里取 —— 两边各写一遍迟早会分叉 */
const CONTEXT_OPEN = '<steer-attachments>'
const CONTEXT_CLOSE = '</steer-attachments>'

/**
 * 插话带的附件（文档正文、音视频说明、图片关口的提示）包成一块，拼在原话前面。
 *
 * 普通发送不需要这一块：那条不走回执。插话要 —— 回执按**文本相等**销号
 * （`markSteerDelivered` / `agentStream.markSteerApplied`），附件文字不剥掉的话
 * 那条插话会一直显示「未生效」。所以这些东西要有一对能认出来的边界。
 */
export function formatSteerContextBlock(parts: readonly string[]): string {
  const body = parts.filter((part) => part.trim()).join('\n\n---\n\n')
  if (!body) return ''
  return `${CONTEXT_OPEN}\n${body}\n${CONTEXT_CLOSE}`
}

/** 剥掉插话附件块，还原成用户打的那句话。只认开头那一处，理由同 `stripAttachmentBlock` */
export function stripSteerContextBlock(text: string): string {
  if (!text.startsWith(CONTEXT_OPEN)) return text
  const end = text.indexOf(CONTEXT_CLOSE)
  if (end < 0) return text
  return text.slice(end + CONTEXT_CLOSE.length).replace(/^\r?\n\r?\n?/, '')
}
