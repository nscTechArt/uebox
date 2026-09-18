import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { pairConversationHistory } from './conversationHistory'
import { DOUBAO_DEFAULT_REALTIME_VOICE, isDoubaoRealtimeBaseUrl } from '../../../shared/aiProvider'
import type {
  AudioSpec,
  RealtimeConversationMessage,
  RealtimeSessionConfig,
  VoiceSessionEvent,
  VoiceSessionHandle
} from './types'

/**
 * 豆包实时语音 3.0（Seeduplex）会话。
 *
 * ## 好消息：不用碰二进制协议
 *
 * 2.0 那代是自定义的二进制帧（header + event + sessionId + payload）。3.0 换成了
 * **纯 JSON 文本帧**，而且事件语义有意对齐了 OpenAI Realtime ——
 * `input_audio_buffer.append`、`response.output_audio.delta`、`response.done`
 * 这些名字两边一模一样，二进制编解码在这条链路上一行都用不上。
 *
 * ## 但同构不等于同形，四处差异
 *
 * 1. **首帧是 `session.create` 而不是 `session.update`**，而且 model 在
 *    `session.model` 里（固定 `1.2.6.1`），不在 URL 上
 * 2. **进 16k、出 24k**。OpenAI 两头都是 24k。用一个数糊过去，一边必然变调
 * 3. **工具结果的形状不一样**：这边是 `items[]`，每项 `role: 'tool'` +
 *    `content: [{type:'input_text'}]`，而且同一轮的多个调用要**聚合成一条**回传；
 *    OpenAI 那边是 `item.type = 'function_call_output'` + `output` 字符串
 * 4. **必须先 `session.close` 收到回复再断**，直接关 WebSocket 会被判成
 *    `ContextCanceled`（55000001）
 *
 * 还有一条不在代码里但会咬人的：全双工靠上行音频流保活。麦克风关掉之后如果
 * 不再发帧，服务端会因为收不到输入而超时（45000003）。我们的做法是**关麦即关会话**，
 * 所以用不上 `input_audio_mute.commit` —— 真要做「暂时静音但不挂断」时才需要它。
 *
 * @see 端到端实时语音大模型 API（全双工版本）
 */

const DEFAULT_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'

/** 全双工版本固定这一个。选路不再走 `extension.dialog.extra` */
export const DOUBAO_REALTIME_MODEL = '1.2.6.1'

/** 兼容原有调用名；现在它只负责老配置回落，正常值由模型设置传入。 */
export const DOUBAO_DEFAULT_VOICE = DOUBAO_DEFAULT_REALTIME_VOICE

/** 豆包的 `pcm` 下行是 Float32；播放器要 Int16，必须明确请求这一种 */
export const DOUBAO_OUTPUT_FORMAT = 'pcm_s16le'

/**
 * 上行积压超过这么多字节就开始丢包。
 *
 * 16kHz 的 PCM16 一秒是 32000 字节，base64 之后约 42.7KB —— 六万字节大约是
 * **一秒半**的音频。正常情况下这个值永远是 0：一有积压就说明发送端已经跟不上，
 * 而音频恒速产生，积压只会越滚越大（见 `perMessageDeflate`）。
 */
export const UPLINK_BACKLOG_LIMIT = 60_000

/** 进 16k 出 24k。这两个数是文档写死的，不是可调项 */
export const DOUBAO_AUDIO: AudioSpec = { inputSampleRate: 16_000, outputSampleRate: 24_000 }

/** 认出这是不是豆包的地址。用户可能填带路径的全址，也可能只填域名 */
export function isDoubaoRealtimeUrl(baseUrl: string): boolean {
  return isDoubaoRealtimeBaseUrl(baseUrl)
}

/** Provider 通常只保存域名；也兼容用户直接填完整 WebSocket 地址 */
export function resolveDoubaoRealtimeUrl(baseUrl?: string): string {
  const url = (baseUrl?.trim() || DEFAULT_URL).replace(/^http/i, 'ws').replace(/\/+$/, '')
  return /\/api\/v3\/duplex\/realtime\/dialogue$/i.test(url)
    ? url
    : `${url}/api/v3/duplex/realtime/dialogue`
}

/** 单独构造首帧，防止必填协议字段在没有真实 WebSocket 的单测里漏检 */
export function buildDoubaoSessionCreate(config: RealtimeSessionConfig): Record<string, unknown> {
  return {
    type: 'session.create',
    event_id: randomUUID(),
    session: {
      model: config.model || DOUBAO_REALTIME_MODEL,
      instructions: config.instructions,
      audio: {
        input: { format: { type: 'pcm', rate: DOUBAO_AUDIO.inputSampleRate } },
        output: {
          // 这里不能写 `pcm`：官方 Demo 明确把它按 Float32 播放。我们统一用
          // Int16 little-endian，避免把每个 Float32 样本拆成两段后产生强噪声。
          format: { type: DOUBAO_OUTPUT_FORMAT, rate: DOUBAO_AUDIO.outputSampleRate },
          voice: config.voice || DOUBAO_DEFAULT_VOICE
        }
      },
      tools: config.tools.map((tool) => ({ type: 'function', ...tool }))
    }
  }
}

/**
 * 灌历史之前先配对。
 *
 * 文档对 `conversation.item.create` 的硬要求：**上下文须按 user/assistant 成对提交，
 * 数组长度为偶数**，一次最多 20 轮（40 条）。而我们的来源是聊天界面的最近若干条 ——
 * 它可能以 assistant 开头（截断截在半路）、可能连着两条同角色（Agent 一轮说了两段）。
 *
 * 不配对会怎样文档没写，只说了「须」。这类约束违反了通常不报错，
 * 而是让整条会话行为古怪 —— 所以宁可少灌几条，也不送畸形的进去。
 *
 * 连续同角色内容合并；缺失的一侧使用明确的传递状态，不丢掉最终答复或未完成的用户请求。
 */
export function pairDoubaoHistory(
  messages: RealtimeConversationMessage[]
): RealtimeConversationMessage[] {
  return pairConversationHistory(messages).slice(-20).flat()
}

/** 豆包一次最多接 40 条上下文；调用方已经裁过，这里只负责协议形状。 */
export function buildDoubaoConversationCreate(
  messages: RealtimeConversationMessage[]
): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    event_id: randomUUID(),
    items: messages.map((message) => ({
      id: randomUUID(),
      type: 'message',
      role: message.role,
      content: [{ type: 'input_text', text: message.text }]
    }))
  }
}

/**
 * 一次播报要进上下文的那一帧。
 *
 * 成对送：user 是「[系统通知] …」，assistant 是随后念出的那句。文档对
 * `conversation.item.create` 的硬要求是 user/assistant 成对、长度为偶数
 * （见 `pairDoubaoHistory`）；成对送还让模型记得「这句话是我说的」，下一轮接得上。
 * 会话中途发这一帧服务端回 `conversation.item.added`，真机验过。
 */
export function buildDoubaoAnnouncement(notice: {
  speech: string
  context: string
}): Record<string, unknown> {
  return buildDoubaoConversationCreate([
    { role: 'user', text: notice.context },
    { role: 'assistant', text: notice.speech }
  ])
}

/**
 * 让豆包用它自己的嗓音念一段话 —— 文档里叫「打招呼」。
 *
 * 全双工文档给了两条「指定文本合成音频」的路，字段都核对过：
 *
 * | 事件                                          | 文档定位                                   | 真机                                                 |
 * | --------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
 * | `speech_text_buffer.replacement.append/commit` | 干预模型回复：不要模型闲聊结果、替换成指定文本 | 平时发出去只回 `conversation.item.added`，没有音频   |
 * | `speech_text_buffer.commit` + `text`           | 打招呼：一次性念一段话，示例下行就是音频三件套 | 会话中途发管不管用**还没验过** —— 所以配了本机兜底   |
 *
 * 上一版用的是前者，那是替换模型回答用的，不在用户刚说完的窗口里发就石沉大海。
 */
export function buildDoubaoGreeting(text: string): Record<string, unknown> {
  return { type: 'speech_text_buffer.commit', event_id: randomUUID(), text }
}

/**
 * 发了「打招呼」之后最多等这么久。等不到豆包的音频就退回本机语音合成念。
 *
 * 两秒半：豆包首包音频通常几百毫秒就到；再长用户会觉得「它怎么不说话」。
 */
export const ANNOUNCE_FALLBACK_MS = 2_500

/**
 * 这一帧是不是「豆包开始念我们给的话」。
 *
 * 用 `tts_type` 区分：模型自己答用户的是 `default`，联网播报是 `network`，
 * 安全审核是 `audit_content_risky`；剩下的（`chat_tts_text`，打招呼示例里是空串）
 * 才是客户文本合成。分不清的话，用户恰好在这两秒半里问了句话，模型答他的那段音频
 * 会被当成「豆包念了通知」，通知就丢了。
 */
export function isVendorSpeechStart(event: Record<string, unknown>): boolean {
  if (event.type !== 'response.output_audio.started') return false
  const ttsType = String(event.tts_type ?? '')
  return ttsType !== 'default' && ttsType !== 'network' && ttsType !== 'audit_content_risky'
}

/** 每秒几十条的那几种不打，其余每条都留一行 —— 这一层的故障全是「安静」，没日志只能猜 */
const NOISY_EVENTS = new Set([
  'input_audio_buffer.append',
  'response.output_audio.delta',
  'response.output_text.delta',
  'conversation.item.input_audio_transcription.delta'
])

/** 带毫秒的时刻。排「说了之后十几秒才响应」这类问题，没有时间戳的日志等于没有 */
export function stamp(): string {
  return new Date().toISOString().slice(11, 23)
}

function logFrame(direction: '↑' | '↓', event: Record<string, unknown>): void {
  const type = String(event.type || '?')
  if (NOISY_EVENTS.has(type)) return
  // 报错把整包打出来：错误码和原因藏在哪一层各版本不一样
  const detail = type === 'error' || type.endsWith('.failed') ? ` ${JSON.stringify(event)}` : ''
  console.log(`[豆包实时语音 ${stamp()}] ${direction} ${type}${detail}`)
}

export function openDoubaoRealtimeSession(config: RealtimeSessionConfig): VoiceSessionHandle {
  const socket = new WebSocket(resolveDoubaoRealtimeUrl(config.baseUrl), {
    headers: {
      // 新版控制台的 API Key，单个值 —— 不是老接口那套 appid + access token
      'X-Api-Key': config.apiKey,
      // 服务端拿它把一条连接上的所有事件串起来，排查时和 X-Tt-Logid 配合用
      'X-Api-Connect-Id': randomUUID()
    },
    /*
     * **必须关掉压缩。**
     *
     * `ws` 客户端默认开 permessage-deflate（`options.perMessageDeflate=true`），
     * 而它压一条消息要走一次 zlib 的异步回调；**压的期间后面的 send 全排队**。
     * 上行音频是 20 毫秒一包、每秒 50 条 —— 只要主进程的事件循环偶尔忙上几十毫秒，
     * 这个队列就有进无出地涨，而且**永远不会自己追回来**（音频是恒速产生的）。
     *
     * 真机上的样子正是这一条：安静坐着不说话，队列照样按时间线性堆高，
     * 四十秒之后开口，服务端要把前面攒下的十几秒音频先吃完才轮到这句话 ——
     * 表现是「说了之后十几秒才识别」，而日志里一条错都没有。
     *
     * 压缩本来也没什么可省的：包体是 base64 的 PCM，压不动。ws 自己的文档也写着
     * 压缩会显著拖慢吞吐、不建议开。
     */
    perMessageDeflate: false
  })

  let closed = false
  /** 上一次报「上行积压」的时刻。每秒最多报一行，别把日志刷满 */
  let lastBacklogWarnAt = 0
  /** 已经发过 session.close、正在等回复。等到了才真的断 */
  let closing = false
  /**
   * 发出去、还没等到豆包开口的那条播报。等到音频就清掉；超时就让渲染层本机念。
   * 一次只有一条 —— 任务表本来就一次只放一条播报。
   */
  let pendingSpeech: { text: string; timer: NodeJS.Timeout } | null = null

  const settlePendingSpeech = (spokenByVendor: boolean): void => {
    if (!pendingSpeech) return
    const { text, timer } = pendingSpeech
    clearTimeout(timer)
    pendingSpeech = null
    if (spokenByVendor) {
      console.log(`[豆包实时语音 ${stamp()}] 播报由豆包念出：`, text)
      return
    }
    console.log(`[豆包实时语音 ${stamp()}] 等不到豆包的音频，改由本机念：`, text)
    config.onEvent({ type: 'speak', text })
  }

  const send = (payload: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    logFrame('↑', payload as Record<string, unknown>)
    socket.send(JSON.stringify(payload))
  }

  socket.on('open', () => {
    send(buildDoubaoSessionCreate(config))
  })

  socket.on('message', (raw: Buffer) => {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(raw.toString('utf-8'))
    } catch {
      config.onEvent({ type: 'error', message: '返回的不是 JSON' })
      return
    }

    logFrame('↓', event)

    // 豆包开始念我们给的那句了，本机就不用念
    if (pendingSpeech && isVendorSpeechStart(event)) settlePendingSpeech(true)

    // 优雅关闭的第二步：收到回执才真的断。直接 close 会拿到 ContextCanceled
    if (event.type === 'session.closed') {
      socket.close()
      return
    }

    if (event.type === 'session.created') {
      const history = pairDoubaoHistory(config.history || [])
      if (history.length > 0) send(buildDoubaoConversationCreate(history))
    }

    for (const translated of translateDoubao(event)) config.onEvent(translated)
  })

  socket.on('error', (error) => {
    config.onEvent({ type: 'error', message: `连接失败：${error.message}` })
  })

  socket.on('close', () => {
    closed = true
    // 连接没了，挂着的那条播报也不用等了。不本机念：会话已经结束，没人在听
    if (pendingSpeech) clearTimeout(pendingSpeech.timer)
    pendingSpeech = null
    config.onEvent({ type: 'closed' })
  })

  return {
    appendAudio(base64) {
      /*
       * 发不出去就**丢**，不排队。
       *
       * 音频是恒速产生的：一旦发送端跟不上（网络抖、事件循环忙），排队的那些
       * 只会越积越多，服务端永远在听十几秒前的声音 —— 用户看到的是「说完好久才识别」。
       * 实时语音里迟到的音频没有价值，丢掉最近这一包换回同步是划算的。
       */
      if (socket.bufferedAmount > UPLINK_BACKLOG_LIMIT) {
        const now = Date.now()
        if (now - lastBacklogWarnAt > 1_000) {
          lastBacklogWarnAt = now
          console.warn(
            `[豆包实时语音 ${stamp()}] 上行积压 ${socket.bufferedAmount} 字节，丢弃这一包音频`
          )
        }
        return
      }
      send({ type: 'input_audio_buffer.append', event_id: randomUUID(), audio: base64 })
    },
    sendText(text) {
      /*
       * **只进上下文，不会让模型开口。**
       *
       * 3.0 的上行事件表里没有 `response.create`，`conversation.item.create`
       * 等价于旧版的 `ConversationCreate`，职责就是上下文管理。这一家的模型
       * 只由**音频**驱动生成，所以键入的这句话要等用户下次开口那一轮才被看见。
       *
       * 主动出声走 `announce`，那条路是 TTS 直合成，不经过模型生成。
       */
      send(buildDoubaoConversationCreate([{ role: 'user', text }]))
    },
    announce(notice) {
      // 先进上下文（成对，见 `buildDoubaoAnnouncement`），模型才记得发生了什么
      send(buildDoubaoAnnouncement(notice))
      // 原话写进「语音助手」对话 —— 念出来的每一句用户都该在屏幕上看得到
      config.onEvent({ type: 'announced', text: notice.speech })

      /*
       * 再念出声。先让豆包用它自己的嗓音念（「打招呼」事件，见 `buildDoubaoGreeting`），
       * 等不到它的音频再退回本机语音合成 —— 逐字念我们写好的话，两条路都不给模型
       * 把「失败了」说成「已经改好了」的机会。
       *
       * 连接没开就直接本机念：发出去也没人收。
       */
      if (socket.readyState !== WebSocket.OPEN) {
        config.onEvent({ type: 'speak', text: notice.speech })
        return
      }
      // 上一条还没等到结果就来了新的（不该发生，任务表一次只放一条）：先把上一条落定
      settlePendingSpeech(false)
      pendingSpeech = {
        text: notice.speech,
        timer: setTimeout(() => settlePendingSpeech(false), ANNOUNCE_FALLBACK_MS)
      }
      send(buildDoubaoGreeting(notice.speech))
    },
    /**
     * 用户插话，掐掉服务端这一轮。
     *
     * 旧版叫 `ClientInterrupt`，文档写的用途正是「客户端主动打断服务端播报，
     * 便于进行下一次识别」。缺了这一条，本地把扬声器掐了也没用 ——
     * 服务端照样把整轮生成完，音频分片继续往这边推。
     */
    cancelResponse() {
      send({ type: 'response.cancel', event_id: randomUUID() })
    },
    sendToolResults(results) {
      if (results.length === 0) return
      /*
       * 一条里带上这一轮的**全部**结果。
       *
       * 文档明写：全部回传完成后模型才会继续。分成多条发的话，模型会一直等
       * 那些它认为还没回来的 —— 表现是「说完一句就再也不理人了」。
       */
      send({
        type: 'conversation.item.create',
        event_id: randomUUID(),
        items: results.map((item) => ({
          call_id: item.callId,
          role: 'tool',
          content: [{ type: 'input_text', text: item.output }]
        }))
      })
    },
    close() {
      if (closed || closing) return
      closing = true
      send({ type: 'session.close', event_id: randomUUID() })
      // 服务端不回执时的兜底：等两秒就硬断，不能让连接（和账单）挂在那儿
      setTimeout(() => {
        if (!closed) socket.close()
      }, 2000)
    }
  }
}

/**
 * 豆包事件 → 我们的形状。
 *
 * 导出**只为可测**：这一层错了不会报错，只是某一类信息永远不出现
 * （没有声音、没有字幕、或者工具永远不触发）。
 */
export function translateDoubao(event: Record<string, unknown>): VoiceSessionEvent[] {
  const type = String(event.type || '')

  switch (type) {
    case 'session.created':
      return [{ type: 'ready' }]

    case 'response.output_audio.delta':
      return typeof event.delta === 'string' ? [{ type: 'audio', base64: event.delta }] : []

    case 'response.output_text.delta':
      return typeof event.delta === 'string' ? [{ type: 'assistant-text', text: event.delta }] : []

    /*
     * 识别一开始就意味着用户在说话 —— 这就是打断信号。
     * demo 里也是收到它立刻停掉播报。
     */
    case 'conversation.item.input_audio_transcription.started':
      return [{ type: 'interrupted' }]

    case 'conversation.item.input_audio_transcription.delta':
      return typeof event.delta === 'string'
        ? [{ type: 'user-text', text: event.delta, final: false }]
        : []

    case 'conversation.item.input_audio_transcription.completed': {
      // 这一家把最终文本放在 transcript 或 text 上，两个都见过
      const text = event.transcript ?? event.text
      return typeof text === 'string' ? [{ type: 'user-text', text, final: true }] : []
    }

    /*
     * 识别失败。**必须说出来**，不能像以前那样掉进 default 里。
     *
     * 掉进 default 的表现是：用户对着麦克风说话，界面一点动静都没有，
     * 他不知道是没听见、还是在想、还是坏了 —— 只能一直重复说。
     * 这是最难自查的一类故障，因为日志里也是一片安静。
     */
    case 'conversation.item.input_audio_transcription.failed':
      return [{ type: 'asr-failed' }]

    /*
     * 工具调用是**独立事件**，不像 OpenAI 藏在 response.done 里。
     *
     * `items` 可能是数组也可能是单个对象（demo 里就两种都兼容），
     * 而且一次可能有多个调用 —— 少处理一个，模型就永远等它。
     */
    case 'response.function_call_arguments.done': {
      const raw = event.items
      const items = Array.isArray(raw) ? raw : raw ? [raw] : []
      return items
        .map((item) => item as { call_id?: string; name?: string; arguments?: string })
        .filter((item) => item.call_id && item.name)
        .map((item) => ({
          type: 'tool-call',
          callId: item.call_id as string,
          name: item.name as string,
          args: item.arguments || '{}'
        }))
    }

    /*
     * 回合结束有**两个**事件，两个都要认。
     *
     * `response.output_audio.done` 是「音频播完了」，`response.done` 是「这一轮结束」。
     * 只认前者的话，**没有音频的那种回合永远不算结束** —— 比如模型这一轮只调了工具
     * 没说话。后果是「谁在说话」永远停在「模型在说」，中间进度从此再也播不出来，
     * 界面的状态球也一直转。两个都收，重复一次是无害的（收尾是幂等的）。
     */
    case 'response.output_audio.done':
    case 'response.done':
      return [{ type: 'turn-done' }]

    // 打断的回执。这一轮到此为止，场子空出来了
    case 'response.canceled':
      return [{ type: 'turn-done' }]

    case 'error': {
      // 错误码与关键字都可能在顶层，也可能包在 error 里
      const error = (event.error ?? event) as { message?: unknown; code?: unknown }
      const code = error.code ? `${error.code}：` : ''
      const message = typeof error.message === 'string' ? error.message : '厂商返回错误'
      return [{ type: 'error', message: `${code}${message}` }]
    }

    default:
      // 会话更新、conversation.item.added…… 对我们没有意义。
      // 每一帧都已经在 socket 那层留了日志（`logFrame`），这里不重复打
      return []
  }
}
