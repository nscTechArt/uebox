import { describe, expect, it } from 'vitest'

import { noteToMentionSource, parseMentionQuery, stripMentionQuery } from './mentionQuery'

describe('parseMentionQuery', () => {
  it('刚按下 @ 时是空串，不是 null —— 弹层要开，只是还没东西搜', () => {
    expect(parseMentionQuery('帮我看看 @')).toBe('')
  })

  it('取 @ 后面已经打的关键词', () => {
    expect(parseMentionQuery('帮我看看 @材质')).toBe('材质')
  })

  it('没有 @ 返回 null', () => {
    expect(parseMentionQuery('帮我看看材质')).toBeNull()
    expect(parseMentionQuery('')).toBeNull()
  })

  it('@ 后面出现空格就当这次提及结束了', () => {
    // 否则一个 @ 会让弹层一直挂着关不掉
    expect(parseMentionQuery('@材质 是怎么做的')).toBeNull()
    expect(parseMentionQuery('@ 材质')).toBeNull()
  })

  it('换行也算空白', () => {
    expect(parseMentionQuery('@材质\n再问一句')).toBeNull()
  })

  it('多个 @ 时认最后一个', () => {
    expect(parseMentionQuery('@已选 的东西 @雪地')).toBe('雪地')
  })

  it('@ 在句子中间也认', () => {
    expect(parseMentionQuery('对比一下@Sequences')).toBe('Sequences')
  })
})

describe('stripMentionQuery', () => {
  it('把 @ 连同关键词一起删掉', () => {
    expect(stripMentionQuery('帮我看看 @材质')).toBe('帮我看看 ')
  })

  it('只有光秃秃的 @ 也删', () => {
    expect(stripMentionQuery('帮我看看 @')).toBe('帮我看看 ')
  })

  it('这次提及已经结束的就不动', () => {
    expect(stripMentionQuery('@材质 是怎么做的')).toBe('@材质 是怎么做的')
  })

  it('没有 @ 原样返回', () => {
    expect(stripMentionQuery('帮我看看材质')).toBe('帮我看看材质')
  })

  it('多个 @ 时只删最后一次', () => {
    expect(stripMentionQuery('@已选 的东西 @雪')).toBe('@已选 的东西 ')
  })
})

describe('noteToMentionSource', () => {
  it('id 加 note: 前缀，避免和知识库来源撞号', () => {
    // 两种东西现在混在同一个已选集合里，id 撞了就会串台
    expect(noteToMentionSource({ id: 12, title: '雪地材质 · 说明' }, '新笔记')).toEqual({
      id: 'note:12',
      title: '雪地材质 · 说明',
      type: 'note'
    })
  })

  it('没标题的笔记用兜底文案，不显示空白条', () => {
    expect(noteToMentionSource({ id: 3, title: '   ' }, '新笔记').title).toBe('新笔记')
    expect(noteToMentionSource({ id: 4 }, '新笔记').title).toBe('新笔记')
  })

  it('type 固定是 note —— 下游靠它决定要不要标成「笔记《…》」', () => {
    expect(noteToMentionSource({ id: 5, title: 'x' }, '新笔记').type).toBe('note')
  })
})
