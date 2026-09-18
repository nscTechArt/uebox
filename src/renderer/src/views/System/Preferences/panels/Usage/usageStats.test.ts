import { describe, expect, it } from 'vitest'

import type { ChatMessage, ResponseMetadataChange } from '@renderer/store/modules/chatMessages'

import {
  average,
  buildHeatmap,
  buildUsageReport,
  cacheHitRate,
  formatCount,
  formatDuration,
  formatPercent,
  metricValue,
  rangeDays,
  toLocalDateKey,
  type UsageDay,
  type UsageTotals
} from './usageStats'

/** 固定一个「现在」：2026-09-08 14:00 本地时间 */
const NOW = new Date(2026, 8, 8, 14, 0, 0).getTime()

function daysAgo(n: number, hour = 10): number {
  const date = new Date(NOW)
  date.setDate(date.getDate() - n)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    role: 'assistant',
    content: '好了',
    startTime: daysAgo(0),
    ...overrides
  } as ChatMessage
}

function usage(total: number): NonNullable<ChatMessage['responseMetadata']>['usage'] {
  // cost 仍在类型里（厂商回包带着它），但这一页不看 —— 见 usageStats.ts 的文件头
  return { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, cost: 0 }
}

function report(
  messagesBySid: Record<string, ChatMessage[]>,
  days: number | 'all' = 7,
  projectBySid?: Record<string, string>
): ReturnType<typeof buildUsageReport> {
  return buildUsageReport(messagesBySid, {
    days,
    now: NOW,
    ...(projectBySid ? { projectBySid } : {})
  })
}

describe('按天汇总', () => {
  it('窗口里每一天都在，没有活动的那天是 0 —— 柱状图要看得出空档', () => {
    const result = report({ a: [] })
    expect(result.days).toHaveLength(7)
    expect(result.days.every((day) => day.tokens === 0)).toBe(true)
  })

  it('日期升序，最后一天是今天', () => {
    const result = report({ a: [] })
    expect(result.days.at(-1)!.date).toBe(toLocalDateKey(NOW))
    const sorted = [...result.days].sort((x, y) => x.date.localeCompare(y.date))
    expect(result.days.map((d) => d.date)).toEqual(sorted.map((d) => d.date))
  })

  it('同一天的多轮累加', () => {
    const result = report({
      a: [
        assistant({ responseMetadata: { usage: usage(100) } }),
        assistant({ responseMetadata: { usage: usage(50) } })
      ]
    })
    const today = result.days.at(-1)!
    expect(today.tokens).toBe(150)
    expect(today.turns).toBe(2)
  })

  it('落在各自的那一天，不会都堆到今天', () => {
    const result = report({
      a: [
        assistant({ startTime: daysAgo(0), responseMetadata: { usage: usage(10) } }),
        assistant({ startTime: daysAgo(2), responseMetadata: { usage: usage(20) } })
      ]
    })
    expect(result.days.at(-1)!.tokens).toBe(10)
    expect(result.days.at(-3)!.tokens).toBe(20)
  })

  it('窗口之外的不算 —— 选了 7 天就是 7 天', () => {
    const result = report({
      a: [assistant({ startTime: daysAgo(30), responseMetadata: { usage: usage(999) } })]
    })
    expect(result.totals.tokens).toBe(0)
  })

  it('跨会话合并', () => {
    const result = report({
      a: [assistant({ responseMetadata: { usage: usage(10) } })],
      b: [assistant({ responseMetadata: { usage: usage(20) } })]
    })
    expect(result.totals.tokens).toBe(30)
  })

  it('每一天之和等于总数 —— 两处对不上用户会当场发现', () => {
    const result = report({
      a: [
        assistant({ startTime: daysAgo(0), responseMetadata: { usage: usage(10) } }),
        assistant({ startTime: daysAgo(3), responseMetadata: { usage: usage(20) } })
      ]
    })
    const summed = result.days.reduce((acc, day) => acc + day.tokens, 0)
    expect(summed).toBe(result.totals.tokens)
  })

  it('每天的缓存命中单独记一份 —— 柱状图要能把它扣掉', () => {
    const result = report({
      a: [
        assistant({
          responseMetadata: {
            usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 85, total: 1000, cost: 0 }
          }
        })
      ]
    })
    const today = result.days.at(-1)!
    expect(today.tokens).toBe(1000)
    expect(today.cacheRead).toBe(900)
    expect(metricValue(today, 'uncached')).toBe(100)
  })

  it('改动也按天落格，柱子可以画「哪天干活最多」', () => {
    const result = report({
      a: [
        assistant({
          startTime: daysAgo(1),
          responseMetadata: {
            changes: [
              {
                toolName: 'ue_spawn',
                risk: 'mutating',
                target: 'A',
                reversible: true,
                failed: false
              }
            ]
          }
        })
      ]
    })
    expect(result.days.at(-2)!.changes).toBe(1)
    expect(result.days.at(-1)!.changes).toBe(0)
  })
})

describe('算不出来的那部分要如实报', () => {
  it('没有用量字段的老会话单独数出来，不混进总数', () => {
    const result = report({ a: [assistant(), assistant()] })
    expect(result.totals.turns).toBe(0)
    expect(result.turnsWithoutUsage).toBe(2)
  })

  it('没有时间戳的落不进任何一天，也单独数', () => {
    const result = report({
      a: [assistant({ startTime: undefined, responseMetadata: { usage: usage(10) } })]
    })
    expect(result.totals.tokens).toBe(0)
    expect(result.turnsWithoutUsage).toBe(1)
  })

  it('用户消息不参与统计 —— 那条既没用量也没工具调用', () => {
    const result = report({
      a: [{ id: 'u1', role: 'user', content: '帮我改一下', startTime: daysAgo(0) } as ChatMessage]
    })
    expect(result.turnsWithoutUsage).toBe(0)
    expect(result.totals.turns).toBe(0)
  })
})

describe('工具与技能', () => {
  it('按次数降序', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [
            { type: 'tool-call', data: { name: 'ue_save' }, timestamp: 1 },
            { type: 'tool-call', data: { name: 'content_search' }, timestamp: 2 },
            { type: 'tool-call', data: { name: 'content_search' }, timestamp: 3 }
          ]
        })
      ]
    })
    expect(result.tools.map((tool) => [tool.name, tool.calls])).toEqual([
      ['content_search', 2],
      ['ue_save', 1]
    ])
    expect(result.totals.toolCalls).toBe(3)
  })

  it('两种历史写法都认 —— 老条目是 function.name，新的是 name', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [
            { type: 'tool-call', data: { function: { name: 'ue_save' } }, timestamp: 1 },
            { type: 'tool-call', data: { name: 'ue_save' }, timestamp: 2 }
          ]
        })
      ]
    })
    expect(result.tools).toEqual([{ name: 'ue_save', calls: 2, failed: 0, medianMs: null }])
  })

  it('不是 tool-call 的条目不算', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [
            { type: 'text', data: { text: '在改材质' }, timestamp: 1 },
            { type: 'step', data: {}, timestamp: 2 }
          ]
        })
      ]
    })
    expect(result.tools).toEqual([])
  })

  it('技能按名字计数', () => {
    const result = report({
      a: [
        assistant({ responseMetadata: { usedSkills: [{ name: 'ue-blueprint-graph-wiring' }] } }),
        assistant({ responseMetadata: { usedSkills: [{ name: 'ue-blueprint-graph-wiring' }] } })
      ]
    })
    expect(result.skills).toEqual([
      { name: 'ue-blueprint-graph-wiring', count: 2, source: 'unknown' }
    ])
  })

  it('记了来源就带上来源，没记的标成不详 —— 不猜', () => {
    const result = report({
      a: [
        assistant({ responseMetadata: { usedSkills: [{ name: 'mine', source: 'user' }] } }),
        assistant({ responseMetadata: { usedSkills: [{ name: 'theirs' }] } })
      ]
    })
    const byName = Object.fromEntries(result.skills.map((skill) => [skill.name, skill.source]))
    expect(byName).toEqual({ mine: 'user', theirs: 'unknown' })
  })

  it('没有用量的那一轮，工具和技能照样统计 —— 老会话的这部分记录是全的', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [{ type: 'tool-call', data: { name: 'ue_save' }, timestamp: 1 }]
        })
      ]
    })
    expect(result.turnsWithoutUsage).toBe(1)
    expect(result.tools[0]).toMatchObject({ name: 'ue_save', calls: 1 })
  })

  it('同次数按名字排，每次打开顺序一样', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [
            { type: 'tool-call', data: { name: 'zebra' }, timestamp: 1 },
            { type: 'tool-call', data: { name: 'alpha' }, timestamp: 2 }
          ]
        })
      ]
    })
    expect(result.tools.map((t) => t.name)).toEqual(['alpha', 'zebra'])
  })
})

describe('工具成败与耗时', () => {
  it('报错的结果计进失败数 —— 「调了 300 次」看不出哪个工具在拖后腿', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [
            { type: 'tool-call', data: { name: 'ue_save' }, timestamp: 0 },
            { type: 'tool-result', data: { toolName: 'ue_save', isError: true }, timestamp: 10 },
            { type: 'tool-call', data: { name: 'ue_save' }, timestamp: 20 },
            { type: 'tool-result', data: { toolName: 'ue_save', isError: false }, timestamp: 30 }
          ]
        })
      ]
    })
    expect(result.tools[0]).toMatchObject({ name: 'ue_save', calls: 2, failed: 1 })
  })

  it('取中位数不取平均 —— 一次审批等了很久不该把整列拽飞', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [
            { type: 'tool-call', data: { name: 'slow' }, timestamp: 0 },
            { type: 'tool-result', data: { toolName: 'slow' }, timestamp: 100 },
            { type: 'tool-call', data: { name: 'slow' }, timestamp: 200 },
            { type: 'tool-result', data: { toolName: 'slow' }, timestamp: 300 },
            { type: 'tool-call', data: { name: 'slow' }, timestamp: 400 },
            { type: 'tool-result', data: { toolName: 'slow' }, timestamp: 400 + 600_000 }
          ]
        })
      ]
    })
    expect(result.tools[0].medianMs).toBe(100)
  })

  it('超过一小时的间隔丢掉 —— 那不是工具在跑，是弹窗挂了一整晚', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [
            { type: 'tool-call', data: { name: 'hung' }, timestamp: 0 },
            { type: 'tool-result', data: { toolName: 'hung' }, timestamp: 2 * 60 * 60 * 1000 }
          ]
        })
      ]
    })
    expect(result.tools[0]).toMatchObject({ calls: 1, medianMs: null })
  })

  it('没返回的调用不参与耗时，但仍然算一次调用', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [{ type: 'tool-call', data: { name: 'stopped' }, timestamp: 0 }]
        })
      ]
    })
    expect(result.tools[0]).toMatchObject({ calls: 1, failed: 0, medianMs: null })
  })

  it('同名工具按出现顺序配对，跨消息不串味', () => {
    const result = report({
      a: [
        assistant({
          agentProcess: [
            { type: 'tool-call', data: { name: 'x' }, timestamp: 0 },
            { type: 'tool-result', data: { toolName: 'x' }, timestamp: 50 }
          ]
        }),
        assistant({
          agentProcess: [
            { type: 'tool-call', data: { name: 'x' }, timestamp: 1000 },
            { type: 'tool-result', data: { toolName: 'x' }, timestamp: 1050 }
          ]
        })
      ]
    })
    expect(result.tools[0]).toMatchObject({ calls: 2, medianMs: 50 })
  })
})

describe('改动台账', () => {
  function change(overrides: Partial<ResponseMetadataChange> = {}): ResponseMetadataChange {
    return {
      toolName: 'ue_spawn',
      risk: 'mutating',
      target: 'Cube',
      reversible: true,
      failed: false,
      ...overrides
    }
  }

  it('落地的和没成功的分开数 —— 相加才是台账全长', () => {
    const result = report({
      a: [
        assistant({
          responseMetadata: {
            changes: [change(), change({ failed: true }), change()]
          }
        } as Partial<ChatMessage>)
      ]
    })
    expect(result.changes.total).toBe(2)
    expect(result.changes.failed).toBe(1)
  })

  it('不再统计破坏性和撤不回 —— 那两个说的是审批档位，不是后果', () => {
    const result = report({
      a: [
        assistant({
          responseMetadata: {
            changes: [
              change({ reversible: false, risk: 'destructive' }),
              change({ reversible: false, risk: 'destructive' })
            ]
          }
        } as Partial<ChatMessage>)
      ]
    })
    expect(result.changes).not.toHaveProperty('irreversible')
    expect(result.changes).not.toHaveProperty('destructive')
    expect(result.changes.total).toBe(2)
  })

  it('同一个目标改多次只算一处资产', () => {
    const result = report({
      a: [
        assistant({
          responseMetadata: {
            changes: [
              change({ target: 'Cube' }),
              change({ target: 'Cube', toolName: 'ue_set_property' }),
              change({ target: 'Sphere' })
            ]
          }
        } as Partial<ChatMessage>)
      ]
    })
    expect(result.changes.total).toBe(3)
    expect(result.changes.targets).toBe(2)
  })

  it('认不出目标的（命令行、脚本）进总数但不进资产数 —— 宁可少算', () => {
    const result = report({
      a: [
        assistant({
          responseMetadata: {
            changes: [change({ toolName: 'run_shell_command', target: '' }), change()]
          }
        } as Partial<ChatMessage>)
      ]
    })
    expect(result.changes.total).toBe(2)
    expect(result.changes.targets).toBe(1)
  })

  it('失败那条不算资产 —— 它什么都没动', () => {
    const result = report({
      a: [
        assistant({
          responseMetadata: { changes: [change({ target: 'OnlyTried', failed: true })] }
        } as Partial<ChatMessage>)
      ]
    })
    expect(result.changes.targets).toBe(0)
    expect(result.changes.failed).toBe(1)
  })

  it('按工具排行，降序', () => {
    const result = report({
      a: [
        assistant({
          responseMetadata: {
            changes: [change(), change(), change({ toolName: 'material_set_node_value' })]
          }
        } as Partial<ChatMessage>)
      ]
    })
    expect(result.changes.byTool).toEqual([
      { name: 'ue_spawn', count: 2 },
      { name: 'material_set_node_value', count: 1 }
    ])
  })
})

describe('按工程分组', () => {
  it('会话归到它绑的工程，没绑的落到空名字那一格', () => {
    const result = report(
      {
        a: [assistant({ responseMetadata: { usage: usage(100) } })],
        b: [assistant({ responseMetadata: { usage: usage(30) } })]
      },
      7,
      { a: 'BIKEOUT' }
    )
    expect(result.projects).toEqual([
      { name: 'BIKEOUT', tokens: 100, cacheRead: 0, turns: 1, changes: 0 },
      { name: '', tokens: 30, cacheRead: 0, turns: 1, changes: 0 }
    ])
  })

  it('同一个工程的多条会话合并', () => {
    const result = report(
      {
        a: [assistant({ responseMetadata: { usage: usage(10) } })],
        b: [assistant({ responseMetadata: { usage: usage(20) } })]
      },
      7,
      { a: 'BIKEOUT', b: 'BIKEOUT' }
    )
    expect(result.projects).toEqual([
      { name: 'BIKEOUT', tokens: 30, cacheRead: 0, turns: 2, changes: 0 }
    ])
  })

  it('工程之和等于总数', () => {
    const result = report(
      {
        a: [assistant({ responseMetadata: { usage: usage(10) } })],
        b: [assistant({ responseMetadata: { usage: usage(20) } })]
      },
      7,
      { a: 'P1', b: 'P2' }
    )
    const summed = result.projects.reduce((acc, project) => acc + project.tokens, 0)
    expect(summed).toBe(result.totals.tokens)
  })

  it('工程按不含缓存的量排，和界面显示的那一列一致', () => {
    // P1 总量更大但几乎全是缓存命中；P2 总量小，花的却更多
    const result = report(
      {
        a: [
          assistant({
            responseMetadata: {
              usage: { input: 10, output: 0, cacheRead: 990, cacheWrite: 0, total: 1000, cost: 0 }
            }
          })
        ],
        b: [
          assistant({
            responseMetadata: {
              usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, total: 200, cost: 0 }
            }
          })
        ]
      },
      7,
      { a: 'P1', b: 'P2' }
    )
    expect(result.projects.map((project) => project.name)).toEqual(['P2', 'P1'])
  })

  it('这段时间一次没跑的工程不占位置', () => {
    const result = report({ a: [] }, 7, { a: 'BIKEOUT' })
    expect(result.projects).toEqual([])
  })
})

describe('输入健壮性', () => {
  it('空对象不炸', () => {
    expect(report({}).totals.tokens).toBe(0)
  })

  it('某条会话的值不是数组时跳过，不带崩整份报告', () => {
    const broken = { a: null, b: [assistant({ responseMetadata: { usage: usage(5) } })] }
    expect(report(broken as unknown as Record<string, ChatMessage[]>).totals.tokens).toBe(5)
  })
})

describe('时间档位', () => {
  it('今日就是一天，7 天和 30 天照字面', () => {
    expect(rangeDays('today')).toBe(1)
    expect(rangeDays('week')).toBe(7)
    expect(rangeDays('month')).toBe(30)
  })

  it('全部档交给报告生成器按现存记录决定范围', () => {
    expect(rangeDays('all')).toBe('all')
  })

  it('全部档包含今年以前的现存记录', () => {
    const oldTime = new Date(2024, 11, 31, 10, 0, 0).getTime()
    const result = report(
      {
        a: [
          assistant({ startTime: oldTime, responseMetadata: { usage: usage(20) } }),
          assistant({ startTime: daysAgo(0), responseMetadata: { usage: usage(10) } })
        ]
      },
      'all'
    )
    expect(result.days[0].date).toBe('2024-12-31')
    expect(result.days.at(-1)!.date).toBe(toLocalDateKey(NOW))
    expect(result.totals.tokens).toBe(30)
  })

  it('没有记录时全部档仍显示今天，不生成空图', () => {
    const result = report({}, 'all')
    expect(result.days.map((day) => day.date)).toEqual([toLocalDateKey(NOW)])
  })

  it('今日档只汇总今天这一天', () => {
    const result = buildUsageReport(
      {
        a: [
          assistant({ startTime: daysAgo(0), responseMetadata: { usage: usage(10) } }),
          assistant({ startTime: daysAgo(1), responseMetadata: { usage: usage(999) } })
        ]
      },
      { days: rangeDays('today'), now: NOW }
    )
    expect(result.days).toHaveLength(1)
    expect(result.totals.tokens).toBe(10)
  })
})

describe('热力图', () => {
  /** 从 `from`（`YYYY-MM-DD`）起连续 n 天，第 i 天的值由 `valueAt` 给 */
  function series(from: string, count: number, valueAt: (index: number) => number): UsageDay[] {
    const [year, month, day] = from.split('-').map(Number)
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(year, month - 1, day + index)
      return {
        date: toLocalDateKey(date.getTime()),
        tokens: valueAt(index),
        cacheRead: 0,
        turns: 0,
        changes: 0
      }
    })
  }

  it('每一列是一整周，头尾都补齐 —— 差一格整张图的星期就错位了', () => {
    // 2026-01-01 是周四
    const heatmap = buildHeatmap(
      series('2026-01-01', 10, () => 0),
      'uncached'
    )
    expect(heatmap.weeks.every((week) => week.length === 7)).toBe(true)
    // 前四格（周日到周三）是补出来的空格
    expect(heatmap.weeks[0].slice(0, 4).every((cell) => cell.day === null)).toBe(true)
    expect(heatmap.weeks[0][4].day?.date).toBe('2026-01-01')
  })

  it('每一天都还在，一格不多一格不少', () => {
    const days = series('2026-01-01', 364, () => 1)
    const heatmap = buildHeatmap(days, 'uncached')
    const real = heatmap.weeks.flat().filter((cell) => cell.day)
    expect(real).toHaveLength(364)
    expect(real[0].day?.date).toBe(days[0].date)
    expect(real.at(-1)?.day?.date).toBe(days.at(-1)?.date)
  })

  it('没活动的那天是 0 档，其余都进 1–4 档', () => {
    const heatmap = buildHeatmap(
      series('2026-01-01', 28, (i) => (i % 2 === 0 ? 0 : i)),
      'uncached'
    )
    for (const cell of heatmap.weeks.flat()) {
      if (!cell.day) continue
      if (cell.day.tokens === 0) {
        expect(cell.level).toBe(0)
        continue
      }
      expect(cell.level).toBeGreaterThanOrEqual(1)
      expect(cell.level).toBeLessThanOrEqual(4)
    }
  })

  it('分档按四分位数，一天跑飞不会把其余全压成最浅那档', () => {
    // 27 天平铺 1，最后一天 100 万
    const heatmap = buildHeatmap(
      series('2026-01-01', 28, (i) => (i === 27 ? 1_000_000 : i + 1)),
      'uncached'
    )
    const levels = new Set(
      heatmap.weeks
        .flat()
        .filter((cell) => cell.day && cell.day.tokens > 0)
        .map((cell) => cell.level)
    )
    expect(levels).toEqual(new Set([1, 2, 3, 4]))
  })

  it('全平的一段不会假装有深浅', () => {
    const heatmap = buildHeatmap(
      series('2026-01-01', 14, () => 5),
      'uncached'
    )
    const levels = new Set(
      heatmap.weeks
        .flat()
        .filter((cell) => cell.day)
        .map((cell) => cell.level)
    )
    expect(levels).toEqual(new Set([1]))
  })

  it('跟着选的指标走 —— 同一批天，看轮次和看 token 深浅不一样', () => {
    const days: UsageDay[] = [
      { date: '2026-01-01', tokens: 100, cacheRead: 0, turns: 0, changes: 0 },
      { date: '2026-01-02', tokens: 0, cacheRead: 0, turns: 3, changes: 0 }
    ]
    const byTokens = buildHeatmap(days, 'uncached')
      .weeks.flat()
      .filter((cell) => cell.day)
    const byTurns = buildHeatmap(days, 'turns')
      .weeks.flat()
      .filter((cell) => cell.day)
    expect([byTokens[0].level, byTokens[1].level]).toEqual([1, 0])
    expect([byTurns[0].level, byTurns[1].level]).toEqual([0, 1])
  })

  it('月份标不重复、不挨在一起', () => {
    const heatmap = buildHeatmap(
      series('2026-01-15', 364, () => 1),
      'uncached'
    )
    const columns = heatmap.months.map((month) => month.column)
    expect(new Set(columns).size).toBe(columns.length)
    for (let index = 1; index < columns.length; index += 1) {
      expect(columns[index] - columns[index - 1]).toBeGreaterThanOrEqual(3)
    }
  })

  it('一天数据都没有时给空图，不炸', () => {
    expect(buildHeatmap([], 'uncached')).toEqual({ weeks: [], months: [] })
  })

  it('指标取值三种都对得上', () => {
    const day: UsageDay = { date: '2026-01-01', tokens: 7, cacheRead: 0, turns: 5, changes: 3 }
    expect(metricValue(day, 'uncached')).toBe(7)
    expect(metricValue(day, 'turns')).toBe(5)
    expect(metricValue(day, 'changes')).toBe(3)
  })

  it('token 指标扣掉缓存命中 —— 混算的话图只反映缓存读了多少', () => {
    const day: UsageDay = {
      date: '2026-01-01',
      tokens: 1000,
      cacheRead: 900,
      turns: 1,
      changes: 0
    }
    expect(metricValue(day, 'uncached')).toBe(100)
  })

  it('缓存命中大于总数时给 0，不给负数 —— 界面上画不出负高度的柱子', () => {
    const day: UsageDay = { date: '2026-01-01', tokens: 10, cacheRead: 99, turns: 1, changes: 0 }
    expect(metricValue(day, 'uncached')).toBe(0)
  })
})

describe('派生指标', () => {
  function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
    return {
      tokens: 0,
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      toolCalls: 0,
      ...overrides
    }
  }

  it('命中率的分母是三项输入，不含输出 —— 输出从来不走缓存', () => {
    const rate = cacheHitRate(totals({ input: 10, output: 1000, cacheRead: 90, cacheWrite: 0 }))
    expect(rate).toBeCloseTo(0.9)
  })

  it('一点输入都没有时返回 null —— 「没数据」和「一次没命中」不是一回事', () => {
    expect(cacheHitRate(totals({ output: 500 }))).toBeNull()
  })

  it('平均值分母为 0 时返回 null，不给 NaN', () => {
    expect(average(100, 0)).toBeNull()
    expect(average(100, 4)).toBe(25)
  })
})

describe('格式化', () => {
  it('token 分节，读得出量级', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
  })

  it('null 给破折号，不假装是 0%', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(0.9821)).toBe('98.2%')
  })

  it('耗时按量级换单位，一秒以内保留毫秒', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(11)).toBe('11 ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(90_000)).toBe('1m 30s')
  })
})
