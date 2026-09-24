import { describe, expect, it } from 'vitest'

import {
  describeFailures,
  hasPartialFailure,
  partialHeadline,
  withPartialHeadline
} from './partialResult'

describe('partialResult', () => {
  it('全部成功时不加任何东西', () => {
    expect(hasPartialFailure({ succeeded: 3, failed: 0 })).toBe(false)
    expect(partialHeadline({ succeeded: 3, failed: 0 })).toBe('')
    expect(withPartialHeadline('成功创建 3 个 Actor', { succeeded: 3, failed: 0 })).toBe(
      '成功创建 3 个 Actor'
    )
  })

  it('有失败时第一句先说部分完成，而不是成功', () => {
    const text = withPartialHeadline(
      '创建了 3 个 Actor',
      { succeeded: 3, failed: 2, unit: '个 Actor' },
      [{ item: '#2', reason: 'class not found' }, { item: '#4' }]
    )
    const [first] = text.split('\n')
    expect(first).toBe('⚠️ 部分完成：3 个 Actor 成功 / 2 个 Actor 失败。')
    expect(text).toContain('- #2：class not found')
    expect(text).toContain('- #4：未给原因')
  })

  it('只有跳过也算部分完成', () => {
    expect(partialHeadline({ succeeded: 1, failed: 0, skipped: 2 })).toBe(
      '⚠️ 部分完成：1 项成功 / 0 项失败 / 2 项跳过。'
    )
  })

  it('失败条目太多时折叠', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ item: `#${i}`, reason: 'x' }))
    const text = describeFailures(many)
    expect(text).toContain('- #7：x')
    expect(text).not.toContain('- #8：x')
    expect(text).toContain('还有 4 条')
  })
})
