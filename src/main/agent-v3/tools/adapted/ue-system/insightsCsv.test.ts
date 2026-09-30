/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { parseGenericCsv } from './insightsCsv'

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
