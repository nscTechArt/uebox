/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import type { RealtimeSessionConfig } from './types'
import {
  buildDoubaoAnnouncement,
  buildDoubaoGreeting,
  buildDoubaoSessionCreate,
  buildDoubaoConversationCreate,
  isVendorSpeechStart,
  pairDoubaoHistory,
  DOUBAO_DEFAULT_VOICE,
  DOUBAO_OUTPUT_FORMAT,
  isDoubaoRealtimeUrl,
  resolveDoubaoRealtimeUrl,
  translateDoubao
} from './doubaoRealtime'

function sessionConfig(voice?: string): RealtimeSessionConfig {
  return {
    apiKey: 'test-key',
    model: '1.2.6.1',
    voice,
    instructions: 'test',
    tools: [],
    onEvent: () => undefined
  }
}

describe('session.create', () => {
  it('按 3.0 协议用 rate 指定采样率，不能写成旧 Web Demo 的 sample_rate', () => {
    const payload = buildDoubaoSessionCreate(sessionConfig())

    expect(payload).toMatchObject({
      session: {
        audio: {
          input: { format: { type: 'pcm', rate: 16_000 } },
          output: { format: { type: DOUBAO_OUTPUT_FORMAT, rate: 24_000 } }
        }
      }
    })
    expect(JSON.stringify(payload)).not.toContain('sample_rate')
  })

  it('下行明确请求 pcm_s16le；普通 pcm 是 Float32，按 Int16 播会叠加强噪声', () => {
    expect(buildDoubaoSessionCreate(sessionConfig())).toMatchObject({
      session: {
        audio: {
          output: { format: { type: 'pcm_s16le' } }
        }
      }
    })
  })

  it('设置页未提供音色时仍发送协议必填的默认音色', () => {
    expect(buildDoubaoSessionCreate(sessionConfig())).toMatchObject({
      session: {
        audio: {
          output: { voice: DOUBAO_DEFAULT_VOICE }
        }
      }
    })
  })

  it('设置页选择的音色覆盖兼容默认值', () => {
    expect(buildDoubaoSessionCreate(sessionConfig('zh_male_yunzhou_jupiter_bigtts'))).toMatchObject(
      {
        session: {
          audio: {
            output: { voice: 'zh_male_yunzhou_jupiter_bigtts' }
          }
        }
      }
    )
  })
})

describe('pairDoubaoHistory', () => {
  /*
   * 文档硬要求：上下文须按 user/assistant **成对**提交，数组长度为偶数。
   * 而来源是聊天界面的最近若干条，天然会以 assistant 开头、或连着两条同角色。
   * 违反了不报错，只是整条会话行为古怪 —— 所以宁可少灌几条。
   */
  const user = (text: string): { role: 'user'; text: string } => ({ role: 'user', text })
  const bot = (text: string): { role: 'assistant'; text: string } => ({ role: 'assistant', text })

  it('仅有历史答复时标记用户消息缺失，不丢掉答复', () => {
    expect(pairDoubaoHistory([bot('上一轮的尾巴'), user('问'), bot('答')])).toEqual([
      user(expect.stringContaining('用户消息未提供')),
      bot('上一轮的尾巴'),
      user('问'),
      bot('答')
    ])
  })

  it('连着两条 assistant（Agent 一轮说了两段）不会把配对错开', () => {
    expect(
      pairDoubaoHistory([user('问'), bot('答一'), bot('答二'), user('再问'), bot('再答')])
    ).toEqual([user('问'), bot('答一\n\n答二'), user('再问'), bot('再答')])
  })

  it('未完成轮保留用户消息，以状态补齐协议配对', () => {
    expect(pairDoubaoHistory([user('问'), bot('答'), user('刚问出口')])).toEqual([
      user('问'),
      bot('答'),
      user('刚问出口'),
      bot(expect.stringContaining('尚无最终答复'))
    ])
  })

  it('超过 20 轮就丢最早的，砍在轮的边界上', () => {
    const many = Array.from({ length: 30 }, (_, i) => [user(`问${i}`), bot(`答${i}`)]).flat()

    const paired = pairDoubaoHistory(many)

    expect(paired).toHaveLength(40)
    expect(paired[0]).toEqual(user('问10'))
  })
})

describe('主动播报', () => {
  /*
   * 上下文那一帧要**成对**送：文档对 conversation.item.create 的硬要求是 user/assistant
   * 成对、长度为偶数。念出声不在这一帧里 —— 那是「打招呼」事件的事（下一条测试）。
   */
  it('播报的上下文成对送，不夹带念的指令', () => {
    const frame = buildDoubaoAnnouncement({
      speech: '有个问题要问你：要冷色还是暖色。',
      context: '[系统通知] 任务 t1 需要你问用户：要冷色还是暖色。'
    })

    expect(frame).toMatchObject({
      type: 'conversation.item.create',
      items: [
        { role: 'user', content: [{ type: 'input_text', text: expect.stringContaining('t1') }] },
        {
          role: 'assistant',
          content: [{ type: 'input_text', text: '有个问题要问你：要冷色还是暖色。' }]
        }
      ]
    })
    expect(JSON.stringify(frame)).not.toContain('speech_text_buffer')
  })

  /*
   * 让豆包自己念走「打招呼」：`speech_text_buffer.commit` 带 text，
   * 官方示例的下行就是音频三件套。不是 replacement —— 那是替换模型回答用的，
   * 不在用户刚说完的窗口里发就石沉大海（真机日志）。
   */
  it('让豆包念走「打招呼」事件，不再用 replacement', () => {
    expect(buildDoubaoGreeting('做完了，没找到 moba 工程。')).toMatchObject({
      type: 'speech_text_buffer.commit',
      text: '做完了，没找到 moba 工程。'
    })
  })

  /*
   * 等豆包开口时要认得出哪段音频是念我们的话：用户恰好在这两秒半里问了句话，
   * 模型答他的那段（default）不能被当成「通知念过了」，否则通知就丢了。
   */
  it('只把客户文本合成的音频起始当成「豆包念了」', () => {
    expect(
      isVendorSpeechStart({ type: 'response.output_audio.started', tts_type: 'chat_tts_text' })
    ).toBe(true)
    // 打招呼的官方示例里 tts_type 是空串
    expect(isVendorSpeechStart({ type: 'response.output_audio.started', tts_type: '' })).toBe(true)
    expect(
      isVendorSpeechStart({ type: 'response.output_audio.started', tts_type: 'default' })
    ).toBe(false)
    expect(
      isVendorSpeechStart({ type: 'response.output_audio.started', tts_type: 'network' })
    ).toBe(false)
    expect(isVendorSpeechStart({ type: 'response.output_audio.delta', delta: 'AAAA' })).toBe(false)
  })
})

describe('conversation.item.create', () => {
  it('普通历史和键盘输入都使用 3.0 的 message/items 结构', () => {
    expect(buildDoubaoConversationCreate([{ role: 'user', text: '继续聊' }])).toMatchObject({
      type: 'conversation.item.create',
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续聊' }]
        }
      ]
    })
  })
})

/**
 * 豆包 3.0 的事件名和 OpenAI 几乎同构，但**不完全一样** ——
 * 工具调用是独立事件、回合结束看的是另一个事件。这两处抄错了不报错，
 * 只是工具永远不触发、或者「正在说」的状态永远不消失。
 */
describe('translateDoubao', () => {
  it('session.created 才算连上 —— 不是 WebSocket open', () => {
    expect(translateDoubao({ type: 'session.created' })).toEqual([{ type: 'ready' }])
  })

  it('音频与文字增量', () => {
    expect(translateDoubao({ type: 'response.output_audio.delta', delta: 'AAAA' })).toEqual([
      { type: 'audio', base64: 'AAAA' }
    ])
    expect(translateDoubao({ type: 'response.output_text.delta', delta: '好的' })).toEqual([
      { type: 'assistant-text', text: '好的' }
    ])
  })

  /** 最终文本这一家在 transcript 和 text 两个字段上都见过 */
  it.each([
    ['transcript', { transcript: '把灯调暗' }],
    ['text', { text: '把灯调暗' }]
  ])('识别完成时从 %s 取', (_label, extra) => {
    expect(
      translateDoubao({ type: 'conversation.item.input_audio_transcription.completed', ...extra })
    ).toEqual([{ type: 'user-text', text: '把灯调暗', final: true }])
  })

  describe('工具调用', () => {
    const call = (callId: string): unknown => ({
      call_id: callId,
      name: 'dispatch_task',
      arguments: '{"instruction":"把灯调暗"}'
    })

    /** 与 OpenAI 最大的不同：这是**独立事件**，不藏在 response.done 里 */
    it('来自 response.function_call_arguments.done', () => {
      expect(
        translateDoubao({ type: 'response.function_call_arguments.done', items: [call('c1')] })
      ).toEqual([
        {
          type: 'tool-call',
          callId: 'c1',
          name: 'dispatch_task',
          args: '{"instruction":"把灯调暗"}'
        }
      ])
    })

    /** 一轮里可能并行调多个。漏掉一个，模型会一直等它 */
    it('并行调用全都抛出来', () => {
      const events = translateDoubao({
        type: 'response.function_call_arguments.done',
        items: [call('c1'), call('c2')]
      })

      expect(events).toHaveLength(2)
    })

    /** items 可能是单个对象而不是数组 —— demo 里两种都兼容 */
    it('items 是单个对象时也认', () => {
      expect(
        translateDoubao({ type: 'response.function_call_arguments.done', items: call('c1') })
      ).toHaveLength(1)
    })
  })

  /*
   * 回合结束有两个事件，两个都要认。只认 output_audio.done 的话，
   * 「这一轮只调了工具、没说话」那种回合永远不算结束 ——
   * 「谁在说话」从此停在「模型在说」，中间进度再也播不出来。
   */
  it.each(['response.output_audio.done', 'response.done', 'response.canceled'])(
    '回合结束认 %s',
    (type) => {
      expect(translateDoubao({ type })).toEqual([{ type: 'turn-done' }])
    }
  )

  /*
   * 以前这条掉进 default 被静默丢掉，表现是用户说完话界面毫无动静 ——
   * 他没法判断是没听见、还是在想、还是坏了。
   */
  it('识别失败要说出来，而不是安静地丢掉', () => {
    expect(translateDoubao({ type: 'conversation.item.input_audio_transcription.failed' })).toEqual(
      [{ type: 'asr-failed' }]
    )
  })

  /** 错误码要带上：文档里那张表是按码查的，只给一句话没法对照 */
  it('报错带上错误码', () => {
    expect(translateDoubao({ type: 'error', code: 55000001, message: 'ContextCanceled' })).toEqual([
      { type: 'error', message: '55000001：ContextCanceled' }
    ])
  })

  it.each(['session.updated', 'conversation.item.added', 'response.output_audio.started'])(
    '%s 忽略掉',
    (type) => {
      expect(translateDoubao({ type })).toEqual([])
    }
  )
})

describe('isDoubaoRealtimeUrl', () => {
  it.each([
    'https://openspeech.bytedance.com',
    'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
  ])('%s 认得出来', (url) => {
    expect(isDoubaoRealtimeUrl(url)).toBe(true)
  })

  it.each(['https://api.openai.com/v1', 'https://ark.cn-beijing.volces.com/api/v3'])(
    '%s 不是',
    (url) => {
      expect(isDoubaoRealtimeUrl(url)).toBe(false)
    }
  )
})

describe('resolveDoubaoRealtimeUrl', () => {
  it('把设置页保存的 HTTPS 厂商域名补成全双工 WebSocket 地址', () => {
    expect(resolveDoubaoRealtimeUrl('https://openspeech.bytedance.com')).toBe(
      'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
    )
  })

  it('完整地址不重复追加路径', () => {
    const full = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
    expect(resolveDoubaoRealtimeUrl(full)).toBe(full)
  })
})

/**
 * 打断是全双工的重点。
 *
 * 服务端会停止后续音频，但**我们这边已经排进播放队列的那几百毫秒不会自己消失** ——
 * 不把这个事件翻出来，表现是「我都开口了它还在自顾自说完」，比不能打断更糟。
 */
describe('打断', () => {
  it('识别开始就是打断信号', () => {
    expect(
      translateDoubao({ type: 'conversation.item.input_audio_transcription.started' })
    ).toEqual([{ type: 'interrupted' }])
  })
})
