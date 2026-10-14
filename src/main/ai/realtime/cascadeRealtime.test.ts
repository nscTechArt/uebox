/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, Message, ToolCall } from '@earendil-works/pi-ai'
import {
  CASCADE_INSTRUCTIONS,
  forSpeech,
  openCascadeSession,
  sentenceBreak,
  type CascadeDeps,
  type ReplyStream
} from './cascadeRealtime'
import type { SttEvent } from '../stt/types'
import type { VoiceSessionEvent } from './types'

/** 一段模型输出：几段字、几个工具调用。`hold` 给了就停在第一段字之后等它放行 */
interface Script {
  text?: string[]
  calls?: ToolCall[]
  hold?: Promise<void>
  error?: string
}

function message(content: AssistantMessage['content'], stopReason: string): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: 0
  } as AssistantMessage
}

/** 按脚本吐事件的假模型。被掐（signal abort）就停，`result()` 回 aborted */
function scripted(script: Script, signal: AbortSignal): ReplyStream {
  let aborted = false
  const said: string[] = []
  async function* events(): AsyncGenerator<never> {
    for (const [index, delta] of (script.text ?? []).entries()) {
      if (signal.aborted) {
        aborted = true
        return
      }
      said.push(delta)
      yield { type: 'text_delta', delta, contentIndex: 0 } as never
      if (index === 0 && script.hold) await script.hold
      await Promise.resolve()
    }
    for (const toolCall of script.calls ?? []) {
      if (signal.aborted) {
        aborted = true
        return
      }
      yield { type: 'toolcall_end', toolCall, contentIndex: 1 } as never
    }
    if (signal.aborted) aborted = true
  }
  return {
    [Symbol.asyncIterator]: events,
    result: async () => {
      if (script.error) return { ...message([], 'error'), errorMessage: script.error }
      const content = [
        ...(said.length ? [{ type: 'text' as const, text: said.join('') }] : []),
        ...(aborted ? [] : (script.calls ?? []))
      ]
      return message(content, aborted ? 'aborted' : script.calls?.length ? 'toolUse' : 'stop')
    }
  }
}

function harness(scripts: Script[]): {
  events: VoiceSessionEvent[]
  requests: Message[][]
  signals: AbortSignal[]
  spoken: string[]
  stt: { onEvent: (event: SttEvent) => void; audio: string[]; opened: number; close: () => void }
  session: ReturnType<typeof openCascadeSession>
  systems: string[]
} {
  const events: VoiceSessionEvent[] = []
  const requests: Message[][] = []
  const signals: AbortSignal[] = []
  const systems: string[] = []
  const spoken: string[] = []
  const stt = {
    onEvent: (() => {}) as (event: SttEvent) => void,
    audio: [] as string[],
    opened: 0,
    close: vi.fn()
  }
  const deps: CascadeDeps = {
    openStt: (onEvent) => {
      stt.onEvent = onEvent
      stt.opened += 1
      return { appendAudio: (base64) => stt.audio.push(base64), flush: vi.fn(), close: stt.close }
    },
    reply: ({ system, messages, signal }) => {
      systems.push(system)
      // 拷一份：会话之后还会往同一个数组里加
      requests.push([...messages])
      signals.push(signal)
      return scripted(scripts.shift() ?? { text: ['（没有脚本）'] }, signal)
    },
    speak: async (text, _signal, onAudio) => {
      spoken.push(text)
      // 100 毫秒的静音当作合成出来的音频
      onAudio({
        base64: Buffer.alloc(4_800).toString('base64'),
        format: 'pcm_s16le',
        sampleRate: 24000
      })
    }
  }
  const session = openCascadeSession(
    {
      instructions: '你是语音助手。',
      history: [{ role: 'user', text: '之前聊过的' }],
      tools: [{ name: 'dispatch_task', description: '派活', parameters: { type: 'object' } }],
      onEvent: (event) => events.push(event)
    },
    deps
  )
  return { events, requests, signals, spoken, stt, session, systems }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 一段够响的「说话」（正弦波），20 毫秒一包 base64 */
function loudPackets(ms: number): string[] {
  const packets: string[] = []
  for (let t = 0; t < ms; t += 20) {
    const pcm = Buffer.alloc(640)
    for (let i = 0; i < 320; i += 1) {
      pcm.writeInt16LE(
        Math.round(6_000 * Math.sin((2 * Math.PI * 220 * (t * 16 + i)) / 16_000)),
        i * 2
      )
    }
    packets.push(pcm.toString('base64'))
  }
  return packets
}

const quietPackets = (ms: number): string[] =>
  Array.from({ length: ms / 20 }, () => Buffer.alloc(640).toString('base64'))

const types = (events: VoiceSessionEvent[]): string[] => events.map((event) => event.type)

describe('切句与清洗', () => {
  it('到句号、问号、换行就切；英文句点后面要跟空白才算', () => {
    expect(sentenceBreak('好的。接着')).toBe(3)
    expect(sentenceBreak('版本 5.4 很稳')).toBe(0)
    expect(sentenceBreak('Done. Next')).toBe(5)
    expect(sentenceBreak('第一行\n第二行')).toBe(4)
  })

  it('一逗到底的长句，够长了在最后一个逗号处先念', () => {
    const text = `${'很长的一段话'.repeat(10)}，后面还没完`
    expect(sentenceBreak(text)).toBe(text.lastIndexOf('，') + 1)
  })

  it('Markdown 记号和代码块不念', () => {
    expect(forSpeech('**好的**，`main.cpp` 已改')).toBe('好的，main.cpp 已改')
    expect(forSpeech('看这里\n```ts\nconst a = 1\n```\n完了')).toBe('看这里 完了')
    expect(forSpeech('- 第一条\n- 第二条')).toBe('第一条 第二条')
  })
})

describe('一问一答', () => {
  it('识别就绪才报就绪', () => {
    const { events, stt } = harness([])
    expect(events).toEqual([])
    stt.onEvent({ type: 'ready' })
    expect(events).toEqual([{ type: 'ready' }])
  })

  it('一句终稿：上文 + 这句交给模型，字幕逐段出，逐句合成，最后收这一轮', async () => {
    const h = harness([{ text: ['好的，', '我来看看。', '马上好'] }])
    h.stt.onEvent({ type: 'user-text', text: '帮我看看灯光', final: true })
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))

    expect(h.systems[0]).toContain(CASCADE_INSTRUCTIONS)
    expect(h.requests[0].map((item) => item.role)).toEqual(['user', 'user'])
    expect(h.events.filter((event) => event.type === 'assistant-text')).toHaveLength(3)
    // 「好的，我来看看。」是一句，「马上好」收尾时补念
    expect(h.spoken).toEqual(['好的，我来看看。', '马上好'])
    expect(types(h.events).filter((type) => type === 'audio')).toHaveLength(2)
    expect(types(h.events).at(-1)).toBe('turn-done')
  })

  it('中间态只上字幕，不问模型', async () => {
    const h = harness([])
    h.stt.onEvent({ type: 'user-text', text: '帮我', final: false })
    await settle()
    expect(h.requests).toHaveLength(0)
    expect(h.events).toEqual([{ type: 'user-text', text: '帮我', final: false }])
  })

  it('打字发来的一句也当用户说的', async () => {
    const h = harness([{ text: ['收到。'] }])
    h.session.sendText('改成红色')
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))
    expect(h.requests[0].at(-1)).toMatchObject({ role: 'user', content: '改成红色' })
  })
})

describe('工具', () => {
  const call: ToolCall = {
    type: 'toolCall',
    id: 'c1',
    name: 'dispatch_task',
    arguments: { instruction: '调暗主灯' }
  }

  it('模型调工具：交给上层跑，结果回来接着问，调用和结果成对进上下文', async () => {
    const h = harness([{ calls: [call] }, { text: ['开始做了。'] }])
    h.stt.onEvent({ type: 'user-text', text: '把主灯调暗', final: true })
    await vi.waitFor(() => expect(types(h.events)).toContain('tool-call'))
    expect(h.events.find((event) => event.type === 'tool-call')).toEqual({
      type: 'tool-call',
      callId: 'c1',
      name: 'dispatch_task',
      args: JSON.stringify({ instruction: '调暗主灯' })
    })

    h.session.sendToolResults([{ callId: 'c1', output: '已派发 t1' }])
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))
    expect(h.requests[1].slice(-2).map((item) => item.role)).toEqual(['assistant', 'toolResult'])
    expect(h.requests[1].at(-1)).toMatchObject({ toolCallId: 'c1', isError: false })
    expect(h.spoken).toEqual(['开始做了。'])
  })

  /**
   * 调用已经在上层跑了，用户这时插了一句。结果必须紧跟在调用后面，
   * 排在他这句话前头 —— 反过来厂商当场 400，整通电话断掉。
   */
  it('等结果时用户插话：先收结果，再记他的话', async () => {
    const h = harness([{ calls: [call] }, { text: ['好。'] }])
    h.stt.onEvent({ type: 'user-text', text: '把主灯调暗', final: true })
    await vi.waitFor(() => expect(types(h.events)).toContain('tool-call'))

    h.stt.onEvent({ type: 'user-text', text: '算了改成蓝色', final: true })
    await settle()
    // 结果没回来之前不往下问
    expect(h.requests).toHaveLength(1)

    h.session.sendToolResults([{ callId: 'c1', output: '已派发 t1' }])
    await vi.waitFor(() => expect(h.requests).toHaveLength(2))
    expect(h.requests[1].slice(-3).map((item) => item.role)).toEqual([
      'assistant',
      'toolResult',
      'user'
    ])
  })
})

describe('插话', () => {
  it('它正说着，用户又说了一句：掐掉这一轮，说出口的半句记进上下文，回新的这句', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['我先看一下灯光。', '然后再'], hold }, { text: ['好，改蓝色。'] }])
    h.stt.onEvent({ type: 'user-text', text: '看看灯光', final: true })
    await vi.waitFor(() => expect(h.spoken).toEqual(['我先看一下灯光。']))

    h.stt.onEvent({ type: 'user-text', text: '不对，改成蓝色', final: true })
    expect(types(h.events)).toContain('interrupted')
    expect(h.signals[0].aborted).toBe(true)
    release()

    await vi.waitFor(() => expect(h.requests).toHaveLength(2))
    const roles = h.requests[1].map((item) => item.role)
    expect(roles.slice(-3)).toEqual(['user', 'assistant', 'user'])
    expect(h.requests[1].at(-2)).toMatchObject({
      content: [{ type: 'text', text: '我先看一下灯光。' }]
    })
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))
    // 被掐的那半句后面的「然后再」不念
    expect(h.spoken).toEqual(['我先看一下灯光。', '好，改蓝色。'])
  })

  it('它说着的时候用户一开口（麦克风听见了），不等识别出字就掐掉', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['我先看一下。', '还有'], hold }])
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))

    for (const packet of [...quietPackets(300), ...loudPackets(200)]) h.session.appendAudio(packet)
    expect(types(h.events)).toContain('interrupted')
    expect(h.signals[0].aborted).toBe(true)
    // 音频照样交给识别那一路
    expect(h.stt.audio.length).toBeGreaterThan(0)
    release()

    for (const packet of quietPackets(1_000)) h.session.appendAudio(packet)
    expect(types(h.events)).toContain('user-speech-done')
  })

  it('没在说话时用户开口：不发打断', () => {
    const h = harness([])
    for (const packet of [...quietPackets(300), ...loudPackets(200)]) h.session.appendAudio(packet)
    expect(types(h.events)).not.toContain('interrupted')
  })

  it('界面上点了打断：掐掉这一轮，不再念', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['第一句。', '第二句。'], hold }])
    h.stt.onEvent({ type: 'user-text', text: '说两句', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))
    h.session.cancelResponse()
    release()
    await settle()
    await settle()
    expect(h.spoken).toEqual(['第一句。'])
    expect(types(h.events)).not.toContain('turn-done')
  })
})

describe('播报', () => {
  it('原话逐字念，上下文成对记下，写进对话', async () => {
    const h = harness([{ text: ['好的。'] }])
    h.session.announce({ speech: '灯光那边做完了。', context: '[系统通知] 任务 t1 完成' })
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))
    expect(h.events).toContainEqual({ type: 'announced', text: '灯光那边做完了。' })
    expect(h.spoken).toEqual(['灯光那边做完了。'])

    h.stt.onEvent({ type: 'user-text', text: '好', final: true })
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(h.requests[0].slice(-3)).toMatchObject([
      { role: 'user', content: '[系统通知] 任务 t1 完成' },
      { role: 'assistant', content: [{ type: 'text', text: '灯光那边做完了。' }] },
      { role: 'user', content: '好' }
    ])
  })

  it('正在回答时来的播报排在后面，不抢话', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['我在看。', '看完了。'], hold }])
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))
    h.session.announce({ speech: '另一件做完了。', context: '[系统通知] t2 完成' })
    await settle()
    expect(h.spoken).toEqual(['我在看。'])
    release()
    await vi.waitFor(() => expect(h.spoken).toEqual(['我在看。', '看完了。', '另一件做完了。']))
  })
})

describe('出错与收尾', () => {
  it('模型报错：原话交出去，然后挂断', async () => {
    const h = harness([{ error: '401 Invalid API key' }])
    h.stt.onEvent({ type: 'user-text', text: '你好', final: true })
    await vi.waitFor(() => expect(types(h.events)).toContain('closed'))
    expect(h.events).toContainEqual({ type: 'error', message: '401 Invalid API key' })
    expect(h.stt.close).toHaveBeenCalled()
  })

  it('上层收到 closed 回头再关一次：不重入、只报一次', () => {
    const events: VoiceSessionEvent[] = []
    let session: ReturnType<typeof openCascadeSession> | null = null
    session = openCascadeSession(
      {
        instructions: '',
        tools: [],
        onEvent: (event) => {
          events.push(event)
          if (event.type === 'closed') session?.close()
        }
      },
      {
        openStt: () => ({ appendAudio: vi.fn(), flush: vi.fn(), close: vi.fn() }),
        reply: () => scripted({}, new AbortController().signal),
        speak: async () => {}
      }
    )
    session.close()
    expect(events).toEqual([{ type: 'closed' }])
  })

  it('识别那一路被厂商断开：接着开一路，通话不断', () => {
    const h = harness([])
    h.stt.onEvent({ type: 'closed' })
    expect(h.stt.opened).toBe(2)
    expect(types(h.events)).not.toContain('closed')
  })

  it('识别一开就断、来回好几次：不再硬撑，说清楚', () => {
    const h = harness([])
    for (let i = 0; i < 4; i += 1) h.stt.onEvent({ type: 'closed' })
    expect(h.events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('语音识别连接反复断开')
    })
  })
})
