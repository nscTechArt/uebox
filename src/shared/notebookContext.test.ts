import { describe, expect, it } from 'vitest'
import {
  SUMMARY_FALLBACK_HEAD_CHARS,
  contextCharsForSource,
  normalizeNotebookContextLevel,
  packSourcesWithinBudget,
  resolveContextContent,
  summarizeContextBudget,
  type NotebookContextSource
} from './notebookContext'

function source(overrides: Partial<NotebookContextSource> = {}): NotebookContextSource {
  return { contextLevel: 'full', content: '一段正文', ...overrides }
}

describe('normalizeNotebookContextLevel', () => {
  it('认不出来的值一律当全文', () => {
    expect(normalizeNotebookContextLevel(null)).toBe('full')
    expect(normalizeNotebookContextLevel(undefined)).toBe('full')
    expect(normalizeNotebookContextLevel('nonsense')).toBe('full')
    expect(normalizeNotebookContextLevel(1)).toBe('full')
  })

  it('三个合法档位原样返回', () => {
    expect(normalizeNotebookContextLevel('full')).toBe('full')
    expect(normalizeNotebookContextLevel('summary')).toBe('summary')
    expect(normalizeNotebookContextLevel('excluded')).toBe('excluded')
  })
})

describe('resolveContextContent', () => {
  it('不进上下文的来源什么都不送', () => {
    expect(resolveContextContent(source({ contextLevel: 'excluded' }))).toBeNull()
  })

  it('还在加载 / 加载失败 / 空内容的来源都送不出去', () => {
    expect(resolveContextContent(source({ loading: true }))).toBeNull()
    expect(resolveContextContent(source({ error: '读取失败' }))).toBeNull()
    expect(resolveContextContent(source({ content: '   ' }))).toBeNull()
  })

  it('全文档原样交出去，不在这里截 —— 装不下由装箱那一步整条丢掉', () => {
    const resolved = resolveContextContent(source({ content: 'x'.repeat(60000) }))
    expect(resolved?.text.length).toBe(60000)
    expect(resolved?.truncated).toBe(false)
  })

  it('超长来源不会截到正好等于预算，然后把其余来源全挤掉', () => {
    const budget = summarizeContextBudget(
      [
        { title: '巨无霸', contextLevel: 'full', content: 'x'.repeat(60000) },
        { title: '小笔记', contextLevel: 'full', content: '短' }
      ],
      20000
    )

    // 巨无霸整条送不进去，小笔记照样能进
    expect(budget.droppedTitles).toEqual(['巨无霸'])
    expect(budget.includedCount).toBe(1)
  })

  it('摘要档有摘要就送摘要', () => {
    const resolved = resolveContextContent(
      source({
        contextLevel: 'summary',
        content: 'x'.repeat(5000),
        summaryContent: 'y'.repeat(500),
        summaryStatus: 'completed'
      })
    )
    expect(resolved?.usedSummary).toBe(true)
    expect(resolved?.text).toBe('y'.repeat(500))
  })

  it('摘要太短当没有 —— 模型有时只回一句寒暄', () => {
    const resolved = resolveContextContent(
      source({
        contextLevel: 'summary',
        content: 'x'.repeat(5000),
        summaryContent: '好的',
        summaryStatus: 'completed'
      })
    )
    expect(resolved?.usedSummary).toBe(false)
    expect(resolved?.summaryMissing).toBe(true)
  })

  it('摘要还没生成时退回正文开头，绝不悄悄回落到全文', () => {
    const resolved = resolveContextContent(
      source({ contextLevel: 'summary', content: 'x'.repeat(50000) })
    )
    expect(resolved?.summaryMissing).toBe(true)
    expect(resolved?.text.length).toBe(SUMMARY_FALLBACK_HEAD_CHARS)
  })
})

describe('contextCharsForSource', () => {
  it('不进上下文就是 0 字', () => {
    expect(contextCharsForSource(source({ contextLevel: 'excluded' }))).toBe(0)
  })

  it('摘要档按摘要长度算，不按正文', () => {
    const chars = contextCharsForSource(
      source({
        contextLevel: 'summary',
        content: 'x'.repeat(9000),
        summaryContent: 'y'.repeat(300),
        summaryStatus: 'completed'
      })
    )
    expect(chars).toBe(300)
  })
})

describe('packSourcesWithinBudget', () => {
  it('装不下的整条丢掉，不塞半条', () => {
    const { included, dropped, usedChars } = packSourcesWithinBudget(
      [
        { title: '甲', content: 'a'.repeat(6000) },
        { title: '乙', content: 'b'.repeat(6000) }
      ],
      10000
    )

    expect(included.map((item) => item.title)).toEqual(['甲'])
    expect(dropped.map((item) => item.title)).toEqual(['乙'])
    expect(usedChars).toBe(6000)
  })

  it('前面那条超大不该把后面装得下的连累掉', () => {
    const { included, dropped } = packSourcesWithinBudget(
      [
        { title: '巨无霸', content: 'a'.repeat(50000) },
        { title: '小条', content: '短' }
      ],
      10000
    )

    expect(included.map((item) => item.title)).toEqual(['小条'])
    expect(dropped.map((item) => item.title)).toEqual(['巨无霸'])
  })

  it('都装得下就一条不丢', () => {
    const { included, dropped } = packSourcesWithinBudget([
      { title: '甲', content: '短' },
      { title: '乙', content: '也短' }
    ])
    expect(included).toHaveLength(2)
    expect(dropped).toHaveLength(0)
  })
})

describe('summarizeContextBudget', () => {
  it('只算真会送出去的那些', () => {
    const budget = summarizeContextBudget([
      { title: '进', contextLevel: 'full', content: 'x'.repeat(100) },
      { title: '不进', contextLevel: 'excluded', content: 'x'.repeat(9999) },
      { title: '加载中', contextLevel: 'full', content: 'x'.repeat(9999), loading: true }
    ])

    expect(budget.includedCount).toBe(1)
    expect(budget.totalChars).toBe(100)
    expect(budget.overBudget).toBe(false)
  })

  it('超额时点名是哪几条送不进去', () => {
    const budget = summarizeContextBudget(
      [
        { title: '甲', contextLevel: 'full', content: 'a'.repeat(6000) },
        { title: '乙', contextLevel: 'full', content: 'b'.repeat(6000) }
      ],
      10000
    )

    expect(budget.overBudget).toBe(true)
    expect(budget.droppedTitles).toEqual(['乙'])
  })

  it('预算变大之后同一批来源全塞得下 —— 上限跟着模型窗口走', () => {
    const sources = [
      { title: '甲', contextLevel: 'full' as const, content: 'a'.repeat(6000) },
      { title: '乙', contextLevel: 'full' as const, content: 'b'.repeat(6000) }
    ]

    expect(summarizeContextBudget(sources, 10000).overBudget).toBe(true)
    expect(summarizeContextBudget(sources, 100000).overBudget).toBe(false)
    expect(summarizeContextBudget(sources, 100000).maxChars).toBe(100000)
  })

  it('数出摘要还没生成的来源，界面要把这件事说出来', () => {
    const budget = summarizeContextBudget([
      { title: '甲', contextLevel: 'summary', content: 'a'.repeat(5000) }
    ])
    expect(budget.summaryMissingCount).toBe(1)
  })
})
