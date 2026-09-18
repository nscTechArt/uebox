import { message } from '@renderer/utils/messageManager'

import i18n from '@renderer/i18n'

/**
 * 远端同步结果提示。
 *
 * 主进程的写入 IPC 现在会在返回值里带一个旁路字段 `remoteSync`：本地写照常
 * 成功（`success: true`），但如果这条改动**还没上服务器**，就要诚实地告诉
 * 用户，而不是像以前那样静默吞掉 —— 那会导致「界面说保存成功，过一会儿
 * 数据自己消失」。
 */

export interface RemoteSyncInfo {
  status: 'skipped' | 'pushed' | 'recorded' | 'queued' | 'failed'
  reason?: 'offline' | 'push_failed'
  error?: string
  pendingCount?: number
}

/** 批量操作时可能连着回来很多条，节流避免刷屏 */
const NOTICE_THROTTLE_MS = 10_000
let lastNoticeAt = 0

/** 仅供测试重置内部节流状态 */
export function resetRemoteSyncNoticeThrottle(): void {
  lastNoticeAt = 0
}

/**
 * 从 IPC 返回值里取出 remoteSync 并按需提示。
 *
 * 不改变 unwrapResult 的行为 —— 本地写成功仍然是成功。
 */
export function reportRemoteSync(res: unknown, now = Date.now()): void {
  const info = (res as { remoteSync?: RemoteSyncInfo } | null | undefined)?.remoteSync
  if (!info) return
  if (info.status !== 'queued' && info.status !== 'failed') return

  if (now - lastNoticeAt < NOTICE_THROTTLE_MS) return
  lastNoticeAt = now

  const { t } = i18n.global
  const key = info.reason === 'offline' ? 'networkSync.queuedOffline' : 'networkSync.queuedFailed'
  message.warning(t(key, { count: info.pendingCount ?? 1 }), 6)
}
