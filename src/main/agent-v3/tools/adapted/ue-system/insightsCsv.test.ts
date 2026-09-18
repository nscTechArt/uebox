/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import {
  parseGenericCsv,
  pickColumn,
  rankRows,
  TIMER_NAME_PATTERNS,
  TIMER_VALUE_PATTERNS
} from './insightsCsv'

describe('parseGenericCsv', () => {
  it('第一行是表头，其余是数据行', () => {
    const table = parseGenericCsv('Name,Count,TotalInclusiveTime\nFoo,3,12.5\nBar,1,4.0\n')

    expect(table!.columns).toEqual(['Name', 'Count', 'TotalInclusiveTime'])
    expect(table!.rows).toHaveLength(2)
    expect(table!.rows[0]).toEqual({ Name: 'Foo', Count: '3', TotalInclusiveTime: '12.5' })
  })

  it('列数对不上的行算 malformed，不硬凑数据', () => {
    const table = parseGenericCsv('Name,Value\nFoo,1\nBroken,too,many,cells\nBar,2\n')

    expect(table!.rows).toHaveLength(2)
    expect(table!.malformedRowCount).toBe(1)
  })

  it('只有表头没有数据行时返回空 rows，不是 null', () => {
    const table = parseGenericCsv('Name,Value\n')

    expect(table).not.toBeNull()
    expect(table!.rows).toHaveLength(0)
  })

  it('完全空文件返回 null', () => {
    expect(parseGenericCsv('')).toBeNull()
  })
})

describe('pickColumn', () => {
  it('按模式优先级找列——更精确的模式排在前面', () => {
    const columns = ['EventName', 'Count', 'InclusiveTimeMs', 'TotalIncl(ms)']

    expect(pickColumn(columns, TIMER_NAME_PATTERNS)).toBe('EventName')
    expect(pickColumn(columns, TIMER_VALUE_PATTERNS)).toBe('TotalIncl(ms)')
  })

  it('一个都没匹配上时返回 undefined，不猜', () => {
    expect(pickColumn(['Foo', 'Bar'], TIMER_VALUE_PATTERNS)).toBeUndefined()
  })
})

describe('rankRows', () => {
  const table = parseGenericCsv('Name,Total\nA,10\nB,30\nC,20\n')!

  it('按识别出的总计列降序排', () => {
    const { sortedBy, topEntries } = rankRows(table, 'Total', 10)

    expect(sortedBy).toBe('Total')
    expect(topEntries.map((r) => r.Name)).toEqual(['B', 'C', 'A'])
  })

  it('识别不出总计列时原样截断，不假装排过序', () => {
    const { sortedBy, topEntries } = rankRows(table, undefined, 2)

    expect(sortedBy).toBeUndefined()
    expect(topEntries).toHaveLength(2)
    expect(topEntries[0]!.Name).toBe('A') // 原始顺序，没有被重排
  })

  it('尊重 limit', () => {
    const { topEntries } = rankRows(table, 'Total', 2)
    expect(topEntries).toHaveLength(2)
  })
})
