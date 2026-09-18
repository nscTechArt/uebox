/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

// @ts-expect-error —— 报告脚本是 .mjs，没有类型声明；这里只测它的纯函数
import {
  aggregate,
  countAdjacentRepeats,
  coverageCurve,
  formatReport,
  parseTranscript
} from '../../scripts/tool-usage-report.mjs'

/**
 * 同 `tool-selection-metrics.test.ts` 的立场：
 * **指标算错比不量更糟** —— 会拿着一个假数字去改架构。
 *
 * 这套报告要回答的是「核心工具集该多大」，答错的代价是把常用工具挪进搜索，
 * 或者把长尾留在上下文里继续挤准确率。所以每条判据都钉一个测试。
 */

/** 造一份 JSONL：调用写在 assistant 消息里，成败写在随后的 toolResult 里 */
function transcript(
  entries: Array<{ name: string; id: string; isError?: boolean; result?: string }>
): string {
  const lines: string[] = [JSON.stringify({ kind: 'header', version: 1 })]
  for (const e of entries) {
    lines.push(
      JSON.stringify({
        kind: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: e.id, name: e.name, arguments: {} }]
        }
      })
    )
    lines.push(
      JSON.stringify({
        kind: 'message',
        message: {
          role: 'toolResult',
          toolCallId: e.id,
          toolName: e.name,
          content: e.result ?? 'ok',
          isError: e.isError ?? false
        }
      })
    )
  }
  return lines.join('\n')
}

describe('parseTranscript', () => {
  it('从 assistant 消息里取出调用，按 id 回填成败', () => {
    const calls = parseTranscript(
      transcript([
        { name: 'ue_get_actor', id: 'a' },
        { name: 'ue_spawn_actor', id: 'b', isError: true }
      ])
    )

    expect(calls.map((c: { name: string }) => c.name)).toEqual(['ue_get_actor', 'ue_spawn_actor'])
    expect(calls[0].isError).toBe(false)
    expect(calls[1].isError).toBe(true)
  })

  it('一条 assistant 消息里的多个调用都要取到', () => {
    const line = JSON.stringify({
      kind: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'toolCall', id: 'a', name: 'x' },
          { type: 'toolCall', id: 'b', name: 'y' }
        ]
      }
    })
    expect(parseTranscript(line)).toHaveLength(2)
  })

  it('没有对应结果的调用仍然计入 —— 丢掉会把失败率洗白', () => {
    // 会话被中断时结果没落盘。把这类调用丢掉等于缩小分母
    const line = JSON.stringify({
      kind: 'message',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'x' }] }
    })
    expect(parseTranscript(line)).toHaveLength(1)
  })

  it('半行 JSON 不让整份记录作废', () => {
    // 追加写的最后一行可能写到一半就断电了
    const good = transcript([{ name: 'x', id: 'a' }])
    expect(parseTranscript(`${good}\n{"kind":"message","mess`)).toHaveLength(1)
  })

  it('空文本返回空数组', () => {
    expect(parseTranscript('')).toEqual([])
  })

  it('审批拦下的调用标成没执行', () => {
    const calls = parseTranscript(
      transcript([
        { name: 'run_shell_command', id: 'a', result: '用户拒绝执行 run_shell_command。' }
      ])
    )
    expect(calls[0].executed).toBe(false)
  })
})

describe('countAdjacentRepeats', () => {
  it('连着调同一个工具算重复', () => {
    expect(countAdjacentRepeats([{ name: 'a' }, { name: 'a' }, { name: 'a' }])).toBe(2)
  })

  it('隔开了就不算 —— a b a 是正常的来回查证，不是原地打转', () => {
    expect(countAdjacentRepeats([{ name: 'a' }, { name: 'b' }, { name: 'a' }])).toBe(0)
  })

  it('单个和空列表都是 0', () => {
    expect(countAdjacentRepeats([{ name: 'a' }])).toBe(0)
    expect(countAdjacentRepeats([])).toBe(0)
  })
})

describe('coverageCurve', () => {
  it('前 N 个的占比是累加的', () => {
    // 10 个工具各调 10 次，前 5 个应该正好一半
    const counts = Array.from({ length: 10 }, () => 10)
    const curve = coverageCurve(counts, 100, [5, 10])
    expect(curve[0]).toEqual({ n: 5, pct: 0.5 })
    expect(curve[1]).toEqual({ n: 10, pct: 1 })
  })

  it('N 超过实际工具数时不输出那一档 —— 打印一个虚假的 100% 会让人以为覆盖很好', () => {
    expect(coverageCurve([5, 3], 8, [5, 10])).toEqual([])
  })

  it('总数为 0 时不除零', () => {
    expect(coverageCurve([], 0, [5])).toEqual([])
  })
})

describe('aggregate', () => {
  const sessions = [
    parseTranscript(
      transcript([
        { name: 'ue_get_actor', id: 'a' },
        { name: 'ue_get_actor', id: 'b' },
        { name: 'ue_run_python_script', id: 'c' }
      ])
    ),
    parseTranscript(transcript([{ name: 'ue_get_actor', id: 'd', isError: true }])),
    parseTranscript('')
  ]

  it('按频次降序排名', () => {
    const stats = aggregate(sessions)
    expect(stats.ranked[0]).toEqual(['ue_get_actor', 3])
    expect(stats.total).toBe(4)
    expect(stats.distinct).toBe(2)
  })

  it('一次都没调工具的会话计入总数但不计入 sessionsWithCalls', () => {
    // 纯聊天的会话很多。混进分母会让「平均每会话调用数」严重偏低
    const stats = aggregate(sessions)
    expect(stats.sessions).toBe(3)
    expect(stats.sessionsWithCalls).toBe(2)
  })

  it('失败和兜底分开计数', () => {
    const stats = aggregate(sessions)
    expect(stats.failed).toBe(1)
    expect(stats.fallbacks).toBe(1)
  })

  it('重复只在会话内部算，不跨会话', () => {
    // 跨会话相邻是排序造成的假象，不是模型在原地打转
    const stats = aggregate([
      parseTranscript(transcript([{ name: 'x', id: 'a' }])),
      parseTranscript(transcript([{ name: 'x', id: 'b' }]))
    ])
    expect(stats.repeats).toBe(0)
  })
})

describe('formatReport', () => {
  it('没有调用时明说，而不是打印一堆 0', () => {
    // 一屏 0% 看着像「表现完美」，实际是「一次都没量到」
    const text = formatReport(aggregate([]))
    expect(text).toContain('没有可分析的调用')
    expect(text).not.toContain('0.0%')
  })

  it('给了工具清单才报「从未被调用」', () => {
    const stats = aggregate([parseTranscript(transcript([{ name: 'used', id: 'a' }]))])
    expect(formatReport(stats, { inventory: ['used', 'never'] })).toContain('从未被调用')
    // 没有清单时无从知道有多少工具，不能瞎报
    expect(formatReport(stats)).not.toContain('从未被调用')
  })

  it('兜底那行带着「先查主工具是不是坏了」的提醒', () => {
    // 这是真实误诊过一次的坑：工具故障会被记成模型选错
    const stats = aggregate([parseTranscript(transcript([{ name: 'x', id: 'a' }]))])
    expect(formatReport(stats)).toContain('先查主工具是不是坏了')
  })
})
