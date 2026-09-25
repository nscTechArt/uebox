/**
 * 队员之间「当场说话」：对方正在干活，留言就插进它的下一步；还能等回执、等回复。
 *
 * ## 三种送法
 *
 * 1. **对方正卡在「等回复」上** —— 直接把这条交给它，它的等待立刻返回。
 *    这是防死锁的关键：A 在等 B 回话、B 也在等 A 回话时，B 发给 A 的那句会把 A 叫醒，
 *    A 看到 B 的问题就能先回。当场对话最常见的死法（两人互等）就这样拆掉。
 * 2. **对方正在跑** —— 用 pi 的 `steer` 插进去，它下一步（手上这次工具调用结束后）就会读到。
 *    和用户在界面上插话是同一条路。
 * 3. **对方没在跑** —— 进信箱，下一次接活时整段交给它。
 *
 * ## 回执
 *
 * 「送到」和「读到」分开记：插进去只算送到；这条消息真的出现在对方的上下文里
 * （`message_start`，角色是 user，里面带着 `[team mail m12 …]` 这个标记）才算读到。
 * 对方来不及读就收工了的，退回信箱，下次接活再交 —— 不会悄悄丢掉。
 *
 * 只在一次运行（进程）里有效：谁在跑、谁在等，都是内存里的事；留言本身照旧落盘。
 */

import { PRODUCER, type TeamMail, type TeamStore } from './teamStore'

export interface LiveHandle {
  /** 把一段话插进它正在跑的上下文 */
  steer: (text: string) => void
}

export type Delivery = 'handed' | 'live' | 'queued'

export type WaitResult =
  | { kind: 'reply'; mail: TeamMail }
  /** 等的时候别人发来了话（可能正是在问你）。先处理它，再决定要不要接着等 */
  | { kind: 'incoming'; mails: TeamMail[] }
  | { kind: 'timeout' }

const MARK = /\[team mail (m\d+)\b/g

const key = (name: string): string => name.trim().toLowerCase()
const who = (name: string): string => (name === PRODUCER ? '制作人' : name)

/** 插进对方上下文的那段话。以 user 身份进去，开头说清不是用户在说话、怎么回 */
export function renderLiveMail(mail: TeamMail): string {
  return [
    `[team mail ${mail.id} · from ${who(mail.from)}${mail.replyTo ? ` · reply to ${mail.replyTo}` : ''}] This is not the user speaking.`,
    mail.text,
    `(To answer, use team_message to "${mail.from}" with reply_to "${mail.id}".)`
  ].join('\n')
}

export function mailIdsIn(text: string): string[] {
  return [...text.matchAll(MARK)].map((m) => m[1]!)
}

export interface TeamLive {
  /** 开始跑的时候登记，返回收工时调用的注销函数（它返回的 Promise 是「退回信箱」那次落盘） */
  attach(name: string, handle: LiveHandle): () => Promise<void>
  isRunning(name: string): boolean
  send(
    from: string,
    to: string,
    text: string,
    replyTo?: string
  ): Promise<{ mail: TeamMail; delivery: Delivery }>
  /** 它的上下文里进来了一段 user 消息：从里面认出留言编号，记成已读。返回那次落盘 */
  consumed(name: string, text: string): Promise<void>
  waitRead(mailId: string, timeoutMs: number, signal?: AbortSignal): Promise<'read' | 'timeout'>
  /** 等某条留言的回复。等的时候有别人发话，也会叫醒 */
  waitReply(
    waiter: string,
    mailId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<WaitResult>
  /** 制作人正卡在「等这个队员交活」上（同步派活）。这时候它没法当场回这个队员的话 */
  awaiting(member: string): () => void
  isAwaiting(member: string): boolean
  /** 后台派出去的活 */
  track(member: string, job: Promise<unknown>): void
  pendingJobs(): Array<{ member: string; startedAt: number }>
  /** 等下一件后台活结束。到点没结束给 false */
  nextSettle(timeoutMs: number, signal?: AbortSignal): Promise<boolean>
}

export function createTeamLive(store: TeamStore): TeamLive {
  const running = new Map<string, { handle: LiveHandle; pending: Set<string> }>()
  const waiting = new Map<string, { mailId: string; wake: (result: WaitResult) => void }>()
  const readers = new Map<string, Array<() => void>>()
  const awaited = new Map<string, number>()
  const jobs = new Set<{ member: string; startedAt: number }>()
  let settleWaiters: Array<() => void> = []

  /** 落盘失败（目录被删、磁盘满）不影响对话本身，吞掉；返回的 Promise 给要等它落盘的人 */
  const markRead = (ids: string[]): Promise<void> => {
    if (ids.length === 0) return Promise.resolve()
    const written = store.markRead(ids).catch(() => undefined)
    for (const id of ids) {
      for (const wake of readers.get(id) ?? []) wake()
      readers.delete(id)
    }
    return written
  }

  const timed = <T>(
    ms: number,
    signal: AbortSignal | undefined,
    register: (resolve: (value: T) => void) => () => void,
    onTimeout: T
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      signal?.throwIfAborted()
      let done = false
      const finish = (value: T): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        unregister()
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        unregister()
        reject(signal?.reason ?? new Error('Operation aborted'))
      }
      const unregister = register(finish)
      const timer = setTimeout(() => finish(onTimeout), ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })

  return {
    attach(name, handle) {
      const k = key(name)
      const entry = { handle, pending: new Set<string>() }
      running.set(k, entry)
      return async () => {
        if (running.get(k) !== entry) return
        running.delete(k)
        // 插进去了但没来得及读：退回信箱，下次接活再交
        if (entry.pending.size) await store.requeue([...entry.pending]).catch(() => undefined)
      }
    },

    isRunning: (name) => running.has(key(name)),

    async send(from, to, text, replyTo) {
      const mail = await store.post(from, to, text, replyTo)
      const k = key(to)

      const waiter = waiting.get(k)
      if (waiter) {
        waiting.delete(k)
        void markRead([mail.id])
        waiter.wake(
          mail.replyTo === waiter.mailId
            ? { kind: 'reply', mail }
            : { kind: 'incoming', mails: [mail] }
        )
        return { mail, delivery: 'handed' }
      }

      const target = running.get(k)
      if (target) {
        await store.markDelivered([mail.id])
        target.pending.add(mail.id)
        target.handle.steer(renderLiveMail(mail))
        return { mail, delivery: 'live' }
      }

      return { mail, delivery: 'queued' }
    },

    consumed(name, text) {
      const entry = running.get(key(name))
      const ids = mailIdsIn(text)
      if (entry) for (const id of ids) entry.pending.delete(id)
      return markRead(ids)
    },

    waitRead: (mailId, timeoutMs, signal) =>
      timed<'read' | 'timeout'>(
        timeoutMs,
        signal,
        (resolve) => {
          const wake = (): void => resolve('read')
          readers.set(mailId, [...(readers.get(mailId) ?? []), wake])
          return () =>
            readers.set(
              mailId,
              (readers.get(mailId) ?? []).filter((w) => w !== wake)
            )
        },
        'timeout'
      ),

    awaiting(member) {
      const k = key(member)
      awaited.set(k, (awaited.get(k) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const left = (awaited.get(k) ?? 1) - 1
        if (left > 0) awaited.set(k, left)
        else awaited.delete(k)
      }
    },

    isAwaiting: (member) => awaited.has(key(member)),

    track(member, job) {
      const entry = { member, startedAt: Date.now() }
      jobs.add(entry)
      const settle = (): void => {
        jobs.delete(entry)
        const wake = settleWaiters
        settleWaiters = []
        for (const w of wake) w()
      }
      job.then(settle, settle)
    },

    pendingJobs: () => [...jobs].map((job) => ({ ...job })),

    nextSettle: (timeoutMs, signal) =>
      jobs.size === 0
        ? Promise.resolve(true)
        : timed<boolean>(
            timeoutMs,
            signal,
            (resolve) => {
              const wake = (): void => resolve(true)
              settleWaiters.push(wake)
              return () => {
                settleWaiters = settleWaiters.filter((w) => w !== wake)
              }
            },
            false
          ),

    waitReply: (waiterName, mailId, timeoutMs, signal) =>
      timed<WaitResult>(
        timeoutMs,
        signal,
        (resolve) => {
          const k = key(waiterName)
          const entry = { mailId, wake: resolve }
          waiting.set(k, entry)
          return () => {
            if (waiting.get(k) === entry) waiting.delete(k)
          }
        },
        { kind: 'timeout' }
      )
  }
}
