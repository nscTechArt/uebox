import { describe, expect, it } from 'vitest'

import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import { readLatestPlan, readWrapUp, wrapUpActionMessage } from './agentTurnReport'

function result(toolName: string, details: unknown, isError = false): AgentProcessItem {
  return {
    type: 'tool-result',
    data: { toolName, toolCallId: `${toolName}-${Math.random()}`, isError, result: details },
    timestamp: Date.now()
  }
}

describe('任务清单', () => {
  it('取最后一次成功的清单', () => {
    const items = [
      result('update_plan', { items: [{ content: '读代码', status: 'in_progress' }] }),
      result('update_plan', {
        items: [
          { content: '读代码', status: 'completed' },
          { content: '改代码', status: 'in_progress' }
        ]
      }),
      result('update_plan', '给 items 或 advance=true。', true)
    ]
    expect(readLatestPlan(items).map((item) => item.status)).toEqual(['completed', 'in_progress'])
  })

  it('没调过就是空的，不从正文里猜', () => {
    expect(
      readLatestPlan([{ type: 'text', data: { text: '1. 读代码\n2. 改代码' }, timestamp: 0 }])
    ).toEqual([])
    expect(readLatestPlan(undefined)).toEqual([])
  })

  it('结果是 JSON 字符串时也认（存盘再读回来的消息）', () => {
    const items = [
      result('update_plan', JSON.stringify({ items: [{ content: 'a', status: 'pending' }] }))
    ]
    expect(readLatestPlan(items)).toHaveLength(1)
  })
})

describe('收尾提问', () => {
  it('读出问题和按钮，按钮没给 message 就发 label', () => {
    const wrapUp = readWrapUp([
      result('wrap_up', {
        ask: '要提交吗？',
        actions: [{ label: '提交' }, { label: '先不', message: '先别提交' }]
      })
    ])
    expect(wrapUp?.ask).toBe('要提交吗？')
    expect(wrapUp?.actions.map(wrapUpActionMessage)).toEqual(['提交', '先别提交'])
  })

  it('没有按钮的问题不算 —— 建议按钮那排照旧', () => {
    expect(readWrapUp([result('wrap_up', { ask: '要提交吗？', actions: [] })])).toBeNull()
    expect(
      readWrapUp([result('wrap_up', { ask: '要提交吗？', actions: [{ label: '提交' }] }, true)])
    ).toBeNull()
  })
})
