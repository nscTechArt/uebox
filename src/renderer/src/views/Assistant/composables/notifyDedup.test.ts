import { describe, expect, it } from 'vitest'

import { isDuplicateNotify } from './notifyDedup'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'

function notify(
  message: string,
  timestamp: number,
  extra: Record<string, unknown> = {}
): AgentProcessItem {
  return { type: 'notify-users', data: { message, notifyType: 'progress', ...extra }, timestamp }
}

describe('isDuplicateNotify', () => {
  it('短时间内同一条通知只留一次', () => {
    const items = [notify('正在导入 12/50', 1000)]

    expect(
      isDuplicateNotify(items, { notifyType: 'progress', message: '正在导入 12/50。' }, 1200)
    ).toBe(true)
  })

  it('并行的两路子任务进度文本相同也不算重复', () => {
    const items = [notify('子任务：调用 ue_get_actor', 1000, { toolCallId: 'call-a' })]

    expect(
      isDuplicateNotify(
        items,
        {
          notifyType: 'progress',
          message: '子任务：调用 ue_get_actor',
          toolCallId: 'call-b'
        },
        1100
      )
    ).toBe(false)

    // 同一路真重发了才算重复
    expect(
      isDuplicateNotify(
        items,
        {
          notifyType: 'progress',
          message: '子任务：调用 ue_get_actor',
          toolCallId: 'call-a'
        },
        1100
      )
    ).toBe(true)
  })

  it('隔得够久的同样文本是又发生了一次，不是重复', () => {
    const items = [notify('子任务：调用 ue_get_actor', 1000, { toolCallId: 'call-a' })]

    expect(
      isDuplicateNotify(
        items,
        { notifyType: 'progress', message: '子任务：调用 ue_get_actor', toolCallId: 'call-a' },
        1000 + 10001
      )
    ).toBe(false)
  })

  it('推理内容是累积的，不参与判重', () => {
    const items = [notify('想了一半', 1000, { notifyType: 'thinking' })]

    expect(isDuplicateNotify(items, { notifyType: 'thinking', message: '想了一半' }, 1100)).toBe(
      false
    )
  })
})
