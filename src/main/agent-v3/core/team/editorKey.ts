/**
 * 编辑器钥匙：同一个编辑器，同一时间只放一个写操作进去。
 *
 * ## 为什么要有它
 *
 * 发往 UE 的请求按消息 id 复用同一条连接，宿主这边不排队（`websocket/server.ts`）。
 * 单个 Agent 时这不是问题；工作室模式下几个队员并行，就会出现一个在跑 PIE 试玩、
 * 另一个同时往关卡里塞 Actor 的情况 —— 试玩看到的是半截场景，报出来的 bug 不是 bug。
 * Epic 自己的 Unreal MCP 也要求客户端别发重叠的调用。
 *
 * 资产锁（`assetLock.ts`）挡的是「两个人改同一个包」，拿不到立刻失败；
 * 这把钥匙挡的是「两个人同时动编辑器」，拿不到就**排队等**。两者叠着用：
 * 先过资产锁（快速失败），再排钥匙。
 *
 * ## 粒度是一次工具调用
 *
 * 不是「一件活」：队员干一件活要几十次调用，整件活独占编辑器等于把团队串成一个人。
 * 一次调用内独占就够了 —— PIE 试玩、自动试玩都是一次调用跑完的。
 *
 * ## 只在工作室模式里生效
 *
 * 由 `runWithEditorKey` 把执行流标上。普通会话的行为一点不变。
 */

import { AsyncLocalStorage } from 'async_hooks'

const scope = new AsyncLocalStorage<true>()

/** 把这条执行流（含它派生的所有子 Agent）标成「写编辑器要排钥匙」 */
export function runWithEditorKey<T>(fn: () => T): T {
  return scope.run(true, fn)
}

export function editorKeyActive(): boolean {
  return scope.getStore() === true
}

/** 每个编辑器连接一条队尾。只存队尾：前面的人放手时后面的人自然接上 */
const tails = new Map<string, Promise<void>>()

/**
 * 拿到钥匙再跑 `fn`，跑完（含抛异常）放手。
 *
 * 排队中途被停下：直接退出，**不插队也不漏放** —— 自己那一截照样在链上，
 * 前一个人放手时会顺着链放给后一个人，顺序不乱。
 */
export async function withEditorKey<T>(
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => mine)
  tails.set(key, tail)

  try {
    await untilAborted(previous, signal)
    return await fn()
  } finally {
    release()
    // 排队中途被停下时，前面的人可能还拿着钥匙：要等整条链真放空了才能清掉队尾，
    // 否则下一个来的人拿到一条空链，直接和前面那位同时动编辑器
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
  }
}

function untilAborted(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('Operation aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    wait.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
