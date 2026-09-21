/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPENAI_AUDIO,
  OPENAI_TRANSCRIPTION_MODEL,
  buildOpenAiConversationItem,
  buildOpenAiSessionUpdate,
  createResponseGate,
  translate
} from './openaiRealtime'
import type { RealtimeSessionConfig } from './types'
import { DEFAULT_REALTIME_ECHO_GUARD } from '../../../shared/realtimeEchoGuard'

const CONFIG: RealtimeSessionConfig = {
  apiKey: 'sk-test',
  model: 'gpt-realtime',
  instructions: '你是前台',
  tools: [{ name: 'dispatch_task', description: '派活', parameters: { type: 'object' } }],
  onEvent: () => {}
}

/**
 * 首帧的字段错了**不会报错**，只是某一类信息永远不出现。逐条钉住是唯一的发现办法。
 */
describe('session.update 首帧', () => {
  it('GA 的位置：type=realtime，格式在 audio.input / audio.output 底下', () => {
    expect(buildOpenAiSessionUpdate(CONFIG)).toMatchObject({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: { format: { type: 'audio/pcm', rate: OPENAI_AUDIO.inputSampleRate } },
          output: { format: { type: 'audio/pcm', rate: OPENAI_AUDIO.outputSampleRate } }
        }
      }
    })
  })

  /**
   * 转写是选填的，不给一样连得上 —— 代价是界面上看不到用户说了什么，
   * 而且渲染层「丢弃在途残片」的出口（识别结果）永远不来，整段回答会被静音。
   */
  it('必须显式开转写，否则用户说的话既不显示、回答也会被静音', () => {
    const session = (buildOpenAiSessionUpdate(CONFIG) as { session: Record<string, never> }).session
    expect(session).toMatchObject({
      audio: { input: { transcription: { model: OPENAI_TRANSCRIPTION_MODEL } } }
    })
  })

  it('服务端判停，音色只在配了的时候才发', () => {
    const withoutVoice = buildOpenAiSessionUpdate(CONFIG) as {
      session: {
        audio: { input: { turn_detection: { type: string } }; output: Record<string, unknown> }
      }
    }
    expect(withoutVoice.session.audio.input.turn_detection.type).toBe('server_vad')
    expect(withoutVoice.session.audio.output).not.toHaveProperty('voice')

    expect(buildOpenAiSessionUpdate({ ...CONFIG, voice: 'marin' })).toMatchObject({
      session: { audio: { output: { voice: 'marin' } } }
    })
  })

  /**
   * 判停门限和输入降噪**必须显式给**。少了它们照样连得上、不报错，
   * 只是默认的 0.5 门限顶得过本地 AEC 的回声残留 —— 模型自己的尾音被转写成
   * 一句「用户发言」，然后它开始回应自己。钉住是唯一发现得了的办法。
   */
  it.each([
    ['headset' as const, 0.5, 'near_field'],
    ['speaker' as const, 0.65, 'far_field'],
    ['strong' as const, 0.8, 'far_field']
  ])('回声门限 %s：门限 %s，降噪 %s', (echoGuard, threshold, noiseReduction) => {
    expect(buildOpenAiSessionUpdate({ ...CONFIG, echoGuard })).toMatchObject({
      session: {
        audio: {
          input: {
            noise_reduction: { type: noiseReduction },
            turn_detection: { type: 'server_vad', threshold }
          }
        }
      }
    })
  })

  /** 不给（旧版渲染层）和给了个不认识的值，都必须落到默认档，不能是「不发」 */
  it.each([undefined, 'loud' as never])('档位给的是 %s 时退回默认档', (echoGuard) => {
    expect(buildOpenAiSessionUpdate({ ...CONFIG, echoGuard })).toMatchObject(
      buildOpenAiSessionUpdate({ ...CONFIG, echoGuard: DEFAULT_REALTIME_ECHO_GUARD })
    )
  })
})

describe('conversation.item.create', () => {
  it('键盘输入使用 user/input_text，历史助手消息使用 assistant/output_text', () => {
    expect(buildOpenAiConversationItem({ role: 'user', text: '继续聊' })).toMatchObject({
      item: { role: 'user', content: [{ type: 'input_text', text: '继续聊' }] }
    })
    expect(buildOpenAiConversationItem({ role: 'assistant', text: '上轮回答' })).toMatchObject({
      item: { role: 'assistant', content: [{ type: 'output_text', text: '上轮回答' }] }
    })
  })
})

/**
 * 事件名在 GA 那次整体改过一轮（`response.audio.delta` → `response.output_audio.delta`）。
 * 照旧名字写**连得上、也不报错**，只是永远没有声音 —— 这类错必须被逐字钉住，
 * 没有别的办法能发现它。
 */
describe('translate', () => {
  it('音频增量取 GA 的事件名', () => {
    expect(translate({ type: 'response.output_audio.delta', delta: 'AAAA' })).toEqual([
      { type: 'audio', base64: 'AAAA' }
    ])
  })

  /** beta 的旧名字现在什么都不该匹配上 —— 匹配上说明有人抄了过时的教程 */
  it('beta 的旧事件名不再产生音频', () => {
    expect(translate({ type: 'response.audio.delta', delta: 'AAAA' })).toEqual([])
  })

  it.each(['response.output_audio_transcript.delta', 'response.output_text.delta'])(
    '%s 当作助手文字',
    (type) => {
      expect(translate({ type, delta: '好的' })).toEqual([{ type: 'assistant-text', text: '好的' }])
    }
  )

  it('用户识别结果分中间态与最终态', () => {
    expect(
      translate({ type: 'conversation.item.input_audio_transcription.delta', delta: '把这' })
    ).toEqual([{ type: 'user-text', text: '把这', final: false }])

    expect(
      translate({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '把这盏灯调暗'
      })
    ).toEqual([{ type: 'user-text', text: '把这盏灯调暗', final: true }])
  })

  describe('工具调用', () => {
    const call = (callId: string, name = 'dispatch_task'): unknown => ({
      type: 'function_call',
      call_id: callId,
      name,
      arguments: '{"instruction":"把灯调暗"}'
    })

    it('从 response.done 里挖出来，并跟一个回合结束', () => {
      expect(translate({ type: 'response.done', response: { output: [call('c1')] } })).toEqual([
        {
          type: 'tool-call',
          callId: 'c1',
          name: 'dispatch_task',
          args: '{"instruction":"把灯调暗"}'
        },
        { type: 'turn-done' }
      ])
    })

    /**
     * 一轮里可能点两个工具。只取第一个的话，另一个永远拿不到结果，
     * 而模型会一直等着它 —— 表现是「说完一句就再也不理人了」。
     */
    it('一轮里的多个调用全都抛出来', () => {
      const events = translate({
        type: 'response.done',
        response: { output: [call('c1'), call('c2')] }
      })

      expect(events.filter((item) => item.type === 'tool-call')).toHaveLength(2)
    })

    it('纯说话的一轮只有回合结束', () => {
      expect(
        translate({ type: 'response.done', response: { output: [{ type: 'message' }] } })
      ).toEqual([{ type: 'turn-done' }])
    })

    it('output 不是数组时不炸', () => {
      expect(translate({ type: 'response.done', response: {} })).toEqual([{ type: 'turn-done' }])
    })
  })

  it('厂商报错取里面那句话', () => {
    expect(translate({ type: 'error', error: { message: '额度不足' } })).toEqual([
      { type: 'error', message: '额度不足' }
    ])
  })

  /**
   * 「已经有一轮在跑了」是我们自己多按了一次开口键。渲染层收到 error 会掐掉整通电话 ——
   * 为一次重复请求挂断，比这次请求没发出去糟得多。
   */
  it('重复请求开口不算故障，不能把整通电话带走', () => {
    expect(
      translate({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'conversation_already_has_active_response',
          message: 'Conversation already has an active response in progress: resp_x'
        }
      })
    ).toEqual([])
  })

  /** 事件种类几十个，绝大多数与我们无关。安静忽略，而不是刷日志或报错 */
  it.each(['session.created', 'session.updated', 'rate_limits.updated', 'response.created'])(
    '%s 忽略掉',
    (type) => {
      expect(translate({ type })).toEqual([])
    }
  )
})

/**
 * 真机上这条被踩中过：模型点了工具、我们回结果时又请求了一次开口，
 * 而上一轮还没结束 —— 服务端回 `conversation_already_has_active_response`，
 * 渲染层收到 error 就把整通电话挂了。
 */
describe('同一时间只许有一轮响应', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('第一次直接发', () => {
    const send = vi.fn()
    createResponseGate(send).request()
    expect(send).toHaveBeenCalledWith({ type: 'response.create' })
  })

  it('这一轮还在跑时不再发，等它结束再补一次', () => {
    const send = vi.fn()
    const gate = createResponseGate(send)

    gate.request()
    gate.observe('response.created')
    gate.request()
    expect(send).toHaveBeenCalledOnce()

    gate.observe('response.done')
    expect(send).toHaveBeenCalledTimes(2)
  })

  /** 压着的那次丢了的话，模型收了工具结果却一声不吭 —— 比多发一次糟得多 */
  it('压着的只补一次，不会攒成一串', () => {
    const send = vi.fn()
    const gate = createResponseGate(send)

    gate.request()
    gate.observe('response.created')
    gate.request()
    gate.request()
    gate.request()
    gate.observe('response.done')

    expect(send).toHaveBeenCalledTimes(2)
  })

  /**
   * 服务端 VAD 会在用户开口时**自己**起一轮，我们这边没发过 create。
   * 不认这一轮的话，播报会正好插进用户那一轮里，又是一条 error。
   */
  it('服务端自己起的那一轮也算数', () => {
    const send = vi.fn()
    const gate = createResponseGate(send)

    gate.observe('response.created')
    gate.request()
    expect(send).not.toHaveBeenCalled()

    gate.observe('response.done')
    expect(send).toHaveBeenCalledOnce()
  })

  /**
   * 回执要是永远不来（这次 create 被拒了），账不能永久挂着 ——
   * 那之后一句播报都出不去，而且没有任何报错。
   */
  it('回执不来时兜底放行，不能把通话变哑', () => {
    const send = vi.fn()
    const gate = createResponseGate(send)

    gate.request()
    gate.request()
    expect(send).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(5_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  /*
   * 打断这条路是**必须能用**的：它说话期间麦克风被掐成静音（半双工），
   * 服务端 VAD 发现不了用户开口，所以不发这一条就等于永远打断不了。
   */
  describe('打断', () => {
    it('有一轮在跑时发取消', () => {
      const send = vi.fn()
      const gate = createResponseGate(send)

      gate.request()
      gate.observe('response.created')
      send.mockClear()
      gate.cancel()

      expect(send).toHaveBeenCalledWith({ type: 'response.cancel' })
    })

    /** 没有进行中的响应时发取消，服务端回一条 error，而 error 会掐掉整通电话 */
    it('没有在跑的一轮就什么都不发', () => {
      const send = vi.fn()

      createResponseGate(send).cancel()

      expect(send).not.toHaveBeenCalled()
    })

    /** 用户按打断就是要它闭嘴，这时候再把压着的那次补出去是最气人的 */
    it('压着待发的那次一并作废', () => {
      const send = vi.fn()
      const gate = createResponseGate(send)

      gate.request()
      gate.observe('response.created')
      gate.request()
      gate.cancel()
      send.mockClear()
      gate.observe('response.done')

      expect(send).not.toHaveBeenCalled()
    })
  })

  it('挂断后兜底不再触发', () => {
    const send = vi.fn()
    const gate = createResponseGate(send)

    gate.request()
    gate.dispose()
    vi.advanceTimersByTime(60_000)

    expect(send).toHaveBeenCalledOnce()
  })
})

/** 与豆包的「识别开始」是同一件事：用户开口了，正在播的那段要立刻掐掉 */
describe('打断', () => {
  it('服务端 VAD 检测到说话时抛出打断', () => {
    expect(translate({ type: 'input_audio_buffer.speech_started' })).toEqual([
      { type: 'interrupted' }
    ])
  })

  /**
   * 「说完了」也要抛出去：渲染层丢弃在途残片的出口不能只有识别结果那一条，
   * 识别一旦不来，一句短回答会被整段吞掉，而且没有任何报错。
   */
  it('服务端 VAD 判停时抛出「这句说完了」', () => {
    expect(translate({ type: 'input_audio_buffer.speech_stopped' })).toEqual([
      { type: 'user-speech-done' }
    ])
  })
})
