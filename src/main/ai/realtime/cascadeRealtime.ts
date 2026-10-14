import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Tool,
  ToolCall
} from '@earendil-works/pi-ai'
import type { SpeechAudio } from '../../../shared/speech'
import type { RealtimeEchoGuard } from '../../../shared/realtimeEchoGuard'
import { createEndpointer } from '../stt/endpointer'
import { STT_INPUT_SAMPLE_RATE, type SttEvent, type SttSessionHandle } from '../stt/types'
import type {
  AudioSpec,
  RealtimeSessionConfig,
  VoiceAnnouncement,
  VoiceSessionEvent,
  VoiceSessionHandle
} from './types'

/**
 * 拼装通话：语音识别当耳朵、普通对话模型当脑子、语音合成当嘴。
 *
 * ## 为什么要有它
 *
 * 「实时语音」那一档只有 OpenAI gpt-realtime 和豆包 Seeduplex 两家能用 —— 一个国内
 * 不好开、一个要单独开通火山引擎。而大多数用户手上本来就有一个对话模型，
 * 配个语音识别（本机 SenseVoice 都行）、配个语音合成，三样拼起来同样能通话。
 *
 * ## 和上面两家的关系
 *
 * 实现的是同一个 `VoiceSessionHandle`、发的是同一套事件，上层（语音前台的工具、
 * 任务线、播报纪律、渲染层的播放与打断）**一行不改**。所以它对上层表现得
 * 就像第三家厂商；差别全在这一个文件里：
 *
 * | | 实时语音那两家 | 拼装 |
 * |---|---|---|
 * | 判停 | 服务端 VAD | 识别那一路（流式厂商自己判，整段转写由 `endpointer` 判） |
 * | 插话 | 服务端听见就停 | 本地 `endpointer` 听见开口就掐掉这一轮 |
 * | 回答 | 模型直接出声 | 对话模型出字 → 逐句合成 |
 * | 播报 | 模型转述 | 原话逐字念（和 Box Plan 那条线同一个做法） |
 *
 * 代价是慢：一句话要等识别、模型首字、合成首包三段，比端到端的模型多一两秒。
 *
 * ## 依赖从外面给
 *
 * 识别、模型、合成三样都要读配置、解密钥，一 import 就把 electron 拖进来了。
 * 这里只管编排，三样由 `cascadeDeps.ts` 接上 —— 和 `frontDesk.ts` 不 import 实现是同一个理由。
 */

/** 进 16k（识别那一路的采样率）、出 24k（几家语音合成都是 24k PCM） */
export const CASCADE_AUDIO: AudioSpec = {
  inputSampleRate: STT_INPUT_SAMPLE_RATE,
  outputSampleRate: 24_000
}

/** 一轮里模型最多连着调几次工具。语音前台的工具都是查一眼、派一件，正常两三步就完 */
const MAX_STEPS = 6

/**
 * 等工具结果最多等多久。到点给一句占位接着走。
 *
 * 不能无限等：工具调用和结果在上下文里必须成对，等不到的话下一轮请求带着一个
 * 没有结果的调用发出去，厂商当场 400，整通电话断掉。
 */
const TOOL_RESULT_TIMEOUT_MS = 30_000

/**
 * 插话的门槛，按回声档位抬。
 *
 * 判插话用的是本地响度（`endpointer`），而外放时喇叭的声音会被麦克风收回来一点 ——
 * 回声消除压得住大部分，压不干净的那点残留够响的话，它会把自己打断。
 * 耳机没有回声，用默认的那一档。
 */
const BARGE_IN_FLOOR_DB: Record<RealtimeEchoGuard, number> = {
  headset: -50,
  speaker: -45,
  strong: -38
}

/** 识别那一路连着断开多少次就不再重连了。正常是几十分钟断一次（厂商的单次时长上限） */
const MAX_STT_RECONNECTS = 3

/**
 * 上下文最多留多少条。一通电话最长 30 分钟，派活、查进度的工具结果一条条往上叠，
 * 不收的话越聊越慢、越聊越贵。实时语音那两家是服务端自己截，这里得自己截。
 */
const MAX_HISTORY = 80

/**
 * 给系统提示词补的一段。实时语音那两家直接出声，不会写 Markdown；
 * 对话模型会，而合成引擎会把星号和井号原样念出来。
 */
export const CASCADE_INSTRUCTIONS =
  '你的回复会被逐句合成语音念给用户听：只说口语，不用 Markdown、列表、代码块和表情符号。'

/** 模型这一轮的输出。和 pi 的流同形：逐个吐事件，结束后 `result()` 拿整条消息 */
export interface ReplyStream extends AsyncIterable<AssistantMessageEvent> {
  result: () => Promise<AssistantMessage>
}

export interface CascadeDeps {
  /** 开一路识别。断了会再调一次 */
  openStt: (onEvent: (event: SttEvent) => void) => SttSessionHandle
  /** 让对话模型回一轮 */
  reply: (request: {
    system: string
    messages: Message[]
    tools: Tool[]
    signal: AbortSignal
  }) => ReplyStream
  /** 合成一句话，边合成边吐 PCM */
  speak: (text: string, signal: AbortSignal, onAudio: (chunk: SpeechAudio) => void) => Promise<void>
}

/**
 * 从流里切出能念的一句。回切点（这句的结尾位置），切不出来回 0。
 *
 * 一句一合成而不是等整段：模型吐完一段话要好几秒，等它吐完再合成，
 * 用户就要干等这几秒。按句切，第一句话写完就能开口。
 */
export function sentenceBreak(text: string): number {
  const match = /[。！？；!?;\n]|[.](?=\s)/.exec(text)
  if (match) return match.index + 1
  // 一直不收句的长句（模型一逗到底）：够长了就在最后一个逗号处先念出去
  if (text.length >= 60) {
    const comma = Math.max(text.lastIndexOf('，'), text.lastIndexOf(','), text.lastIndexOf('、'))
    if (comma > 0) return comma + 1
  }
  return 0
}

/** 合成之前去掉念出来很怪的东西：Markdown 记号、代码块 */
export function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*#`>|_~]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 这段音频播完要多久。用来估计喇叭什么时候停，判「它还在说」 */
function audioMs(chunk: SpeechAudio): number {
  return (Buffer.byteLength(chunk.base64, 'base64') / 2 / chunk.sampleRate) * 1000
}

/** 一条只有文字的助手消息。元信息填空 —— 它不是这一轮模型生成的，是我们替它记的 */
function spokenMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: '',
    provider: '',
    model: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  } as AssistantMessage
}

function userMessage(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() }
}

/** 地址、密钥、模型名都在三样依赖里，会话本身不需要 */
export type CascadeSessionConfig = Omit<RealtimeSessionConfig, 'apiKey' | 'baseUrl' | 'model'>

export function openCascadeSession(
  config: CascadeSessionConfig,
  deps: CascadeDeps
): VoiceSessionHandle {
  const system = [config.instructions, CASCADE_INSTRUCTIONS].filter(Boolean).join('\n')
  const tools = config.tools.map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.description,
        // JSON Schema 原样给：pi 的 TSchema 运行时就是 JSON Schema
        parameters: tool.parameters
      }) as unknown as Tool
  )
  const history: Message[] = (config.history ?? []).map((item) =>
    item.role === 'user' ? userMessage(item.text) : spokenMessage(item.text)
  )

  let closed = false
  let ready = false
  /**
   * 还活着的那几件事（回答、播报）。插话时一起掐掉。
   *
   * 它们**排成一队**做（`chain`）：上下文是一条线，被掐的那一轮要先把说出口的半句、
   * 发出去的调用记进去，下一件才能往后接 —— 并发的话用户的新一句会插到
   * 半截回答前面，或者插到工具调用和它的结果中间，厂商当场 400。
   */
  const live = new Set<AbortController>()
  let chain: Promise<void> = Promise.resolve()
  /**
   * 发出去、还没收到结果的工具调用（按发出顺序）。
   *
   * **哪怕这一轮被掐了也要等它们的结果**：调用已经在上层跑了（派出去的活不会因为
   * 用户插了句话就撤回），而上下文里调用和结果必须成对，否则下一轮请求直接 400。
   */
  let pendingCalls: ToolCall[] = []
  const results = new Map<string, string>()
  let resultsArrived: (() => void) | null = null
  /** 估计的喇叭停下的时刻。最后一包合成出来不等于念完了，渲染层还排着好几秒 */
  let playbackUntil = 0

  const endpointer = createEndpointer({
    sampleRate: STT_INPUT_SAMPLE_RATE,
    speechFloorDb: BARGE_IN_FLOOR_DB[config.echoGuard ?? 'speaker']
  })

  const emit = (event: VoiceSessionEvent): void => {
    if (closed) return
    config.onEvent(event)
  }

  function fail(message: string): void {
    if (closed) return
    emit({ type: 'error', message })
    close()
  }

  // ── 耳朵 ──

  let stt: SttSessionHandle | null = null
  let sttReconnects = 0

  function openEar(): void {
    const session = deps.openStt((event) => {
      if (closed || stt !== session) return
      switch (event.type) {
        case 'ready':
          if (!ready) {
            ready = true
            emit({ type: 'ready' })
          }
          break
        case 'user-text':
          emit(event)
          if (event.final && event.text.trim()) {
            // 出得了整句，说明这一路是好的。重连计数只防「一开就断」那种来回
            sttReconnects = 0
            respond(event.text.trim())
          }
          break
        case 'asr-failed':
          emit(event)
          break
        case 'error':
          fail(event.message)
          break
        case 'closed':
          // 厂商那边的单次会话到点了（豆包、百炼都有时长上限）。通话还在，接着开一路
          if (sttReconnects >= MAX_STT_RECONNECTS) {
            fail('语音识别连接反复断开，请检查语音识别服务。')
            return
          }
          sttReconnects += 1
          openEar()
          break
      }
    })
    stt = session
  }

  // ── 插话 ──

  /** 它在说话吗：模型还在想或出字、合成还没完，或者喇叭里还排着 */
  function speaking(): boolean {
    return live.size > 0 || Date.now() < playbackUntil
  }

  /** 掐掉手上的事。`notify` 为真时告诉渲染层把喇叭里排着的也掐掉 */
  function interrupt(notify: boolean): void {
    const wasSpeaking = speaking()
    for (const controller of live) controller.abort()
    live.clear()
    playbackUntil = 0
    if (notify && wasSpeaking) emit({ type: 'interrupted' })
  }

  /** 排一件事进队。掐掉的那件照样轮到它，由它自己决定被掐之前要记下什么 */
  function schedule(job: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    live.add(controller)
    chain = chain
      .then(() => (closed ? undefined : job(controller.signal)))
      .catch((error) => {
        if (!controller.signal.aborted) fail(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        live.delete(controller)
      })
  }

  // ── 嘴 ──

  /**
   * 一轮的嘴：收模型的字，攒够一句就送去合成，按顺序吐音频。
   *
   * 合成一句接一句排着做（不并发）：几家合成都是流式的，第一包几百毫秒就到，
   * 而上一句念完要好几秒 —— 排着做喇叭也不会断，还保证了先后顺序。
   */
  function createMouth(signal: AbortSignal): {
    push: (delta: string) => void
    finish: () => Promise<void>
  } {
    let buffer = ''
    let queue = Promise.resolve()
    let failure: unknown = null

    const say = (sentence: string): void => {
      const text = forSpeech(sentence)
      // 只剩标点（「。」「……」）的不送，合成那边会当成空文本报错
      if (!/[\p{L}\p{N}]/u.test(text)) return
      queue = queue.then(async () => {
        if (signal.aborted) return
        try {
          await deps.speak(text, signal, (chunk) => {
            if (signal.aborted) return
            emit({ type: 'audio', base64: chunk.base64 })
            playbackUntil = Math.max(Date.now(), playbackUntil) + audioMs(chunk)
          })
        } catch (error) {
          if (!signal.aborted) failure ??= error
        }
      })
    }

    return {
      push(delta) {
        buffer += delta
        for (let cut = sentenceBreak(buffer); cut > 0; cut = sentenceBreak(buffer)) {
          say(buffer.slice(0, cut))
          buffer = buffer.slice(cut)
        }
      },
      async finish() {
        say(buffer)
        buffer = ''
        await queue
        if (failure) throw failure
      }
    }
  }

  // ── 脑子 ──

  /**
   * 把挂着的工具调用的结果收齐，成对写进上下文。
   *
   * 写进去的时机放在这里而不是 `sendToolResults` 里：结果必须排在发起调用的那条
   * 助手消息**后面**，而那条消息要等模型这一轮吐完才写得进去。
   */
  async function settleToolResults(): Promise<void> {
    if (!pendingCalls.length) return
    if (pendingCalls.some((call) => !results.has(call.id))) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resultsArrived = null
          resolve()
        }, TOOL_RESULT_TIMEOUT_MS)
        resultsArrived = () => {
          clearTimeout(timer)
          resultsArrived = null
          resolve()
        }
      })
    }
    for (const call of pendingCalls) {
      history.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: results.get(call.id) ?? '（没有拿到结果）' }],
        isError: !results.has(call.id),
        timestamp: Date.now()
      } as Message)
      results.delete(call.id)
    }
    pendingCalls = []
  }

  /**
   * 太长了就从最早的开始丢，**丢到一条用户消息为止** —— 开头不能是半截的工具结果，
   * 那条结果对应的调用已经丢了，厂商会拒。
   */
  function trimHistory(): void {
    if (history.length <= MAX_HISTORY) return
    history.splice(0, history.length - MAX_HISTORY)
    while (history.length && history[0].role !== 'user') history.shift()
  }

  /** 让模型回一轮：可能先调几次工具，最后出一段话 */
  async function runTurn(signal: AbortSignal): Promise<void> {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      // 上一步调了工具：结果收齐、成对记下，才能接着问模型
      await settleToolResults()
      if (signal.aborted) return
      trimHistory()

      const mouth = createMouth(signal)
      const stream = deps.reply({ system, messages: history, tools, signal })
      let text = ''
      const calls: ToolCall[] = []
      for await (const event of stream) {
        if (signal.aborted) break
        if (event.type === 'text_delta') {
          text += event.delta
          emit({ type: 'assistant-text', text: event.delta })
          mouth.push(event.delta)
        } else if (event.type === 'toolcall_end') {
          // 立刻交出去：派活这类工具越早开跑越好，不用等模型把这一轮说完
          calls.push(event.toolCall)
          pendingCalls.push(event.toolCall)
          emit({
            type: 'tool-call',
            callId: event.toolCall.id,
            name: event.toolCall.name,
            args: JSON.stringify(event.toolCall.arguments ?? {})
          })
        }
      }
      const message = await stream.result()

      if (signal.aborted || message.stopReason === 'aborted') {
        // 被掐了。说出口的半句和已经发出去的调用照实记下，别的都不算
        if (text.trim() || calls.length) {
          history.push({
            ...message,
            content: [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...calls],
            stopReason: calls.length ? 'toolUse' : 'stop'
          } as AssistantMessage)
        }
        // 不是我们掐的（厂商自己断了）：场子得让出来，不然界面一直停在「在想」
        if (!signal.aborted) emit({ type: 'turn-done' })
        return
      }
      if (message.stopReason === 'error') {
        throw new Error(message.errorMessage || '对话模型调用失败')
      }

      history.push(message)
      await mouth.finish()
      if (signal.aborted) return
      if (!calls.length) {
        emit({ type: 'turn-done' })
        return
      }
    }
    // 工具调用打转了：收住这一轮，别一直烧下去
    await settleToolResults()
    emit({ type: 'turn-done' })
  }

  /**
   * 用户说了一句（或打了一句字）：正在回的那一轮作废，回这一句。
   *
   * 作废的那一轮回的已经不是他要的了 —— 他补了半句、改了主意，或者打断了它。
   * 他的话先记进上下文再问模型；被掐的那一轮先把自己收拾完（见 `schedule`）。
   */
  function respond(text: string): void {
    interrupt(true)
    schedule(async (signal) => {
      // 被掐的那一轮可能还有工具结果没收：结果得紧跟在调用后面，排在这句话前头
      await settleToolResults()
      history.push(userMessage(text))
      if (signal.aborted) return
      await runTurn(signal)
    })
  }

  /**
   * 念一条播报：原话逐字念，上下文成对记下。
   *
   * 不让模型转述，理由和 Box Plan 那条线一样（`openaiRealtime.ts` 的 `announce`）：
   * 转述要多等一轮模型，而原话本来就是给人听的定稿。
   *
   * 正在回答时它排在后面，不抢话；还没轮到就被插话掐了的，上下文照记（模型得知道
   * 后台发生了什么），但不念、也不往对话里写。
   */
  function announceLater(notice: VoiceAnnouncement): void {
    schedule(async (signal) => {
      await settleToolResults()
      history.push(userMessage(notice.context))
      if (signal.aborted) return
      history.push(spokenMessage(notice.speech))
      emit({ type: 'announced', text: notice.speech })
      const mouth = createMouth(signal)
      mouth.push(notice.speech)
      await mouth.finish()
      if (!signal.aborted) emit({ type: 'turn-done' })
    })
  }

  function close(): void {
    if (closed) return
    // 先置位再发 `closed`：上层收到它会回头再关一次，那一次得直接返回
    closed = true
    interrupt(false)
    resultsArrived?.()
    const ear = stt
    stt = null
    ear?.close()
    config.onEvent({ type: 'closed' })
  }

  openEar()

  return {
    appendAudio(base64) {
      if (closed) return
      stt?.appendAudio(base64)
      const wasTalking = endpointer.speaking
      endpointer.push(Buffer.from(base64, 'base64'))
      if (!wasTalking && endpointer.speaking) interrupt(true)
      // 他停下了：渲染层据此不再把新到的音频当被打断那一轮的残片丢掉
      if (wasTalking && !endpointer.speaking) emit({ type: 'user-speech-done' })
    },
    sendText(text) {
      if (closed || !text.trim()) return
      respond(text.trim())
    },
    announce(notice) {
      if (closed) return
      announceLater(notice)
    },
    cancelResponse() {
      interrupt(false)
    },
    sendToolResults(items) {
      for (const item of items) {
        if (pendingCalls.some((call) => call.id === item.callId))
          results.set(item.callId, item.output)
      }
      if (pendingCalls.every((call) => results.has(call.id))) resultsArrived?.()
    },
    close
  }
}
