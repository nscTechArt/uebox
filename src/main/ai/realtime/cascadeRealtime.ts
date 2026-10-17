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
import {
  STT_INPUT_SAMPLE_RATE,
  type SttAudioSpan,
  type SttEvent,
  type SttSessionHandle
} from '../stt/types'
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
 * | 插话 | 服务端听见就停 | 听见声音先停播，识别出来、判过是在对它说话才掐（见下） |
 * | 回答 | 模型直接出声 | 对话模型出字 → 逐句合成 |
 * | 播报 | 模型转述 | 原话逐字念（和 Box Plan 那条线同一个做法） |
 *
 * 代价是慢：一句话要等识别、模型首字、合成首包三段，比端到端的模型多一两秒。
 *
 * ## 插话：先停播，再判，最后才掐
 *
 * 听见声音就掐掉这一轮的话，一声咳嗽、敲一下键盘、喇叭的回声被认成「Yeah.」，
 * 都会把等了十几秒的回答作废，用户只好再问一遍（真机 2026-10-14）。现在分三步：
 *
 * 1. **听见声音先停播**（`output-hold`），什么都不扔。
 * 2. **识别模型说那不是人声的，当没发生**：SenseVoice 对杂音会打 `nospeech` 标签、
 *    或者只回一个标点（`readTranscript`）。那一段不上屏，喇叭接着放（`output-release`）。
 * 3. **识别出了字的，交给判定模型看一眼**（`judgeUtterance`，约 100ms）：是在对它说话、
 *    要它停下吗？只是附和（「嗯」「对」）、杂音认出来的零碎字、喇叭回声，都接着说。
 *    判定模型没配或判不了，照老规矩当真 —— 宁可多停一次，不吞用户的话。
 *
 * 判什么、阈值多少都不在这里猜：是不是人声由识别模型说了算，是不是在说话由判定模型说了算。
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

/**
 * 停播之后，用户停下来多久还没等到识别结果，就当刚才那是杂音、接着放。
 *
 * 识别那一路认定不是人声的时候**什么都不回**，只能靠等。本机识别两三百毫秒出结果，
 * 云端整段转写一秒上下；两秒等得住，又不至于让人觉得它卡住了。
 */
const HOLD_RESULT_GRACE_MS = 2_000

/** 停播最多停多久。一直有声音（旁边在放音乐）也不能让它永远不说 */
const HOLD_MAX_MS = 15_000

/**
 * 判定模型的阈值。`judge.isYes` 的约定是阈值跟着后果走，这里两条后果不对称：
 *
 * - **当成杂音丢掉**是吞了用户的话，只在很有把握时做（说话的概率低于 0.2）；
 * - **它在说话时打断它**是丢掉它说了一半的话，过半就打断 —— 那是用户在要东西。
 */
const ADDRESSED_FLOOR = 0.2

/**
 * 喇叭停了之后多久之内，识别出来的话还可能是它自己的回声（房间混响、播放缓冲）
 */
const ECHO_TAIL_MS = 800
const INTERRUPT_AT = 0.5

/**
 * 合成连着失败几句才算真坏了、挂断。
 *
 * 云端合成偶尔断一下连接（真机 2026-10-14：Qwen-Audio 一次 TTS_CONNECTION_FAILED），
 * 为此挂断整通电话太重了 —— 先重试一次，还不行就这一句不念（字幕照样在），
 * 连着几句都念不出来才是配置坏了，那时说清楚再挂。
 */
const MAX_SPEAK_FAILURES = 3

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
  /**
   * 判一句话该不该当真（可选，见文件头「插话」）。回 null 表示判不了 —— 没配判定模型、
   * 超时、出错 —— 调用方按老规矩当真。
   */
  judgeUtterance?: (input: UtteranceContext) => Promise<UtteranceVerdict | null>
}

/** 判一句话要用到的上下文 */
export interface UtteranceContext {
  /** 识别出来的那句话 */
  text: string
  /** 它这会儿（或刚才）在说的话，判回声、判附和都靠它 */
  assistantSaying: string
  /** 它正在想或正在说。这时候才要问「是不是要打断它」 */
  busy: boolean
  /** 识别模型打的标签（SenseVoice 的语种、情绪、事件），有就给 */
  asrTags?: string[]
}

/** 两个概率，0 到 1 */
export interface UtteranceVerdict {
  /** 这句是用户在对它说话（提问、下指令、回答、确认、叫停） */
  addressed: number
  /** 它忙着时：用户是要它停下、改说别的。不忙时不问，没有这一项 */
  interrupt?: number
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
  /** 合成连着失败了几句，见 MAX_SPEAK_FAILURES */
  let speakFailures = 0
  /** 它这会儿（或刚才）在说的话。给判定模型认回声、认附和 */
  let assistantSaying = ''
  /**
   * 听见声音、先停了播，正等识别结果（见文件头「插话」）。
   *
   * `grace`：用户已经停下了，再等这么久还没结果就接着放。`limit`：停播的上限。
   */
  let hold: {
    grace: ReturnType<typeof setTimeout> | null
    limit: ReturnType<typeof setTimeout>
  } | null = null
  /**
   * 停着播时开口（或这一开口触发了停播）的那几段，在这一路识别的音频里从哪到哪（毫秒，`earMs`）。
   *
   * 认回声不能只看「这会儿停没停着播」：用户说「嗯」触发停播，紧接着说「停一下」，
   * 「嗯」先判成附和、放开了停播，「停一下」的结果再到时已经没在停着了，会被当回声丢掉。
   *
   * 也不能按段数记账：这里的断句和识别那一路的各断各的 —— 太短被扔掉的一下、识别说不是人声的
   * 一段都不会有结果，两下开口也可能被识别成一句。记下的账一旦对不上，后面喇叭的回声会冒领
   * 停播时的那一笔（自己打断自己），真说的「停一下」反倒被当回声丢掉。所以**按位置对**：
   * 识别结果带着它那一句的起止（`audioMs`），和这里哪一段重叠，就是停着播时说的。
   * 位置对不上就是对不上，没有剩下的账，停播怎么收场都不用清。
   */
  let heldSpans: SttAudioSpan[] = []
  /** 送进这一路识别的音频有多长（毫秒）。识别那一路的起止也从它开的那一刻算起 */
  let earMs = 0
  /** 上一条结果回来时 `earMs` 走到哪了。不报起止的那几家（流式厂商），这一句只知道是那以后说的 */
  let lastResultMs = 0
  /** 一句一句排着判，判定快慢不一也不会把两句的先后弄反 */
  let judging: Promise<void> = Promise.resolve()

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
        case 'user-text': {
          // 中间态照常上字幕；整句要先判过才算数，判过之前不上屏
          if (!event.final) {
            emit(event)
            break
          }
          const text = event.text.trim()
          if (!text) break
          // 出得了整句，说明这一路是好的。重连计数只防「一开就断」那种来回
          sttReconnects = 0
          // 这会儿就对：结果按说话的顺序回来，排队判到它时后面的结果可能已经把账对掉了
          const heard = startedUnderHold(event.audioMs)
          judging = judging.then(() => consider(text, heard, event.asrTags))
          break
        }
        case 'asr-failed':
          startedUnderHold(event.audioMs)
          if (event.reason === 'service') {
            // 识别服务这一句没办成，他说了什么不知道 —— 可能正是「停一下」。接着放，让他再说一遍
            releaseOutput()
            emit({ type: 'asr-failed' })
          } else if (hold) {
            // 停着播等结果时识别说没听清：多半是杂音，接着放，不说「没听清」
            releaseOutput()
          } else emit({ type: 'asr-failed' })
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
    // 新的一路从零算起，上一路记的位置对不上了
    earMs = 0
    lastResultMs = 0
    heldSpans = []
  }

  /**
   * 这一句是不是停着播时开口说的（见 `heldSpans`）。顺手丢掉以后再也对不上的那几段。
   *
   * 不报起止的那几家，当它是上一条结果之后说的：宽一点，最多让一句回声多过一遍判定。
   */
  function startedUnderHold(audio?: SttAudioSpan): boolean {
    const span = audio ?? { start: lastResultMs, end: earMs }
    lastResultMs = earMs
    const heard = heldSpans.some((item) => item.start <= span.end && item.end >= span.start)
    // 结果按说话的顺序回来：在这一句开头之前就结束的段，后面的句子也对不上了
    heldSpans = heldSpans.filter((item) => item.end >= span.start)
    return heard
  }

  // ── 插话 ──

  /** 它在说话吗：模型还在想或出字、合成还没完，或者喇叭里还排着 */
  function speaking(): boolean {
    return live.size > 0 || Date.now() < playbackUntil
  }

  function clearHold(): boolean {
    if (!hold) return false
    if (hold.grace) clearTimeout(hold.grace)
    clearTimeout(hold.limit)
    hold = null
    return true
  }

  /** 听见声音：先停播，什么都不扔 */
  function holdOutput(): void {
    if (hold) {
      // 又开口了：「停下来多久没结果」重新算
      if (hold.grace) clearTimeout(hold.grace)
      hold.grace = null
      return
    }
    hold = { grace: null, limit: setTimeout(giveUpHold, HOLD_MAX_MS) }
    emit({ type: 'output-hold' })
  }

  /** 刚才那不算插话：接着放 */
  function releaseOutput(): void {
    if (clearHold()) emit({ type: 'output-release' })
  }

  /**
   * 等到点了还没结果：多半是识别那一路认定不是人声，不会再回来了。
   * 真回来了（识别得慢、重试过）也还认得出是停着播时说的，见 `heldSpans`
   */
  function giveUpHold(): void {
    releaseOutput()
  }

  /** 掐掉手上的事。`notify` 为真时告诉渲染层把喇叭里排着的也掐掉 */
  function interrupt(notify: boolean): void {
    const held = clearHold()
    const wasSpeaking = speaking()
    for (const controller of live) controller.abort()
    live.clear()
    playbackUntil = 0
    // `interrupted` 会让渲染层掐掉排着的音频、并把停着的播放恢复；
    // 没在说话但停着播（喇叭刚好放完）的，单独放开，不然后面的回答出不了声
    if (notify && wasSpeaking) emit({ type: 'interrupted' })
    else if (held) emit({ type: 'output-release' })
  }

  /**
   * 一句整话识别出来了：当真，还是当没听见（见文件头「插话」）。
   *
   * 不忙时也问一句「是不是在对它说话」：它说完了、喇叭的尾音被收回来认成「Yeah.」，
   * 不拦的话它会一本正经地问「你说的 Yeah 是什么意思」。
   */
  async function consider(text: string, heard: boolean, asrTags?: string[]): Promise<void> {
    if (closed) return
    /*
     * **回声先拦，不交给判定模型。** 它出声的时候，用户真开口会先被本机响度检测听见、
     * 触发停播（门槛跟着「回声抑制」档位，`BARGE_IN_FLOOR_DB`）。识别那一路的门槛低，
     * 喇叭里自己的声音收回来也认得出字 —— 「虚幻工程」被认成「来工程。」，判定模型
     * 看它像个回答，0.85 放行了（真机 2026-10-14）。所以：喇叭在响（或刚停）时认出的话，
     * 之前没触发过停播的，就是不够响、不像有人凑着麦克风在说，按回声丢掉。
     *
     * 「触发过停播」按这一段算，不看这会儿还停没停着（见 `heldSpans`）：这会儿停着播，
     * 可能是后面另一句触发的，这一句照样是回声。
     */
    if (!heard && Date.now() < playbackUntil + ECHO_TAIL_MS) {
      console.log(`[拼装通话] 当作回声：「${text}」`)
      return
    }
    const busy = speaking() || hold !== null
    const verdict = deps.judgeUtterance
      ? await deps.judgeUtterance({ text, assistantSaying, busy, asrTags })
      : null
    if (closed) return
    const ignore =
      verdict !== null &&
      (verdict.addressed < ADDRESSED_FLOOR ||
        (busy && verdict.interrupt !== undefined && verdict.interrupt < INTERRUPT_AT))
    if (ignore) {
      console.log(`[拼装通话] 当作没听见：「${text}」`)
      releaseOutput()
      return
    }
    respond(text, true)
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
        let produced = false
        const onAudio = (chunk: SpeechAudio): void => {
          if (signal.aborted) return
          produced = true
          emit({ type: 'audio', base64: chunk.base64 })
          playbackUntil = Math.max(Date.now(), playbackUntil) + audioMs(chunk)
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await deps.speak(text, signal, onAudio)
            speakFailures = 0
            return
          } catch (error) {
            if (signal.aborted) return
            // 念了一半断的不重试，重念会把前半句再说一遍
            if (attempt === 1 || produced) {
              speakFailures += 1
              console.warn(`[拼装通话] 这一句没念出来（第 ${speakFailures} 次）：`, error)
              if (speakFailures >= MAX_SPEAK_FAILURES) failure ??= error
              return
            }
          }
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
      const askedAt = Date.now()
      assistantSaying = ''
      const stream = deps.reply({ system, messages: history, tools, signal })
      let text = ''
      const calls: ToolCall[] = []
      /*
       * 慢在哪儿得看得见。一句话从识别完到开口，模型首字常常占大头 —— 而那多半是
       * 它在先想（关不掉思考的模型、或者厂商默认开着思考）。日志里记一行，
       * 用户嫌慢时一眼看出是该换个快模型，还是该去关思考。
       */
      let firstTokenMs: number | null = null
      let thinkingChars = 0
      for await (const event of stream) {
        if (signal.aborted) break
        if (event.type === 'thinking_delta') thinkingChars += event.delta.length
        if (
          firstTokenMs === null &&
          (event.type === 'text_delta' || event.type === 'toolcall_end')
        ) {
          firstTokenMs = Date.now() - askedAt
          console.log(
            `[拼装通话] 模型首字 ${firstTokenMs}ms${thinkingChars ? `，此前思考 ${thinkingChars} 字` : ''}`
          )
        }
        if (event.type === 'text_delta') {
          text += event.delta
          assistantSaying = text
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
        /*
         * 这一轮哪怕被掐了也要报一句「说完了」—— 和 OpenAI 取消一轮之后照样发
         * `response.done` 一个约定。渲染层靠它落定说了一半的字幕；不报的话那个
         * 「正在输入」的气泡一直挂着，输入框以为还在执行，停止按钮怎么点都没反应
         * （真机 2026-10-14）。什么都没说出口的，没有气泡要落定，不报。
         */
        if (text.trim() || calls.length || !signal.aborted) emit({ type: 'turn-done' })
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
  function respond(text: string, spoken: boolean): void {
    interrupt(true)
    // 先 `interrupted` 再上屏这句：反过来的话渲染层会把这句之后的新回答当被打断的残片丢掉
    if (spoken) emit({ type: 'user-text', text, final: true })
    // 打字发来的没有那条终稿，渲染层「丢弃残片」只能等三秒兜底，新回答的头一两秒全被吞掉。
    // 被掐那一轮已经停发音频了（排着的由 `interrupted` 清掉），这里直接告诉它这句说完了
    else emit({ type: 'user-speech-done' })
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
      assistantSaying = notice.speech
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
    clearHold()
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
      const pcm = Buffer.from(base64, 'base64')
      const at = earMs
      earMs += (pcm.length / 2 / STT_INPUT_SAMPLE_RATE) * 1000
      const wasTalking = endpointer.speaking
      endpointer.push(pcm)
      // 它在说、或者在想的时候有人出声：先停播，等识别结果再定（不再一听见就掐）
      if (!wasTalking && endpointer.speaking && (speaking() || hold)) {
        holdOutput()
        // 这一段从这一包算起，到他停下为止
        heldSpans.push({ start: at, end: Infinity })
      }
      if (wasTalking && !endpointer.speaking) {
        const open = heldSpans.at(-1)
        if (open?.end === Infinity) open.end = earMs
        // 他停下了：渲染层据此不再把新到的音频当被打断那一轮的残片丢掉
        emit({ type: 'user-speech-done' })
        // 停下来这么久还没识别结果，就是识别那一路认定不是人声，接着放
        if (hold && !hold.grace) hold.grace = setTimeout(giveUpHold, HOLD_RESULT_GRACE_MS)
      }
    },
    sendText(text) {
      if (closed || !text.trim()) return
      // 打字发来的那句渲染层自己上过屏了
      respond(text.trim(), false)
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
