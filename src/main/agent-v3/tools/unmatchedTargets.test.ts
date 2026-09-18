/**
 * @vitest-environment node
 *
 * 「点名了但没找到」这件事必须出现在 message 里。
 *
 * 钉住的是一类沉默：插件以前把对不上的 names 静默丢掉，响应里只有认出来的那几个，
 * 于是删 7 个只删了 6 个、镜头只框住 6 个，而调用方读到的是一个没有异常的成功。
 */

import { describe, expect, it } from 'vitest'

import { describeUnmatchedTargets, unmatchedTargetFields } from './unmatchedTargets'

describe('describeUnmatchedTargets', () => {
  it('没漏掉任何目标时一个字都不加', () => {
    expect(describeUnmatchedTargets({})).toBe('')
    expect(describeUnmatchedTargets({ unmatched_targets: [] })).toBe('')
    expect(describeUnmatchedTargets(undefined)).toBe('')
    // 老插件不回这两个字段，行为要和以前一样
    expect(describeUnmatchedTargets(null)).toBe('')
  })

  it('把没找到的名字列出来，并说清这一步没对它们生效', () => {
    const text = describeUnmatchedTargets({
      unmatched_targets: ['SM_Wall_04'],
      unmatched_count: 1
    })

    expect(text).toContain('SM_Wall_04')
    expect(text).toContain('没找到')
    expect(text).toContain('没有')
    // 下一步要可执行：告诉它名字认的是 ActorLabel，别原样重试
    expect(text).toContain('ActorLabel')
    expect(text).toContain('name_pattern')
  })

  it('名字太多时折叠，但总数照实说', () => {
    const names = Array.from({ length: 12 }, (_, i) => `SM_Crate_${i}`)
    const text = describeUnmatchedTargets({ unmatched_targets: names })

    expect(text).toContain('12 个目标')
    expect(text).toContain('SM_Crate_0')
    expect(text).toContain('还有 4 个')
    expect(text).not.toContain('SM_Crate_11')
  })

  it('字段脏了也不崩：非字符串项直接忽略', () => {
    const text = describeUnmatchedTargets({
      unmatched_targets: ['A', '', null as unknown as string, 'B']
    })

    expect(text).toContain('2 个目标')
    expect(text).toContain('A、B')
  })
})

describe('unmatchedTargetFields', () => {
  it('没有漏掉的目标就不产出字段，正常返回体保持原样', () => {
    expect(unmatchedTargetFields({ unmatched_targets: [] })).toEqual({})
    expect(unmatchedTargetFields(undefined)).toEqual({})
  })

  it('count 按**清洗后**的条数算，不照抄插件给的数', () => {
    const fields = unmatchedTargetFields({
      unmatched_targets: ['A', '' as string],
      unmatched_count: 2
    })

    expect(fields).toEqual({ unmatched_targets: ['A'], unmatched_count: 1 })
  })
})
