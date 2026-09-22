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
/** 这一轮的音频去了哪条通道。选错通道是这一块最贵的 bug，用例必须看得见 */
let usedChannel: 'stt' | 'realtime' | null
/** 收尾包发到哪条通道上了。「松开发送」全靠它，发错通道等于没发 */
let flushed: Array<'stt' | 'realtime'>

/**
 * 两条通道都摆出来。
 *
 * `sttAudioSpec` 决定走哪条：回 `ok` 就走语音识别，回 `ok: false` 就回落到
 * 实时语音那一路 —— 和主进程的判据一模一样（绑没绑「语音识别」角色）。
 */
function stubApi(
  startDictation: () => Promise<unknown> = async () => ({
    ok: true,
    inputSampleRate: 24_000,
    outputSampleRate: 24_000,
    connectionId: 1
  }),
  options: {
    sttAudioSpec?: () => Promise<unknown>
    sttStart?: () => Promise<unknown>
  } = {}
): void {
  sentAudio = []
  usedChannel = null
  flushed = []
  emit = () => {}
  vi.stubGlobal('window', {
    api: {
      platform: 'win32',
      speechToText: {
        audioSpec: options.sttAudioSpec || (async () => ({ ok: false })),
        start: options.sttStart || (async () => ({ ok: true, inputSampleRate: 16_000 })),
        flush: async () => {
          flushed.push('stt')
          return { ok: true }
        },
        stop: async () => ({ ok: true }),
        sendAudio: (base64: string) => {
          usedChannel = 'stt'
          sentAudio.push(base64)
        },
        onEvent: (handler: (payload: VoiceSessionEvent) => void) => {
          emit = handler
          return () => {}
        }
      },
      realtimeVoice: {
        audioSpec: async () => ({ ok: true, inputSampleRate: 24_000, outputSampleRate: 24_000 }),
        startDictation,
        commitAudio: async () => {
          flushed.push('realtime')
          return { ok: true }
        },
        stop: async () => ({ ok: true }),
        sendAudio: (base64: string) => {
          usedChannel = 'realtime'
          sentAudio.push(base64)
        },
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

  /**
   * 绑了「语音识别」就走它，**不再去借实时语音那一路**。
   *
   * 这条错了不会报错：实时语音那一路对 OpenAI 用户照样能出字，只是每说一句话
   * 都白烧一轮对话 token；而对豆包用户是直接用不了（它关不掉自动应答）。
   */
  it('绑了语音识别就走识别那条通道', async () => {
    stubApi(undefined, { sttAudioSpec: async () => ({ ok: true, inputSampleRate: 16_000 }) })
    const dictation = useVoiceDictation({ onText: vi.fn() })
    expect(await dictation.start()).toBeNull()

    emit({ type: 'ready' })
    feedPacket(1)
    expect(usedChannel).toBe('stt')
  })

  /** 没绑识别角色时行为要和这一档出现之前**一模一样** */
  it('没绑语音识别就回落到实时语音那一路', async () => {
    const dictation = useVoiceDictation({ onText: vi.fn() })
    expect(await dictation.start()).toBeNull()

    emit({ type: 'ready' })
    feedPacket(1)
    expect(usedChannel).toBe('realtime')
  })

  /** 识别那条也会遇到「助手页正在通话」—— 麦克风只有一个。同样静默退回打字 */
  it('识别那条回 busy 时不当成错误', async () => {
    stubApi(undefined, {
      sttAudioSpec: async () => ({ ok: true, inputSampleRate: 16_000 }),
      sttStart: async () => ({ ok: false, reason: 'busy' })
    })
    const onError = vi.fn()
    const dictation = useVoiceDictation({ onText: vi.fn(), onError })

    expect(await dictation.start()).toBe('busy')
    expect(onError).not.toHaveBeenCalled()
    expect(dictation.state.value).toBe('idle')
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

  /**
   * 「按住说话、松开发送」的核心：**松手时不能把还在路上的终稿丢掉**。
   *
   * 红灯用例：用 `stop` 收尾。它一进门就不再放事件，而用户刚说完的最后一句
   * 正好在那之后才到 —— 表现是每次松手输入框都少最后一句，而且一声不吭。
   */
  it('松手时发收尾包，并且等到终稿才收摊', async () => {
    const onText = vi.fn()
    const dictation = useVoiceDictation({ onText })
    await dictation.start()
    emit({ type: 'ready' })

    const settled = dictation.finish()
    // `finish` 在发收尾包之前先 await 了收麦克风那一步，所以不止一个微任务
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 收尾包得先发出去，否则厂商还在等那档静音判停
    expect(flushed).toEqual(['realtime'])
    // 还没收摊 —— 终稿还没来
    expect(dictation.state.value).toBe('finishing')

    // 厂商回终稿，然后把会话关了
    emit({ type: 'user-text', text: '把选中的 actor 缩放两倍', final: true })
    emit({ type: 'closed' })
    await settled

    expect(onText).toHaveBeenCalledWith('把选中的 actor 缩放两倍')
    expect(dictation.state.value).toBe('idle')
  })

  /**
   * 终稿可能永远不来（网断了、厂商吞了）。卡在「识别中」不动比少一句话更糟 ——
   * 用户完全没法判断该等还是该重说。
   */
  it('终稿一直不来也会到点收摊，不会卡死', async () => {
    vi.useFakeTimers()
    try {
      const dictation = useVoiceDictation({ onText: vi.fn() })
      await dictation.start()
      emit({ type: 'ready' })

      const settled = dictation.finish()
      // flush 是个 await，得让微任务跑完才进到等待那一段
      await vi.advanceTimersByTimeAsync(0)
      expect(dictation.state.value).toBe('finishing')

      await vi.advanceTimersByTimeAsync(3_000)
      await settled
      expect(dictation.state.value).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  /** 没在听的时候松手（短按、或者压根没开起来）不该去碰厂商 */
  it('没在听时 finish 不发收尾包', async () => {
    const dictation = useVoiceDictation({ onText: vi.fn() })
    await dictation.finish()
    expect(flushed).toEqual([])
    expect(dictation.state.value).toBe('idle')
  })
})
