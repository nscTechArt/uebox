import { describe, expect, it } from 'vitest'

import type { AgentReviewFinding } from '@core/shared/agentReview'

import { buildSelfCheckPrompt, findRequestBefore } from './selfCheck'

/** 假的 t：把 key 和参数原样吐出来，断言不依赖具体文案 */
const t = (key: string, params?: Record<string, unknown>): string =>
  params && Object.keys(params).length > 0
    ? `${key}(${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')})`
    : key

const finding = (patch: Partial<AgentReviewFinding> = {}): AgentReviewFinding => ({
  target: '/Game/A/M_Wood',
  code: 'unsaved',
  severity: 'warning',
  ...patch
})

describe('buildSelfCheckPrompt', () => {
  it('把机器查出的每条问题都摆到模型面前', () => {
    const prompt = buildSelfCheckPrompt(
      {
        findings: [finding(), finding({ target: '/Game/A/BP_X', code: 'compile-error' })],
        checked: 2,
        engineChecked: true,
        request: '做个呼吸发光材质'
      },
      t
    )

    expect(prompt).toContain('/Game/A/M_Wood')
    expect(prompt).toContain('/Game/A/BP_X')
    expect(prompt).toContain('assistant.review.codes.compile-error')
    expect(prompt).toContain('foundHeader(count=2)')
  })

  /** 规矩那一段是这个功能的全部意义：没有它，自证就是让它自夸 */
  it('永远带着「不许凭记忆、不许顺手改」那段规矩', () => {
    const prompt = buildSelfCheckPrompt(
      { findings: [], checked: 3, engineChecked: true, request: '' },
      t
    )

    expect(prompt).toContain('assistant.selfCheck.prompt.rules')
  })

  it('机器没查出问题时也要自证 —— 那正是机器答不了的那一半', () => {
    const prompt = buildSelfCheckPrompt(
      { findings: [], checked: 3, engineChecked: true, request: '做个呼吸发光材质' },
      t
    )

    expect(prompt).toContain('cleanHeader(count=3)')
    expect(prompt).toContain('做个呼吸发光材质')
  })

  it('引擎没跑成时说清楚，别让模型把「机器没说话」读成「没问题」', () => {
    const prompt = buildSelfCheckPrompt(
      { findings: [], checked: 3, engineChecked: false, request: '' },
      t
    )

    expect(prompt).toContain('engineOfflineHeader')
    expect(prompt).not.toContain('cleanHeader')
  })

  it('取不到最初的要求就不写那一段 —— 编一个比不写更糟', () => {
    const prompt = buildSelfCheckPrompt(
      { findings: [finding()], checked: 1, engineChecked: true, request: '' },
      t
    )

    expect(prompt).not.toContain('assistant.selfCheck.prompt.request')
  })
})

describe('findRequestBefore', () => {
  const messages = [
    { id: 'u1', role: 'user', content: '先看看有什么材质' },
    { id: 'a1', role: 'assistant', content: '有三个' },
    { id: 'u2', role: 'user', content: '做个呼吸发光材质' },
    { id: 'a2', role: 'assistant', content: '做好了' }
  ]

  it('往前找最近的那句用户消息', () => {
    expect(findRequestBefore(messages, 'a2')).toBe('做个呼吸发光材质')
    expect(findRequestBefore(messages, 'a1')).toBe('先看看有什么材质')
  })

  it('多模态消息里把文字抠出来', () => {
    const withImage = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'image_url' as const, image_url: { url: 'data:...' } },
          { type: 'text' as const, text: '照着这张图做' }
        ]
      },
      { id: 'a1', role: 'assistant', content: '好' }
    ]

    expect(findRequestBefore(withImage as never, 'a1')).toBe('照着这张图做')
  })

  it('找不到就返回空串', () => {
    expect(findRequestBefore(messages, 'nope')).toBe('')
    expect(findRequestBefore([{ id: 'a1', role: 'assistant', content: '好' }], 'a1')).toBe('')
  })
})
