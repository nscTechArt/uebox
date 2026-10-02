/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { sanitizeTrayRecentSessions } from './recentSessions'

/**
 * IPC 边界上收到的「最近三条对话」要过一遍手：
 * 形状不对的不收，没有 id 的不收，超三条的截掉 ——
 * 收下来的东西会原样画进系统菜单。
 */
describe('最近会话净化', () => {
  it('正常三条原样过', () => {
    const input = [
      { id: 'a', title: '会话一' },
      { id: 'b', title: '会话二' }
    ]
    expect(sanitizeTrayRecentSessions(input)).toEqual(input)
  })

  it('不是数组一律清空', () => {
    expect(sanitizeTrayRecentSessions(undefined)).toEqual([])
    expect(sanitizeTrayRecentSessions('abc')).toEqual([])
    expect(sanitizeTrayRecentSessions({ id: 'a' })).toEqual([])
    expect(sanitizeTrayRecentSessions(null)).toEqual([])
  })

  it('没有 id 的丢掉 —— 点了也没法跳，收进来只是空白菜单项', () => {
    expect(
      sanitizeTrayRecentSessions([
        { id: '', title: '空 id' },
        { title: '没 id' },
        { id: 42, title: '数字 id' },
        'string item',
        null,
        { id: 'ok', title: '正常' }
      ])
    ).toEqual([{ id: 'ok', title: '正常' }])
  })

  it('title 不是字符串就当成空标题', () => {
    expect(sanitizeTrayRecentSessions([{ id: 'a', title: 5 }])).toEqual([{ id: 'a', title: '' }])
  })

  it('超过三条截断，截的是前三个之后的多余项', () => {
    const input = [
      { id: '1', title: '一' },
      { id: '2', title: '二' },
      { id: '3', title: '三' },
      { id: '4', title: '四' }
    ]
    expect(sanitizeTrayRecentSessions(input)).toEqual(input.slice(0, 3))
  })

  it('垃圾条目不占名额：滤掉之后才数三条', () => {
    const input = [
      { bad: true },
      { id: '1', title: '一' },
      { id: '2', title: '二' },
      { id: '3', title: '三' }
    ]
    expect(sanitizeTrayRecentSessions(input)).toHaveLength(3)
  })
})
