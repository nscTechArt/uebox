import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiAPI, parseFollowUpSuggestions } from './ai'

const chatCompletion = vi.fn()

beforeEach(() => {
  chatCompletion.mockReset()
  Object.assign(window.api, { ai: { chatCompletion } })
})

describe('parseFollowUpSuggestions', () => {
  it('解析 JSON 代码块并去重、限制为三条', () => {
    expect(
      parseFollowUpSuggestions(
        '```json\n{"followUps":["继续展开", "继续展开", "给个示例", "如何验收"]}\n```'
      )
    ).toEqual(['继续展开', '给个示例', '如何验收'])
  })

  it('兼容不支持结构化输出的模型返回的编号列表', () => {
    expect(
      parseFollowUpSuggestions('可以继续问：\n1. 给个具体示例\n2、有哪些风险？\n- 如何验收？')
    ).toEqual(['给个具体示例', '有哪些风险？', '如何验收？'])
  })

  it('普通解释文本不会被误当成建议', () => {
    expect(parseFollowUpSuggestions('我暂时无法生成结构化追问。')).toEqual([])
  })
})

describe('getFollowUpSuggestions', () => {
  it('请求结构化输出，并在兼容模型回编号列表时仍返回建议', async () => {
    chatCompletion.mockResolvedValue({
      success: true,
      data: { content: '1. 展开第一点\n2. 给出验证步骤' }
    })

    await expect(
      aiAPI.getFollowUpSuggestions({ userMessage: '怎么修？', assistantMessage: '先定位原因。' })
    ).resolves.toEqual(['展开第一点', '给出验证步骤'])

    expect(chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: expect.objectContaining({
          type: 'json_schema',
          json_schema: expect.objectContaining({ name: 'follow_ups', strict: true })
        })
      })
    )
  })
})
