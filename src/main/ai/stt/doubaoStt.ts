import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import WebSocket from 'ws'
import {
  STT_FLUSH_GRACE_MS,
  STT_INPUT_SAMPLE_RATE,
  type SttEvent,
  type SttSessionConfig
} from './types'
import type { SttSessionHandle } from './types'

/**
 * 豆包大模型流式语音识别（STT 2.0 / sauc）。
 *
 * ## 和同一个域名下的另外两条线的关系
 *
 * `openspeech.bytedance.com` 上挂着三条我们都在用的线，它们**谁也不能替谁**：
 *
 * | | 走哪条 | 出什么 |
 * |---|---|---|
 * | 实时语音（`realtime/doubaoRealtime.ts`） | `/api/v3/duplex/realtime/dialogue` | 音频 + 转写 + 工具调用 |
 * | 语音合成（`speech.ts`） | `/api/v3/tts/unidirectional/sse` | 音频 |
 * | 听写（这里） | `/api/v3/sauc/bigmodel` | **只有文字** |
 *
 * 听写以前是借第一条跑的，而豆包全双工的上行事件表里没有关掉自动应答的开关 ——
 * 于是绑豆包的用户按下热键只能得到一句「这会儿用不了语音」。这条线没有那个问题：
 * 它本来就只做识别，压根没有「回答」这回事。
 *
 * ## 这条线是二进制协议，不是 JSON 帧
 *
 * 实时语音 3.0 换成了纯 JSON 文本帧，而识别这条**还是老的二进制封装**：
 * 4 字节头 + （可选的 4 字节序号）+ 4 字节长度 + gzip 过的负载。整数一律大端。
 * 两条线在同一个域名下用着两套完全不同的协议，是这一块最容易想当然的地方。
 *
 * ## 三个「填错了不报错、只是不工作」的地方
 *
 * 1. **`model_name` 恒为 `bigmodel`**，不是用户绑的那个模型 id。用户绑的那个
 *    是**资源 ID**（`volc.seedasr.sauc.duration`），走 `X-Api-Resource-Id` 头。
 *    填反了拿到的是 45000001，而报错里不会说是哪个字段。
 * 2. **只收 16k**。文档写死「目前只支持 16000」，送 24k 得到的是一串糊字，
 *    不是报错。
 * 3. **单包 100~200ms**。每秒 50 个 20ms 小包会显著拖垮识别延迟（文档原话是
 *    「过大或者过小均会影响性能」），攒包在上层的 `sttSession` 里做。
 *
 * @see https://www.volcengine.com/docs/6561/1354869 大模型流式语音识别 API
 */

const DEFAULT_PATH = '/api/v3/sauc/bigmodel'

/** 资源 ID 没填时的默认值：豆包流式语音识别 2.0，小时版 */
export const DOUBAO_STT_RESOURCE_ID = 'volc.seedasr.sauc.duration'

/** 协议里的消息类型。低 4 位是 flags，见 `header` */
const MESSAGE_TYPE = {
  fullClientRequest: 0b0001,
  audioOnlyRequest: 0b0010,
  fullServerResponse: 0b1001,
  serverError: 0b1111
} as const

/** flags：0b0000 表示「头后面那 4 个字节不是序号」，0b0010 追加「这是最后一包」 */
const FLAG_NONE = 0b0000
const FLAG_LAST_PACKET = 0b0010
/** 服务端回包带序号时的两种 flags（正序号 / 负序号）。解包要据此跳过 4 个字节 */
const FLAG_HAS_SEQUENCE = new Set([0b0001, 0b0011])

const SERIALIZATION_NONE = 0b0000
const SERIALIZATION_JSON = 0b0001
const COMPRESSION_GZIP = 0b0001

/** 成功码。豆包这条线用 20000000 表示「一切正常」，不是 0 */
const CODE_SUCCESS = 20000000

/** 发完负包最多等这么久让它刷出去，超了就硬断 */
const CLOSE_GRACE_MS = 1_000

/**
 * 4 字节头。
 *
 * ```
 * byte0: 协议版本(4) | 头长度(4)          —— 固定 0b0001_0001，头长 1×4 字节
 * byte1: 消息类型(4) | 消息类型补充标志(4)
 * byte2: 序列化方式(4) | 压缩方式(4)
 * byte3: 保留
 * ```
 */
function header(messageType: number, flags: number, serialization: number): Buffer {
  return Buffer.from([
    0b0001_0001,
    (messageType << 4) | flags,
    (serialization << 4) | COMPRESSION_GZIP,
    0x00
  ])
}

/** 头 + 4 字节大端长度 + gzip 负载。三种上行帧唯一的区别就是头里那几位 */
function frame(messageType: number, flags: number, serialization: number, payload: Buffer): Buffer {
  const compressed = gzipSync(payload)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(compressed.length, 0)
  return Buffer.concat([header(messageType, flags, serialization), size, compressed])
}

export interface DoubaoSttFrame {
  kind: 'response' | 'error'
  /** 错误帧里的错误码；正常回包没有这一位 */
  code?: number
  payload: unknown
  /** 服务端标了「这是最后一包结果」（flags 第二位）。收尾之后见到它就可以关了 */
  last: boolean
}

/**
 * 「没听到人说话」这类码。不是故障：按住热键没开口、声音太小，都会回这个。
 * 当成错误的话，状态条上是一句「识别服务报错（20000003）」，听写也跟着关了。
 */
const NOTHING_HEARD_CODES = new Set([20000003, 45000002])

/**
 * 拆一个服务端下行帧。
 *
 * 单独导出是为了能单测 —— 这段里每一个偏移量错了都不会抛，只会把 JSON
 * 解析在一个错位的字节上，表现是「连上了，但一个字都不出」。
 */
export function decodeDoubaoSttFrame(data: Buffer): DoubaoSttFrame | null {
  if (data.length < 8) return null
  const headerSize = (data[0] & 0x0f) * 4
  const messageType = data[1] >> 4
  const flags = data[1] & 0x0f
  const serialization = data[2] >> 4
  const compression = data[2] & 0x0f

  let offset = headerSize
  let code: number | undefined
  if (messageType === MESSAGE_TYPE.serverError) {
    code = data.readUInt32BE(offset)
    offset += 4
  } else if (FLAG_HAS_SEQUENCE.has(flags)) {
    // 序号本身用不上（我们不重发），但它占着 4 个字节，不跳过就会把长度读歪
    offset += 4
  }

  if (offset + 4 > data.length) return null
  const size = data.readUInt32BE(offset)
  offset += 4
  const body = data.subarray(offset, offset + size)
  const raw = compression === COMPRESSION_GZIP && body.length ? gunzipSync(body) : body
  const text = raw.toString('utf8')
  const payload = serialization === SERIALIZATION_JSON && text ? safeJson(text) : text
  return {
    kind: messageType === MESSAGE_TYPE.serverError ? 'error' : 'response',
    code,
    payload,
    last: (flags & 0b0010) !== 0
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // 解不出来就把原文交上去。这一层不判断内容，交给调用方去说人话
    return text
  }
}

/** Provider 里通常只填域名；也兼容用户直接粘一条完整的 WebSocket 地址 */
export function resolveDoubaoSttUrl(baseUrl?: string): string {
  const url = (baseUrl?.trim() || `wss://openspeech.bytedance.com${DEFAULT_PATH}`)
    .replace(/^http/i, 'ws')
    .replace(/\/+$/, '')
  return /\/sauc\/[a-z_]+$/i.test(url) ? url : `${url}${DEFAULT_PATH}`
}

/**
 * 首帧要发的那包参数。
 *
 * 几个不走默认值的地方，每一个都是为听写这个场景选的：
 *
 * - `show_utterances` —— 不开就只有一个不断增长的 `result.text`，没有任何
 *   「这一句说完了」的信号，而听写整条链路等的就是那个信号。
 * - `result_type: 'single'` —— 增量返回。全量的话每一包都带着之前所有分句，
 *   上层每收一包就要自己去算「哪一段是新的」。
 * - `end_window_size` —— 按静音判停而不是语义分句。语义分句更准，但它会等
 *   模型想明白这句话完没完，交互场景里那几百毫秒就是干等。
 * - `enable_ddc`（顺滑，默认关）—— 听写出来的字是要交给 Agent 当指令的，
 *   「呃」「那个」「把把把这个」留着只会让指令更难懂。
 */
function requestParams(): Record<string, unknown> {
  return {
    user: { uid: 'unreal-box' },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: STT_INPUT_SAMPLE_RATE,
      bits: 16,
      channel: 1
    },
    request: {
      model_name: 'bigmodel',
      show_utterances: true,
      result_type: 'single',
      enable_punc: true,
      enable_itn: true,
      enable_ddc: true,
      end_window_size: 800
    }
  }
}

interface Utterance {
  text?: string
  definite?: boolean
  start_time?: number
  end_time?: number
}

export function openDoubaoSttSession(config: SttSessionConfig): SttSessionHandle {
  const socket = new WebSocket(resolveDoubaoSttUrl(config.baseUrl), {
    headers: {
      ...config.headers,
      // 新版控制台的单值 API Key。旧版那套 AppKey + AccessKey 这里不支持 ——
      // 同一个仓库里实时语音、语音合成走的都是新版，再兼容一套只会多一条分支
      'X-Api-Key': config.apiKey,
      'X-Api-Resource-Id': config.model || DOUBAO_STT_RESOURCE_ID,
      'X-Api-Request-Id': randomUUID(),
      // 服务端拿它把一条连接上的所有事件串起来，排查时和 X-Tt-Logid 配合用
      'X-Api-Connect-Id': randomUUID(),
      // 文档的鉴权表里列着它，说明是「发包序号，固定值 -1」。示例里没写，
      // 但多发一个服务端忽略的头，代价远小于漏发一个它要的头
      'X-Api-Sequence': '-1'
    },
    // 关掉 permessage-deflate，理由同实时语音那条线：压缩走 zlib 的异步回调，
    // 压的期间后面的 send 全排队，而音频是恒速产生的 —— 队列有进无出。
    // 何况这条线的负载本来就已经 gzip 过了，再压一遍纯属白烧 CPU
    perMessageDeflate: false,
    handshakeTimeout: 15_000
  })

  let closed = false
  /** 已经发过收尾包。发完还继续收终稿，但不再接受新音频 */
  let flushed = false
  /** 真的把 socket 收掉了没有。`closed` 只表示「不再接受新事件」，两者不同步 */
  let finished = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  /** 已经交出去的终稿，去重用。键是 起止时间 + 原文 */
  const emitted = new Set<string>()

  const emit = (event: SttEvent): void => {
    if (closed && event.type !== 'closed') return
    config.onEvent(event)
  }

  /** 真正把 socket 收掉。三个入口（超时、厂商的 close、我们自己关）都走这儿 */
  function finish(): void {
    if (finished) return
    finished = true
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    socket.removeAllListeners()
    // terminate() 在握手期间被取消时会异步抛一个 error 出来，接住它
    socket.on('error', () => {})
    socket.terminate()
    config.onEvent({ type: 'closed' })
  }

  const fail = (message: string): void => {
    if (closed) return
    closed = true
    emit({ type: 'error', message })
    finish()
  }

  /**
   * 发负包告诉服务端音频到此为止。
   *
   * `close` 和 `flush` 都要发它，区别只在发完之后还收不收事件 —— 所以抽出来，
   * 免得两条路各写一份、改了一处忘了另一处。
   *
   * 发完**不立刻 terminate**：terminate 是硬断，刚 send 进去还没刷出去的那一帧
   * 会跟着连接一起消失，于是「好好收尾」这件事只是看起来做了。
   */
  function sendLastPacket(): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false
    socket.send(
      frame(MESSAGE_TYPE.audioOnlyRequest, FLAG_LAST_PACKET, SERIALIZATION_NONE, Buffer.alloc(0))
    )
    return true
  }

  /**
   * 音频到此为止，但继续等终稿（见 `SttSessionHandle.flush`）。
   *
   * **不置 `closed`**，这是它和 `close` 唯一的、也是全部的区别：置了的话
   * `emit` 会把负包换回来的那条终稿挡在门外，用户松手之后就永远少最后一句。
   *
   * 这里不主动 `socket.close()` —— 服务端收到负包、回完终稿会自己关，
   * 那条 `close` 事件由下面的 `socket.on('close')` 接住。我们只留一个兜底闹钟。
   */
  function flush(): void {
    if (closed || flushed) return
    flushed = true
    if (!sendLastPacket()) {
      close()
      return
    }
    closeTimer = setTimeout(close, STT_FLUSH_GRACE_MS)
  }

  function close(): void {
    if (closed) return
    closed = true
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    /*
     * 已经 flush 过就不必再发一次负包：服务端那边这条会话早就结束了，
     * 再发一帧只会拿到一个协议错误（而那时候我们已经不看事件了）。
     */
    if (flushed || !sendLastPacket()) {
      finish()
      return
    }
    socket.once('close', finish)
    closeTimer = setTimeout(finish, CLOSE_GRACE_MS)
    socket.close()
  }

  socket.on('open', () => {
    if (closed) return
    socket.send(
      frame(
        MESSAGE_TYPE.fullClientRequest,
        FLAG_NONE,
        SERIALIZATION_JSON,
        Buffer.from(JSON.stringify(requestParams()), 'utf8')
      ),
      (error) => {
        if (error) fail(error.message)
      }
    )
    /*
     * **首帧发出去就算就绪。**
     *
     * 豆包对 full client request 也会回一包 full server response，等那一包
     * 再放行更「严谨」—— 但它和第一包音频的识别结果之间没有顺序保证，而这边
     * 等着 ready 才开始送音频。真机上的表现是首字被吃掉一两个。
     */
    emit({ type: 'ready' })
  })

  socket.on('message', (data) => {
    if (closed) return
    try {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      const decoded = decodeDoubaoSttFrame(buffer)
      if (!decoded) return
      if (decoded.kind === 'error') {
        if (decoded.code !== undefined && NOTHING_HEARD_CODES.has(decoded.code)) {
          nothingHeard()
          return
        }
        fail(describeError(decoded.code, decoded.payload))
        return
      }
      accept(decoded.payload)
      // 收尾之后等到了最后一包：终稿已经在上面交出去了，不用再干等服务端关连接
      //（它不一定关，干等就是每次松手都白等两秒兜底）
      if (decoded.last && flushed) close()
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })

  socket.on('error', (error) => fail(error.message))
  socket.on('close', () => {
    // flush 之后服务端回完终稿就会自己关，走的正是这条。兜底闹钟得撤掉
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    if (closed) return
    closed = true
    finish()
  })

  /** 没听到人说话：报一声「没听清」，不当故障。已经在收尾的话顺手关掉 */
  function nothingHeard(): void {
    emit({ type: 'asr-failed' })
    if (flushed) close()
  }

  /** 一包识别结果。终稿逐句交出去，中间态整段交出去 */
  function accept(payload: unknown): void {
    const body = payload as {
      result?: { text?: string; utterances?: Utterance[] }
      code?: number
    }
    if (typeof body?.code === 'number' && body.code !== CODE_SUCCESS) {
      if (NOTHING_HEARD_CODES.has(body.code)) {
        nothingHeard()
        return
      }
      fail(describeError(body.code, payload))
      return
    }
    const utterances = body?.result?.utterances
    if (!Array.isArray(utterances) || utterances.length === 0) {
      const text = body?.result?.text?.trim()
      if (text) emit({ type: 'user-text', text, final: false })
      return
    }

    const pending: string[] = []
    for (const utterance of utterances) {
      const text = utterance?.text?.trim()
      if (!text) continue
      if (!utterance.definite) {
        pending.push(text)
        continue
      }
      /*
       * 去重。`result_type: single` 正常情况下不会把同一句再发一遍，但
       * 「正常情况下不会」在这条链路上不够用 —— 真重了一次，用户看到的是
       * 输入框里同一句话贴了两遍，而没有任何报错说明发生了什么。
       */
      const key = `${utterance.start_time ?? ''}-${utterance.end_time ?? ''}-${text}`
      if (emitted.has(key)) continue
      emitted.add(key)
      emit({ type: 'user-text', text, final: true })
    }
    if (pending.length) emit({ type: 'user-text', text: pending.join(''), final: false })
  }

  return {
    appendAudio: (base64: string) => {
      // 收尾包之后再送音频，服务端会当协议错误。上层松手到真正收摊之间还有
      // 一两包在路上，挡在这儿
      if (closed || flushed || socket.readyState !== WebSocket.OPEN) return
      const pcm = Buffer.from(base64, 'base64')
      if (!pcm.length) return
      socket.send(frame(MESSAGE_TYPE.audioOnlyRequest, FLAG_NONE, SERIALIZATION_NONE, pcm))
    },
    flush,
    close
  }
}

/**
 * 把错误码翻成一句能放进界面的话。
 *
 * 码本身也留着 —— 用户来问的时候，「45000001」在文档里搜得到，
 * 而我们翻的那句话搜不到。
 */
export function describeError(code: number | undefined, payload: unknown): string {
  const known: Record<number, string> = {
    45000001: '请求参数无效（资源 ID 或音频参数不对）',
    45000002: '没收到音频',
    45000081: '等包超时',
    45000151: '音频格式不正确',
    55000031: '服务器繁忙'
  }
  const detail =
    typeof payload === 'string'
      ? payload
      : typeof (payload as { message?: string })?.message === 'string'
        ? (payload as { message: string }).message
        : ''
  const head = code ? `${known[code] || '识别服务报错'}（${code}）` : '识别服务报错'
  return detail ? `${head}：${detail}` : head
}
