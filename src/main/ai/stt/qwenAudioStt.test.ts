/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { openQwenAudioSttSession, resolveQwenSttUrl, sentenceToEvent } from './qwenAudioStt'

const sockets = vi.hoisted(() => [] as import('node:events').EventEmitter[])

// 只用来驱动连接出错那一条；其余用例测的是纯函数，碰不到它
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeSocket extends EventEmitter {
    static OPEN = 1
    readyState = 0
    send = vi.fn()
    close = vi.fn()
    terminate = vi.fn()
    constructor() {
      super()
      sockets.push(this)
    }
  }
  return { default: FakeSocket }
})

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

/**
 * 出错时错误要先交出去，再关。
 *
 * 以前是先置「已关闭」再发错误，而发事件的闸门见到「已关闭」就只放 `closed` ——
 * 厂商的原话（密钥不对、模型没开通）被自己挡掉，用户和「测试连接」只看得到
 * 一句「服务端断开了连接」。
 */
describe('连接出错', () => {
  it('先报错误原话，再报关闭', () => {
    const events: unknown[] = []
    openQwenAudioSttSession({
      apiKey: 'k',
      baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
      model: 'fun-asr-realtime',
      onEvent: (event) => events.push(event)
    })
    sockets[0].emit('error', new Error('Unexpected server response: 401'))
    expect(events).toEqual([
      { type: 'error', message: 'Unexpected server response: 401' },
      { type: 'closed' }
    ])
  })
})
