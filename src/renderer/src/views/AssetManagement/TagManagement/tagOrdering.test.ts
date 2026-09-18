import { describe, expect, it } from 'vitest'
import { anchorLetter, groupByAnchor, sortTags, usageOf } from './tagOrdering'
import type { Tag } from './types'

const tag = (id: number, name: string): Tag => ({ id, name })

describe('usageOf', () => {
  it('查不到用量按 0 算，而不是 undefined —— 界面上那一格要显示数字', () => {
    expect(usageOf(tag(1, 'A'), { 1: 7 })).toBe(7)
    expect(usageOf(tag(2, 'B'), { 1: 7 })).toBe(0)
    expect(usageOf({ name: '还没存盘' }, { 1: 7 })).toBe(0)
  })
})

describe('sortTags', () => {
  const tags = [tag(1, 'Metallic'), tag(2, 'AO'), tag(3, 'Diffuse')]

  it('按名称排序不改动入参数组', () => {
    const sorted = sortTags(tags, 'name', {})
    expect(sorted.map((x) => x.name)).toEqual(['AO', 'Diffuse', 'Metallic'])
    expect(tags.map((x) => x.name)).toEqual(['Metallic', 'AO', 'Diffuse'])
  })

  it('按用量是升序 —— 这一屏是用来清理的，没用过的要排最前', () => {
    const counts = { 1: 40, 2: 0, 3: 5 }
    expect(sortTags(tags, 'usage', counts).map((x) => x.name)).toEqual([
      'AO',
      'Diffuse',
      'Metallic'
    ])
  })

  it('用量相同时退回按名称，顺序才是稳定的', () => {
    const same = [tag(1, 'Zeta'), tag(2, 'Alpha'), tag(3, 'Mid')]
    expect(sortTags(same, 'usage', { 1: 3, 2: 3, 3: 3 }).map((x) => x.name)).toEqual([
      'Alpha',
      'Mid',
      'Zeta'
    ])
  })
})

describe('anchorLetter', () => {
  it('中文取拼音首字母', () => {
    expect(anchorLetter('测试')).toBe('C')
    expect(anchorLetter('模型')).toBe('M')
  })

  it('英文取首字母并大写', () => {
    expect(anchorLetter('diffuse')).toBe('D')
  })

  it('数字、符号、空名一律归到 #', () => {
    expect(anchorLetter('404')).toBe('#')
    expect(anchorLetter('_internal')).toBe('#')
    expect(anchorLetter('')).toBe('#')
  })
})

describe('groupByAnchor', () => {
  it('按首字母分行，# 永远垫底', () => {
    const sorted = sortTags(
      [tag(1, 'AO'), tag(2, '404'), tag(3, 'Blueprint'), tag(4, 'Albedo')],
      'name',
      {}
    )
    const rows = groupByAnchor(sorted)
    expect(rows.map((r) => r.letter)).toEqual(['A', 'B', '#'])
    // localeCompare 不按 ASCII 比大小写：Albedo 排在 AO 前面（l < o），
    // 这正是给人看的列表该有的顺序，别改成 <
    expect(rows[0].tags.map((x) => x.name)).toEqual(['Albedo', 'AO'])
  })

  it('保留传入的顺序 —— 分行不该再排一次序', () => {
    const rows = groupByAnchor([tag(1, 'Zebra'), tag(2, 'Zulu'), tag(3, 'Zach')])
    expect(rows).toHaveLength(1)
    expect(rows[0].tags.map((x) => x.name)).toEqual(['Zebra', 'Zulu', 'Zach'])
  })

  it('空列表不产生任何行', () => {
    expect(groupByAnchor([])).toEqual([])
  })
})
