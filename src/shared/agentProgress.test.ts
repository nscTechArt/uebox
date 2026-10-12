import { describe, expect, it } from 'vitest'
import { compactProgress, findReplaceableProgress } from './agentProgress'

const progress = (
  toolCallId: string,
  message: string,
  toolName = 'run_shell_command'
): { type: string; data: Record<string, string> } => ({
  type: 'notify-users',
  data: { message, notifyType: 'progress', toolCallId, toolName }
})

describe('findReplaceableProgress', () => {
  it('同一次工具调用的进度顶掉上一份', () => {
    const items = [{ type: 'tool-call' }, progress('a', '1'), { type: 'text' }]
    expect(findReplaceableProgress(items, progress('a', '2'))).toBe(1)
  })

  it('别的调用、子任务进度、非进度通知都照常追加', () => {
    const items = [progress('a', '1'), progress('t', '子任务：调用 x', 'task')]
    expect(findReplaceableProgress(items, progress('b', '1'))).toBe(-1)
    expect(findReplaceableProgress(items, progress('t', '子任务：调用 y', 'task'))).toBe(-1)
    expect(
      findReplaceableProgress(items, {
        type: 'notify-users',
        data: { message: 'x', notifyType: 'info' }
      })
    ).toBe(-1)
  })
})

describe('compactProgress', () => {
  it('每次调用只留最新一份，位置在第一份那里', () => {
    const call = { type: 'tool-call' }
    const other = { type: 'text' }
    const items = [call, progress('a', '1'), other, progress('a', '2'), progress('a', '3')]
    expect(compactProgress(items)).toEqual([call, progress('a', '3'), other])
  })

  it('没有可收的原样返回', () => {
    const items = [progress('a', '1'), progress('t', 'x', 'task'), progress('t', 'y', 'task')]
    expect(compactProgress(items)).toBe(items)
  })
})
