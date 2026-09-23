/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./planState', () => ({
  readPlanState: async () => ({ unauthorized: true }),
  updatePlanState: async () => undefined
}))

const { CreatorPlanCallError, isDailyLimitResponse, planCallError, planErrorCodeOf } = await import(
  './callError'
)

describe('planCallError', () => {
  it('402 / 403 要状态码和错误码都对得上；401 只看状态码', () => {
    expect(planCallError(402, { error: { code: 'quota_exhausted' } })?.planError).toBe(
      'quota_exhausted'
    )
    expect(planCallError(402, '{"error":{"code":"subscription_inactive"}}')?.planError).toBe(
      'subscription_inactive'
    )
    expect(planCallError(403, { error: { code: 'role_not_in_plan' } })?.planError).toBe(
      'role_not_in_plan'
    )
    expect(planCallError(401, 'not json')?.planError).toBe('unauthorized')
    // 错误码和状态码对不上、或者是别的错误：不是套餐那几种，调用方照走原来的报错
    expect(planCallError(403, { error: { code: 'quota_exhausted' } })).toBeNull()
    expect(planCallError(400, { error: { code: 'invalid_request' } })).toBeNull()
    expect(planCallError(503, null)).toBeNull()
  })

  it('文案带「设置 → 模型」（AI 创作面板见到它才原样透出），并说别重试', () => {
    const error = planCallError(402, { error: { code: 'quota_exhausted' } })!
    expect(error).toBeInstanceOf(CreatorPlanCallError)
    expect(error.message).toContain('设置 → 模型')
    expect(error.message).toContain('重试也一样失败')
    expect(error.status).toBe(402)
  })

  it('错误码从 JSON 或对象里取，取不到回 undefined', () => {
    expect(planErrorCodeOf({ error: { code: 'x' } })).toBe('x')
    expect(planErrorCodeOf('<html>')).toBeUndefined()
    expect(planErrorCodeOf(null)).toBeUndefined()
  })
})

describe('每日上限 429 daily_limit_reached', () => {
  const headers = (values: Record<string, string>): Headers => new Headers(values)

  it('状态码和错误码都对得上才算；别的 429 是限流，不归这里', () => {
    expect(planCallError(429, { error: { code: 'daily_limit_reached' } })?.planError).toBe(
      'daily_limit_reached'
    )
    expect(planCallError(429, { error: { code: 'rate_limited' } })).toBeNull()
    expect(planCallError(429, null)).toBeNull()
    expect(planCallError(402, { error: { code: 'daily_limit_reached' } })).toBeNull()
  })

  it('恢复时间取 X-Uebox-Daily-Reset；没给就按下一个 00:00 UTC 算，文案说别重试', () => {
    const withHeader = planCallError(
      429,
      { error: { code: 'daily_limit_reached' } },
      headers({ 'X-Uebox-Daily-Reset': '2026-09-24T00:00:00Z' })
    )!
    expect(withHeader.detail.dailyResetAt).toBe('2026-09-24T00:00:00Z')
    expect(withHeader.message).toMatch(/今天的额度用完了，.+ 恢复/)
    expect(withHeader.message).toContain('重试也一样失败')
    expect(withHeader.message).toContain('设置 → 模型')

    const without = planCallError(429, '{"error":{"code":"daily_limit_reached"}}')!
    const reset = new Date(without.detail.dailyResetAt!)
    expect(reset.getUTCHours()).toBe(0)
    expect(reset.getUTCMinutes()).toBe(0)
    expect(reset.getTime()).toBeGreaterThan(Date.now())
    expect(reset.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60_000)
  })

  it('isDailyLimitResponse 认响应头或错误码，不读走响应体', async () => {
    const byHeader = new Response('{}', {
      status: 429,
      headers: { 'X-Uebox-Daily-Reset': '2026-09-24T00:00:00Z' }
    })
    expect(await isDailyLimitResponse(byHeader)).toBe(true)
    const byBody = new Response('{"error":{"code":"daily_limit_reached"}}', { status: 429 })
    expect(await isDailyLimitResponse(byBody)).toBe(true)
    expect(await byBody.text()).toContain('daily_limit_reached')
    const rateLimited = new Response('{"error":{"code":"rate_limited"}}', { status: 429 })
    expect(await isDailyLimitResponse(rateLimited)).toBe(false)
    expect(await isDailyLimitResponse(new Response('{}', { status: 402 }))).toBe(false)
  })
})

describe('402 quota_exhausted 带压低原因', () => {
  it('X-Uebox-Quota-Limited-By 给了就把原因说在前面', () => {
    const body = { error: { code: 'quota_exhausted' } }
    const pastDue = planCallError(
      402,
      body,
      new Headers({ 'X-Uebox-Quota-Limited-By': 'past_due' })
    )!
    expect(pastDue.detail.limitedBy).toBe('past_due')
    expect(pastDue.message).toContain('扣款失败')
    expect(pastDue.message).toContain('设置 → 模型')

    const cooldown = planCallError(
      402,
      body,
      new Headers({
        'X-Uebox-Quota-Limited-By': 'new_account',
        'X-Uebox-Quota-Reset': '2026-09-26T08:00:00Z'
      })
    )!
    expect(cooldown.detail).toEqual({
      limitedBy: 'new_account',
      quotaResetAt: '2026-09-26T08:00:00Z'
    })
    expect(cooldown.message).toMatch(/新账户.*72 小时内限额，.+ 解除/)

    expect(
      planCallError(402, body, new Headers({ 'X-Uebox-Quota-Limited-By': 'plan_change' }))!.message
    ).toContain('中途升档')
    // 原因代码不认识：照旧的文案
    const unknown = planCallError(402, body, new Headers({ 'X-Uebox-Quota-Limited-By': 'x' }))!
    expect(unknown.detail).toEqual({})
    expect(unknown.message).toContain('升级，或等额度重置')
  })
})
