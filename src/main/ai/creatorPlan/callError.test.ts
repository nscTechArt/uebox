/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./planState', () => ({
  readPlanState: async () => ({ unauthorized: true }),
  updatePlanState: async () => undefined
}))

const { CreatorPlanCallError, planCallError, planErrorCodeOf } = await import('./callError')

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
