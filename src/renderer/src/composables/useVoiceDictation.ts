/**
 * 听写：把麦克风变成输入法，**只出文字，不出声音**。
 *
 * 全局热键唤起 Spotlight 用的就是这一路。和 `useRealtimeVoice`（语音助手通话）
 * 同走一条实时会话，但两者要的东西几乎不重叠：
 *
 * | | 语音助手 | 听写 |
 * |---|---|---|
 * | 会话 | 连续，用户自己挂断 | 一轮说完就收 |
 * | 模型 | 会回话、会调工具 | 只转写（主进程关掉了服务端自动应答） |
 * | 输出 | 音频 + 字幕 + 派活 | 一条 `user-text` |
 * | 播放 | 要 AEC 回环、要播放队列 | 一个扬声器都不开 |
 *
 * 所以这里**没有**复用那 1800 行，只借它的采集 worklet。合进去的代价是那边每
 * 一条「模型在说话吗」的判断都要多带一个「这一路根本不说话」的分支。
 */

import { ref, type Ref } from 'vue'
import workletUrl from './pcmCapture.worklet.js?url'
import { mediaPermissionErrorKey } from '@renderer/utils/mediaPermissionError'
import i18n from '@renderer/i18n'

/**
 * 为什么会开不起来。调用方按类别处置：前两类**静默退回打字**，后两类要说给用户听。
 *
 * - `busy`：助手页正在通话。会话是全局单例，让路而不是抢
 * - `vendor-unsupported`：绑的是豆包，它做不到「只转写不回答」
 * - `unconfigured`：压根没绑实时语音模型
 * - `failed` / `mic-denied`：连接建不起来 / 麦克风没给权限
 */
export type DictationFailure =
  | 'busy'
  | 'vendor-unsupported'
  | 'unconfigured'
  | 'failed'
  | 'mic-denied'

export type DictationState =
  /** 没在听 */
  | 'idle'
  /** 麦克风开了、连接还在建。**这时候说的话不会丢** —— 攒在 preroll 里 */
  | 'starting'
  /** 厂商就绪，正在听 */
  | 'listening'

export interface VoiceDictation {
  state: Ref<DictationState>
  /** 当前这一包的响度（0~1）。界面拿去做麦克风图标的脉动 */
  level: Ref<number>
  /**
   * 开始听写。回 `null` 表示开起来了，否则是开不起来的原因。
   *
   * 重复调用安全：已经在听就先收掉上一轮再来（热键按第二次就是这条路）。
   */
  start: () => Promise<DictationFailure | null>
  /** 收掉。重复调用无害 */
  stop: () => Promise<void>
}

export interface VoiceDictationOptions {
  /** 听清一整句了。**只给终稿** —— 中间态会让输入框在用户眼皮底下反复改写 */
  onText: (text: string) => void
  /**
   * 用哪个麦克风（偏好设置 → 语音）。不给就用系统默认那个。
   *
   * 和通话那一路读的是同一个偏好：用户挑了头戴麦，说话却从笔记本内置麦走，
   * 转写回来是一片糊的，而界面上没有任何东西说明用错了设备。
   */
  microphoneDeviceId?: () => string
  /**
   * 这一段没听清。
   *
   * 和「出错」分开：没听清不该把会话关掉，再说一遍就行。但也不能静默 ——
   * 用户说完一句输入框一个字没变，他没法判断是没听见还是坏了。
   */
  onUnheard?: () => void
  /** 会话本身出问题了，带一句能说给用户看的话 */
  onError?: (message: string) => void
}

/**
 * 把一包 PCM16 转成 base64。两家协议共同的形状。
 *
 * 一次 `apply` 而不是逐字节 `+=`：这是条热路（20 毫秒一包，每包 960 字节），
 * 逐字节拼等于每秒近五万次字符串拼接，而这个回调里还挤着算响度和一次 IPC。
 * 960 个实参离 `apply` 的上限（几万）还远得很。
 */
function encodePcm(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  return btoa(String.fromCharCode.apply(null, bytes as unknown as number[]))
}

/** 一包麦克风数据多少毫秒。和 `pcmCapture.worklet.js` 里的 `PACKET_MS` 必须一致 */
const PACKET_MS = 20

/**
 * 连接建好之前最多攒这么久的音频。
 *
 * 首字缓冲要的是「握手那一两秒」，而这个上限防的是另一件事：厂商把 socket 收下了、
 * `ready` 却永远不来（网关吞掉了 `session.update`）。没有上限的话，缓冲会按
 * 每秒五十包一直涨到用户自己按 Esc 为止。
 */
const PREROLL_MAX_MS = 30_000

/**
 * 等厂商就绪最多等这么久。
 *
 * 超了就收摊。没有这道闸的表现最难自查：界面写着「正在打开麦克风…」，
 * 系统的录音指示灯亮着，而那条会话其实早就死了 —— 用户对着它说完一整句，
 * 输入框一个字都不会出现，也没有任何报错。
 */
const READY_TIMEOUT_MS = 20_000

/**
 * 响度最多这么久往界面上发一次。
 *
 * worklet 是 20 毫秒一包，每包都写一次响应式变量就是每秒 50 次重渲染 —— 而麦克风
 * 图标上挂着一条 80 毫秒的 transition，那 50 次里一多半根本画不出来。
 * 中间那两包**取峰值**再发，所以一个短促的爆破音不会正好落在被跳过的那一包里。
 * 和通话那一路（`useRealtimeVoice.publishInputLevel`）同一个道理、同一个数。
 */
const LEVEL_PUBLISH_MS = 60

/** 这一包多响。只用来驱动图标动画，不参与任何判停 —— 判停在服务端 */
function rootMeanSquare(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] / 0x8000
    sum += value * value
  }
  return Math.sqrt(sum / samples.length)
}

export function useVoiceDictation(options: VoiceDictationOptions): VoiceDictation {
  const state = ref<DictationState>('idle')
  const level = ref(0)

  let context: AudioContext | null = null
  let stream: MediaStream | null = null
  let unsubscribe: (() => void) | null = null
  /**
   * 第几轮。异步回调（worklet 的一包、IPC 的一条事件）回来时对一下，
   * 对不上就丢 —— 用户按第二次热键时，上一轮的音频包还在路上。
   */
  let generation = 0
  /**
   * 连接建好之前采到的音频。
   *
   * **不能丢。** 这一路的整个场景是「按下热键立刻开口」，而建连接要几百毫秒 ——
   * 丢掉这段的表现是每次都吃掉前一两个字，而且用户永远不知道自己被吃了哪几个字。
   */
  let preroll: string[] = []
  let vendorReady = false
  /**
   * 主进程那条会话是**我们**开起来的吗。
   *
   * 会话是全局单例，两个窗口共用；而收尾这件事每个出口都要做一次（开不起来要收、
   * 关窗要收、组件卸载也要收）。没这个标记的话，那几次收尾会去关一条压根不属于
   * 自己的会话 —— 表现是助手页正在通话时打开一次 Spotlight，通话当场断掉。
   * 主进程那边也查了一道 sender，这里是第二道：没开过就连问都不问。
   */
  let ownsSession = false
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  /** 响度的发布节流。理由见 `LEVEL_PUBLISH_MS` */
  let levelPeak = 0
  let levelPublishedAt = 0

  function publishLevel(value: number): void {
    levelPeak = Math.max(levelPeak, value)
    const now = Date.now()
    if (now - levelPublishedAt < LEVEL_PUBLISH_MS) return
    levelPublishedAt = now
    level.value = levelPeak
    levelPeak = 0
  }

  async function releaseAudio(): Promise<void> {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    // close() 会拒绝一个已经关掉的 context。这里不关心，关上就行
    await context?.close().catch(() => undefined)
    context = null
    level.value = 0
    levelPeak = 0
    levelPublishedAt = 0
  }

  async function stop(): Promise<void> {
    generation += 1
    vendorReady = false
    preroll = []
    if (readyTimer) clearTimeout(readyTimer)
    readyTimer = null
    unsubscribe?.()
    unsubscribe = null
    state.value = 'idle'
    await releaseAudio()
    // 没开过就不去关。理由见 `ownsSession`
    if (!ownsSession) return
    ownsSession = false
    await window.api.realtimeVoice.stop().catch(() => undefined)
  }

  function handleEvent(payload: unknown, currentGeneration: number): void {
    if (generation !== currentGeneration) return
    const event = payload as { type?: string; text?: string; final?: boolean; message?: string }

    switch (event.type) {
      case 'ready':
        vendorReady = true
        if (readyTimer) clearTimeout(readyTimer)
        readyTimer = null
        state.value = 'listening'
        // 攒着的先补发，顺序不能乱 —— 乱了就是一句话被重排过的词
        for (const packet of preroll) window.api.realtimeVoice.sendAudio(packet)
        preroll = []
        break
      case 'user-text':
        // 只认终稿。中间态写进输入框的话，用户会看着自己的话被改来改去，
        // 而两秒自动提交的倒计时也永远重置不完
        if (event.final && event.text?.trim()) options.onText(event.text.trim())
        break
      case 'asr-failed':
        options.onUnheard?.()
        break
      case 'error':
        options.onError?.(event.message || '')
        void stop()
        break
      case 'closed':
        void stop()
        break
      default:
        break
    }
  }

  async function openMicrophone(inputSampleRate: number, currentGeneration: number): Promise<void> {
    /*
     * 采集这一路**必须**用目标采样率创建，让浏览器替我们重采样 —— 手写插值
     * 引入的噪声正好落在语音模型最敏感的频段。
     */
    const audioContext = new AudioContext({ sampleRate: inputSampleRate })
    context = audioContext

    // 用户在偏好设置里挑的那个。不给这个字段的话浏览器给系统默认设备 ——
    // 挑了头戴麦却从内置麦走，转写回来是糊的，而界面上没有一处说明用错了设备
    const deviceId = options.microphoneDeviceId?.()
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    if (generation !== currentGeneration) {
      media.getTracks().forEach((track) => track.stop())
      return
    }
    stream = media

    await audioContext.audioWorklet.addModule(workletUrl)
    if (generation !== currentGeneration) return

    const source = audioContext.createMediaStreamSource(media)
    const node = new AudioWorkletNode(audioContext, 'pcm-capture')
    node.port.onmessage = (message) => {
      if (generation !== currentGeneration) return
      const samples = new Int16Array(message.data as ArrayBuffer)
      publishLevel(rootMeanSquare(samples))
      const packet = encodePcm(samples)
      if (vendorReady) {
        window.api.realtimeVoice.sendAudio(packet)
      } else {
        preroll.push(packet)
        // 首字缓冲要的是握手那一两秒。超过上限就丢最旧的 —— 三十秒之前说的话
        // 早就不是「这一句的开头」了，而留着它只会让缓冲一直涨（见 PREROLL_MAX_MS）
        const maxPackets = Math.ceil(PREROLL_MAX_MS / PACKET_MS)
        if (preroll.length > maxPackets) preroll.splice(0, preroll.length - maxPackets)
      }
    }
    /*
     * **不接 destination。** 上一版在这儿挂了一条 gain 归零的链子接到出口，
     * 理由写的是「不接的话 Chromium 认为这条图没有出口，整条链不会被调度」——
     * 那句话是错的，实测过：24kHz 下让一个 `MediaStreamAudioSourceNode` 喂
     * worklet，接不接出口 `process()` 都是每秒 ~188 次，一次不差
     * （Electron 44 / Chromium；两种顺序各跑一遍排掉 AudioContext 冷启动那一下）。
     *
     * 通话那一路（`useRealtimeVoice`）本来就没接，而它天天在真机上跑 ——
     * 两个文件对同一件事写着相反的话，照错的那句走的人迟早会把对的那边也「修」坏。
     *
     * 接上去不是没代价：听写一个音都不播，却要为此按 16/24kHz 占住一个输出设备。
     */
    source.connect(node)

    /*
     * 全局热键唤起这一路**没有用户手势**，而 Chromium 的自动播放策略会让这种
     * AudioContext 停在 `suspended` —— 停着的图一块都不渲染，表现是麦克风灯亮着、
     * 界面写着「正在听」，而 worklet 一包都不产出，也没有任何报错。
     * 已经在跑时 `resume()` 是空操作，所以无条件调一次就行。
     */
    await audioContext.resume().catch(() => undefined)
  }

  async function start(): Promise<DictationFailure | null> {
    // 已经在听：先收掉上一轮。热键按第二次走的就是这条路
    if (state.value !== 'idle') await stop()

    generation += 1
    const currentGeneration = generation
    state.value = 'starting'
    vendorReady = false
    preroll = []

    /*
     * 采样率先问、麦克风先开、连接后建。**顺序是有意的**：建连接要几百毫秒，
     * 而用户按下热键的下一秒就在说话了。反过来写的代价是每次都吃掉开头几个字。
     */
    const spec = await window.api.realtimeVoice.audioSpec()
    if (generation !== currentGeneration) return null

    try {
      await openMicrophone(spec.ok ? spec.inputSampleRate : 24_000, currentGeneration)
    } catch (error) {
      await stop()
      const key = mediaPermissionErrorKey(error, 'microphone', window.api.platform)
      options.onError?.(key ? i18n.global.t(key) : String(error))
      return 'mic-denied'
    }
    if (generation !== currentGeneration) return null

    unsubscribe = window.api.realtimeVoice.onEvent((payload) =>
      handleEvent(payload, currentGeneration)
    )

    const opened = await window.api.realtimeVoice.startDictation()
    if (!opened.ok) {
      if (generation !== currentGeneration) return null
      await stop()
      if (opened.reason === 'unconfigured' || opened.reason === 'failed') {
        options.onError?.(opened.error)
      }
      return opened.reason
    }

    /*
     * 会话开起来了，从这一刻起关它是我们的事。
     *
     * **认领在判轮次之前**：这一轮就算已经被下一次热键顶掉，会话在主进程里也是
     * 真的开着的。不认领的话它永远留在 `active` 上，之后每一次听写都被自己上一轮
     * 挡成 `busy`，直到重启。认领了就总有人去关它 —— 顶掉它的那一轮收尾时会关。
     */
    ownsSession = true
    if (generation !== currentGeneration) return null

    // 厂商迟迟不 ready 就收摊，别留一个亮着录音灯的死会话（见 READY_TIMEOUT_MS）
    readyTimer = setTimeout(() => {
      if (generation !== currentGeneration || vendorReady) return
      void stop()
      options.onError?.(i18n.global.t('spotlightWindow.dictation.unavailable'))
    }, READY_TIMEOUT_MS)

    return null
  }

  return { state, level, start, stop }
}
