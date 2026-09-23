import { describe, expect, it } from 'vitest'
import { creatorPlanChatError, formatPlanResetTime, nextUtcMidnight } from './creatorPlan'

const words = {
  today: (time: string) => `今天 ${time}`,
  tomorrow: (time: string) => `明天 ${time}`
}

const clock = (at: Date): string =>
  `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

describe('nextUtcMidnight', () => {
  it('下一个 00:00 UTC；正好零点时是第二天的零点', () => {
    expect(nextUtcMidnight(Date.UTC(2026, 8, 23, 15, 30))).toBe('2026-09-24T00:00:00.000Z')
    expect(nextUtcMidnight(Date.UTC(2026, 8, 30, 23, 59))).toBe('2026-10-01T00:00:00.000Z')
    expect(nextUtcMidnight(Date.UTC(2026, 8, 24))).toBe('2026-09-25T00:00:00.000Z')
  })
})

describe('formatPlanResetTime', () => {
  it('按本机时区说今天 / 明天几点；再远的带日期', () => {
    const now = new Date(2026, 8, 23, 10, 0)
    const later = new Date(2026, 8, 23, 17, 5)
    const tomorrow = new Date(2026, 8, 24, 8, 0)
    expect(formatPlanResetTime(later.toISOString(), 'zh-CN', words, now)).toBe(
      `今天 ${clock(later)}`
    )
    expect(formatPlanResetTime(tomorrow.toISOString(), 'zh-CN', words, now)).toBe(
      `明天 ${clock(tomorrow)}`
    )
    const far = formatPlanResetTime(new Date(2026, 8, 27, 8, 0).toISOString(), 'zh-CN', words, now)
    expect(far).not.toContain('今天')
    expect(far).not.toContain('明天')
    expect(far).toContain('27')
  })

  it('认不出的时间原样返回', () => {
    expect(formatPlanResetTime('not a date', 'zh-CN', words)).toBe('not a date')
  })
})

describe('creatorPlanChatError', () => {
  it('429 只有 daily_limit_reached 算套餐错误；限流不算', () => {
    expect(creatorPlanChatError(429, 'daily_limit_reached')).toBe('daily_limit_reached')
    expect(creatorPlanChatError(429, 'rate_limited')).toBeNull()
    expect(creatorPlanChatError(429, undefined)).toBeNull()
  })
})
