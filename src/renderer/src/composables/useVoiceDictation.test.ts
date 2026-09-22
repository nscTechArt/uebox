import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./pcmCapture.worklet.js?url', () => ({ default: 'pcmCapture.worklet.js' }))
vi.mock('@renderer/i18n', () => ({ default: { global: { t: (key: string) => key } } }))

import { useVoiceDictation } from './useVoiceDictation'
import type { VoiceSessionEvent } from '@core/main/ai/realtime/types'

type WorkletPort = { onmessage: ((message: { data: ArrayBuffer }) => void) | null }

/**
 * 每开一轮麦克风就是一个新的 `AudioWorkletNode`，也就是一条新端口。
 *
 * **一轮一条，不能共用一个对象。** 共用的话「上一轮在路上的包被丢掉」那条用例
 * 就是假的：拿到手的 `onmessage` 其实是新一轮的那个闭包，把轮次判断整个删掉
 * 用例照样绿 —— 而它守的正是「上一轮的音频别混进这一句」。
 */
let workletPorts: WorkletPort[] = []

/** 当前这一轮在用的那条 */
function livePort(): WorkletPort {
  return workletPorts[workletPorts.length - 1]
}

/**
 * 把 Web Audio 那一套顶掉。
 *
 * 真跑 AudioContext 在 jsdom 里根本没有实现，而这条用例要验的东西
 * （攒包、补发顺序、只认终稿）一个都不在音频线程上。
 */
function stubWebAudio(): void {
  workletPorts = []
  const node = { connect: vi.fn(() => node) }
  const gain = { gain: { value: 1 }, connect: vi.fn(() => gain) }
  const source = { connect: vi.fn(() => node) }

  vi.stubGlobal(
    'AudioContext',
    class {
      audioWorklet = { addModule: vi.fn(async () => undefined) }
      destination = {}
      createMediaStreamSource = vi.fn(() => source)
      createGain = vi.fn(() => gain)
      close = vi.fn(async () => undefined)
      resume = vi.fn(async () => undefined)
    }
  )
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port: WorkletPort = { onmessage: null }
      connect = vi.fn(() => gain)
      constructor() {
        workletPorts.push(this.port)
      }
    }
  )
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) }
  })
}

let emit: (event: VoiceSessionEvent) => void
let sentAudio: string[]

function stubApi(
  startDictation: () => Promise<unknown> = async () => ({
    ok: true,
    inputSampleRate: 24_000,
    outputSampleRate: 24_000,
    connectionId: 1
  })
): void {
  sentAudio = []
  emit = () => {}
  vi.stubGlobal('window', {
    api: {
      platform: 'win32',
      realtimeVoice: {
        audioSpec: async () => ({ ok: true, inputSampleRate: 24_000, outputSampleRate: 24_000 }),
        startDictation,
        stop: async () => ({ ok: true }),
        sendAudio: (base64: string) => sentAudio.push(base64),
        onEvent: (handler: (payload: VoiceSessionEvent) => void) => {
          emit = handler
          return () => {}
        }
      }
    }
  })
}

/** 灌一包假音频进去。内容无所谓，只看它去了哪儿 */
function feedPacket(value: number): void {
  livePort().onmessage?.({ data: new Int16Array([value]).buffer })
}

beforeEach(() => {
  stubWebAudio()
  stubApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('听写', () => {
  /**
   * 红灯用例：按下热键立刻开口，前一两个字没了。
   *
   * 建连接要几百毫秒，而这一路的整个场景就是「按下就说」。丢掉那段的表现是
   * 每次都吃开头，用户还永远不知道被吃了哪几个字 —— 他只看见一句缺字的指令。
   */
  it('连接建好之前说的话攒着，ready 之后按原顺序补发', async () => {
    const dictation = useVoiceDictation({ onText: vi.fn() })
    await dictation.start()

    feedPacket(1)
    feedPacket(2)
    expect(sentAudio).toEqual([])

    emit({ type: 'ready' })
    const prerolled = [...sentAudio]
    expect(prerolled).toHaveLength(2)

    feedPacket(3)
    // 补发的两包在前、之后的在后。顺序乱了就是一句话被重排过的词
    expect(sentAudio.slice(0, 2)).toEqual(prerolled)
    expect(sentAudio).toHaveLength(3)
    expect(dictation.state.value).toBe('listening')
  })

  /**
   * 中间态写进输入框的话，用户会看着自己的话被反复改写，
   * 而两秒自动提交的倒计时也永远重置不完。
   */
  it('只把终稿交出去，中间态一律丢掉', async () => {
    const onText = vi.fn()
    const dictation = useVoiceDictation({ onText })
    await dictation.start()
    emit({ type: 'ready' })

    emit({ type: 'user-text', text: '把这个', final: false })
    expect(onText).not.toHaveBeenCalled()

    emit({ type: 'user-text', text: '  把这个 actor 缩放两倍  ', final: true })
    expect(onText).toHaveBeenCalledWith('把这个 actor 缩放两倍')
  })

  /** 空的终稿也不能放过去 —— 它会把输入框变成一句只有空格的指令 */
  it('终稿是空白时什么都不交', async () => {
    const onText = vi.fn()
    const dictation = useVoiceDictation({ onText })
    await dictation.start()
    emit({ type: 'ready' })
    emit({ type: 'user-text', text: '   ', final: true })
    expect(onText).not.toHaveBeenCalled()
  })

  /**
   * 没听清**不该把会话关掉**，再说一遍就行。但也不能静默：用户说完一句
   * 输入框一个字没变，他没法判断是没听见还是坏了。
   */
  it('没听清只报一声，会话还在听', async () => {
    const onUnheard = vi.fn()
    const dictation = useVoiceDictation({ onText: vi.fn(), onUnheard })
    await dictation.start()
    emit({ type: 'ready' })

    emit({ type: 'asr-failed' })
    expect(onUnheard).toHaveBeenCalledTimes(1)
    expect(dictation.state.value).toBe('listening')
  })

  /**
   * 助手页正在通话时让路，**不抢**。调用方据此静默退回打字，
   * 所以这里既不能抛，也不能走 onError 弹一句错。
   */
  it('会话被占用时回 busy，不当成错误', async () => {
    stubApi(async () => ({ ok: false, reason: 'busy' }))
    const onError = vi.fn()
    const dictation = useVoiceDictation({ onText: vi.fn(), onError })

    expect(await dictation.start()).toBe('busy')
    expect(onError).not.toHaveBeenCalled()
    // 麦克风必须收掉。漏了就是一个看不见的常驻录音
    expect(dictation.state.value).toBe('idle')
  })

  /** 没绑实时语音模型是要说给用户听的那一类，得把原话带出来 */
  it('没配模型时把厂商那句话交给调用方', async () => {
    stubApi(async () => ({
      ok: false,
      reason: 'unconfigured',
      error: '还没有配置「实时语音」模型。'
    }))
    const onError = vi.fn()
    const dictation = useVoiceDictation({ onText: vi.fn(), onError })

    expect(await dictation.start()).toBe('unconfigured')
    expect(onError).toHaveBeenCalledWith('还没有配置「实时语音」模型。')
  })

  /**
   * 热键按第二次 = 「刚才没说清，重来」。上一轮的音频包这会儿还在路上，
   * 不按轮次丢掉的话它们会混进新的一句里。
   */
  it('重开一轮之后，上一轮在路上的音频包不再发出去', async () => {
    const dictation = useVoiceDictation({ onText: vi.fn() })
    await dictation.start()
    emit({ type: 'ready' })
    const stalePort = livePort()

    await dictation.start()
    sentAudio.length = 0
    // 上一轮的那一包这会儿才到
    stalePort.onmessage?.({ data: new Int16Array([9]).buffer })
    expect(sentAudio).toEqual([])

    /*
     * **也不准偷偷躺进新一轮的缓冲里。** 少了这一句用例就是假的：把轮次判断
     * 整个删掉它照样绿 —— 那一包只是从「当场发出去」变成「攒着，等 ready 再发」，
     * 而补发之后它照样混进了用户的下一句话。
     */
    emit({ type: 'ready' })
    expect(sentAudio).toEqual([])
  })

  /** 会话被主进程关掉（助手页把它抢走了）时要自己收干净 */
  it('收到 closed 就回到 idle', async () => {
    const dictation = useVoiceDictation({ onText: vi.fn() })
    await dictation.start()
    emit({ type: 'ready' })
    expect(dictation.state.value).toBe('listening')

    emit({ type: 'closed' })
    await Promise.resolve()
    expect(dictation.state.value).toBe('idle')
  })
})
