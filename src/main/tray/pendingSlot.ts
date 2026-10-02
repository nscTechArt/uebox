/**
 * 「还有一条动作没送到界面」的暂存格。
 *
 * `tray:action` 只是一句「有东西，来拿」，不带负载 —— 这个格子才是
 * 唯一的送达路径：点菜单先把动作放进来再提醒，提醒落空（渲染进程没
 * 挂好、正在重载）也不要紧，界面挂上来会走 `tray:take-pending` 自取。
 * 取走即清、超时作废、只留最新一条，所以提醒和补取不会把同一条执行
 * 两次。和 agent 通知的 `pending` 同一个道理
 * （见 `services/agentNotifications/index.ts`）。
 */
export interface PendingSlot<T> {
  put: (value: T) => void
  /** 取走并清空；没有、或已经过期，都是 null */
  take: () => T | null
}

export function createPendingSlot<T>(deps: { ttlMs: number; now?: () => number }): PendingSlot<T> {
  const { ttlMs, now = Date.now } = deps
  let stored: { value: T; at: number } | null = null

  return {
    put: (value) => {
      stored = { value, at: now() }
    },
    take: () => {
      const taken = stored
      if (!taken) return null
      stored = null
      if (now() - taken.at > ttlMs) return null
      return taken.value
    }
  }
}
