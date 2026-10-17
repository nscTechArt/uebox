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

function harness(
  scripts: Script[],
  judgeUtterance?: CascadeDeps['judgeUtterance']
): {
  events: VoiceSessionEvent[]
  requests: Message[][]
  signals: AbortSignal[]
  spoken: string[]
  stt: { onEvent: (event: SttEvent) => void; audio: string[]; opened: number; close: () => void }
  session: ReturnType<typeof openCascadeSession>
  systems: string[]
  spokenImpl: CascadeDeps['speak']
  setSpeak: (impl: CascadeDeps['speak']) => void
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
  let speakOverride: CascadeDeps['speak'] | null = null
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
    speak: async (text, signal, onAudio) => {
      if (speakOverride) return speakOverride(text, signal, onAudio)
      spoken.push(text)
      // 100 毫秒的静音当作合成出来的音频
      onAudio({
        base64: Buffer.alloc(4_800).toString('base64'),
        format: 'pcm_s16le',
        sampleRate: 24000
      })
    },
    ...(judgeUtterance ? { judgeUtterance } : {})
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
  return {
    events,
    requests,
    signals,
    spoken,
    stt,
    session,
    systems,
    spokenImpl: deps.speak,
    setSpeak: (impl) => {
      speakOverride = impl
    }
  }
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

/** 用户真开口：先有够响的声音到麦克风，识别结果随后才到 */
function speakUp(h: { session: ReturnType<typeof openCascadeSession> }): void {
  for (const packet of [...quietPackets(300), ...loudPackets(200)]) h.session.appendAudio(packet)
}

/**
 * 整段转写那一路给每句报的起止（毫秒）。开局 `speakUp` 一次，第一句在 300 毫秒处开口；
 * 停一秒再说 200 毫秒，第二句在 1500 毫秒处开口。句尾都带着断句等的那 800 毫秒静音
 */
const firstWords = { start: 300, end: 1_300 }
const secondWords = { start: 1_500, end: 2_500 }

/** 每句合成出来都有十秒长：喇叭一直在响，认回声那一条才判得到 */
function longPlayback(h: ReturnType<typeof harness>): void {
  h.setSpeak(async (text, _signal, onAudio) => {
    h.spoken.push(text)
    onAudio({
      base64: Buffer.alloc(480_000).toString('base64'),
      format: 'pcm_s16le',
      sampleRate: 24000
    })
  })
}

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

    speakUp(h)
    h.stt.onEvent({ type: 'user-text', text: '不对，改成蓝色', final: true })
    // 没配判定模型：按老规矩当真
    await vi.waitFor(() => expect(types(h.events)).toContain('interrupted'))
    expect(h.signals[0].aborted).toBe(true)
    // 先打断、再上屏这句：反过来渲染层会把新回答当残片丢掉
    const order = types(h.events)
    expect(order.lastIndexOf('user-text')).toBeGreaterThan(order.indexOf('interrupted'))
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

  /**
   * 一声咳嗽、敲一下键盘就把等了十几秒的回答作废，用户只好再问一遍（真机 2026-10-14）。
   * 现在听见声音只先停播；识别那一路认定不是人声（什么都不回），停下来两秒就接着放
   */
  it('它说着的时候有人出声：先停播、不掐；识别没出字就接着放', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['我先看一下。', '还有'], hold }])
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))

    vi.useFakeTimers()
    try {
      for (const packet of [...quietPackets(300), ...loudPackets(200)])
        h.session.appendAudio(packet)
      expect(types(h.events)).toContain('output-hold')
      expect(types(h.events)).not.toContain('interrupted')
      expect(h.signals[0].aborted).toBe(false)
      // 音频照样交给识别那一路
      expect(h.stt.audio.length).toBeGreaterThan(0)

      for (const packet of quietPackets(1_000)) h.session.appendAudio(packet)
      expect(types(h.events)).toContain('user-speech-done')
      expect(types(h.events)).not.toContain('output-release')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(types(h.events)).toContain('output-release')
    } finally {
      vi.useRealTimers()
    }
    release()
    await vi.waitFor(() => expect(h.spoken).toEqual(['我先看一下。', '还有']))
  })

  it('停着播时识别说没听清：接着放，不报没听清', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['我先看一下。', '还有'], hold }])
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))
    for (const packet of [...quietPackets(300), ...loudPackets(200)]) h.session.appendAudio(packet)
    h.stt.onEvent({ type: 'asr-failed' })
    expect(types(h.events)).toContain('output-release')
    expect(types(h.events)).not.toContain('asr-failed')
    release()
  })

  it('判定模型说只是附和：它接着说，这句不上屏、不进上下文', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const judge = vi.fn(async () => ({ addressed: 0.9, interrupt: 0.1 }))
    const h = harness([{ text: ['我先看一下。', '看完了。'], hold }, { text: ['好。'] }], judge)
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))
    for (const packet of [...quietPackets(300), ...loudPackets(200)]) h.session.appendAudio(packet)

    h.stt.onEvent({ type: 'user-text', text: '嗯', final: true, asrTags: ['zh'] })
    await vi.waitFor(() => expect(types(h.events)).toContain('output-release'))
    expect(judge).toHaveBeenLastCalledWith({
      text: '嗯',
      assistantSaying: '我先看一下。',
      busy: true,
      asrTags: ['zh']
    })
    expect(h.signals[0].aborted).toBe(false)
    expect(h.events).not.toContainEqual({ type: 'user-text', text: '嗯', final: true })
    release()
    await vi.waitFor(() => expect(h.spoken).toEqual(['我先看一下。', '看完了。']))
    expect(h.requests).toHaveLength(1)
  })

  it('判定模型说要打断：掐掉、回新的这句', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const judge = vi.fn(async () => ({ addressed: 0.95, interrupt: 0.9 }))
    const h = harness([{ text: ['我先看一下。', '还有'], hold }, { text: ['好，改蓝色。'] }], judge)
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))
    speakUp(h)
    h.stt.onEvent({ type: 'user-text', text: '改成蓝色', final: true })
    await vi.waitFor(() => expect(types(h.events)).toContain('interrupted'))
    expect(h.signals[0].aborted).toBe(true)
    release()
    await vi.waitFor(() => expect(h.spoken).toContain('好，改蓝色。'))
  })

  /** 它说完了，喇叭的尾音被收回来认成「Yeah.」：不拦的话它会问「你说的 Yeah 是什么意思」 */
  it('不忙时判定模型说不是在对它说话：当没听见', async () => {
    const judge = vi.fn(async () => ({ addressed: 0.05 }))
    const h = harness([{ text: ['好。'] }], judge)
    h.stt.onEvent({ type: 'user-text', text: 'Yeah.', final: true })
    await vi.waitFor(() => expect(judge).toHaveBeenCalled())
    await settle()
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ busy: false }))
    expect(h.requests).toHaveLength(0)
    expect(types(h.events)).not.toContain('user-text')
  })

  /**
   * 喇叭里自己的「虚幻工程」被收回来认成「来工程。」，判定模型看它像个回答放行了，
   * 它就自顾自重跑了一遍（真机 2026-10-14）。它出声时认出的话，没先触发停播的就是回声
   */
  it('它出声时认出一句、却没听见有人开口：当回声丢掉，连判定都不问', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const judge = vi.fn(async () => ({ addressed: 0.85, interrupt: 0.82 }))
    const h = harness([{ text: ['七十四个虚幻工程。', '要我再跑一遍吗？'], hold }], judge)
    h.stt.onEvent({ type: 'user-text', text: '什么事', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))
    judge.mockClear()
    h.stt.onEvent({ type: 'user-text', text: '来工程。', final: true })
    await settle()
    expect(judge).not.toHaveBeenCalled()
    expect(h.signals[0].aborted).toBe(false)
    expect(types(h.events)).not.toContain('interrupted')
    release()
  })

  /**
   * 「嗯」触发了停播，紧接着又说「停一下」。「嗯」先判成附和、放开了停播，
   * 「停一下」的结果到时已经不在停着了 —— 它也是停着播时开口的，不能当回声丢掉
   */
  it('停着播时接连说了两句，头一句判成附和放开了：后一句照样当真，不当回声', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const judge = vi.fn(async ({ text }: { text: string }) =>
      text === '嗯' ? { addressed: 0.9, interrupt: 0.1 } : { addressed: 0.95, interrupt: 0.9 }
    )
    const h = harness([{ text: ['我先看一下。', '还有'], hold }, { text: ['好，停下了。'] }], judge)
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))

    speakUp(h)
    expect(types(h.events)).toContain('output-hold')
    // 停下一会儿又开口：还停着播，这一段同样记着
    for (const packet of [...quietPackets(1_000), ...loudPackets(200), ...quietPackets(1_000)])
      h.session.appendAudio(packet)

    // 两句的起止照整段转写那一路报的给（开口在 300、1500 毫秒处，各说 200 毫秒）
    h.stt.onEvent({ type: 'user-text', text: '嗯', final: true, audioMs: firstWords })
    await vi.waitFor(() => expect(types(h.events)).toContain('output-release'))
    h.stt.onEvent({ type: 'user-text', text: '停一下', final: true, audioMs: secondWords })
    await vi.waitFor(() => expect(types(h.events)).toContain('interrupted'))
    expect(judge).toHaveBeenLastCalledWith(expect.objectContaining({ text: '停一下' }))
    expect(h.signals[0].aborted).toBe(true)
    release()
    await vi.waitFor(() => expect(h.spoken).toContain('好，停下了。'))
  })

  /**
   * 停着播时开口了两下，第二下识别那一路没回结果（太短被扔了、说不是人声）。
   * 按段数记账的话那一笔一直挂着，后面喇叭的回声冒领了它，绕过认回声把自己打断
   */
  it('停着播时有一下开口没等到结果：后面喇叭的回声不冒领它，照样当回声丢掉', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const judge = vi.fn(async () => ({ addressed: 0.9, interrupt: 0.1 }))
    const h = harness([{ text: ['我先看一下。', '还有'], hold }], judge)
    longPlayback(h)
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))

    speakUp(h)
    for (const packet of [...quietPackets(1_000), ...loudPackets(200), ...quietPackets(1_000)])
      h.session.appendAudio(packet)
    h.stt.onEvent({ type: 'user-text', text: '嗯', final: true, audioMs: firstWords })
    await vi.waitFor(() => expect(types(h.events)).toContain('output-release'))

    // 第二下没有结果。又过了一会儿，喇叭的声音被收回来认成了字
    for (const packet of quietPackets(1_000)) h.session.appendAudio(packet)
    h.stt.onEvent({
      type: 'user-text',
      text: '来工程。',
      final: true,
      audioMs: { start: 2_900, end: 3_700 }
    })
    await settle()
    expect(judge).not.toHaveBeenCalledWith(expect.objectContaining({ text: '来工程。' }))
    expect(types(h.events)).not.toContain('interrupted')
    release()
  })

  /**
   * 结果是按说话顺序回来的，可它前面那句不一定是停着播时说的：喇叭的回声先回来，
   * 不能吃掉后面「停一下」的那一笔，让「停一下」被当成回声丢掉
   */
  it('停着播时先回来一句更早的回声：回声照样丢，后面真说的「停一下」照样当真', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const judge = vi.fn(async ({ text }: { text: string }) =>
      text === '来工程。' ? { addressed: 0.1 } : { addressed: 0.95, interrupt: 0.9 }
    )
    const h = harness([{ text: ['我先看一下。', '还有'], hold }, { text: ['好。'] }], judge)
    longPlayback(h)
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))

    // 前一秒半里喇叭的回声被认成了一句；随后用户真开口（1800 毫秒处），触发停播
    for (const packet of quietPackets(1_500)) h.session.appendAudio(packet)
    speakUp(h)
    expect(types(h.events)).toContain('output-hold')
    h.stt.onEvent({
      type: 'user-text',
      text: '来工程。',
      final: true,
      audioMs: { start: 0, end: 1_400 }
    })
    for (const packet of quietPackets(1_000)) h.session.appendAudio(packet)
    h.stt.onEvent({
      type: 'user-text',
      text: '停一下',
      final: true,
      audioMs: { start: 1_800, end: 2_800 }
    })
    await vi.waitFor(() => expect(types(h.events)).toContain('interrupted'))
    expect(judge).not.toHaveBeenCalledWith(expect.objectContaining({ text: '来工程。' }))
    expect(h.signals[0].aborted).toBe(true)
    release()
  })

  /** 识别慢了（重试过、云端排队），结果在停播放开之后才到：它是停着播时说的，不是回声 */
  it('停着播时说的话结果来晚了、停播已经放开：照样当真，不当回声', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['我先看一下。', '还有'], hold }, { text: ['好，停下了。'] }])
    longPlayback(h)
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))

    vi.useFakeTimers()
    try {
      speakUp(h)
      for (const packet of quietPackets(1_000)) h.session.appendAudio(packet)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(types(h.events)).toContain('output-release')
    } finally {
      vi.useRealTimers()
    }
    h.stt.onEvent({ type: 'user-text', text: '停一下', final: true, audioMs: firstWords })
    await vi.waitFor(() => expect(types(h.events)).toContain('interrupted'))
    expect(h.signals[0].aborted).toBe(true)
    release()
  })

  /** 识别服务这一句没办成，他说的可能正是「停一下」：不能当杂音悄悄放过去 */
  it('停着播时识别服务失败了：接着放，但报没听清，让他再说一遍', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['我先看一下。', '还有'], hold }])
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))
    speakUp(h)
    h.stt.onEvent({ type: 'asr-failed', reason: 'service', audioMs: firstWords })
    expect(types(h.events)).toContain('output-release')
    expect(h.events).toContainEqual({ type: 'asr-failed' })
    release()
  })

  it('判定模型判不了（没配、超时）：照老规矩当真', async () => {
    const judge = vi.fn(async () => null)
    const h = harness([{ text: ['好。'] }], judge)
    h.stt.onEvent({ type: 'user-text', text: '嗯', final: true })
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
  })

  /**
   * 渲染层收到 `interrupted` 就开始丢残片，要等到「这句说完了」的信号才停丢。
   * 打字发来的那句没有识别终稿，不另给信号的话只能等三秒兜底，新回答的头一两秒全被吞掉
   */
  it('它说着时打了一句字：掐掉之后马上说这句完了，新回答的声音不被当残片丢掉', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const h = harness([{ text: ['我先看一下。', '还有'], hold }, { text: ['好，改蓝色。'] }])
    h.stt.onEvent({ type: 'user-text', text: '看看', final: true })
    await vi.waitFor(() => expect(h.spoken).toHaveLength(1))

    h.session.sendText('改成蓝色')
    const cut = types(h.events).lastIndexOf('interrupted')
    expect(cut).toBeGreaterThan(-1)
    release()
    await vi.waitFor(() => expect(h.spoken).toContain('好，改蓝色。'))
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))

    // 照渲染层的规矩走一遍：`interrupted` 起开始丢，到终稿、没听清、他说完了才停丢
    let discarding = false
    let played = 0
    for (const event of h.events.slice(cut)) {
      if (event.type === 'interrupted') discarding = true
      else if (
        (event.type === 'user-text' && event.final) ||
        event.type === 'asr-failed' ||
        event.type === 'user-speech-done'
      )
        discarding = false
      else if (event.type === 'audio' && !discarding) played += 1
    }
    expect(played).toBeGreaterThan(0)
  })

  it('没在说话时用户开口：不发打断', () => {
    const h = harness([])
    for (const packet of [...quietPackets(300), ...loudPackets(200)]) h.session.appendAudio(packet)
    expect(types(h.events)).not.toContain('interrupted')
  })

  /**
   * 被掐的这一轮也要报「说完了」，和 OpenAI 取消后照样发 response.done 一个约定 ——
   * 不报的话渲染层那个「正在输入」的气泡一直挂着，输入框以为还在执行（真机 2026-10-14）
   */
  it('界面上点了打断：掐掉这一轮，不再念，但报说完了好落定字幕', async () => {
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
    expect(types(h.events)).toContain('turn-done')
  })
})

describe('播报', () => {
  it('原话逐字念，上下文成对记下，写进对话', async () => {
    const h = harness([{ text: ['好的。'] }])
    h.session.announce({ speech: '灯光那边做完了。', context: '[系统通知] 任务 t1 完成' })
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))
    expect(h.events).toContainEqual({ type: 'announced', text: '灯光那边做完了。' })
    expect(h.spoken).toEqual(['灯光那边做完了。'])

    speakUp(h)
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

describe('合成失败', () => {
  /** 云端合成偶尔断一下（真机：Qwen-Audio TTS_CONNECTION_FAILED），不该为此挂断整通电话 */
  it('偶尔断一次：重试，念出来了就当没事', async () => {
    const h = harness([{ text: ['好的。'] }])
    let calls = 0
    h.setSpeak(async (_text, _signal, onAudio) => {
      calls += 1
      if (calls === 1) throw new Error('TTS_CONNECTION_FAILED')
      onAudio({
        base64: Buffer.alloc(480).toString('base64'),
        format: 'pcm_s16le',
        sampleRate: 24000
      })
    })
    h.stt.onEvent({ type: 'user-text', text: '你好', final: true })
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))
    expect(calls).toBe(2)
    expect(types(h.events)).not.toContain('error')
  })

  it('一句重试也念不出：这句跳过、字幕照样有，通话不断', async () => {
    const h = harness([{ text: ['好的。'] }])
    h.setSpeak(async () => {
      throw new Error('TTS_CONNECTION_FAILED')
    })
    h.stt.onEvent({ type: 'user-text', text: '你好', final: true })
    await vi.waitFor(() => expect(types(h.events)).toContain('turn-done'))
    expect(types(h.events)).toContain('assistant-text')
    expect(types(h.events)).not.toContain('error')
  })

  it('连着几句都念不出来：是配置坏了，说清楚再挂', async () => {
    const h = harness([{ text: ['一。', '二。', '三。'] }])
    h.setSpeak(async () => {
      throw new Error('TTS_HTTP_401')
    })
    h.stt.onEvent({ type: 'user-text', text: '你好', final: true })
    await vi.waitFor(() => expect(types(h.events)).toContain('closed'))
    expect(h.events).toContainEqual({ type: 'error', message: 'TTS_HTTP_401' })
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
