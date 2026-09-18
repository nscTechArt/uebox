export interface LatestValueScheduler<T> {
  schedule: (value: T) => void
  flush: () => void
  cancel: () => void
}

interface LatestValueSchedulerOptions<T> {
  intervalMs: number
  onValue: (value: T) => void
  now?: () => number
}

/**
 * 只处理区间内的最新值，但不会像 debounce 那样被持续输入无限延期。
 *
 * 第一份值立即处理；同一区间里的后续值合并到固定截止点。这样高频流式内容
 * 不会把渲染线程占满，也保证用户最多等一个 interval 就能看到新内容。
 */
export function createLatestValueScheduler<T>({
  intervalMs,
  onValue,
  now = () => performance.now()
}: LatestValueSchedulerOptions<T>): LatestValueScheduler<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRunAt: number | null = null
  let pendingValue: T | undefined
  let hasPendingValue = false

  const runPending = (): void => {
    timer = null
    if (!hasPendingValue) return

    const value = pendingValue as T
    pendingValue = undefined
    hasPendingValue = false
    lastRunAt = now()
    onValue(value)
  }

  const schedule = (value: T): void => {
    pendingValue = value
    hasPendingValue = true

    if (timer) return
    if (lastRunAt === null) {
      runPending()
      return
    }

    const waitMs = Math.max(0, intervalMs - (now() - lastRunAt))
    if (waitMs === 0) {
      runPending()
      return
    }

    timer = setTimeout(runPending, waitMs)
  }

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    runPending()
  }

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pendingValue = undefined
    hasPendingValue = false
  }

  return { schedule, flush, cancel }
}
