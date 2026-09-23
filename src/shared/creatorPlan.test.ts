import { describe, expect, it } from 'vitest'
import {
  creatorPlanChatError,
  formatPlanResetTime,
  nextUtcMidnight,
  planUsage,
  type CreatorPlanQuota
} from './creatorPlan'

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

describe('planUsage', () => {
  const now = Date.UTC(2026, 8, 24, 10)

  it('有 credits 只看它；向下取整，没真用完不显示 100', () => {
    expect(
      planUsage([
        { key: 'text_tokens', limit: 10, used: 10 },
        { key: 'credits', limit: 1000, used: 999 }
      ])
    ).toEqual({ usedPercent: 99, dailyExhaustedUntil: null })
  })

  it('每日上限用满：给重置时刻；没给就按下一个 00:00 UTC', () => {
    const daily = (resetsAt: string | null): CreatorPlanQuota[] => [
      { key: 'credits', limit: 1000, used: 230, daily: { limit: 200, used: 200, resetsAt } }
    ]
    expect(planUsage(daily('2026-09-25T00:00:00Z'), now)).toEqual({
      usedPercent: 23,
      dailyExhaustedUntil: '2026-09-25T00:00:00Z'
    })
    expect(planUsage(daily(null), now)?.dailyExhaustedUntil).toBe('2026-09-25T00:00:00.000Z')
  })

  it('旧服务端的分项额度：取用得最多的那项；上限为 0 的（暂停）跳过；用超了封顶 100', () => {
    expect(
      planUsage([
        { key: 'text_tokens', limit: 1000, used: 100 },
        { key: 'images', limit: 10, used: 5 },
        { key: 'video_seconds', limit: 0, used: 0 }
      ])?.usedPercent
    ).toBe(50)
    expect(planUsage([{ key: 'images', limit: 10, used: 12 }])?.usedPercent).toBe(100)
    expect(planUsage([{ key: 'images', limit: 0, used: 0 }])?.usedPercent).toBe(100)
  })

  it('没有额度（订阅失效时 quotas 为空）：null', () => {
    expect(planUsage([])).toBeNull()
  })
})
