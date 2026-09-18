/**
 * 过程通知的判重。
 *
 * 同一件事会从两条路到达界面（工具自己 report 一次、上层再通知一次），
 * 短时间内重复的那条不该在时间线上占两行。
 *
 * **但「文本一样」不等于「重复」**：`task` 是并行的，同时跑的几路子任务推的
 * 进度长得一模一样（都是「子任务：调用 xxx」）。只按文本判的话第二路会被
 * 当成第一路的回声丢掉，界面上就永远只有一路在动 —— 所以 `toolCallId`
 * 也是身份的一部分。
 */

import type { AgentProcessItem } from '../components/AgentProcessLog.types'

/** 超过这个间隔的同样文本算「又发生了一次」，不是重复 */
export const NOTIFY_DEDUP_WINDOW_MS = 10000

export interface NotifyIdentity {
  notifyType: string
  message: string
  specialist?: string
  /** 这条通知来自哪次工具调用。并行的几路子任务靠它区分 */
  toolCallId?: string
}

function normalizeNotifyMessage(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。?!！…]+$/g, '')
}

export function isDuplicateNotify(
  items: readonly AgentProcessItem[],
  candidate: NotifyIdentity,
  timestamp: number,
  windowMs = NOTIFY_DEDUP_WINDOW_MS
): boolean {
  // 推理内容是累积的，每条都比上一条长 —— 判重对它没有意义
  if (candidate.notifyType === 'thinking') return false

  const message = normalizeNotifyMessage(candidate.message)
  const specialist = candidate.specialist || ''
  const callId = candidate.toolCallId || ''

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type !== 'notify-users') continue
    if (timestamp - item.timestamp > windowMs) break

    const data = (item.data ?? {}) as Record<string, unknown>
    if (
      ((data.notifyType as string) || 'info') === candidate.notifyType &&
      ((data.specialist as string) || '') === specialist &&
      ((data.toolCallId as string) || '') === callId &&
      normalizeNotifyMessage(String(data.message || '')) === message
    ) {
      return true
    }
  }

  return false
}
