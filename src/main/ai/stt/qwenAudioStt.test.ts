/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { resolveQwenSttUrl, sentenceToEvent } from './qwenAudioStt'

describe('百炼识别结果', () => {
  /**
   * 中间态和终稿在协议里长得一模一样，只差 `sentence_end` 一位。
   * 认错的话，用户说到一半的半句话会被当成说完了提交出去。
   */
  it('`sentence_end` 决定是不是终稿', () => {
    expect(sentenceToEvent({ text: '把这个', sentence_end: false })).toEqual({
      type: 'user-text',
      text: '把这个',
      final: false
    })
    expect(sentenceToEvent({ text: '把这个 actor 缩放两倍', sentence_end: true })).toEqual({
      type: 'user-text',
      text: '把这个 actor 缩放两倍',
      final: true
    })
  })

  /** 心跳包也长成一条识别结果。不认这一位的话，没人说话时输入框会自己动 */
  it('心跳包不上屏', () => {
    expect(sentenceToEvent({ text: '', heartbeat: true, sentence_end: false })).toBeNull()
  })

  it('空句子不上屏', () => {
    expect(sentenceToEvent({ text: '   ', sentence_end: true })).toBeNull()
    expect(sentenceToEvent(undefined)).toBeNull()
  })
})

describe('地址归一化', () => {
  it('http 地址改成 ws，尾斜杠去掉', () => {
    expect(resolveQwenSttUrl('https://dashscope.aliyuncs.com/api-ws/v1/inference/')).toBe(
      'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
    )
  })

  /** 业务空间专属域名是厂商在推的迁移方向，不能被写死的默认值顶掉 */
  it('自定义域名原样保留', () => {
    const url = 'wss://ws-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference'
    expect(resolveQwenSttUrl(url)).toBe(url)
  })
})
