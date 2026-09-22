/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const doubao = vi.hoisted(() => vi.fn())
const qwen = vi.hoisted(() => vi.fn())

vi.mock('./doubaoStt', () => ({ openDoubaoSttSession: doubao }))
vi.mock('./qwenAudioStt', () => ({ openQwenAudioSttSession: qwen }))
vi.mock('../credentials', () => ({ resolveApiKey: async () => 'key' }))
vi.mock('../store', () => ({ readSettings: async () => ({ providers: [], roles: {} }) }))

import { hasSttAdapter, openSttSession } from './index'
import { STT_INPUT_SAMPLE_RATE, STT_PACKET_MS } from './types'

/** 一包采集数据：20 毫秒的 PCM16 单声道 */
const CAPTURE_BYTES = (STT_INPUT_SAMPLE_RATE * 2 * 20) / 1000

function capturePacket(): string {
  return Buffer.alloc(CAPTURE_BYTES, 1).toString('base64')
}

function stubSession(): { sent: string[]; close: ReturnType<typeof vi.fn> } {
  const sent: string[] = []
  const close = vi.fn()
  const handle = { appendAudio: (base64: string) => sent.push(base64), close }
  doubao.mockReturnValue(handle)
  qwen.mockReturnValue(handle)
  return { sent, close }
}

beforeEach(() => {
  doubao.mockReset()
  qwen.mockReset()
})

describe('选路', () => {
  it('按域名认厂商，认不出的明说', () => {
    expect(hasSttAdapter('https://openspeech.bytedance.com/api/v3/sauc/bigmodel')).toBe(true)
    expect(hasSttAdapter('wss://dashscope.aliyuncs.com/api-ws/v1/inference')).toBe(true)
    // 业务空间专属域名：厂商正在推的迁移方向，漏了它用户迁移完就用不了了
    expect(hasSttAdapter('wss://ws-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference')).toBe(true)
    expect(hasSttAdapter('https://api.openai.com/v1')).toBe(false)
  })

  it('豆包地址走豆包适配器，百炼地址走百炼适配器', () => {
    stubSession()
    openSttSession(
      { apiKey: 'k', baseUrl: 'https://openspeech.bytedance.com', model: 'volc.x' },
      () => {}
    )
    expect(doubao).toHaveBeenCalledTimes(1)
    expect(qwen).not.toHaveBeenCalled()

    openSttSession(
      { apiKey: 'k', baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', model: 'm' },
      () => {}
    )
    expect(qwen).toHaveBeenCalledTimes(1)
  })
})

describe('上行攒包', () => {
  /**
   * 采集是 20 毫秒一包，而两家厂商都要 100~200ms 的包（豆包文档原话：过大或者
   * 过小均会影响性能）。直接转发的话是每秒 50 个小包，识别延迟肉眼可见地变差，
   * 而没有任何报错说明原因。
   */
  it('攒够 200 毫秒才发一包', () => {
    const { sent } = stubSession()
    const session = openSttSession(
      { apiKey: 'k', baseUrl: 'https://openspeech.bytedance.com', model: 'volc.x' },
      () => {}
    )

    const perPacket = STT_PACKET_MS / 20
    for (let i = 0; i < perPacket - 1; i += 1) session.appendAudio(capturePacket())
    expect(sent).toHaveLength(0)

    session.appendAudio(capturePacket())
    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0], 'base64')).toHaveLength(CAPTURE_BYTES * perPacket)
  })

  /**
   * 关会话时攒着的那一段**必须先送出去**。
   *
   * 丢掉的话，用户最后那 200 毫秒说的字就没了 —— 而中文里 200 毫秒足够一个字，
   * 缺的正好是一句话的末尾，读起来像话说了一半。
   */
  it('关之前把攒着的送出去', () => {
    const { sent, close } = stubSession()
    const session = openSttSession(
      { apiKey: 'k', baseUrl: 'https://openspeech.bytedance.com', model: 'volc.x' },
      () => {}
    )

    session.appendAudio(capturePacket())
    expect(sent).toHaveLength(0)

    session.close()
    expect(sent).toHaveLength(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('空包不占位', () => {
    const { sent } = stubSession()
    const session = openSttSession(
      { apiKey: 'k', baseUrl: 'https://openspeech.bytedance.com', model: 'volc.x' },
      () => {}
    )
    session.appendAudio('')
    session.close()
    expect(sent).toHaveLength(0)
  })
})
