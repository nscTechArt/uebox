/**
 * 听写：把麦克风变成输入法，**只出文字，不出声音**。
 *
 * 全局热键唤起 Spotlight 用的就是这一路。和 `useRealtimeVoice`（语音助手通话）
 * 相比，两者要的东西几乎不重叠：
 *
 * | | 语音助手 | 听写 |
 * |---|---|---|
 * | 会话 | 连续，用户自己挂断 | 一轮说完就收 |
 * | 模型 | 会回话、会调工具 | 只转写 |
 * | 输出 | 音频 + 字幕 + 派活 | 一条 `user-text` |
 * | 播放 | 要 AEC 回环、要播放队列 | 一个扬声器都不开 |
 *
 * 所以这里**没有**复用那 1800 行，只借它的采集 worklet。合进去的代价是那边每
 * 一条「模型在说话吗」的判断都要多带一个「这一路根本不说话」的分支。
 *
 * ## 两条通道，优先走识别那条
 *
 * - **语音识别**（`window.api.speechToText`）：厂商的纯识别接口，豆包 sauc /
 *   阿里百炼 ASR。绑了「语音识别」角色就走它。
 * - **实时语音**（`window.api.realtimeVoice.startDictation`）：借对话会话的转写，
 *   靠 `create_response: false` 把模型的嘴堵上。没绑识别角色时的回落。
 *
 * 优先识别那条，三个理由：便宜（按识别时长计费，不烧对话 token）、快（不用等
 * 一条对话链路握完手）、**而且豆包只有这条走得通** —— 它的全双工接口关不掉
 * 自动应答，于是绑豆包实时语音的用户按下热键只能得到一句「这会儿用不了语音」。
 *
 * 选路由主进程给答案（`speechToText.audioSpec`）：角色绑定只有它读得到。
 */

import { ref, type Ref } from 'vue'
import workletUrl from './pcmCapture.worklet.js?url'
import { mediaPermissionErrorKey } from '@renderer/utils/mediaPermissionError'
import i18n from '@renderer/i18n'

/**
 * 为什么会开不起来。调用方按类别处置：前两类**静默退回打字**，后三类要说给用户听。
 *
 * - `busy`：助手页正在通话。麦克风只有一个，让路而不是抢
 * - `vendor-unsupported`：回落到实时语音那一路，而绑的是豆包 —— 它做不到
 *   「只转写不回答」。**绑一个「语音识别」模型就能绕过这一条**
 * - `unconfigured`：识别和实时语音两个角色都没绑
 * - `failed` / `mic-denied`：连接建不起来 / 麦克风没给权限
 */
export type DictationFailure =
  | 'busy'
  | 'vendor-unsupported'
  | 'unconfigured'
  | 'failed'
  | 'mic-denied'

/**
 * 一条听写通道。两个实现：主进程的语音识别会话、以及实时语音那一路的听写模式。
 *
 * 抽这一层是为了让下面几百行**完全不关心当前连的是哪条** —— 攒首字、判轮次、
 * 收麦克风这些事两条通道一模一样，按通道各写一遍的话，改了一处忘了另一处的
 * 后果是「换个厂商就开始吃字」，而症状不会指向这里。
 */
interface DictationChannel {
  start: () => Promise<
    | { ok: true }
    | {
        ok: false
        reason: 'busy' | 'vendor-unsupported' | 'unconfigured' | 'failed'
        error?: string
      }
  >
  /**
   * 音频到此为止，但**终稿还要**。「按住说话、松开发送」靠它。
   *
   * 两条通道的实现不是一回事：识别那条发收尾包（厂商回完终稿自己关），
   * 实时语音那条发 `input_audio_buffer.commit`（会话还开着）。共同点是
   * **都不该用 `stop` 代替** —— `stop` 一进门就不再放事件，而用户刚说完的
   * 最后一句正好在那之后才到。
   */
  flush: () => Promise<unknown>
  stop: () => Promise<unknown>
  sendAudio: (base64: string) => void
  onEvent: (handler: (payload: unknown) => void) => () => void
}

export type DictationState =
  /** 没在听 */
  | 'idle'
  /** 麦克风开了、连接还在建。**这时候说的话不会丢** —— 攒在 preroll 里 */
  | 'starting'
  /** 厂商就绪，正在听 */
  | 'listening'
  /**
   * 松手了，麦克风已经关掉，正在等最后一句的终稿。
   *
   * 单独一档而不是直接回 idle：界面要能说出「在识别」和「没在听」的区别 ——
   * 都显示成「没在听」的话，用户会以为刚说的最后一句被吞了，于是重说一遍。
   */
  | 'finishing'

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
  /**
   * 松手了：停止采集、告诉厂商说完了、等最后一句的终稿回来，然后收摊。
   *
   * 「按住说话、松开发送」用它，**不要用 `stop`** —— `stop` 会把还在路上的
   * 那条终稿丢掉，表现是松手之后输入框永远少最后一句。
   */
  finish: () => Promise<void>
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
  /**
   * 会话被那一头关掉了（厂商断开、被助手页的通话顶掉），不是我们自己收的尾。
   * 不告诉界面的话，它会一直挂着麦克风图标、写着「正在打开麦克风…」，而其实什么都没在听。
   */
  onClosed?: () => void
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

/**
 * 松手之后最多等厂商这么久出终稿。
 *
 * 比适配器那边的 `STT_FLUSH_GRACE_MS`（2 秒）略大：那一档到点会主动把会话关掉，
 * 关掉就会有 `closed` 事件把这里叫醒。反过来给小了的话，这边先超时收摊，
 * 而终稿在两百毫秒后才到 —— 那句话就白说了。
 *
 * 到点也不是白等：有多少交多少。卡在「正在识别」不动比少一句话更糟，
 * 用户完全没法判断该等还是该重说。
 */
const FINISH_TIMEOUT_MS = 2_500

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
  /**
   * 这一轮走的是哪条通道。
   *
   * 开会话时定下来，收尾时照它去关 —— **不能在收尾时再判一次**：用户可能在
   * 说话这几秒里改了模型绑定，那样关掉的就是另一条通道上的会话，而自己这条
   * 留在主进程里一直开着。
   */
  let channel: DictationChannel | null = null
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  /** 响度的发布节流。理由见 `LEVEL_PUBLISH_MS` */
  let levelPeak = 0
  let levelPublishedAt = 0
  /**
   * `finish()` 正等着终稿。厂商把会话关掉时由 `handleEvent` 叫醒它。
   *
   * 用一个回调而不是轮询 `state`：终稿到手和会话关闭之间只隔几毫秒，
   * 轮询的那个间隔全都是白等，而这一路等的就是「松手到发出去」那点时间。
   */
  let settleFinish: (() => void) | null = null
  /**
   * `finish()` 在等厂商就绪。松手时 `ready` 还没来的话，这之前说的话全攒在 preroll 里；
   * 这时候就发收尾包，适配器会直接把会话关掉（socket 还没开 / 任务还没开始），
   * 那句话整句丢掉。所以先等 `ready` 把 preroll 补发出去，再收尾。
   */
  let settleReady: (() => void) | null = null
  /** 正在开的那一轮。松手时会话还没开好，`finish()` 得等它开完再收尾，不能直接当没开过 */
  let pendingStart: Promise<DictationFailure | null> | null = null

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

  /**
   * 松手了：停止采集、告诉厂商说完了、**等那条终稿回来**，然后才收摊。
   *
   * ## 为什么不能直接 `stop`
   *
   * 用户松开热键的那一刻，最后一句话还在厂商那边转写。`stop` 一进门就不再放
   * 事件，于是输入框里永远少最后一句 —— 而且一声不吭，用户只会以为自己没说清。
   *
   * ## 为什么要先把麦克风关掉
   *
   * 收尾包发出去之后再送音频，厂商会当协议错误。而松手到收摊之间还有一两包
   * 在路上（worklet 20ms 一包）。两头都挡了一道：这里停采集，适配器那边
   * `flushed` 之后也不再往外发。
   *
   * ## 超时是必须的
   *
   * 终稿可能永远不来（网断了、厂商吞了）。卡在「正在识别」不动比少一句话更糟 ——
   * 用户完全没法判断该等还是该重说。所以到点就收，有多少交多少。
   */
  async function finish(): Promise<void> {
    // 按得很短：会话还在开（连接 IPC 没回来）。等它开完 —— 直接当没开过收掉的话，
    // 这一句话连同主进程那头刚开好的会话一起没了
    if (pendingStart && state.value === 'starting' && !ownsSession) {
      const startedAt = generation
      await pendingStart.catch(() => null)
      if (generation !== startedAt) return
    }
    if (state.value === 'idle' || !ownsSession) {
      await stop()
      return
    }
    state.value = 'finishing'
    // 先断采集：收尾包之后再送音频是协议错误
    await releaseAudio()

    const currentGeneration = generation
    if (!vendorReady) {
      // 见 `settleReady`：先等厂商就绪、把攒着的音频补发出去，再收尾
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          settleReady = null
          resolve()
        }, READY_TIMEOUT_MS)
        settleReady = () => {
          clearTimeout(timer)
          settleReady = null
          resolve()
        }
      })
      if (generation !== currentGeneration) return
    }
    await channel?.flush().catch(() => undefined)
    if (generation !== currentGeneration) return

    /*
     * 等终稿。两个出口：厂商回完终稿把会话关了（`handleEvent` 的 `closed`
     * 会来叫 `settleFinish`），或者到点了。
     */
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        settleFinish = null
        resolve()
      }, FINISH_TIMEOUT_MS)
      settleFinish = () => {
        clearTimeout(timer)
        settleFinish = null
        resolve()
      }
    })

    // 这几百毫秒里用户又按了一次热键，新一轮已经开起来了 —— 别去关它
    if (generation !== currentGeneration) return
    await stop()
  }

  async function stop(): Promise<void> {
    generation += 1
    vendorReady = false
    preroll = []
    if (readyTimer) clearTimeout(readyTimer)
    readyTimer = null
    unsubscribe?.()
    unsubscribe = null
    // 还在等终稿 / 等就绪的那个 Promise 得放掉，否则它会一直挂到超时
    settleFinish?.()
    settleReady?.()
    state.value = 'idle'
    await releaseAudio()
    // 没开过就不去关。理由见 `ownsSession`
    if (!ownsSession) return
    ownsSession = false
    const opened = channel
    channel = null
    await opened?.stop().catch(() => undefined)
  }

  function handleEvent(payload: unknown, currentGeneration: number): void {
    if (generation !== currentGeneration) return
    const event = payload as { type?: string; text?: string; final?: boolean; message?: string }

    switch (event.type) {
      case 'ready':
        vendorReady = true
        if (readyTimer) clearTimeout(readyTimer)
        readyTimer = null
        // 已经松手在收尾的话别改回「在听」：麦克风早关了，`finish()` 正等着这一下
        if (state.value !== 'finishing') state.value = 'listening'
        // 攒着的先补发，顺序不能乱 —— 乱了就是一句话被重排过的词
        for (const packet of preroll) channel?.sendAudio(packet)
        preroll = []
        settleReady?.()
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
      case 'closed': {
        // `finish()` 正等着的就是这一下：终稿已经在上面那个 case 里交出去了
        const expected = state.value === 'finishing'
        settleFinish?.()
        void stop()
        if (!expected) options.onClosed?.()
        break
      }
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
        channel?.sendAudio(packet)
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

  /** 语音识别那条。主进程已经在 `audioSpec` 里确认过角色绑着了 */
  function sttChannel(): DictationChannel {
    const api = window.api.speechToText
    return {
      start: () => api.start(),
      // 收尾包发出去，但会话留着等终稿 —— 用 `stop` 的话那条终稿会被丢掉
      flush: () => api.flush(),
      stop: () => api.stop(),
      sendAudio: api.sendAudio,
      onEvent: api.onEvent
    }
  }

  /** 实时语音那条。没绑识别角色时的回落，行为与这一档出现之前一致 */
  function realtimeChannel(): DictationChannel {
    const api = window.api.realtimeVoice
    return {
      start: () => api.startDictation(),
      // 别等那档 900ms 的静音判停，现在就转写
      flush: () => api.commitAudio(),
      stop: () => api.stop(),
      sendAudio: api.sendAudio,
      onEvent: api.onEvent
    }
  }

  /**
   * 选通道，顺带把上行采样率问出来。
   *
   * 两件事一次问完：它们的答案来自主进程的同一次配置读取，而调用方正等着
   * 拿采样率去开麦克风 —— 多一次 IPC 往返就是多几十毫秒的首字延迟。
   */
  async function pickChannel(): Promise<{ channel: DictationChannel; sampleRate: number }> {
    const spec = await window.api.speechToText.audioSpec()
    if (spec.ok) return { channel: sttChannel(), sampleRate: spec.inputSampleRate }
    const fallback = await window.api.realtimeVoice.audioSpec()
    // 问不出来就按 24k 开麦：OpenAI 那家两头都是 24k，豆包进 16k ——
    // 而问不出来的场合（没绑模型）下一步就会失败，采样率用不上了
    return {
      channel: realtimeChannel(),
      sampleRate: fallback.ok ? fallback.inputSampleRate : 24_000
    }
  }

  function start(): Promise<DictationFailure | null> {
    const run = runStart()
    pendingStart = run
    void run.finally(() => {
      if (pendingStart === run) pendingStart = null
    })
    return run
  }

  async function runStart(): Promise<DictationFailure | null> {
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
    const picked = await pickChannel()
    if (generation !== currentGeneration) return null
    channel = picked.channel

    try {
      await openMicrophone(picked.sampleRate, currentGeneration)
    } catch (error) {
      await stop()
      const key = mediaPermissionErrorKey(error, 'microphone', window.api.platform)
      options.onError?.(key ? i18n.global.t(key) : String(error))
      return 'mic-denied'
    }
    if (generation !== currentGeneration) return null

    unsubscribe = picked.channel.onEvent((payload) => handleEvent(payload, currentGeneration))

    const opened = await picked.channel.start()
    if (!opened.ok) {
      if (generation !== currentGeneration) return null
      await stop()
      /*
       * 识别那条回 `unconfigured` 只可能是**这几百毫秒里用户把绑定改掉了**
       * （`audioSpec` 刚说过它绑着）。没有专门的话可说，按「用不了」处理 ——
       * 再自动回落一次实时语音的话，还得防住「两边都说没绑」的死循环，
       * 而这个场合罕见到不值得为它多一条永远测不到的分支。
       */
      if (opened.reason === 'unconfigured' || opened.reason === 'failed') {
        options.onError?.(opened.error || i18n.global.t('spotlightWindow.dictation.unavailable'))
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
    if (generation !== currentGeneration) {
      // 被收掉而**没有**新一轮接手（按了 Esc、短按松手）：没人会再来关它，这里关。
      // 不关的话主进程那头一直开着，下一次热键会被自己挡成「正忙」
      // `state` 在上面那几个 await 期间可能被 stop() 改回 idle，TS 的收窄看不见这一点
      if ((state.value as string) === 'idle') {
        ownsSession = false
        if (channel === picked.channel) channel = null
        await picked.channel.stop().catch(() => undefined)
      }
      return null
    }

    // 厂商迟迟不 ready 就收摊，别留一个亮着录音灯的死会话（见 READY_TIMEOUT_MS）
    readyTimer = setTimeout(() => {
      if (generation !== currentGeneration || vendorReady) return
      void stop()
      options.onError?.(i18n.global.t('spotlightWindow.dictation.unavailable'))
    }, READY_TIMEOUT_MS)

    return null
  }

  return { state, level, start, finish, stop }
}
