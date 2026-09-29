import { describe, expect, it } from 'vitest'

import { planSessionModel } from './sessionModel'

const settings = {
  providers: [
    {
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'chat' as const,
      protocol: 'openai-responses' as const,
      baseUrl: 'https://example.test/v1',
      apiKey: { kind: 'none' as const },
      models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.5' }]
    },
    {
      id: 'painter',
      displayName: 'Painter',
      kind: 'image' as const,
      protocol: 'openai-responses' as const,
      baseUrl: 'https://example.test/v1',
      apiKey: { kind: 'none' as const },
      models: [{ id: 'gpt-image-1' }]
    }
  ],
  roles: { agent: { providerId: 'openai', modelId: 'gpt-5.4', source: 'plan' as const } }
}

const five = { providerId: 'openai', modelId: 'gpt-5.5' }

describe('planSessionModel', () => {
  it('渲染层带下来的优先于执行记录', () => {
    const plan = planSessionModel(settings, five, { providerId: 'openai', modelId: 'gpt-5.4' })
    expect(plan).toEqual({ record: five, pin: five })
  })

  it('渲染层没带（续跑、后台任务）就用执行记录里那份', () => {
    expect(planSessionModel(settings, undefined, five)).toEqual({ record: five, pin: five })
  })

  it('第一轮按全局默认绑定，不抄全局绑定的归属标记', () => {
    const current = { providerId: 'openai', modelId: 'gpt-5.4' }
    expect(planSessionModel(settings, undefined, undefined)).toEqual({
      record: current,
      pin: current
    })
  })

  it('Agent 没单独绑时沿用 chat 角色', () => {
    const plan = planSessionModel({ ...settings, roles: { chat: five } }, undefined, undefined)
    expect(plan.pin).toEqual(five)
  })

  it('绑定的模型被删了：照记，但这一轮不钉，退回全局默认', () => {
    const gone = { providerId: 'openai', modelId: 'gpt-4' }
    expect(planSessionModel(settings, gone, undefined)).toEqual({ record: gone })
  })

  it('来源被删了或者不是对话类来源，同样不钉', () => {
    expect(planSessionModel(settings, { providerId: 'x', modelId: 'y' }, undefined).pin).toBe(
      undefined
    )
    expect(
      planSessionModel(settings, { providerId: 'painter', modelId: 'gpt-image-1' }, undefined).pin
    ).toBe(undefined)
  })

  it('什么都没配就什么都不给，交给内核去报「没配模型」', () => {
    expect(planSessionModel({ ...settings, roles: {} }, undefined, undefined)).toEqual({})
  })
})
