import { describe, expect, it } from 'vitest'
import { formatErrorMessage } from './errorMessage'

/**
 * 「余额不足」在公开核心里只有一种含义：**用户自己那家模型服务商**没钱了。
 *
 * 本应用没有应用内钱包，模型一律由用户自带 Key 直连。所以这几条
 * 断言的重点不是措辞好不好听，而是**不能把用户导向一条不存在的路**：
 * 以前 DeepSeek 回一句 `Insufficient Balance`、OpenAI 回一个 `insufficient_quota`，
 * 都会被当成本应用的计费错误，于是弹出本应用的充值窗 —— 让人去买一个跟欠费
 * 毫无关系的东西。
 */
const OUT_OF_CREDIT =
  '当前模型服务商返回「余额不足」。请到该服务商的控制台充值，或在 设置 → 模型 换一个可用的模型。'

describe('formatErrorMessage', () => {
  it('把服务商的余额不足翻译成「去服务商那边充值」', () => {
    const message = formatErrorMessage(
      'HTTP 402: {"ok":false,"code":"INSUFFICIENT_FUNDS","message":"余额不足，本次生成需要更多额度。"}'
    )

    expect(message).toBe(OUT_OF_CREDIT)
  })

  /** DeepSeek 的标准报错原文就是这一句，社区版用户最常撞到的一条 */
  it('认得 DeepSeek 的 Insufficient Balance', () => {
    expect(formatErrorMessage('Error: Insufficient Balance')).toBe(OUT_OF_CREDIT)
  })

  /** OpenAI 自带 Key 额度用尽时回的就是这个 code */
  it('认得 OpenAI 的 insufficient_quota', () => {
    const message = formatErrorMessage(
      'HTTP 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'
    )

    expect(message).toBe(OUT_OF_CREDIT)
  })

  it('网络类错误仍然归一成一句人话', () => {
    expect(formatErrorMessage('fetch failed')).toBe('网络请求错误，请稍后再试')
  })

  it('认不出来的报错原样透出，不要吞掉', () => {
    expect(formatErrorMessage('Model not found: gpt-9')).toBe('Model not found: gpt-9')
  })
})
