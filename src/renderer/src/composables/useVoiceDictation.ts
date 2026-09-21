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
   * 这一段没听清。
   *
   * 和「出错」分开：没听清不该把会话关掉，再说一遍就行。但也不能静默 ——
   * 用户说完一句输入框一个字没变，他没法判断是没听见还是坏了。
   */
  onUnheard?: () => void
  /** 会话本身出问题了，带一句能说给用户看的话 */
  onError?: (message: string) => void
}

/** 把一包 PCM16 转成 base64。两家协议共同的形状 */
function encodePcm(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

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

  async function releaseAudio(): Promise<void> {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    // close() 会拒绝一个已经关掉的 context。这里不关心，关上就行
    await context?.close().catch(() => undefined)
    context = null
    level.value = 0
  }

  async function stop(): Promise<void> {
    generation += 1
    vendorReady = false
    preroll = []
    unsubscribe?.()
    unsubscribe = null
    state.value = 'idle'
    await releaseAudio()
    await window.api.realtimeVoice.stop().catch(() => undefined)
  }

  function handleEvent(payload: unknown, currentGeneration: number): void {
    if (generation !== currentGeneration) return
    const event = payload as { type?: string; text?: string; final?: boolean; message?: string }

    switch (event.type) {
      case 'ready':
        vendorReady = true
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

    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
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
      level.value = rootMeanSquare(samples)
      const packet = encodePcm(samples)
      if (vendorReady) {
        window.api.realtimeVoice.sendAudio(packet)
      } else {
        preroll.push(packet)
      }
    }
    /*
     * **必须接到 destination**，否则 Chromium 判定这条图没有出口，
     * 整条链不会被调度 —— 表现是 worklet 一包都不产出，而且没有任何报错。
     * 听写不播放任何东西，所以 gain 归零：接上去但一个音都不发出来。
     */
    const silence = audioContext.createGain()
    silence.gain.value = 0
    source.connect(node).connect(silence).connect(audioContext.destination)
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
    if (generation !== currentGeneration) return null
    if (!opened.ok) {
      await stop()
      if (opened.reason === 'unconfigured' || opened.reason === 'failed') {
        options.onError?.(opened.error)
      }
      return opened.reason
    }

    return null
  }

  return { state, level, start, stop }
}
