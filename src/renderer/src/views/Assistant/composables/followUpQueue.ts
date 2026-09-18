/**
 * 运行中打的字排队等下一轮。
 *
 * ## 为什么需要它
 *
 * 在这之前，agent 跑着的时候用户按回车只有一条路：**插话**（steer）——
 * 消息注入当前这一轮，模型当场改方向。而用户想说的话经常不是「改方向」，
 * 是「等你干完这个，顺便把材质也调一下」。用插话表达它，模型会把手里那件事
 * 丢下去干新的；用发送表达它，主进程直接顶回一句「会话正在执行中」，
 * 他刚敲的那段话就白打了。
 *
 * 所以这里给出第三种处置：**攒着，等这一轮真的结束再发出去**。
 *
 * ## 为什么是纯函数
 *
 * 队列本身没有副作用，值得单独测：漏掉一条（用户的话消失了）和重复发一条
 * （同一件事干两遍）都不会抛任何异常，只会在真机上被用户撞见。
 *
 * ## 为什么按 chatSid 分桶
 *
 * 用户在 A 对话里排了一条，切到 B 去看别的，A 跑完时那条仍然要发进 A。
 * 用一条全局队列的话，它会发进用户此刻正看着的那条对话。
 */

/** 排着的一条跟进消息。`payload` 原样存回发送函数，队列不解释它 */
export interface QueuedFollowUp<TPayload> {
  id: string
  /** 给界面显示的那行字。图片、附件不进这里 */
  text: string
  payload: TPayload
}

/** chatSid -> 排着的消息。空桶会被删掉，不留空数组 */
export type FollowUpQueues<TPayload> = Readonly<
  Record<string, ReadonlyArray<QueuedFollowUp<TPayload>>>
>

export const EMPTY_QUEUES: FollowUpQueues<never> = Object.freeze({})

let seq = 0

/** 队列内唯一就够 —— 它只用来「取消这一条」，不跨进程、不落盘 */
function nextId(): string {
  seq += 1
  return `followup-${seq}`
}

/** 读某条对话排着的消息。没有就是空数组，调用方不用判空 */
export function listFollowUps<T>(
  queues: FollowUpQueues<T>,
  chatSid: string
): ReadonlyArray<QueuedFollowUp<T>> {
  return queues[chatSid] ?? []
}

/**
 * 按 id 取出那一条本身（不出队）。
 *
 * 「把排着的这条改成立即插话」要用：插话可能失败（这一轮刚好收尾了），
 * 失败时它必须**还在队列里**。所以先看，成了再 `removeFollowUp`。
 */
export function findFollowUp<T>(
  queues: FollowUpQueues<T>,
  chatSid: string,
  id: string
): QueuedFollowUp<T> | undefined {
  return listFollowUps(queues, chatSid).find((item) => item.id === id)
}

/**
 * 排一条到队尾。返回新的队列和刚排上的那条。
 *
 * 不做去重：用户连着说两句一样的话，很可能是真的想说两遍（「再试一次」），
 * 替他合并等于替他决定。
 */
export function enqueueFollowUp<T>(
  queues: FollowUpQueues<T>,
  chatSid: string,
  text: string,
  payload: T
): { queues: FollowUpQueues<T>; item: QueuedFollowUp<T> } {
  const item: QueuedFollowUp<T> = { id: nextId(), text, payload }
  return {
    queues: { ...queues, [chatSid]: [...listFollowUps(queues, chatSid), item] },
    item
  }
}

/**
 * 取队首（先进先出）。返回取出来的那条和剩下的队列。
 *
 * 一次只取一条：下一条要等这一条也跑完才能发，否则第二条同样会撞上
 * 「会话正在执行中」—— 那正是这套队列要解决的问题。
 */
export function dequeueFollowUp<T>(
  queues: FollowUpQueues<T>,
  chatSid: string
): { queues: FollowUpQueues<T>; item?: QueuedFollowUp<T> } {
  const items = listFollowUps(queues, chatSid)
  if (items.length === 0) return { queues }
  const [item, ...rest] = items
  return { queues: writeBucket(queues, chatSid, rest), item }
}

/** 用户点掉了排着的某一条。找不到就原样返回 */
export function removeFollowUp<T>(
  queues: FollowUpQueues<T>,
  chatSid: string,
  id: string
): FollowUpQueues<T> {
  const items = listFollowUps(queues, chatSid)
  const rest = items.filter((item) => item.id !== id)
  if (rest.length === items.length) return queues
  return writeBucket(queues, chatSid, rest)
}

/**
 * 清空某条对话的队列。
 *
 * 用在「这条对话被删了 / 用户按了停止」——按停止是「我不要这个结果了」，
 * 把排着的话接着发出去等于无视他刚按的那一下。
 */
export function clearFollowUps<T>(queues: FollowUpQueues<T>, chatSid: string): FollowUpQueues<T> {
  if (!(chatSid in queues)) return queues
  return writeBucket(queues, chatSid, [])
}

/** 写回一个桶。空桶直接删键，免得队列对象随着用过的对话一路长 */
function writeBucket<T>(
  queues: FollowUpQueues<T>,
  chatSid: string,
  items: ReadonlyArray<QueuedFollowUp<T>>
): FollowUpQueues<T> {
  const next = { ...queues }
  if (items.length === 0) delete next[chatSid]
  else next[chatSid] = items
  return next
}

/**
 * 这次按下回车该走哪条路。
 *
 * `behavior` 是用户在设置里定的默认，`opposite` 是他按住了 Ctrl —— 对**这一条**
 * 反着来。两个都由调用方判断好再传进来，这里只做映射，方便单独测。
 *
 * 没在跑的时候永远是普通发送：那时候既没有队可排，也没有方向可改。
 */
export function resolveFollowUpAction(
  behavior: 'queue' | 'steer',
  opposite: boolean,
  isRunning: boolean
): 'send' | 'queue' | 'steer' {
  if (!isRunning) return 'send'
  const effective: 'queue' | 'steer' = opposite
    ? behavior === 'queue'
      ? 'steer'
      : 'queue'
    : behavior
  return effective
}
