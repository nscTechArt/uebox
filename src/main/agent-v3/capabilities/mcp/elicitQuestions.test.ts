import { describe, expect, it } from 'vitest'

import type { AskUserQuestion } from '../../host/questionChannel'
import { elicitQuestions, fromElicitation, toElicitation } from './elicitQuestions'

const QUESTIONS: AskUserQuestion[] = [
  {
    header: '材质',
    question: '用哪种材质？',
    multiSelect: false,
    options: [
      { label: '金属', description: '反光强' },
      { label: '木头', description: '暖色' }
    ]
  },
  {
    header: '平台',
    question: '要打哪些平台？',
    multiSelect: true,
    options: [
      { label: 'PC', description: '' },
      { label: '主机', description: '' }
    ]
  }
]

describe('ask_user 走 MCP elicitation', () => {
  it('单选成字符串枚举、多选成枚举数组，选项说明写进字段描述', () => {
    const { requestedSchema } = toElicitation(QUESTIONS)
    expect(requestedSchema.properties.q1).toMatchObject({
      type: 'string',
      title: '材质',
      enum: ['金属', '木头']
    })
    expect(requestedSchema.properties.q1.description).toContain('金属: 反光强')
    expect(requestedSchema.properties.q2).toMatchObject({
      type: 'array',
      items: { type: 'string', enum: ['PC', '主机'] }
    })
  })

  // 和盒子界面卡片交回来的形状一样：同序、没答的是空串
  it('回答按提问顺序排好，多选拼成一行，没答的是空串', () => {
    expect(fromElicitation(QUESTIONS, { q2: ['PC', '主机'] })).toEqual(['', 'PC, 主机'])
  })

  // decline 和 cancel 必须分开：前者是「你自己定」，后者是「先停一停」
  it('拒绝和取消原样透传，不当成回答', async () => {
    const declined = elicitQuestions(async () => ({ action: 'decline' }))
    expect(await declined({ questions: QUESTIONS })).toEqual({ action: 'decline' })

    const answered = elicitQuestions(async () => ({ action: 'accept', content: { q1: '木头' } }))
    expect(await answered({ questions: QUESTIONS })).toEqual({
      action: 'accept',
      answers: ['木头', '']
    })
  })
})
