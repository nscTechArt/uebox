import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./pcmCapture.worklet.js?url', () => ({ default: 'pcmCapture.worklet.js' }))

import {
  ANSWER_QUESTION,
  APPROVE_TASK,
  CANCEL_TASK,
  CHECK_TASK,
  DISPATCH_TASK,
  END_CALL,
  LIST_PROJECTS,
  LIST_SESSIONS
} from '@core/shared/voiceFrontDesk'

import {
  ECHO_TAIL_MS,
  PACKET_MS,
  PREROLL_LEAD_MS,
  PREROLL_VOICE_RMS,
  USER_SPEAKING_FALLBACK_MS,
  createAecLoopback,
  decodePcm16Le,
  shouldMuteUplink,
  describeSessions,
  detectEncodedAudio,
  firstVoicePacket,
  measurePcmLevel,
  nextRealtimeVoicePhase,
  rootMeanSquare,
  useRealtimeVoice,
  type RealtimeVoiceState
} from './useRealtimeVoice'

describe('nextRealtimeVoicePhase', () => {
  it('把一轮语音从聆听推进到理解、回复，再回到聆听', () => {
    expect(
      nextRealtimeVoicePhase('listening', {
        type: 'user-text',
        text: '编辑器打开了吗',
        final: true
      })
    ).toBe('thinking')
    expect(nextRealtimeVoicePhase('thinking', { type: 'assistant-text', text: '我来看看' })).toBe(
      'speaking'
    )
    expect(nextRealtimeVoicePhase('speaking', { type: 'turn-done' })).toBe('listening')
  })

  /*
   * `ready` 只表示厂商接受了配置，麦克风这时候还没开。在这里就报「正在听」
   * 的话，用户会对着一个还没接上的麦克风说话，而界面毫无异常。
   */
  it('ready 之后还是「正在连」——麦克风还没接上', () => {
    expect(nextRealtimeVoicePhase('connecting', { type: 'ready' })).toBe('connecting')
  })

  it('没听清就回到听，不是报错', () => {
    expect(nextRealtimeVoicePhase('thinking', { type: 'asr-failed' })).toBe('listening')
  })

  it('工具调用只是短暂在忙，这一轮结束就回到聆听', () => {
    // 派发不再阻塞语音，所以「正在听」是真的在听 —— 卡在 executing 才是撒谎
    const executing = nextRealtimeVoicePhase('thinking', {
      type: 'tool-call',
      callId: 'call-1',
      name: DISPATCH_TASK,
      args: '{}'
    })

    expect(executing).toBe('executing')
    expect(nextRealtimeVoicePhase(executing, { type: 'turn-done' })).toBe('listening')
  })
})

describe('describeSessions', () => {
  it('把 id 和标题一起念出来，模型才填得对 session', () => {
    const text = describeSessions([
      { agentSessionId: 's-1', label: '主场景' },
      { agentSessionId: 's-2', label: '' }
    ])

    expect(text).toContain('主场景（id s-1）')
    expect(text).toContain('未命名对话（id s-2）')
  })

  it('一条都没有时说清楚不用填，免得模型瞎猜一个 id', () => {
    expect(describeSessions([])).toContain('不用填 session')
  })
})

/*
 * 走过两版都不对：「比响度」在音箱贴着麦克风时无解（回声的响度不低于用户自己
 * 说话的响度，不存在能分开两者的阈值）；「它出声就全闭」调不准的余地没了，
 * 代价是半双工。第三版把前提本身修掉了 —— 播放绕 WebRTC 回环，Chromium 的
 * 回声消除参考得到我们播的声音，于是上行不用再闭。
 */
describe('shouldMuteUplink', () => {
  const quiet = { localSpeaking: false, vendorSpeaking: false, sinceQuietMs: 10_000 }

  /** 全双工的整个意义：它说话时用户插得进话 */
  it('回环建起来了，厂商音频照播、上行照开', () => {
    expect(shouldMuteUplink({ ...quiet, vendorSpeaking: true, aecReady: true })).toBe(false)
  })

  /*
   * 本机语音合成的声音不经过我们的音频图，塞不进回环，AEC 参考不到它 ——
   * 不闭的话它会一字不差地把自己念的通知听回去，当成用户在说话。
   */
  it('本机语音合成在念的时候还是要闭', () => {
    expect(shouldMuteUplink({ ...quiet, localSpeaking: true, aecReady: true })).toBe(true)
  })

  /** 没有回声消除还开全双工，就是让它自问自答 */
  it('回环没建起来就退回半双工', () => {
    expect(shouldMuteUplink({ ...quiet, vendorSpeaking: true, aecReady: false })).toBe(true)
  })

  /** 混响拖在最后一个采样点之后，卡在这一刻放行会漏进尾音 */
  it('消不掉回声的那一路刚停，余响期间接着闭', () => {
    expect(shouldMuteUplink({ ...quiet, aecReady: true, sinceQuietMs: 0 })).toBe(true)
    expect(shouldMuteUplink({ ...quiet, aecReady: true, sinceQuietMs: ECHO_TAIL_MS - 1 })).toBe(
      true
    )
  })

  /** 一直闭着的话麦克风就废了 */
  it('余响过了就放行', () => {
    expect(shouldMuteUplink({ ...quiet, aecReady: true, sinceQuietMs: ECHO_TAIL_MS })).toBe(false)
    expect(shouldMuteUplink({ ...quiet, aecReady: true })).toBe(false)
  })
})

/*
 * 上一版是握手完成之后才申请麦克风、加载 worklet，这中间说的话一个字都采不到。
 * 用户点完球体就开口是最自然的动作，所以那段音频要攒着、连上之后补发。
 */
describe('firstVoicePacket', () => {
  const lead = Math.ceil(PREROLL_LEAD_MS / PACKET_MS)

  it('从第一声之前留出起音，别把爆破音切掉', () => {
    const levels = Array.from({ length: 20 }, (_, index) => (index === 10 ? 0.02 : 0))

    expect(firstVoicePacket(levels)).toBe(10 - lead)
  })

  /** 第一声就在开头时不能算出负数下标 */
  it('第一包就有人说话就从头补', () => {
    expect(firstVoicePacket([0.5, 0.5])).toBe(0)
  })

  /*
   * 全是静音时一包都不补：几秒钟的环境底噪送进去，服务端会当成一段发言，
   * 判停和识别都会被带偏。
   */
  it('一声都没有就一包不补', () => {
    expect(firstVoicePacket([0, 0, 0])).toBe(-1)
    expect(firstVoicePacket([])).toBe(-1)
  })

  it('门限低到能认出很轻的一声', () => {
    expect(firstVoicePacket([PREROLL_VOICE_RMS])).toBe(0)
    expect(firstVoicePacket([PREROLL_VOICE_RMS / 2])).toBe(-1)
  })
})

describe('rootMeanSquare', () => {
  /** 球体那个 ×4 是给眼睛看的；判门限要用原值，不然 0.003 的门限实际成了 0.00075 */
  it('给的是原始均方根，不带球体那个放大系数', () => {
    expect(rootMeanSquare(new Float32Array([0.1, -0.1]))).toBeCloseTo(0.1)
    expect(measurePcmLevel(new Float32Array([0.1, -0.1]))).toBeCloseTo(0.4)
    expect(rootMeanSquare(new Float32Array([]))).toBe(0)
  })
})

/*
 * jsdom 里没有 RTCPeerConnection。返回 null 而不是抛 —— 抛的话语音直接开不起来，
 * 那比没有回声消除严重得多（调用方会退回直连 + 半双工）。
 */
describe('createAecLoopback', () => {
  it('环境不支持 WebRTC 时回 null，不把整条会话带崩', async () => {
    const context = { createMediaStreamDestination: vi.fn() } as unknown as AudioContext

    await expect(createAecLoopback(context)).resolves.toBeNull()
    expect(context.createMediaStreamDestination).not.toHaveBeenCalled()
  })

  /*
   * 判据是那个 `<audio>` 真的播起来了，不是协商成功。只看协商的话，自动播放
   * 一旦被拒，音频全进了回环、一个音都出不来 —— 那比没有回声消除严重得多。
   */
  it('协商成功但播不出声，也算没建起来', async () => {
    const track = {}
    const stream = { getTracks: () => [track] }
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        onicecandidate: unknown = null
        ontrack: ((event: { streams: unknown[] }) => void) | null = null
        addTrack = vi.fn()
        addIceCandidate = vi.fn()
        close = vi.fn()
        createOffer = vi.fn().mockResolvedValue({})
        createAnswer = vi.fn().mockResolvedValue({})
        setLocalDescription = vi.fn().mockResolvedValue(undefined)
        setRemoteDescription = vi.fn(async () => {
          // 协商到这一步才会有远端轨道
          this.ontrack?.({ streams: [stream] })
        })
      }
    )
    vi.stubGlobal(
      'Audio',
      class {
        srcObject: unknown = null
        pause = vi.fn()
        play = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
      }
    )
    const context = {
      createMediaStreamDestination: vi.fn(() => ({ stream }))
    } as unknown as AudioContext

    await expect(createAecLoopback(context)).resolves.toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('detectEncodedAudio', () => {
  it.each([
    ['OggS', 'ogg'],
    ['RIFF', 'wav'],
    ['\u0000\u0000\u0001\u0000', null]
  ])('识别 %s 头', (header, expected) => {
    expect(detectEncodedAudio(btoa(header))).toBe(expected)
  })
})

describe('decodePcm16Le', () => {
  it('按 little-endian 解码 PCM16，不会把字节顺序播反', () => {
    const bytes = String.fromCharCode(0x00, 0x80, 0x00, 0x00, 0xff, 0x7f)

    expect([...decodePcm16Le(btoa(bytes))]).toEqual([-1, 0, 32767 / 32768])
  })

  it('忽略不完整的末尾单字节', () => {
    expect([...decodePcm16Le(btoa(String.fromCharCode(0x00, 0x40, 0xff)))]).toEqual([0.5])
  })
})

describe('measurePcmLevel', () => {
  it('静音为 0，真实 PCM 响度映射到 0 到 1', () => {
    expect(measurePcmLevel(new Float32Array([0, 0, 0]))).toBe(0)
    expect(measurePcmLevel(new Float32Array([0.1, -0.1]))).toBeCloseTo(0.4)
    expect(measurePcmLevel(new Float32Array([1, -1]))).toBe(1)
  })

  it('麦克风那一路是 Int16，要先按 ±32768 归一化，否则一有声音就顶满', () => {
    expect(measurePcmLevel(new Int16Array([0, 0]))).toBe(0)
    // 0.1 满幅的 Int16 应当和 Float32 的 0.1 读数一致
    expect(measurePcmLevel(new Int16Array([3277, -3277]))).toBeCloseTo(0.4, 2)
    expect(measurePcmLevel(new Int16Array([32767, -32767]))).toBe(1)
  })
})

/**
 * 把会话开到「已连上」为止。
 *
 * 音频设备全部换成空壳 —— 这几个用例测的是工具分发，不是播放队列，
 * 而 happy-dom 里没有 AudioContext。
 */
/** 排进播放队列的分片数。打断之后到的残片不该让它涨 */
let playedChunkCount = 0

/** 本机语音合成念过的那些。`onend` 由测试自己触发，模拟念完 */
let localUtterances: Array<{ text: string; onend: (() => void) | null }> = []

/** 喇叭此刻在响什么。分析节点把它交出去 —— 用例用 `harness.speaker()` 改 */
let speakerFrame = new Float32Array(1024)

/** 采集那一路的 worklet 节点。用例靠它塞一包麦克风数据进去 */
let micPort: { onmessage: ((event: { data: ArrayBuffer }) => void) | null } | null = null

function stubAudioDevices(): void {
  playedChunkCount = 0
  localUtterances = []
  speakerFrame = new Float32Array(1024)
  micPort = null
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      text: string
      lang = ''
      voice: unknown = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
  )
  vi.stubGlobal('speechSynthesis', {
    speak: vi.fn((utterance: { text: string; onend: (() => void) | null }) => {
      localUtterances.push(utterance)
    }),
    cancel: vi.fn(),
    getVoices: () => []
  })
  class FakeAudioContext {
    currentTime = 0
    state = 'running'
    destination = {}
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
    createBuffer = vi.fn(() => ({ getChannelData: () => new Float32Array(1), duration: 0 }))
    createBufferSource = vi.fn(() => {
      playedChunkCount += 1
      return { connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
    })
    /** 回声门限量的是它 —— 默认「喇叭没在响」，用例用 `harness.speaker()` 改 */
    createAnalyser = vi.fn(() => ({
      fftSize: 1024,
      connect: vi.fn(),
      getFloatTimeDomainData: vi.fn((target: Float32Array) => target.set(speakerFrame))
    }))
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }))
    close = vi.fn().mockResolvedValue(undefined)
  }

  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port: { onmessage: ((event: { data: ArrayBuffer }) => void) | null } = { onmessage: null }
      constructor() {
        micPort = this.port
      }
    }
  )
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) }
  })
}

/** 当前这条对话。默认派活都落在它上面 */
const HERE = { agentSessionId: 'session-here', label: '主场景' }

/** 一段合法的、不是 Ogg/RIFF 的 PCM base64。内容无所谓，只看排没排进队列 */
const SILENT_PCM = 'AAAA'

interface VoiceHarness {
  emit: (event: unknown) => Promise<void>
  /** 最近一次回给模型的工具结果 */
  lastOutput: () => string
  /** 到目前为止排进播放队列的分片数 */
  playedChunks: () => number
  /** 这一路语音本身。手动打断、`speaking` 这些要直接摸它 */
  voice: RealtimeVoiceState
  /** 让喇叭「此刻」响到这个响度（0 到 1） */
  speaker: (level: number) => void
  /** 塞一包这个响度的麦克风数据，返回上行的是原声还是一段静音 */
  hear: (level: number) => 'audio' | 'silence'
  api: Record<string, ReturnType<typeof vi.fn>>
}

/** `measurePcmLevel` 是 RMS×4 截到 1，所以等幅信号反推振幅就是 level / 4 */
function frameAt(level: number, length = 1024): Float32Array<ArrayBuffer> {
  return new Float32Array(length).fill(level / 4)
}

async function connect(
  options: Partial<Parameters<typeof useRealtimeVoice>[0]> = {}
): Promise<VoiceHarness> {
  stubAudioDevices()

  const api = {
    playbackReady: vi.fn(),
    sendAudio: vi.fn(),
    sendToolResults: vi.fn(),
    cancelResponse: vi.fn(),
    notify: vi.fn(),
    reportFloor: vi.fn(),
    runLocalTool: vi.fn().mockResolvedValue({ ok: true, output: '已登记 1 个工程：DemoCity' }),
    dispatchTask: vi
      .fn()
      .mockResolvedValue({ ok: true, action: 'start', taskId: 't1', ack: '已派发，任务号 t1。' }),
    taskFailed: vi.fn(),
    describeTask: vi.fn().mockResolvedValue({ text: '任务 t1 还在跑。' }),
    cancelTask: vi
      .fn()
      .mockResolvedValue({ found: true, taskId: 't1', agentSessionId: HERE.agentSessionId }),
    answerQuestion: vi.fn().mockResolvedValue({
      found: true,
      taskId: 't1',
      toolCallId: 'call-9',
      agentSessionId: HERE.agentSessionId,
      questionCount: 1
    }),
    approveTask: vi.fn().mockResolvedValue({
      found: true,
      taskId: 't1',
      toolCallId: 'call-approve',
      toolName: 'ue_destroy_actor',
      allowAlways: true
    }),
    endCall: vi.fn().mockResolvedValue({ hangUp: true, text: '好，这就挂，道个别就行。' })
  }
  let emit: ((payload: unknown) => void) | undefined

  window.api = {
    realtimeVoice: {
      ...api,
      // 麦克风赶在连接之前开起来攒首字，采样率得先问一次（见 `openMicrophone`）
      audioSpec: vi
        .fn()
        .mockResolvedValue({ ok: true, inputSampleRate: 16_000, outputSampleRate: 24_000 }),
      start: vi.fn(async () => {
        emit?.({ type: 'ready' })
        return {
          ok: true as const,
          inputSampleRate: 16_000,
          outputSampleRate: 24_000,
          connectionId: 1
        }
      }),
      stop: vi.fn().mockResolvedValue({ ok: true }),
      sendText: vi.fn(),
      onEvent: vi.fn((handler: (payload: unknown) => void) => {
        emit = handler
        return vi.fn()
      }),
      onRunTask: vi.fn(() => vi.fn())
    }
  } as unknown as typeof window.api

  const voice = useRealtimeVoice({
    resolveSession: () => HERE,
    onDispatch: vi.fn(),
    unsupportedAudioMessage: 'unsupported audio',
    asrFailedMessage: '没听清，再说一遍',
    ...options
  })
  await voice.start()

  return {
    api,
    voice,
    playedChunks: () => playedChunkCount,
    speaker: (level) => {
      speakerFrame = frameAt(level)
    },
    hear: (level) => {
      const samples = new Int16Array(256).fill(Math.round((level / 4) * 0x8000))
      micPort?.onmessage?.({ data: samples.buffer })
      const sent = window.api.realtimeVoice.sendAudio as unknown as ReturnType<typeof vi.fn>
      const base64 = sent.mock.calls[sent.mock.calls.length - 1][0] as string
      return [...atob(base64)].every((char) => char === '\0') ? 'silence' : 'audio'
    },
    lastOutput: () => {
      const calls = api.sendToolResults.mock.calls
      return calls.length === 0 ? '' : calls[calls.length - 1][0][0].output
    },
    emit: async (event) => {
      emit?.(event)
      // handle() 是 async 的，事件派发不等它。让微任务队列跑完再断言
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

function toolCall(name: string, args: Record<string, unknown> = {}): unknown {
  return { type: 'tool-call', callId: `call-${name}`, name, args: JSON.stringify(args) }
}

describe('useRealtimeVoice', () => {
  const originalApi = window.api

  afterEach(() => {
    window.api = originalApi
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('先订阅事件再连接，因此不会漏掉 session.create 的即时错误', async () => {
    const unsubscribe = vi.fn()
    const stop = vi.fn().mockResolvedValue({ ok: true })
    let emit: ((payload: { type: 'error'; message: string }) => void) | undefined

    const onEvent = vi.fn((handler: typeof emit) => {
      emit = handler
      return unsubscribe
    })
    const start = vi.fn(async () => {
      emit?.({ type: 'error', message: 'voice is required' })
      return {
        ok: true as const,
        inputSampleRate: 16_000,
        outputSampleRate: 24_000,
        connectionId: 1
      }
    })

    window.api = {
      realtimeVoice: {
        // 没绑实时模型时就是这个形状：跳过首字缓冲，让 start 那条路去报错 ——
        // 它的报错会告诉用户去哪儿绑模型，比「麦克风开不了」有用得多
        audioSpec: vi.fn().mockResolvedValue({ ok: false }),
        start,
        stop,
        playbackReady: vi.fn(),
        sendAudio: vi.fn(),
        sendText: vi.fn(),
        sendToolResults: vi.fn(),
        onEvent,
        onRunTask: vi.fn(() => vi.fn())
      }
    } as unknown as typeof window.api

    const voice = useRealtimeVoice({
      resolveSession: () => HERE,
      onDispatch: vi.fn(),
      unsupportedAudioMessage: 'unsupported audio',
      asrFailedMessage: '没听清，再说一遍'
    })
    await voice.start()

    expect(onEvent.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0])
    expect(voice.error.value).toBe('voice is required')
    expect(voice.connecting.value).toBe(false)
    expect(voice.active.value).toBe(false)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  /*
   * 审批这道确认拦的是「听错一句就删了场景」。代价不对称：拒了大不了让用户
   * 再说一遍，批了可能是不可逆的。所以拿不准一律 reject。
   */
  describe('高风险操作的口头审批', () => {
    it('用户明确同意就 approve', async () => {
      const onApprove = vi.fn()
      const harness = await connect({ onApprove })

      await harness.emit(toolCall(APPROVE_TASK, { decision: 'approve' }))

      expect(onApprove).toHaveBeenCalledWith('call-approve', 'approve')
    })

    it('模型给了个我们不认的词，按拒绝办 —— 拿不准就别动用户的工程', async () => {
      const onApprove = vi.fn()
      const harness = await connect({ onApprove })

      await harness.emit(toolCall(APPROVE_TASK, { decision: '应该可以吧' }))

      expect(onApprove).toHaveBeenCalledWith('call-approve', 'reject')
    })

    it('这个工具不给「以后都允许」时，always 退回成只批这一次', async () => {
      const onApprove = vi.fn()
      const harness = await connect({
        onApprove
        // 逐次审批的工具（比如往网页里输入）allowAlways 为 false
      })
      window.api.realtimeVoice.approveTask = vi.fn().mockResolvedValue({
        found: true,
        taskId: 't1',
        toolCallId: 'call-approve',
        toolName: 'browser_type',
        allowAlways: false
      })

      await harness.emit(toolCall(APPROVE_TASK, { decision: 'always' }))

      expect(onApprove).toHaveBeenCalledWith('call-approve', 'approve')
    })
  })

  /*
   * `interrupted` 是**服务端自己发现的**打断（豆包是 transcription.started，
   * OpenAI 是 speech_started）—— 用户那句话它已经收到并且开始转写了。
   * 本地掐播放、丢残片照旧；不再回头捅它一下，理由见下面那条用例。
   */
  /*
   * 真机 2026-09-16：用户说「不用了，再见」，助手也道了别，麦克风却一直开着 ——
   * 他以为挂了，接下来在旁边说的每句话还在往上传。防冷场那条路只认「没人说话」。
   */
  describe('用户说再见就挂断（end_call）', () => {
    it('道别念完才挂，不是当场掐断', async () => {
      const harness = await connect()

      await harness.emit(toolCall(END_CALL))
      expect(harness.api.endCall).toHaveBeenCalledWith(false)
      // 工具刚回完，告别还没说 —— 这会儿挂断听起来就是掉线
      expect(window.api.realtimeVoice.stop).not.toHaveBeenCalled()

      await harness.emit({ type: 'assistant-text', text: '好嘞，有需要随时叫我，再见。' })
      await harness.emit({ type: 'turn-done' })

      expect(window.api.realtimeVoice.stop).toHaveBeenCalledOnce()
      expect(harness.voice.active.value).toBe(false)
    })

    // 「再见」和「等一下，还有件事」之间可能只隔两秒，而告别正念着
    it('道别期间他又开口，就不挂了', async () => {
      const harness = await connect()

      await harness.emit(toolCall(END_CALL))
      await harness.emit({ type: 'user-text', text: '等一下，还有件事', final: true })
      await harness.emit({ type: 'turn-done' })

      expect(window.api.realtimeVoice.stop).not.toHaveBeenCalled()
      expect(harness.voice.active.value).toBe(true)
    })

    // 挂了他就听不到那件活的结果了，所以主进程会先拦一次
    it('主进程说还有活在跑就不挂，把原话交给模型去问用户', async () => {
      const harness = await connect()
      harness.api.endCall.mockResolvedValue({
        hangUp: false,
        text: '现在还有 1 件活在跑，问他要等还是现在就挂。'
      })

      await harness.emit(toolCall(END_CALL))
      await harness.emit({ type: 'turn-done' })

      expect(harness.lastOutput()).toContain('还有 1 件活在跑')
      expect(window.api.realtimeVoice.stop).not.toHaveBeenCalled()
    })

    it('用户听过之后仍然要挂，force 照原样交给主进程', async () => {
      const harness = await connect()

      await harness.emit(toolCall(END_CALL, { force: true }))

      expect(harness.api.endCall).toHaveBeenCalledWith(true)
    })
  })

  describe('用户插话打断（服务端发现的）', () => {
    /*
     * 用户反馈：「打断好像是会打断，但他不会把我打断的话当成新输入……
     * 我再说一次，他才当成我的输入」。
     *
     * 时序对得上：我们恰好在服务端转写那句话的当口发了 `response.cancel`
     * （「这一轮作废」），它连着把在途的输入一起丢了。用户再说一遍时模型没在出声，
     * 那条路本来就不发 cancel，于是第二次就正常了。
     *
     * `response.cancel` 是半双工时代的产物：当时上行全闭，服务端不知道用户开口。
     * 现在它自己听得见 —— 它都开始转写了。
     */
    it('不再回头捅服务端 —— 那一下会把用户正在被转写的那句话一起丢掉', async () => {
      const harness = await connect()

      await harness.emit({ type: 'assistant-text', text: '好的，我这就' })
      await harness.emit({ type: 'interrupted' })

      expect(harness.api.cancelResponse).not.toHaveBeenCalled()
    })

    it('本地该掐的照旧掐 —— 用户耳朵里立刻安静，这一条不受影响', async () => {
      const harness = await connect()

      await harness.emit({ type: 'assistant-text', text: '好的' })
      await harness.emit({ type: 'audio', base64: SILENT_PCM })
      expect(harness.voice.speaking.value).toBe(true)

      await harness.emit({ type: 'interrupted' })

      expect(harness.voice.speaking.value).toBe(false)
    })

    it('打断之后到的残片要丢掉，用户说完了才恢复', async () => {
      const harness = await connect()

      await harness.emit({ type: 'assistant-text', text: '好的' })
      await harness.emit({ type: 'interrupted' })
      // 发出 cancel 之后网络上还有在途的分片
      await harness.emit({ type: 'audio', base64: SILENT_PCM })
      expect(harness.playedChunks()).toBe(0)

      // 用户这句识别完了，接下来是新一轮
      await harness.emit({ type: 'user-text', text: '算了', final: true })
      await harness.emit({ type: 'audio', base64: SILENT_PCM })
      expect(harness.playedChunks()).toBe(1)
    })

    /**
     * 出口不能只有识别那两条。OpenAI 的转写是选填的，没配上就一条识别都不发 ——
     * 于是丢弃开关只能等三秒兜底，而一句短回答的音频还不到三秒，整段被吞，
     * 表现是「它答了、字幕也有，就是一点声音都没有」。
     */
    it('服务端说用户停了就恢复播放，不等识别结果', async () => {
      const harness = await connect()

      await harness.emit({ type: 'assistant-text', text: '好的' })
      await harness.emit({ type: 'interrupted' })
      await harness.emit({ type: 'audio', base64: SILENT_PCM })
      expect(harness.playedChunks()).toBe(0)

      await harness.emit({ type: 'user-speech-done' })
      await harness.emit({ type: 'audio', base64: SILENT_PCM })

      expect(harness.playedChunks()).toBe(1)
    })

    it('没听清也要恢复播放 —— 不然新回答会被一起吞掉', async () => {
      const harness = await connect()

      await harness.emit({ type: 'assistant-text', text: '好的' })
      await harness.emit({ type: 'interrupted' })
      await harness.emit({ type: 'asr-failed' })
      await harness.emit({ type: 'audio', base64: SILENT_PCM })

      expect(harness.playedChunks()).toBe(1)
    })
  })

  /*
   * 真机上验过：音箱离麦克风近的桌面，**没有任何响度阈值能把回声和人声分开** ——
   * 回声进麦克风的响度已经不低于用户自己说话的响度。所以不再判断，改成半双工：
   * 它出声期间上行一律静音，打断改成手动（点球体 / 快捷键）。
   */
  describe('它说话时麦克风闭嘴（半双工）', () => {
    it('它没出声时原样放行 —— 一直掐着的话麦克风就废了', async () => {
      const harness = await connect()

      expect(harness.hear(0.05)).toBe('audio')
    })

    it('播放队列里有东西就掐，用户喊多大声都一样', async () => {
      const harness = await connect()

      await harness.emit({ type: 'audio', base64: SILENT_PCM })

      expect(harness.hear(0.95)).toBe('silence')
    })

    /** 掐掉也要照发一包静音：豆包全双工靠上行音频流保活，停发几秒就被判超时断开 */
    it('掐掉的那几包照样发出去，不能停发', async () => {
      const harness = await connect()

      await harness.emit({ type: 'audio', base64: SILENT_PCM })
      harness.hear(0.9)

      expect(harness.api.sendAudio).toHaveBeenCalled()
    })

    it('它在出声时界面上的麦克风响度是 0 —— 显示着波动却一个字都没送上去最误导人', async () => {
      const harness = await connect()

      await harness.emit({ type: 'audio', base64: SILENT_PCM })
      harness.hear(0.9)

      expect(harness.voice.inputLevel.value).toBe(0)
    })
  })

  /*
   * 麦克风在它说话时是闭着的，厂商的服务端 VAD 不可能发现用户开口 ——
   * 打断只能由界面发起。这条路断了就是「它说起来没完，你只能挂断」。
   */
  describe('手动打断', () => {
    it('掐掉本地播放，并且让服务端停掉这一轮', async () => {
      const harness = await connect()

      await harness.emit({ type: 'assistant-text', text: '好的，我这就' })
      await harness.emit({ type: 'audio', base64: SILENT_PCM })
      expect(harness.voice.speaking.value).toBe(true)

      harness.voice.interrupt()

      expect(harness.api.cancelResponse).toHaveBeenCalledOnce()
      expect(harness.voice.speaking.value).toBe(false)
    })

    it('打断之后到的在途残片要丢掉，不然它接着说完', async () => {
      const harness = await connect()

      await harness.emit({ type: 'audio', base64: SILENT_PCM })
      const before = harness.playedChunks()
      harness.voice.interrupt()

      await harness.emit({ type: 'audio', base64: SILENT_PCM })

      expect(harness.playedChunks()).toBe(before)
    })

    /** 没在说话时按了不能去打扰服务端：没有进行中的响应时发取消会换来一条 error */
    it('它没在说话时按下去是空操作', async () => {
      const harness = await connect()

      harness.voice.interrupt()

      expect(harness.api.cancelResponse).not.toHaveBeenCalled()
    })
  })

  it('派活只等启动，不等 Agent 做完就回任务号', async () => {
    const onDispatch = vi.fn()
    const harness = await connect({ onDispatch })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '把灯调暗一半' }))

    expect(harness.api.dispatchTask).toHaveBeenCalledWith({
      instruction: '把灯调暗一半',
      executionInstruction: '把灯调暗一半',
      resumeTaskId: '',
      agentSessionId: HERE.agentSessionId,
      // 灶名要报上去 —— 几个灶同时跑时，播报得说清是哪个灶做完了
      sessionLabel: HERE.label,
      // 不填 when 就是排队 —— 插队的代价不对称，默认必须是保守的那个
      when: 'queue'
    })
    expect(onDispatch).toHaveBeenCalledWith(
      '把灯调暗一半',
      HERE.agentSessionId,
      expect.any(Function),
      '把灯调暗一半'
    )
    expect(harness.api.sendToolResults).toHaveBeenCalledOnce()
    expect(harness.lastOutput()).toContain('任务号 t1')
  })

  /*
   * 挑哪个灶的规矩（同名合并、新名并行、满了排队）在 `ensureVoiceWorker` 里，
   * 这一层只负责把模型给的名字原样交过去 —— 在这儿再判一次就是两套规矩。
   */
  it('恢复任务沿用原来的会话和派发快照，不创建新工作会话', async () => {
    const resolveSession = vi.fn(() => HERE)
    const onDispatch = vi.fn()
    const harness = await connect({ resolveSession, onDispatch })
    harness.api.dispatchTask.mockResolvedValueOnce({
      ok: true,
      action: 'start',
      taskId: 'old-task',
      agentSessionId: 'old-worker',
      instruction: '做材质',
      executionInstruction: '做材质，仅修改 A 工程',
      ack: '已恢复'
    })
    await harness.emit(toolCall(DISPATCH_TASK, { resumeTaskId: 'old-task' }))
    expect(resolveSession).not.toHaveBeenCalled()
    expect(onDispatch).toHaveBeenCalledWith(
      '做材质',
      'old-worker',
      expect.any(Function),
      '做材质，仅修改 A 工程'
    )
    await harness.voice.stop()
  })

  it('旧通话迟到的工具结果不清除新通话的等待状态', async () => {
    const harness = await connect()
    let resolveOld: (value: { ok: boolean; output: string }) => void = () => {}
    let resolveNew: (value: { ok: boolean; output: string }) => void = () => {}
    harness.api.runLocalTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    await harness.emit(toolCall(LIST_PROJECTS))
    await harness.voice.stop()
    await harness.voice.start()
    harness.api.runLocalTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve
        })
    )
    await harness.emit(toolCall(LIST_PROJECTS))
    resolveOld({ ok: true, output: '旧结果' })
    await harness.emit({ type: 'turn-done' })
    expect(harness.api.sendToolResults).not.toHaveBeenCalled()
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: true
    })
    resolveNew({ ok: true, output: '新结果' })
    await harness.emit({ type: 'turn-done' })
    expect(harness.lastOutput()).toBe('新结果')
    await harness.voice.stop()
  })

  it('暂停收音发送静音，恢复后能继续采集', async () => {
    const harness = await connect()
    expect(harness.hear(0.4)).toBe('audio')
    harness.voice.setMuted(true)
    expect(harness.voice.muted.value).toBe(true)
    expect(harness.hear(0.4)).toBe('silence')
    expect(harness.voice.inputLevel.value).toBe(0)
    harness.voice.setMuted(false)
    expect(harness.hear(0.4)).toBe('audio')
    await harness.voice.stop()
  })

  it('麦克风授权迟迟不返回时超时退出，迟到的音轨被释放', async () => {
    const harness = await connect()
    await harness.voice.stop()
    vi.useFakeTimers()
    try {
      let resolveMic: (stream: MediaStream) => void = () => {}
      vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveMic = resolve
          })
      )
      const starting = harness.voice.start()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(harness.voice.connecting.value).toBe(false)
      expect(harness.voice.active.value).toBe(false)
      expect(harness.voice.error.value).toContain('timed out')
      const track = { stop: vi.fn() }
      resolveMic({ getTracks: () => [track] } as unknown as MediaStream)
      await starting
      expect(track.stop).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('连接中可以取消，旧连接的握手不能重新打开语音', async () => {
    const harness = await connect()
    await harness.voice.stop()
    vi.mocked(window.api.realtimeVoice.start).mockResolvedValueOnce({
      ok: true,
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      connectionId: 1
    })
    const starting = harness.voice.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.voice.connecting.value).toBe(true)
    await harness.voice.stop()
    await harness.emit({ type: 'ready' })
    await starting
    expect(harness.voice.active.value).toBe(false)
    expect(harness.voice.connecting.value).toBe(false)
  })

  it('把模型挑的灶名原样交给挑灶那一层', async () => {
    const resolveSession = vi.fn(() => ({ ...HERE, key: '灯光' }))
    const harness = await connect({ resolveSession })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '把主灯调暗', worker: '灯光' }))

    expect(resolveSession).toHaveBeenCalledWith('灯光')
  })

  /*
   * 派给**别的对话**时不挑灶：灶是这通电话内部的分工，别人那条对话有它自己的
   * agent 会话和排队规矩。挑了反而会在这通电话下面凭空建一个用不上的灶。
   */
  it('派给别的对话时不挑灶', async () => {
    const resolveSession = vi.fn(() => HERE)
    const harness = await connect({
      resolveSession,
      listSessions: () => [{ agentSessionId: 'session-other', label: '副本关卡' }]
    })

    await harness.emit(
      toolCall(DISPATCH_TASK, { instruction: '编译一下', session: 'session-other', worker: '蓝图' })
    )

    expect(resolveSession).not.toHaveBeenCalled()
    expect(harness.api.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: 'session-other', sessionLabel: '副本关卡' })
    )
  })

  /*
   * 聊天界面那条路的发起是异步的：invoke 要等整轮跑完才返回，
   * 「会话正在执行中」这种拒绝是回调里才到的 —— 抛不出异常，得有条晚一点报的路
   */
  it('启动失败晚一点才知道的，通过 fail 回报也能撤销登记', async () => {
    const harness = await connect({
      onDispatch: vi.fn((_instruction, _sessionId, fail: (reason: string) => void) => {
        fail('会话正在执行中')
      })
    })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '编译蓝图' }))

    expect(harness.api.taskFailed).toHaveBeenCalledWith({
      taskId: 't1',
      attempt: 1,
      reason: '会话正在执行中'
    })
  })

  it('Agent 启动失败会撤销主进程登记，不留下永远占位的任务', async () => {
    const harness = await connect({
      onDispatch: vi.fn().mockRejectedValue(new Error('连不上编辑器'))
    })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '编译蓝图' }))

    expect(harness.api.taskFailed).toHaveBeenCalledWith({
      taskId: 't1',
      attempt: 1,
      reason: '连不上编辑器'
    })
    expect(harness.lastOutput()).toContain('没能启动任务')
  })

  /*
   * 一条 agent 会话同时只能有一件活。排上队的那件**这会儿什么都不做** ——
   * 前面那件结束时主进程会把它推回来（`run-task`），不是在这里等。
   */
  it('排上队的那件不立刻开跑', async () => {
    const onDispatch = vi.fn()
    const harness = await connect({ onDispatch })
    harness.api.dispatchTask
      .mockResolvedValueOnce({
        ok: true,
        action: 'start',
        taskId: 't1',
        ack: '已派发，任务号 t1。'
      })
      .mockResolvedValueOnce({
        ok: true,
        action: 'queued',
        taskId: 't2',
        ack: '记下了，排在第 1 位。'
      })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '第一件' }))
    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '第二件' }))

    expect(onDispatch).toHaveBeenCalledOnce()
    expect(harness.lastOutput()).toContain('排在第 1 位')
  })

  it('明确插队时走 steer，不新起一次运行', async () => {
    const onDispatch = vi.fn()
    const onSteer = vi.fn().mockResolvedValue(true)
    const harness = await connect({ onDispatch, onSteer })
    harness.api.dispatchTask.mockResolvedValueOnce({
      ok: true,
      action: 'steer',
      taskId: 't1',
      agentSessionId: HERE.agentSessionId,
      ack: '已经插进正在做的那件事里了。'
    })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '等等，只改那盏主灯', when: 'now' }))

    expect(onSteer).toHaveBeenCalledWith(HERE.agentSessionId, '等等，只改那盏主灯')
    expect(onDispatch).not.toHaveBeenCalled()
  })

  // 插不进去还说「已经插进去了」，用户以为改过来了，而 Agent 照原样做完
  it('插不进去就照实说，不假装改过来了', async () => {
    const harness = await connect({ onSteer: vi.fn().mockResolvedValue(false) })
    harness.api.dispatchTask.mockResolvedValueOnce({
      ok: true,
      action: 'steer',
      taskId: 't1',
      agentSessionId: HERE.agentSessionId,
      ack: '已经插进去了。'
    })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '改一下', when: 'now' }))

    expect(harness.lastOutput()).toContain('没能插进')
  })

  it('check_task 不给任务号就报最近那一件', async () => {
    const harness = await connect()

    await harness.emit(toolCall(CHECK_TASK))

    expect(harness.api.describeTask).toHaveBeenCalledWith('')
    expect(harness.lastOutput()).toBe('任务 t1 还在跑。')
  })

  it('停不掉就照实说，不假装已经停了', async () => {
    const harness = await connect({
      onCancel: vi.fn().mockResolvedValue(false)
    })

    await harness.emit(toolCall(CANCEL_TASK))

    expect(harness.lastOutput()).toContain('没能停下')
  })

  it('可以列出其他对话，派活时不用让模型猜会话号', async () => {
    const harness = await connect({
      listSessions: () => [HERE, { agentSessionId: 'session-other', label: '材质整理' }]
    })

    await harness.emit(toolCall(LIST_SESSIONS))

    expect(harness.lastOutput()).toContain('材质整理（id session-other）')
  })

  it('口头回答会交回正在等人的 Agent', async () => {
    const onAnswerQuestion = vi.fn()
    const harness = await connect({ onAnswerQuestion })

    await harness.emit(toolCall(ANSWER_QUESTION, { taskId: 't1', answer: '继续执行' }))

    expect(harness.api.answerQuestion).toHaveBeenCalledWith('t1')
    expect(onAnswerQuestion).toHaveBeenCalledWith('call-9', ['继续执行'], HERE.agentSessionId)
    expect(harness.lastOutput()).toContain('答案已经交回去了')
  })

  it('只读工具走主进程当场答，不惊动 Agent', async () => {
    const onDispatch = vi.fn()
    const harness = await connect({ onDispatch })

    await harness.emit(toolCall(LIST_PROJECTS))

    expect(onDispatch).not.toHaveBeenCalled()
    expect(harness.api.runLocalTool).toHaveBeenCalledWith(LIST_PROJECTS)
    expect(harness.api.sendToolResults.mock.calls[0][0][0].output).toContain('DemoCity')
  })

  it('调了不存在的工具也要回一句，否则模型永远等在那儿', async () => {
    const harness = await connect()

    await harness.emit(toolCall('teleport_me_to_mars'))

    expect(harness.api.sendToolResults).toHaveBeenCalledOnce()
    expect(harness.api.sendToolResults.mock.calls[0][0][0].output).toContain('teleport_me_to_mars')
  })

  it('先登记再启动 —— 反过来最初几条 agent 事件会落到不存在的任务上', async () => {
    const order: string[] = []
    const harness = await connect({ onDispatch: vi.fn(() => void order.push('dispatch')) })
    harness.api.dispatchTask.mockImplementation(async () => {
      order.push('register')
      return { ok: true, taskId: 't1', ack: '已派发，任务号 t1。' }
    })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '编译蓝图' }))

    expect(order).toEqual(['register', 'dispatch'])
  })

  it('派给别的对话时用那条对话的会话号和标题', async () => {
    const onDispatch = vi.fn()
    const harness = await connect({
      onDispatch,
      listSessions: () => [HERE, { agentSessionId: 'session-other', label: '副本关卡' }]
    })

    await harness.emit(
      toolCall(DISPATCH_TASK, { instruction: '编译那边的蓝图', session: 'session-other' })
    )

    expect(onDispatch).toHaveBeenCalledWith(
      '编译那边的蓝图',
      'session-other',
      expect.any(Function),
      '编译那边的蓝图'
    )
    expect(harness.api.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: 'session-other', sessionLabel: '副本关卡' })
    )
  })

  it('session 填了个不存在的 id 就不派 —— 猜错就把活扔进别人的项目了', async () => {
    const onDispatch = vi.fn()
    const harness = await connect({ onDispatch, listSessions: () => [HERE] })

    await harness.emit(toolCall(DISPATCH_TASK, { instruction: '删掉那个关卡', session: '瞎编的' }))

    expect(onDispatch).not.toHaveBeenCalled()
    expect(harness.api.dispatchTask).not.toHaveBeenCalled()
    expect(harness.lastOutput()).toContain('瞎编的')
  })

  it('「你看着办」交的是空数组，不是一个空答案', async () => {
    // 空答案会让 Agent 拿着空字符串当成用户的选择继续做；空数组才走 decline
    const onAnswerQuestion = vi.fn()
    const harness = await connect({ onAnswerQuestion })

    await harness.emit(toolCall(ANSWER_QUESTION, { answers: ['   '] }))

    expect(onAnswerQuestion).toHaveBeenCalledWith('call-9', [], HERE.agentSessionId)
    expect(harness.lastOutput()).toContain('你自己定')
  })

  it('没人在等回答时不乱答，照实回给模型', async () => {
    const onAnswerQuestion = vi.fn()
    const harness = await connect({ onAnswerQuestion })
    harness.api.answerQuestion.mockResolvedValue({
      found: false,
      text: '现在没有 Agent 在等回答，不用调这个。'
    })

    await harness.emit(toolCall(ANSWER_QUESTION, { answers: ['随便'] }))

    expect(onAnswerQuestion).not.toHaveBeenCalled()
    expect(harness.lastOutput()).toContain('没有 Agent 在等回答')
  })

  it('谁在说话要报给主进程 —— 播报纪律全靠它', async () => {
    const harness = await connect()

    await harness.emit({ type: 'user-text', text: '等一下', final: false })
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: true,
      assistantSpeaking: false
    })

    await harness.emit({ type: 'assistant-text', text: '好的' })
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: true
    })

    await harness.emit({ type: 'turn-done' })
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: false
    })
  })

  it('状态没变就不重复报 —— 这两个值一秒钟要翻好几次', async () => {
    const harness = await connect()

    await harness.emit({ type: 'assistant-text', text: '好' })
    await harness.emit({ type: 'assistant-text', text: '的' })

    expect(harness.api.reportFloor).toHaveBeenCalledOnce()
  })

  /*
   * 模型点了工具、我们还没回结果，这一轮没完 —— 它在等我们。这期间往里插播，
   * 真机上正是把整路会话弄哑的时刻。豆包对只调了工具的回合会发 response.done，
   * 那一条不能把「模型在说」清掉。
   */
  it('模型在等工具结果期间算它还在说，回合结束事件也不能清掉', async () => {
    let finish: (() => void) | undefined
    const harness = await connect({
      onDispatch: () => new Promise<void>((resolve) => (finish = resolve))
    })

    const pending = harness.emit(toolCall(DISPATCH_TASK, { instruction: '把灯调暗' }))
    await Promise.resolve()
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: true
    })

    await harness.emit({ type: 'turn-done' })
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: true
    })

    finish?.()
    await pending
    // 工具结果要走完 dispatchTask → handleToolCall 好几跳微任务才交回去
    await new Promise((resolve) => setTimeout(resolve, 0))
    await harness.emit({ type: 'turn-done' })
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: false
    })
  })

  // 「用户在说」永久卡住的话，播报纪律会把所有通知压到天荒地老 —— 任务跑完了一声不吭
  it('「用户在说」等不到结论就自动作废，播报不至于永远被压着', async () => {
    const harness = await connect()
    vi.useFakeTimers()
    // harness.emit 内部靠一个 setTimeout(0) 等微任务跑完，假时钟下要手动拨一下
    const emit = async (event: unknown): Promise<void> => {
      const done = harness.emit(event)
      await vi.advanceTimersByTimeAsync(0)
      await done
    }
    try {
      await emit({ type: 'user-text', text: '等一', final: false })
      await vi.advanceTimersByTimeAsync(USER_SPEAKING_FALLBACK_MS - 1)
      // 又来一条中间态，计时要重来
      await emit({ type: 'user-text', text: '等一下', final: false })
      await vi.advanceTimersByTimeAsync(USER_SPEAKING_FALLBACK_MS - 1)
      expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
        userSpeaking: true,
        assistantSpeaking: false
      })

      await vi.advanceTimersByTimeAsync(1)
      expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
        userSpeaking: false,
        assistantSpeaking: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  /*
   * 豆包没有「主动开口」的路：让它照着念的那个事件平时发出去没有任何音频。
   * 任务的进度、结果、反问只能由这边用本机语音合成念。
   */
  it('speak 事件用本机语音念，念的期间算模型在说，念完恢复', async () => {
    const harness = await connect()

    await harness.emit({ type: 'speak', text: '做完了，没找到 moba 工程。' })

    expect(localUtterances.map((item) => item.text)).toEqual(['做完了，没找到 moba 工程。'])
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: true
    })

    // 豆包对没有音频的回合也会发 response.done，这一条不能把「在念」清掉
    await harness.emit({ type: 'turn-done' })
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: true
    })

    localUtterances[0].onend?.()
    expect(harness.api.reportFloor).toHaveBeenLastCalledWith({
      userSpeaking: false,
      assistantSpeaking: false
    })
  })

  /*
   * 真机：问题念出去，用户说「55 的那个」，模型回了句「已经记下了」却没调
   * answer_question，Agent 卡了一分多钟。这条保险不经过模型。
   */
  describe('反问的保险：模型漏调 answer_question', () => {
    it('问题念出去后，用户的下一句模型没拿去调工具，回合结束就直接当答案交回去', async () => {
      const onAnswerQuestion = vi.fn()
      const harness = await connect({ onAnswerQuestion })

      await harness.emit({ type: 'question-announced', taskId: 't1' })
      await harness.emit({ type: 'user-text', text: '55 的那个', final: true })
      await harness.emit({ type: 'assistant-text', text: '已经记下了。' })
      await harness.emit({ type: 'turn-done' })

      expect(harness.api.answerQuestion).toHaveBeenCalledWith('t1')
      expect(onAnswerQuestion).toHaveBeenCalledWith('call-9', ['55 的那个'], HERE.agentSessionId)
      // 让模型知道交过了，别再调一次
      expect(window.api.realtimeVoice.sendText).toHaveBeenCalledWith(
        expect.stringContaining('不用再调')
      )
    })

    it('模型自己调了 answer_question 就不插手，答案只交一次', async () => {
      const onAnswerQuestion = vi.fn()
      const harness = await connect({ onAnswerQuestion })

      await harness.emit({ type: 'question-announced', taskId: 't1' })
      await harness.emit({ type: 'user-text', text: '55 的那个', final: true })
      await harness.emit(toolCall(ANSWER_QUESTION, { taskId: 't1', answers: ['UALinkDev55'] }))
      await harness.emit({ type: 'turn-done' })

      expect(onAnswerQuestion).toHaveBeenCalledTimes(1)
      expect(onAnswerQuestion).toHaveBeenCalledWith('call-9', ['UALinkDev55'], HERE.agentSessionId)
    })

    it('模型调了别的工具（比如用户其实是在说「停下」）也不插手', async () => {
      const onAnswerQuestion = vi.fn()
      const harness = await connect({ onAnswerQuestion })

      await harness.emit({ type: 'question-announced', taskId: 't1' })
      await harness.emit({ type: 'user-text', text: '算了停下', final: true })
      await harness.emit(toolCall(CANCEL_TASK, { taskId: 't1' }))
      await harness.emit({ type: 'turn-done' })

      expect(onAnswerQuestion).not.toHaveBeenCalled()
    })

    it('另一项任务的问题结束，不清掉当前等待的回答', async () => {
      const onAnswerQuestion = vi.fn()
      const harness = await connect({ onAnswerQuestion })
      await harness.emit({ type: 'question-announced', taskId: 't1' })
      await harness.emit({ type: 'question-settled', taskId: 't2' })
      await harness.emit({ type: 'user-text', text: '使用 A 工程', final: true })
      await harness.emit({ type: 'turn-done' })
      expect(harness.api.answerQuestion).toHaveBeenCalledWith('t1')
      expect(onAnswerQuestion).toHaveBeenCalledOnce()
      await harness.voice.stop()
    })

    it('用户在界面上答掉了就不再等他的下一句', async () => {
      const onAnswerQuestion = vi.fn()
      const harness = await connect({ onAnswerQuestion })

      await harness.emit({ type: 'question-announced', taskId: 't1' })
      await harness.emit({ type: 'question-settled', taskId: 't1' })
      await harness.emit({ type: 'user-text', text: '今天天气不错', final: true })
      await harness.emit({ type: 'turn-done' })

      expect(onAnswerQuestion).not.toHaveBeenCalled()
    })
  })

  it('播报发出去了，原话交给对话层写进「语音助手」', async () => {
    const onAnnouncement = vi.fn()
    const harness = await connect({ onAnnouncement })

    await harness.emit({ type: 'announced', text: '工程打开了。' })

    expect(onAnnouncement).toHaveBeenCalledWith('工程打开了。')
  })

  it('用户插话时掐掉本机正在念的通知 —— 别跟他抢', async () => {
    const harness = await connect()
    await harness.emit({ type: 'speak', text: '在处理工程。' })

    await harness.emit({ type: 'interrupted' })

    expect(window.speechSynthesis.cancel).toHaveBeenCalled()
  })

  /*
   * 豆包念我们给的播报时只有音频、没有文字增量。用户这时插话，服务端同样是自己
   * 发现的（它开始转写了），所以也不捅它 —— 但本地那段音频必须当场停掉，
   * 不然用户开了口它还在念。
   */
  it('豆包正念着播报时用户插话，本地立刻停，但不回头捅服务端', async () => {
    const harness = await connect()
    await harness.emit({ type: 'audio', base64: SILENT_PCM })
    expect(harness.playedChunks()).toBe(1)

    await harness.emit({ type: 'interrupted' })

    expect(harness.voice.speaking.value).toBe(false)
    expect(harness.api.cancelResponse).not.toHaveBeenCalled()

    // 手动打断（点球体）那条路照旧要通知服务端 —— 它无从知道用户按了键。
    // 先把「丢弃残片」的窗口关掉（用户这句识别完了），否则新音频会被当残片丢掉
    await harness.emit({ type: 'user-text', text: '等一下', final: true })
    await harness.emit({ type: 'audio', base64: SILENT_PCM })
    harness.voice.interrupt()
    expect(harness.api.cancelResponse).toHaveBeenCalledOnce()
  })

  it('工具执行抛了异常也要回一条结果，否则模型永远等着', async () => {
    const harness = await connect()
    harness.api.describeTask.mockRejectedValueOnce(new Error('IPC 断了'))

    await harness.emit(toolCall(CHECK_TASK, { taskId: 't1' }))

    expect(harness.api.sendToolResults).toHaveBeenCalledOnce()
    expect(harness.lastOutput()).toContain('工具执行出错')
    expect(harness.lastOutput()).toContain('IPC 断了')
  })
})

describe('microphone selection', () => {
  it.each(['', 'usb-mic'])('opens the configured input: %s', async (id) => {
    const { voice } = await connect({ microphoneDeviceId: () => id })
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        ...(id ? { deviceId: { exact: id } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    await voice.stop()
  })
})

describe('识别晚于回答到达', () => {
  /**
   * OpenAI 的转写是另一条管线，常常比回答的头几批增量晚到。晚到的那条
   * 不能把已经在写的回答当成「上一轮的残留」收掉 —— 收了就是把一句整话
   * 劈成两条气泡，中间还夹着用户那句（真机 2026-09-22）。
   */
  it('模型已经在回了，晚到的识别不落定这半句', async () => {
    const onAssistantDone = vi.fn()
    const harness = await connect({ onAssistantDone })

    await harness.emit({ type: 'interrupted' })
    await harness.emit({ type: 'assistant-text', text: '你好呀！很高兴' })
    await harness.emit({ type: 'user-text', text: '嗨,你好', final: true })

    expect(onAssistantDone).not.toHaveBeenCalled()

    // 这一轮真说完了才落定，而且是完整的一句
    await harness.emit({ type: 'assistant-text', text: '听到你的声音。' })
    await harness.emit({ type: 'turn-done' })
    expect(onAssistantDone).toHaveBeenCalledWith('你好呀！很高兴听到你的声音。')

    await harness.voice.stop()
  })

  /**
   * 服务端「有人开口了」判错时（外放把模型自己的头两个字收了回去），
   * 不准把说了一半的那句当场收掉。真机 2026-09-22：「好，我」「听到了。你可以…」
   * —— 一句整话从词中间劈成两条气泡。
   */
  it('打断不收字幕，同一轮的后半句接着写进同一条', async () => {
    const onAssistantDone = vi.fn()
    const harness = await connect({ onAssistantDone })

    await harness.emit({ type: 'assistant-text', text: '好，我' })
    // 回声把模型自己的头两个字顶成了「用户开口」
    await harness.emit({ type: 'interrupted' })
    expect(onAssistantDone).not.toHaveBeenCalled()

    // 服务端并没有真的取消这一轮，后半句接着来
    await harness.emit({ type: 'assistant-text', text: '听到了。你可以直接说一句。' })
    await harness.emit({ type: 'turn-done' })

    expect(onAssistantDone).toHaveBeenCalledTimes(1)
    expect(onAssistantDone).toHaveBeenCalledWith('好，我听到了。你可以直接说一句。')

    await harness.voice.stop()
  })

  /**
   * 「已经在回了」这个状态必须**逐轮清零**。不清的话它在第一轮之后永远是真，
   * 从此每一轮的字幕都接在上一轮后面，越滚越长。
   */
  it('一轮说完就清零，下一轮的字幕不接在上一轮后面', async () => {
    const onAssistantDone = vi.fn()
    const harness = await connect({ onAssistantDone })

    await harness.emit({ type: 'assistant-text', text: '上一轮说完的话' })
    await harness.emit({ type: 'turn-done' })
    expect(onAssistantDone).toHaveBeenLastCalledWith('上一轮说完的话')

    await harness.emit({ type: 'user-text', text: '再来一件事', final: true })
    await harness.emit({ type: 'assistant-text', text: '这一轮的话' })
    await harness.emit({ type: 'turn-done' })
    expect(onAssistantDone).toHaveBeenLastCalledWith('这一轮的话')

    await harness.voice.stop()
  })
})

/**
 * 门限只在首帧读一次，所以必须**随开会话带上去**。漏传不报错 ——
 * 主进程会按默认档发，而用户在设置里选的那一档从此不起作用，没有任何提示。
 */
describe('echo guard', () => {
  it('把偏好里的回声门限档位随 start 带给主进程', async () => {
    const { voice } = await connect({ echoGuard: () => 'strong' })
    expect(window.api.realtimeVoice.start).toHaveBeenCalledWith(
      expect.objectContaining({ echoGuard: 'strong' })
    )
    await voice.stop()
  })
})
