import { createEndpointer } from './endpointer'
import {
  STT_FLUSH_GRACE_MS,
  STT_INPUT_SAMPLE_RATE,
  type SttEvent,
  type SttSessionConfig,
  type SttSessionHandle
} from './types'

/**
 * 整段转写：收一整段音频、回一整段文字的那一类识别服务。
 *
 * 本机跑的 SenseVoice / Whisper（Xinference、FunASR、speaches、LocalAI …）、
 * 硅基流动、OpenAI 自己，用的都是 OpenAI 的 `/v1/audio/transcriptions` 这一个形状；
 * SenseVoice 仓库自带的 `api.py` 是另一个（`/api/v1/asr`）。两个形状只差表单字段名
 * 和回包结构，按地址认，不另设下拉框 —— 理由同 `stt/index.ts` 文件头。
 *
 * ## 和豆包、百炼那两家的区别
 *
 * 那两家是流式的：边说边识别，厂商自己判断一句话说完没有。这一类**不断句**，
 * 所以断句由我们做（`endpointer.ts`）：静下来 800 毫秒就把这一句送去识别。
 * 代价是没有中间态 —— 字是一句一句出来的，不是一个一个。
 *
 * @see https://platform.openai.com/docs/api-reference/audio/createTranscription
 * @see https://github.com/FunAudioLLM/SenseVoice/blob/main/api.py
 */

/** 单次识别最多等多久。本机识别是百毫秒级，云端一段 30 秒的话也就一两秒 */
const REQUEST_TIMEOUT_MS = 30_000

/** 「测试连接」送多长的静音。OpenAI 那家短于 0.1 秒直接拒，留足余量 */
const PROBE_AUDIO_MS = 500

export type TranscriptionApi = 'openai' | 'sensevoice'

export interface TranscriptionTarget {
  url: string
  api: TranscriptionApi
}

/**
 * 认地址：填的是哪一种、真正要打哪个 URL。
 *
 * 用户填的多半是 Base URL（`http://127.0.0.1:8000/v1`），和对话那边一个习惯，
 * 这里替他补上 `/audio/transcriptions`；直接贴了完整接口地址的也认。
 */
export function resolveTranscriptionTarget(baseUrl: string): TranscriptionTarget {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/api\/v1\/asr$/i.test(url)) return { url, api: 'sensevoice' }
  if (/\/audio\/transcriptions$/i.test(url)) return { url, api: 'openai' }
  return { url: `${url}/audio/transcriptions`, api: 'openai' }
}

/** PCM16 单声道包成 WAV。两种接口都按文件收，WAV 是唯一一个不用编码器就能做出来的格式 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 去掉 SenseVoice 的标签。
 *
 * 它的原始输出长这样：`<|zh|><|NEUTRAL|><|Speech|><|withitn|>你好。` ——
 * 语种、情绪、事件、是否规整，四个标签打在最前面。有的封装会去掉，有的原样透传，
 * 不去的话用户的搜索框里就是这一串。
 */
export function stripSenseVoiceTags(text: string): string {
  return text.replace(/<\|[^|]*\|>/g, '').trim()
}

/** 回包里拿出那句话。形状不对就抛 —— 200 回一个网页（地址填到了服务的首页）也是 200 */
export function parseTranscription(api: TranscriptionApi, body: unknown): string {
  if (api === 'sensevoice') {
    const result = (body as { result?: unknown } | null)?.result
    if (!Array.isArray(result)) throw new Error('识别服务的回包里没有 result，地址可能填错了')
    const first = (result[0] ?? {}) as { raw_text?: unknown; text?: unknown }
    // raw_text 只带标签；text 被它自己的后处理换成了表情符号，拿 raw_text 自己去标签
    const text = typeof first.raw_text === 'string' ? first.raw_text : first.text
    return typeof text === 'string' ? stripSenseVoiceTags(text) : ''
  }
  const text = (body as { text?: unknown } | null)?.text
  if (typeof text !== 'string') throw new Error('识别服务的回包里没有 text，地址可能填错了')
  return stripSenseVoiceTags(text)
}

/** 厂商回的错误原文。OpenAI 是 error.message，FastAPI 一系是 detail，其余的给原文开头 */
function vendorDetail(raw: string): string {
  try {
    const body = JSON.parse(raw) as {
      error?: { message?: unknown } | string
      detail?: unknown
      message?: unknown
    }
    const candidate =
      (typeof body.error === 'object' ? body.error?.message : body.error) ??
      body.detail ??
      body.message
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (candidate !== undefined) return JSON.stringify(candidate).slice(0, 200)
  } catch {
    // 不是 JSON，给原文
  }
  return raw.trim().slice(0, 200)
}

/**
 * HTTP 失败翻成一句用户能照着改的话。
 *
 * 只挑两类单独说：密钥不对和地址不对 —— 这一档十次失败里九次是这两样，
 * 而厂商那句 `Not Found` 不会告诉他地址该填到哪一层。
 */
function describeHttpFailure(status: number, detail: string): string {
  const suffix = detail ? `：${detail}` : ''
  if (status === 401 || status === 403) return `语音识别服务拒绝了密钥（HTTP ${status}）${suffix}`
  if (status === 404) {
    return `找不到识别接口（HTTP 404）。OpenAI 兼容服务的地址一般填到 /v1 为止；SenseVoice 自带的服务填到 /api/v1/asr`
  }
  return `语音识别请求失败（HTTP ${status}）${suffix}`
}

/** 网络层的失败。连不上本机服务是最常见的一种 —— 服务没开 */
function describeNetworkFailure(error: unknown, url: string): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return '语音识别服务迟迟没有回应'
  }
  const code = (error as { cause?: { code?: string } })?.cause?.code
  if (code === 'ECONNREFUSED') return `连不上语音识别服务（${url}），请确认它正在运行`
  if (code === 'ENOTFOUND') return `找不到语音识别服务的地址（${url}）`
  return error instanceof Error ? error.message : String(error)
}

export interface TranscriptionConfig {
  apiKey: string
  baseUrl: string
  model: string
  headers?: Record<string, string>
}

/** 识别一段 PCM16 单声道，回识别出的文字（没听出东西是空串） */
export async function transcribePcm(
  config: TranscriptionConfig,
  pcm: Buffer,
  sampleRate: number,
  signal: AbortSignal
): Promise<string> {
  const target = resolveTranscriptionTarget(config.baseUrl)
  const form = new FormData()
  // 拷进一块独立的 ArrayBuffer：Buffer 可能是共享池里的一截，Blob 的类型不收
  const audio = new Blob([new Uint8Array(pcmToWav(pcm, sampleRate))], { type: 'audio/wav' })
  if (target.api === 'sensevoice') {
    form.append('files', audio, 'speech.wav')
    form.append('lang', 'auto')
    // 打开文本规整：带标点、数字写成阿拉伯数字。关着出来的是一串没有标点的字
    form.append('use_itn', 'true')
  } else {
    form.append('file', audio, 'speech.wav')
    form.append('model', config.model)
    form.append('response_format', 'json')
  }

  let response: Response
  try {
    response = await fetch(target.url, {
      method: 'POST',
      headers: {
        ...config.headers,
        // 本机服务多半不要密钥。空着就不带，带一个空的 Bearer 有的服务会当成填错了
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })
  } catch (error) {
    // 我们自己撤的（会话关了）原样抛，调用方认得出；超时和网络错误翻成人话
    if (signal.aborted && (signal.reason as Error | undefined)?.name !== 'TimeoutError') throw error
    throw new Error(describeNetworkFailure(error, target.url))
  }

  const raw = await response.text()
  if (!response.ok) throw new Error(describeHttpFailure(response.status, vendorDetail(raw)))
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new Error('识别服务回的不是 JSON，地址可能填错了')
  }
  return parseTranscription(target.api, body)
}

/**
 * 「测试连接」：送半秒静音，看能不能拿回一个形状对的回包。
 *
 * 流式那两家靠握手就能验密钥和模型名；这一类没有握手，不真送一段音频什么都验不了。
 * 半秒静音的识别费用可以忽略（按时长计费的也是按秒），本机服务则是零成本。
 */
export async function probeTranscription(
  config: TranscriptionConfig,
  signal: AbortSignal
): Promise<void> {
  const silence = Buffer.alloc(((STT_INPUT_SAMPLE_RATE * PROBE_AUDIO_MS) / 1000) * 2)
  await transcribePcm(config, silence, STT_INPUT_SAMPLE_RATE, signal)
}

export function openTranscriptionSttSession(config: SttSessionConfig): SttSessionHandle {
  const endpointer = createEndpointer({ sampleRate: STT_INPUT_SAMPLE_RATE })
  const controller = new AbortController()
  /** 不再往外放事件（`closed` 除外） */
  let closed = false
  /** 松手了：不再收音频，等手上的几句识别完就收摊 */
  let flushed = false
  let finished = false
  /** 一句一句排着识别，出字的顺序才和说话的顺序一致 */
  let queue: Promise<void> = Promise.resolve()
  let pending = 0
  let graceTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (event: SttEvent): void => {
    if (closed) return
    config.onEvent(event)
  }

  /*
   * 没有握手，开起来就能收音频。但**不能同步报就绪**：IPC 那头要等这个函数
   * 返回、把会话记成「当前这一路」之后才转发事件（`ipc/speechToText.ts`），
   * 同步发出去的那一条会被当成别人的事件丢掉，渲染层永远等不到就绪。
   */
  const readyTimer = setTimeout(() => emit({ type: 'ready' }), 0)

  function finish(): void {
    if (finished) return
    finished = true
    closed = true
    clearTimeout(readyTimer)
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = null
    // 还在路上的请求一并撤掉：本机服务无所谓，云端按次计费的那几家就是白花钱
    controller.abort()
    config.onEvent({ type: 'closed' })
  }

  function fail(message: string): void {
    if (closed) return
    // 先发错误再关 —— 关了之后 emit 什么都不放了
    emit({ type: 'error', message })
    finish()
  }

  function recognize(sentence: Buffer): void {
    pending += 1
    queue = queue.then(async () => {
      try {
        if (closed) return
        const text = await transcribePcm(config, sentence, STT_INPUT_SAMPLE_RATE, controller.signal)
        // 断句判出来有人说话，识别却一个字没有：多半是没说清，让界面说一声
        emit(text ? { type: 'user-text', text, final: true } : { type: 'asr-failed' })
      } catch (error) {
        if (!closed) fail(error instanceof Error ? error.message : String(error))
      } finally {
        pending -= 1
        if (flushed && pending === 0) finish()
      }
    })
  }

  return {
    appendAudio(base64) {
      if (closed || flushed) return
      for (const sentence of endpointer.push(Buffer.from(base64, 'base64'))) recognize(sentence)
    },
    flush() {
      if (closed || flushed) return
      flushed = true
      const tail = endpointer.end()
      if (tail) recognize(tail)
      if (pending === 0) {
        finish()
        return
      }
      graceTimer = setTimeout(finish, STT_FLUSH_GRACE_MS)
    },
    close() {
      finish()
    }
  }
}
