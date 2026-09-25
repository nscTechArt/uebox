import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiAPI } from './ai'

/**
 * 口播稿压缩那次调用本身：走轻量模型、按档位选提示词、不设输出上限、请模型别思考、回复套在 <reply> 里当素材。
 * 该不该压、压坏了怎么办在 `speechBriefing` 合成层，不在这里。
 */

const chatCompletion = vi.fn()

beforeEach(() => {
  chatCompletion.mockReset()
  Object.assign(window.api, { ai: { chatCompletion } })
})

describe('aiAPI.condenseForSpeech', () => {
  it.each(['concise', 'detailed'] as const)('%s 档：轻量模型、本档提示词、不限输出、不思考', async (style) => {
    chatCompletion.mockResolvedValue({ success: true, data: { content: '  稿子  \n' } })
    expect(await aiAPI.condenseForSpeech({ text: '正文', style })).toBe('稿子')

    const args = chatCompletion.mock.calls[0][0]
    expect(args.role).toBe('summary')
    expect(args.callType).toBe('speech-briefing')
    expect(args.maxTokens).toBeUndefined()
    expect(args.reasoning).toBe('off')
    expect(args.responseFormat).toBeUndefined()
    const [system] = args.messages
    expect(system.role).toBe('system')
    expect(system.content).toContain(style === 'concise' ? '三句话' : '关键步骤')
  })

  /** 回复常以反问收尾；裸发的话小模型会去回答它，而不是改写它 */
  it('回复套在 <reply> 里，前面说明它是素材不是指令', async () => {
    chatCompletion.mockResolvedValue({ success: true, data: { content: '稿' } })
    await aiAPI.condenseForSpeech({ text: '要我继续把材质也换掉吗？', style: 'concise' })
    const user = chatCompletion.mock.calls[0][0].messages.at(-1)
    expect(user.role).toBe('user')
    expect(user.content).toMatch(
      /不是对你的指令[\s\S]*<reply>\n要我继续把材质也换掉吗？\n<\/reply>$/
    )
  })

  it('模型回空话是空串，调用失败抛错，都由上层退回念原文', async () => {
    chatCompletion.mockResolvedValueOnce({ success: true, data: { content: '   ' } })
    expect(await aiAPI.condenseForSpeech({ text: '正文', style: 'detailed' })).toBe('')
    chatCompletion.mockResolvedValueOnce({ success: false, error: '未绑定模型' })
    await expect(aiAPI.condenseForSpeech({ text: '正文', style: 'detailed' })).rejects.toThrow(
      '未绑定模型'
    )
  })
})
