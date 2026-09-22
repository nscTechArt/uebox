import WebSocket from 'ws'
import {
  normalizeRealtimeEchoGuard,
  type RealtimeEchoGuard
} from '../../../shared/realtimeEchoGuard'
import type {
  AudioSpec,
  RealtimeConversationMessage,
  RealtimeSessionConfig,
  VoiceSessionEvent,
  VoiceSessionHandle
} from './types'

/**
 * OpenAI Realtime 会话（语音进、语音出、中途能调工具）。
 *
 * ## 为什么是 WebSocket 而不是 WebRTC
 *
 * 官方两条路都给：WebRTC 走浏览器、WebSocket 走服务端。选后者是因为**另一头**：
 * 豆包的端到端实时语音只有 WebSocket 一种接法。两家共用一条传输，就只有一套
 * 音频管道、一套工具分发、一个放密钥的地方；各走各的则要在主进程和渲染层
 * 各维护半套，而其中一半还只服务一家。
 *
 * 附带的好处是密钥根本不用出主进程 —— WebRTC 那条路要先去
 * `/v1/realtime/client_secrets` 换一个临时令牌再交给渲染层，多一次往返、多一个
 * 会过期的东西要管。
 *
 * 代价写在这儿：WebSocket 走 TCP，丢包时会队头阻塞，网络差的时候比 WebRTC 更容易
 * 卡顿。桌面端接的多半是有线或稳定 Wi-Fi，先按这个前提做；真出现卡顿再说。
 *
 * ## 边界
 *
 * 这一层**只管连接与协议**：把音频送上去、把事件翻译成我们自己的形状。
 * 工具真正怎么执行、要不要先问用户，都不在这儿 —— 见 ipc/realtimeVoice.ts。
 *
 * @see https://developers.openai.com/api/docs/guides/realtime-websocket
 * @see https://developers.openai.com/api/docs/guides/realtime-conversations
 */

/**
 * 进出都是 24kHz。
 *
 * 这是 Realtime 这一家收发两侧的规格，不是可选项 —— 送 16k 进去，
 * 对面按 24k 解，听到的是一段变调的快放。
 */
export const OPENAI_AUDIO: AudioSpec = { inputSampleRate: 24_000, outputSampleRate: 24_000 }

const DEFAULT_BASE_URL = 'wss://api.openai.com/v1/realtime'

/**
 * 用哪个模型转写**用户说的话**。
 *
 * GA 把它做成了**选填**：不给 `audio.input.transcription`，整条链路照常工作，
 * 只是一条 `conversation.item.input_audio_transcription.*` 都不发。
 * 少了它有两处后果，而且没有任何报错：
 *
 * 1. 界面上**看不到用户说了什么**（豆包那家默认就转写，所以只有这家有这个坑）
 * 2. 更狠的一条 —— 渲染层「打断后丢弃在途残片」的出口就是识别结果，
 *    识别永远不来，那个开关只能等三秒兜底，而一句短回答的音频往往还没三秒长，
 *    于是**模型答了、字幕也有，就是一点声音都没有**
 *
 * 选 mini 那档：比 `whisper-1` 中文准，价钱又低于 `gpt-4o-transcribe`。
 * 自建网关如果不认这个名字，服务端会回一条 error 说清楚，换成 `whisper-1` 即可。
 *
 * @see https://developers.openai.com/api/docs/guides/realtime-transcription
 */
export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'

/**
 * 三档回声门限各自发什么。
 *
 * 档位的含义和「为什么是三档」在 `shared/realtimeEchoGuard.ts`，这里只管数值。
 *
 * - `threshold`：服务端 VAD 的判开口门限，默认 0.5。本地 AEC 压不干净的那点残留
 *   正好顶得过 0.5 —— 外放的桌面上把它抬到 0.65 是这一整项改动的主要作用。
 *   再高的代价是用户小声说话时要多说半个字才被听见，所以不做成「越高越好」。
 * - `noise_reduction`：服务端在 VAD 和转写**之前**做的降噪。`far_field` 就是为
 *   「音箱外放、麦克风离嘴远」这个场景调的，`near_field` 给耳机和领夹麦。
 *   不给这个字段则整个降噪都不开 —— 之前就是这样。
 *
 * @see https://developers.openai.com/api/docs/guides/realtime-vad
 */
export const OPENAI_ECHO_GUARD_TUNING: Record<
  RealtimeEchoGuard,
  { threshold: number; noiseReduction: 'near_field' | 'far_field' }
> = {
  headset: { threshold: 0.5, noiseReduction: 'near_field' },
  speaker: { threshold: 0.65, noiseReduction: 'far_field' },
  strong: { threshold: 0.8, noiseReduction: 'far_field' }
}

/**
 * 听写模式的判停参数。
 *
 * 通话和听写要的判停不是一回事，所以不复用那一档默认值：
 *
 * - `silence_duration_ms`：厂商默认 500ms。对话里这是对的 —— 半秒不吭声就该轮到
 *   模型接话。但听写是**说一条指令**，中间停下来想词是常态（「把这个……呃……
 *   选中的 actor 缩放两倍」）。500ms 会把它切成两轮，于是输入框里先出现半句、
 *   两秒倒计时跑完直接提交，后半句还没说完就已经派给 Agent 了。900ms 是
 *   「想词的停顿」和「说完了」之间比较稳的一条线。
 * - `prefix_padding_ms`：判定开口之前倒回来多带这么久的音频。厂商默认就是 300ms，
 *   这里显式写出来是因为听写没有第二次机会 —— 通话里第一个字被吃掉还能从上下文
 *   猜出来，听写吃掉的是「删掉」的「删」。
 * - `create_response: false`：**这一条是听写模式的全部意义**。不关的话服务端判停
 *   即应答，用户对着一个还没提交的输入框被模型抢答。
 */
export const OPENAI_DICTATION_TURN_DETECTION = {
  silenceDurationMs: 900,
  prefixPaddingMs: 300
} as const

/**
 * 喂给转写模型的领域词表。
 *
 * `transcription.prompt` 影响的是**识别**，和 `session.instructions` 不是一回事 ——
 * 后者只管模型怎么回话，而听写模式下模型根本不回话。
 *
 * 为什么值得给：这一路收到的几乎全是虚幻的行话，而且多半是中英混着说的
 * （「把这个 actor 缩放两倍」「打开那个蓝图」）。不给词表时「actor」稳定被写成
 * 「阿克特」、「蓝图」写成「蓝色图」—— 转写错了 Agent 就照错的干，
 * 而用户在输入框里看到的是一句不知所云的话。
 *
 * 只列**高频且容易听错**的，不是把术语表倒进来：prompt 越长，转写越容易
 * 往词表上硬凑，把没说过的词也认出来。
 */
export const OPENAI_DICTATION_PROMPT =
  '虚幻引擎操作指令。常见词汇：actor、蓝图、关卡、材质、贴图、静态网格体、骨骼网格体、' +
  '序列器、大纲视图、细节面板、视口、缩放、旋转、位移、变换、导入、烘焙、编译、播放。'

/**
 * 首帧单独构造，**为的是能在没有真实 WebSocket 的单测里检查必填字段**。
 *
 * 这一层的故障全都是安静的：字段错了照样连得上、不报错，只是某一类信息永远不出现。
 * 只有把首帧钉在测试里才发现得了。
 */
export function buildOpenAiSessionUpdate(config: RealtimeSessionConfig): Record<string, unknown> {
  const echoGuard = OPENAI_ECHO_GUARD_TUNING[normalizeRealtimeEchoGuard(config.echoGuard)]
  return {
    /*
     * GA 版的字段位置和 beta 不一样：会话类型要显式给 `type: 'realtime'`，
     * 音频格式挪到了 `audio.input` / `audio.output` 底下。照 beta 的教程写，
     * 连得上但音频格式对不上，听到的是噪声。
     */
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: config.instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: OPENAI_AUDIO.inputSampleRate },
          // 选填但**必须给**，理由见 OPENAI_TRANSCRIPTION_MODEL
          transcription: {
            model: OPENAI_TRANSCRIPTION_MODEL,
            // 听写这一路转写就是全部产出，值得给它一份领域词表兜住行话
            ...(config.dictation ? { prompt: OPENAI_DICTATION_PROMPT } : {})
          },
          // 服务端在判停和转写之前先降一道噪。不给这个字段整个降噪都不开
          noise_reduction: { type: echoGuard.noiseReduction },
          // 交给服务端判停。自己做 VAD 要处理静音阈值、尾音、抢话，
          // 而这一家的服务端 VAD 本来就带打断（用户一开口就掐掉正在播的回答）。
          //
          // 门限**必须显式给**：默认的 0.5 顶得过本地 AEC 压不干净的那点回声残留，
          // 于是模型自己的尾音被转写成一句「用户发言」，它开始回应自己
          // （见 OPENAI_ECHO_GUARD_TUNING）
          turn_detection: {
            type: 'server_vad',
            threshold: echoGuard.threshold,
            // 听写要的判停比对话宽，而且判停之后不准应答（见 OPENAI_DICTATION_TURN_DETECTION）
            ...(config.dictation
              ? {
                  silence_duration_ms: OPENAI_DICTATION_TURN_DETECTION.silenceDurationMs,
                  prefix_padding_ms: OPENAI_DICTATION_TURN_DETECTION.prefixPaddingMs,
                  create_response: false
                }
              : {})
          }
        },
        output: {
          format: { type: 'audio/pcm', rate: OPENAI_AUDIO.outputSampleRate },
          ...(config.voice ? { voice: config.voice } : {})
        }
      },
      tools: config.tools.map((tool) => ({ type: 'function', ...tool })),
      tool_choice: 'auto'
    }
  }
}

/**
 * `response.create` 发出去到 `response.created` 之间等这么久。
 *
 * 只盖这一小段握手，不是「一轮回答的时长」—— 回执正常一两百毫秒就到。
 * 它存在只为一件事：这次 create 要是被服务端拒了，回执永远不来，
 * 「有一轮在跑」的账就永久挂着，之后一句播报都出不去，而且没有任何报错。
 */
const RESPONSE_CREATE_TIMEOUT_MS = 5_000

/**
 * 我们自己多按了一次「请开口」。
 *
 * 这条**不能当故障**：渲染层收到 error 会掐掉整通电话，而为一次重复请求挂断，
 * 比这次请求没发出去糟得多。真正的修法是不让它发生（见 `createResponseGate`），
 * 这里只是不让残留的竞态毁掉通话。整包已经由 `logFrame` 打在日志里了。
 */
const HARMLESS_ERROR_CODES = new Set(['conversation_already_has_active_response'])

export interface ResponseGate {
  /** 请求模型开口。已经有一轮在跑就先压着，等它结束再补发 */
  request: () => void
  /**
   * 用户打断了，让服务端停掉这一轮。
   *
   * 没有在跑的一轮就**什么都不发** —— 那种情况下发取消，服务端回一条 error，
   * 而渲染层收到 error 会掐掉整通电话。压着待发的那次也一并作废：
   * 用户按打断就是要它闭嘴，这时候再补一次开口是最气人的。
   */
  cancel: () => void
  /** 喂一帧服务端事件的类型名进来，更新记账 */
  observe: (type: string) => void
  /** 挂断时清掉兜底计时器 */
  dispose: () => void
}

/**
 * 「同一时间只许有一轮响应」的记账。
 *
 * 这一家的硬约束：已经有一轮在跑的时候再发 `response.create`，服务端回
 * `conversation_already_has_active_response`，而渲染层收到 error 会**掐掉整通电话** ——
 * 用户看到的是「说着说着突然断了」，日志里只有一行看不懂的英文。
 *
 * 会请求开口的有三处，彼此都不知道对方在做什么：键入、播报（任务表随时插进来）、
 * 工具结果回传（一轮里点了两个工具就来两次）。**服务端 VAD 还会在用户开口时自己起一轮**，
 * 那一轮我们压根没发过 create。所以只能集中记账，调用方各自判断是判断不出来的。
 *
 * 压下来的那次**不能丢**：模型收了工具结果却一声不吭，比多发一次糟得多。
 *
 * 独立出来是**为了可测** —— 这里错了不会报错，只会表现成通话莫名其妙断掉，
 * 或者播报再也出不去，两种都没法从界面上看出来。
 */
export function createResponseGate(send: (payload: unknown) => void): ResponseGate {
  let active = false
  let pending = false
  let timer: NodeJS.Timeout | null = null

  const clearFallback = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  /** 这一轮结束（或压根没起来），把压着的那次放进去 */
  const settle = (): void => {
    active = false
    clearFallback()
    if (!pending) return
    pending = false
    request()
  }

  function request(): void {
    if (active) {
      pending = true
      return
    }
    /*
     * **乐观置位**，不等回执。回执要一两百毫秒才到，而这段时间里第二次请求
     * 完全来得及发出去 —— 那正是这个 bug 原本发生的窗口。
     *
     * 代价是回执要是永远不来（这次 create 被服务端拒了），账就永久挂着，
     * 之后一句播报都出不去。所以配一条兜底，只盖 create → created 这一小段；
     * 真起来了的话 `response.created` 会提前撤掉它。
     */
    active = true
    clearFallback()
    timer = setTimeout(() => {
      timer = null
      console.warn('[OpenAI 实时语音] response.create 没等到回执，按这一轮没起来处理')
      settle()
    }, RESPONSE_CREATE_TIMEOUT_MS)
    send({ type: 'response.create' })
  }

  return {
    request,
    cancel() {
      pending = false
      if (!active) return
      send({ type: 'response.cancel' })
      // 这里**不 settle**：服务端会回一条 `response.done`（status 是 cancelled），
      // 到那时才算真的结束。提前放行的话下一次 create 又撞上没结束的这一轮
    },
    observe(type) {
      // 用户开口时服务端自己起的那一轮也要认，否则播报会正好插进他那一轮里
      if (type === 'response.created') {
        active = true
        clearFallback()
        return
      }
      // 被取消的那一轮也走 `response.done`（status 是 cancelled），不用单独认
      if (type === 'response.done') settle()
    },
    dispose: clearFallback
  }
}

/** 每秒几十条的那几种不打，其余每条都留一行 —— 这一层的故障全是「安静」，没日志只能猜 */
const NOISY_EVENTS = new Set([
  'input_audio_buffer.append',
  'response.output_audio.delta',
  'response.output_audio_transcript.delta',
  'response.output_text.delta',
  'conversation.item.input_audio_transcription.delta'
])

/**
 * 每一帧留一行。
 *
 * 豆包那家一直有，这家原先没有 —— 于是「它答了但没声音」这类故障在日志里
 * 和一切正常长得一模一样，只能靠猜。报错把整包打出来：原因藏在哪一层各版本不一样。
 */
function logFrame(direction: '↑' | '↓', event: Record<string, unknown>): void {
  const type = String(event.type || '?')
  if (NOISY_EVENTS.has(type)) return
  const detail = type === 'error' || type.endsWith('.failed') ? ` ${JSON.stringify(event)}` : ''
  const at = new Date().toISOString().slice(11, 23)
  console.log(`[OpenAI 实时语音 ${at}] ${direction} ${type}${detail}`)
}

/** 历史和实时键入共用同一种 message item；角色决定文本内容类型。 */
export function buildOpenAiConversationItem(message: RealtimeConversationMessage): unknown {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: message.role,
      content: [
        {
          type: message.role === 'user' ? 'input_text' : 'output_text',
          text: message.text
        }
      ]
    }
  }
}

export function openOpenAiRealtimeSession(config: RealtimeSessionConfig): VoiceSessionHandle {
  const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const socket = new WebSocket(`${base}?model=${encodeURIComponent(config.model)}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    // 关掉压缩，理由和豆包那条一样：压一条消息要走一次 zlib 异步回调，
    // 期间后面的 send 全排队；上行音频每秒 50 包，排起来就再也追不回来了，
    // 表现是「说完十几秒才识别」（见 `doubaoRealtime.ts` 的 `perMessageDeflate`）
    perMessageDeflate: false
  })

  let closed = false
  const send = (payload: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    logFrame('↑', payload as Record<string, unknown>)
    socket.send(JSON.stringify(payload))
  }

  const responses = createResponseGate(send)

  socket.on('open', () => {
    /*
     * 把这一通**实际发出去**的回声门限打出来。
     *
     * `logFrame` 只打事件名，不打内容，所以首帧里的判停参数在日志里是看不见的 ——
     * 而「用户改了设置但没重启，主进程还跑着旧代码」和「改了、生效了、还是压不住」
     * 这两种情况，从对话界面上长得一模一样（都是凭空冒出用户没说过的话）。
     * 排查时第一个要回答的就是这个，没有这行就只能猜。
     */
    const guard = normalizeRealtimeEchoGuard(config.echoGuard)
    const tuning = OPENAI_ECHO_GUARD_TUNING[guard]
    console.log(
      `[OpenAI 实时语音 ${new Date().toISOString().slice(11, 23)}] ` +
        `回声门限 ${guard}：threshold ${tuning.threshold}，降噪 ${tuning.noiseReduction}`
    )
    send(buildOpenAiSessionUpdate(config))
    for (const message of config.history || []) send(buildOpenAiConversationItem(message))
    config.onEvent({ type: 'ready' })
  })

  socket.on('message', (raw: Buffer) => {
    let event: { type?: string } & Record<string, unknown>
    try {
      event = JSON.parse(raw.toString('utf-8'))
    } catch {
      config.onEvent({ type: 'error', message: '返回的不是 JSON' })
      return
    }
    logFrame('↓', event)
    responses.observe(String(event.type || ''))
    for (const translated of translate(event)) config.onEvent(translated)
  })

  socket.on('error', (error) => {
    /*
     * 404 在这条链路上几乎只有一个含义：**绑的模型不是实时模型**。
     *
     * 握手打的是 `/v1/realtime`，普通对话厂商根本没有这个端点。原样透出
     * 「Unexpected server response: 404」既不说是谁返回的，也不说该去哪儿改 ——
     * 用户会去查网络、换密钥，而问题在角色绑定那一栏。
     */
    const message = error.message.includes('404')
      ? '此服务商不支持实时语音。请到 设置 → 模型 → 默认模型，' + '选择支持的实时语音模型。'
      : `连接失败：${error.message}`
    config.onEvent({ type: 'error', message })
  })

  socket.on('close', () => {
    closed = true
    /*
     * **这里也要 dispose。** 连接是对面断的（掉线、服务端超时）时先走到这儿，
     * `closed` 一置真，后面上层调 `handle.close()` 就被那句 `if (closed) return`
     * 挡掉了 —— 于是 `response.create` 的那个五秒回执定时器没人清：五秒后它在一条
     * 已经没了的会话上醒来，打一行「没等到回执」，还可能顺手再排一个。
     */
    responses.dispose()
    config.onEvent({ type: 'closed' })
  })

  return {
    appendAudio(base64) {
      // 服务端 VAD 开着，所以不用手动 commit —— 它自己判断一句话说完了没有
      send({ type: 'input_audio_buffer.append', audio: base64 })
    },
    sendText(text) {
      send(buildOpenAiConversationItem({ role: 'user', text }))
      responses.request()
    },
    /**
     * 这一家有 `response.create`，所以**让模型自己转述**，只发 `context` 那份。
     *
     * 不用 `speech`：OpenAI Realtime 没有「照读这段文本」的事件，硬要逐字念
     * 得自己接一路 TTS。而且它转述得比逐字念自然 —— 豆包那边逐字念是**被迫**的，
     * 不是更优解。两家听感会有差别，这是协议差异，不是 bug。
     */
    announce({ context }) {
      send(buildOpenAiConversationItem({ role: 'user', text: context }))
      responses.request()
    },
    /**
     * **照发不误，哪怕服务端 VAD 也会自己截断。**
     *
     * 这条走过一个来回。最早是空的，理由是「服务端 VAD 检测到用户开口会自己
     * 截断」；后来半双工上线（它出声期间上行整个掐成静音），服务端根本听不到
     * 用户开口，于是改成必须我们发。现在回声消除接上了回环、上行不再闭
     * （见 `useRealtimeVoice.shouldMuteUplink`），服务端**又**听得到了 ——
     * 但这一条留着，两个理由：
     *
     * 1. 界面上的打断（点球体、快捷键）不经过麦克风，服务端无从知道；
     * 2. 回环建不起来的机器上仍然是半双工，那时候它还是唯一的打断入口。
     *
     * 重复发是安全的：没有在跑的一轮时不发（那会换来一条 error，而 error 会掐掉
     * 整通电话），这个判断在 `createResponseGate` 里，它本来就记着账。
     */
    cancelResponse() {
      responses.cancel()
    },
    sendToolResults(results) {
      if (results.length === 0) return
      // 这一家一条一条收，所以逐条发；批量是为了和豆包共用同一个接口，
      // 那边要求同一轮的多个结果必须聚合成一条
      for (const item of results) {
        send({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: item.callId, output: item.output }
        })
      }
      // 少了这一句模型不会接着说话 —— 它把结果收下了，然后一直等下一个指令
      responses.request()
    },
    close() {
      if (closed) return
      closed = true
      responses.dispose()
      socket.close()
    }
  }
}

/**
 * 厂商事件 → 我们的形状。
 *
 * 导出**只为可测**：事件名在 GA 那次改过一轮（`response.audio.delta` 变成了
 * `response.output_audio.delta`），照旧名字写完全连得上、也不报错，
 * 只是永远没有声音。这种错必须被钉住。
 */
export function translate(event: Record<string, unknown>): VoiceSessionEvent[] {
  const type = String(event.type || '')

  switch (type) {
    case 'response.output_audio.delta':
      return typeof event.delta === 'string' ? [{ type: 'audio', base64: event.delta }] : []

    case 'response.output_audio_transcript.delta':
    case 'response.output_text.delta':
      return typeof event.delta === 'string' ? [{ type: 'assistant-text', text: event.delta }] : []

    /** 服务端 VAD 认为用户开口了。与豆包的「识别开始」是同一件事 */
    case 'input_audio_buffer.speech_started':
      return [{ type: 'interrupted' }]

    /**
     * 服务端 VAD 认为用户这句说完了。
     *
     * 抛出去只为一件事：给「丢弃在途残片」一个**不依赖识别**的出口（见 types.ts）。
     * 转写要是没配上或被网关吞了，识别结果永远不来，那个开关就只能等三秒兜底 ——
     * 而一句短回答的音频往往还没三秒长，整段就这么被吞了。
     *
     * 这条不会把打断放得太早：它在用户停下说话之后才来（服务端 VAD 要先攒够静音），
     * 那时被打断那一轮的在途分片早就走完了。
     */
    case 'input_audio_buffer.speech_stopped':
      return [{ type: 'user-speech-done' }]

    case 'conversation.item.input_audio_transcription.delta':
      return typeof event.delta === 'string'
        ? [{ type: 'user-text', text: event.delta, final: false }]
        : []

    case 'conversation.item.input_audio_transcription.completed':
      return typeof event.transcript === 'string'
        ? [{ type: 'user-text', text: event.transcript, final: true }]
        : []

    // 没听清要说出来。静默丢掉的表现是用户说完话界面毫无动静，
    // 他没法判断是没听见还是在想，只能一直重复说
    case 'conversation.item.input_audio_transcription.failed':
      return [{ type: 'asr-failed' }]

    /*
     * 工具调用在 `response.done` 里，不是单独一个事件。
     *
     * 一轮里可能有多个 function_call，所以这里返回的是数组 ——
     * 只取第一个的话，模型点了两个工具却只有一个拿到结果，
     * 剩下那个会让整轮永远等下去。
     */
    case 'response.done': {
      const output = (event.response as { output?: unknown })?.output
      const calls = Array.isArray(output)
        ? output
            .map(
              (item) =>
                item as { type?: string; call_id?: string; name?: string; arguments?: string }
            )
            .filter((item) => item.type === 'function_call' && item.call_id && item.name)
            .map<VoiceSessionEvent>((item) => ({
              type: 'tool-call',
              callId: item.call_id as string,
              name: item.name as string,
              args: item.arguments || '{}'
            }))
        : []
      return [...calls, { type: 'turn-done' }]
    }

    case 'error': {
      const error = (event.error as { message?: unknown; code?: unknown }) || {}
      // 自己人造成的、且不影响通话继续的那几种，不往上报（理由见 HARMLESS_ERROR_CODES）
      if (typeof error.code === 'string' && HARMLESS_ERROR_CODES.has(error.code)) return []
      const message = error.message
      return [{ type: 'error', message: typeof message === 'string' ? message : '厂商返回错误' }]
    }

    default:
      // 事件种类有几十个，绝大多数（session.created、rate_limits.updated…）
      // 对我们没有意义。安静地忽略，而不是刷日志
      return []
  }
}
