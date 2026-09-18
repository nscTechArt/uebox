/**
 * 正在跑的会话登记表。
 *
 * 除了「谁在跑」，它还回答一个 `Map` 回答不了的问题：**它停下来了吗**。
 *
 * `agent.abort()` 只是把中止意图递进去。会话要等当前这步（可能是个正跑着的
 * 工具）退出、transcript 落完盘，才会从表里摘掉，中间这段时间它对新的一轮
 * 来说仍然是「正在执行中」。不给出这个信号的话，界面上「停下来 → 立刻重发
 * 一轮」这件事只能靠猜时机 —— 猜错了用户看到的是一句「会话 xxx 正在执行中」，
 * 而他刚敲的那段话已经没了。
 */

interface Run<T> {
  entry: T
  /** 这一轮跑完的信号。`release()` 时兑现 */
  done: Promise<void>
  finish: () => void
}

export class ActiveRuns<T> {
  private readonly runs = new Map<string, Run<T>>()

  /**
   * 登记一条开始执行的会话。
   *
   * 必须和 `release()` 成对使用，且后者要放在 `finally` 里 ——
   * 漏掉的话等它停下来的人会一直等到超时。
   */
  track(sessionId: string, entry: T): void {
    if (this.runs.has(sessionId)) throw new Error(`Session ${sessionId} is already running`)
    let finish: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.runs.set(sessionId, { entry, done, finish })
  }

  get(sessionId: string): T | undefined {
    return this.runs.get(sessionId)?.entry
  }

  has(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  entries(): Array<[string, T]> {
    return [...this.runs].map(([sessionId, run]) => [sessionId, run.entry])
  }

  /** 摘掉一条跑完的会话，并唤醒所有在等它停下来的人 */
  release(sessionId: string): void {
    const run = this.runs.get(sessionId)
    this.runs.delete(sessionId)
    run?.finish()
  }

  /**
   * 等这条会话跑完，最多等 `timeoutMs`。返回它是不是真的停下来了。
   *
   * 有上限是因为「停不下来」确实可能发生：模型卡在审批框上、工具在等一个
   * 不回话的引擎。超时就如实回 false 让调用方自己决定 —— 无限等下去会把
   * 界面上的停止按钮变成一个永远转圈的东西。
   *
   * 没在跑的会话直接回 true：要的结果本来就已经成立。
   */
  drain(sessionId: string, timeoutMs: number): Promise<boolean> {
    const run = this.runs.get(sessionId)
    if (!run) return Promise.resolve(true)

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      void run.done.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }
}
