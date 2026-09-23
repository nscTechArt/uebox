/**
 * @vitest-environment node
 *
 * 查询切词。OR 表达式、全中表达式、JS 侧比对共用同一份切词 —— 各写一份的话，
 * 只认字母数字的那份在查「马」时会拼出空的 AND 表达式，FTS5 当场报语法错。
 */

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import {
  buildFtsAllTermsQuery,
  buildFtsMatchQuery,
  buildFtsTerms,
  prepareIndexText,
  textMatchesTerm
} from './ftsText'

describe('buildFtsTerms', () => {
  it('英文小写加前缀，中文拆成逐字短语', () => {
    expect(buildFtsTerms('SM_Chair 椅子')).toEqual([
      { expr: '"sm"*', text: 'sm', cjk: false },
      { expr: '"chair"*', text: 'chair', cjk: false },
      { expr: '"椅 子"', text: '椅子', cjk: true }
    ])
  })

  it('全是标点时没有词', () => {
    expect(buildFtsTerms('!!! ***')).toEqual([])
    expect(buildFtsAllTermsQuery('!!!')).toBeNull()
  })

  it('OR 表达式和原来一样', () => {
    expect(buildFtsMatchQuery('pine tree')).toBe('"pine"* OR "tree"*')
  })
})

describe('buildFtsAllTermsQuery', () => {
  it('限定四列、词之间 AND', () => {
    expect(buildFtsAllTermsQuery('police car')).toBe(
      '{name tags folder type} : ("police"* AND "car"*)'
    )
  })

  it('纯中文、中英混合在真 FTS5 上都能执行，而且只认四列', () => {
    const db = new Database(':memory:')
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(name, tags, folder, type, note, path, tokenize = 'unicode61 remove_diacritics 2')"
    )
    const add = (rowid: number, name: string, note = ''): void => {
      db.prepare(
        'INSERT INTO t (rowid, name, tags, folder, type, note, path) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(rowid, prepareIndexText(name), '', '', '', prepareIndexText(note), '')
    }
    add(1, 'SM_木头椅子')
    add(2, 'villa.png', '马 SM')
    const match = (q: string): number[] =>
      (
        db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(buildFtsAllTermsQuery(q)) as Array<{
          rowid: number
        }>
      ).map((r) => r.rowid)

    expect(match('SM 椅子')).toEqual([1])
    // 只在 note 里出现的不算全中
    expect(match('马')).toEqual([])
  })
})

describe('textMatchesTerm：和 FTS 的命中口径一致', () => {
  const [car] = buildFtsTerms('car')
  const [chair] = buildFtsTerms('椅子')

  it('英文按词前缀：car 命中 Cars、SM_Car_01，不命中 Scarf', () => {
    expect(textMatchesTerm('SM_Car_01', car!)).toBe(true)
    expect(textMatchesTerm('Cars', car!)).toBe(true)
    expect(textMatchesTerm('SM_Scarf_01', car!)).toBe(false)
  })

  it('中文按连续出现', () => {
    expect(textMatchesTerm('木头椅子', chair!)).toBe(true)
    expect(textMatchesTerm('椅背子', chair!)).toBe(false)
  })

  it('空值不命中', () => {
    expect(textMatchesTerm(null, car!)).toBe(false)
  })
})
