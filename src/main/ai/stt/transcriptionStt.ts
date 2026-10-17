import { createEndpointer } from './endpointer'
import {
  STT_FLUSH_GRACE_MS,
  STT_INPUT_SAMPLE_RATE,
  type SttAudioSpan,
  type SttEvent,
  type SttSessionConfig,
  type SttSessionHandle
} from './types'

/**
 * 整段转写：收一整段音频、回一整段文字的那一类识别服务。
 *
 * 本机跑的 SenseVoice / Whisper（Xinference、FunASR、speaches、LocalAI …）、
 * 硅基流动、OpenAI 自己，用的都是 OpenAI 的 `/v1/audio/transcriptions` 这一个形状；
 * SenseVoice 仓库自带的 `api.py` 是另一个（`/api/v1/asr`）；一键包、整合包多半只开了
 * Gradio 网页界面，那是第三个（先传文件、再发起、再取结果，见 `transcribeGradio`）。
 * 按地址认，不另设下拉框 —— 理由同 `stt/index.ts` 文件头。
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

/**
 * 单次识别最多等多久，重试、等限流也算在里面。本机识别是百毫秒级，云端一段 30 秒的话也就一两秒
 */
const REQUEST_TIMEOUT_MS = 30_000

/** 「测试连接」送多长的静音。OpenAI 那家短于 0.1 秒直接拒，留足余量 */
const PROBE_AUDIO_MS = 500

/**
 * 连着几句没识别出来就挂断。和合成那边（`cascadeRealtime.ts` 的 MAX_SPEAK_FAILURES）一个想法：
 * 偶尔一句超时、限流，作废这一句就好；连着几句都不行，是服务坏了或者配错了，说清楚再挂。
 */
const MAX_FAILED_SENTENCES = 3

/** 等一会儿。会话关了就不等了 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

export type TranscriptionApi = 'openai' | 'sensevoice' | 'gradio'

export interface TranscriptionTarget {
  /** OpenAI / SenseVoice：要打的那个接口。Gradio：网页界面的根地址（`/gradio_api` 之前那段） */
  url: string
  api: TranscriptionApi
  /** Gradio 的接口名（`/gradio_api/call/<它>`）。地址里没写就从界面的接口清单里找带音频输入的那个 */
  endpoint?: string
}

/**
 * 认地址：填的是哪一种、真正要打哪个 URL。
 *
 * 用户填的多半是 Base URL（`http://127.0.0.1:8000/v1`），和对话那边一个习惯，
 * 这里替他补上 `/audio/transcriptions`；直接贴了完整接口地址的也认。
 *
 * **只有主机和端口、没有路径的**按 Gradio 网页界面算：那是用户在浏览器里打开的地址，
 * 也是他唯一知道的地址。OpenAI 兼容的服务几乎都挂在 `/v1` 下面，裸地址本来就打不通。
 */
export function resolveTranscriptionTarget(baseUrl: string): TranscriptionTarget {
  const url = baseUrl.trim().replace(/\/+$/, '')
  const gradio = url.search(/\/gradio_api(\/|$)/i)
  if (gradio >= 0) {
    const endpoint = /\/gradio_api\/call\/([^/?#]+)/i.exec(url)?.[1]
    return { url: url.slice(0, gradio), api: 'gradio', ...(endpoint ? { endpoint } : {}) }
  }
  if (/^https?:\/\/[^/]+$/i.test(url)) return { url, api: 'gradio' }
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
 * SenseVoice 自己的后处理（`rich_transcription_postprocess`）把情绪、声音事件标签
 * 换成的那几个表情（funasr `postprocess_utils.py` 的 emo_dict / event_dict / emoji_dict）。官方网页界面回的就是这种文字：「好的。😊」「🎼音乐」。
 * 只认这一张表里的，用户真念出来的字一个不动。
 */
const SENSEVOICE_EVENT_EMOJI = /[😊😔😡😰🤢😮🎼👏😀😭🤧😷❓]/gu

/**
 * 去掉 SenseVoice 的标签。
 *
 * 它的原始输出长这样：`<|zh|><|NEUTRAL|><|Speech|><|withitn|>你好。` ——
 * 语种、情绪、事件、是否规整，四个标签打在最前面。有的封装会去掉，有的原样透传，
 * 有的换成了表情（见 `SENSEVOICE_EVENT_EMOJI`）。不去的话用户的搜索框里就是这一串。
 */
export function stripSenseVoiceTags(text: string): string {
  return text
    .replace(/<\|[^|]*\|>/g, '')
    .replace(SENSEVOICE_EVENT_EMOJI, '')
    .trim()
}

/** 识别回来的一段 */
export interface Transcript {
  /** 去掉标签和表情之后的那句话。不是人声时为空 */
  text: string
  /** SenseVoice 打的标签（语种、情绪、事件，如 `zh`、`NEUTRAL`、`Cough`），没有就是空数组 */
  tags: string[]
  /**
   * 识别模型自己说这段是不是人声。
   *
   * **判断交给模型，不由我们猜**：SenseVoice 对没人说话的一段会打 `nospeech` 标签；
   * 去完标签和表情一个字都不剩（只剩「.」「。」）的，也是它在说「这里没有话」。
   * 杂音、咳嗽、喇叭的回声被它认成这样的，拼装通话就当没发生 —— 不上屏、不打断。
   */
  speech: boolean
}

/** 从带标签的原文里读出那句话。`tagSource` 给了就从它读标签（Gradio 界面把原始输出放在另一栏） */
export function readTranscript(raw: string, tagSource: string = raw): Transcript {
  const tags = [...tagSource.matchAll(/<\|([^|]*)\|>/g)].map((match) => match[1])
  const text = stripSenseVoiceTags(raw)
  const speech = !tags.includes('nospeech') && /[\p{L}\p{N}]/u.test(text)
  return { text: speech ? text : '', tags, speech }
}

/** 回包里拿出那句话。形状不对就抛 —— 200 回一个网页（地址填到了服务的首页）也是 200 */
export function parseTranscription(
  api: Exclude<TranscriptionApi, 'gradio'>,
  body: unknown
): Transcript {
  if (api === 'sensevoice') {
    const result = (body as { result?: unknown } | null)?.result
    if (!Array.isArray(result)) throw new Error('识别服务的回包里没有 result，地址可能填错了')
    const first = (result[0] ?? {}) as { raw_text?: unknown; text?: unknown }
    // raw_text 只带标签；text 被它自己的后处理换成了表情符号，拿 raw_text 自己去标签
    const text = typeof first.raw_text === 'string' ? first.raw_text : first.text
    return readTranscript(typeof text === 'string' ? text : '')
  }
  const text = (body as { text?: unknown } | null)?.text
  if (typeof text !== 'string') throw new Error('识别服务的回包里没有 text，地址可能填错了')
  return readTranscript(text)
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
 * 识别请求的失败，带上「是不是一过性的」。
 *
 * **一过性的按白名单认**：超时、连接中途断了、网关 502/503/504、500、不是额度用完的 429。
 * 这些只作废这一句，不为它挂断整通电话。其余的（密钥、地址、服务没开、证书、额度用完……）
 * 重试多少次都一样，要用户去改 —— 当场说清楚，别一直报「没听清」。
 *
 * `retryAfterMs`：值得再送一次、送之前等多久。超时的不给 —— 排着队识别，
 * 一句再等一轮，后面的话全跟着等。
 */
class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly retryAfterMs?: number
  ) {
    super(message)
  }
}

const isTransient = (error: unknown): error is TranscriptionError =>
  error instanceof TranscriptionError && error.transient

/** 限流、服务忙时没说等多久，就等这么久再送 */
const RETRY_BACKOFF_MS = 500

/** 最多等这么久再送。对方要我们等得更久，这一句就不再送了：边说边等，用户会以为它卡住了 */
const RETRY_BACKOFF_MAX_MS = 2_000

/** 回包说该等多久（`Retry-After`，秒数或日期）。等不起的回 undefined，不重试 */
function retryDelay(header: string | null): number | undefined {
  const seconds = header === null || header.trim() === '' ? NaN : Number(header)
  const at = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(header ?? '')
  const delay = Number.isFinite(at) ? Math.max(0, at - Date.now()) : RETRY_BACKOFF_MS
  return delay <= RETRY_BACKOFF_MAX_MS ? delay : undefined
}

/** 429 里额度用完的那种（OpenAI 的 insufficient_quota）：等多久都没用，要用户去充值 */
const isQuotaExhausted = (raw: string): boolean =>
  /insufficient_quota|exceeded your current quota|余额不足|欠费/i.test(raw)

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
    return (
      '找不到识别接口（HTTP 404）。OpenAI 兼容服务的地址一般填到 /v1 为止；' +
      'SenseVoice 自带的 api.py 填到 /api/v1/asr；Gradio 网页界面直接填浏览器里打开的那个地址'
    )
  }
  return `语音识别请求失败（HTTP ${status}）${suffix}`
}

const isTimeout = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'TimeoutError'

const causeOf = (error: unknown): { code?: string; message?: string } | undefined =>
  (error as { cause?: { code?: string; message?: string } } | null)?.cause

/**
 * 连接中途被掐断：连上了、请求发了一半或回包读了一半，对面断了。重连一次多半就好。
 * undici 读回包读到一半断掉时抛的是 `TypeError('terminated')`，cause 不一定带 code
 */
function isDropped(error: unknown): boolean {
  const code = causeOf(error)?.code ?? (error as { code?: string } | null)?.code
  if (code && ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return true
  return error instanceof Error && error.message === 'terminated'
}

/** 网络层的失败。连不上本机服务是最常见的一种 —— 服务没开 */
function describeNetworkFailure(error: unknown, url: string): string {
  if (isTimeout(error)) return '语音识别服务迟迟没有回应'
  const cause = causeOf(error)
  if (cause?.code === 'ECONNREFUSED') return `连不上语音识别服务（${url}），请确认它正在运行`
  if (cause?.code === 'ENOTFOUND') return `找不到语音识别服务的地址（${url}）`
  if (isDropped(error)) return '和语音识别服务的连接中途断了'
  // 其余的（证书不认、主机不可达、端口被浏览器内核禁用……）带上底层原话，fetch failed 那一句没用
  const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : '')
  return `连不上语音识别服务（${url}）${detail ? `：${detail}` : ''}`
}

export interface TranscriptionConfig {
  apiKey: string
  baseUrl: string
  model: string
  headers?: Record<string, string>
}

/**
 * 发一次请求，回原文。超时、网络错误、HTTP 失败都在这里翻成人话。
 *
 * 三种接口共用：Gradio 那一种一次识别要打三个请求，每一个都可能失败在同样几处。
 */
async function send(
  config: TranscriptionConfig,
  url: string,
  init: { method: 'GET' | 'POST'; body?: FormData; json?: unknown },
  signal: AbortSignal
): Promise<string> {
  let response: Response
  let raw: string
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        ...config.headers,
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        // 本机服务多半不要密钥。空着就不带，带一个空的 Bearer 有的服务会当成填错了
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })
    // 回包也在这里读：它同样会超时、读到一半断掉（Gradio 取结果那一下是一段事件流，识别完才收尾）
    raw = await response.text()
  } catch (error) {
    // 我们自己撤的（会话关了）原样抛，调用方认得出；超时和网络错误翻成人话
    if (signal.aborted && (signal.reason as Error | undefined)?.name !== 'TimeoutError') throw error
    const dropped = isDropped(error)
    throw new TranscriptionError(
      describeNetworkFailure(error, url),
      dropped || isTimeout(error),
      dropped ? 0 : undefined
    )
  }
  if (!response.ok) {
    const { status } = response
    const busy = [502, 503, 504].includes(status) || (status === 429 && !isQuotaExhausted(raw))
    // 500：本机服务显存一紧就会回一次，只作废这一句、不重送；一直 500 由连败上限收摊
    throw new TranscriptionError(
      describeHttpFailure(status, vendorDetail(raw)),
      busy || status === 500,
      busy ? retryDelay(response.headers.get('retry-after')) : undefined
    )
  }
  return raw
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('识别服务回的不是 JSON，地址可能填错了')
  }
}

/** 识别一段 PCM16 单声道 */
export async function transcribePcm(
  config: TranscriptionConfig,
  pcm: Buffer,
  sampleRate: number,
  signal: AbortSignal
): Promise<Transcript> {
  const target = resolveTranscriptionTarget(config.baseUrl)
  // 拷进一块独立的 ArrayBuffer：Buffer 可能是共享池里的一截，Blob 的类型不收
  const audio = new Blob([new Uint8Array(pcmToWav(pcm, sampleRate))], { type: 'audio/wav' })
  if (target.api === 'gradio') return transcribeGradio(config, target, audio, signal)

  const form = new FormData()
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
  const raw = await send(config, target.url, { method: 'POST', body: form }, signal)
  return parseTranscription(target.api, parseJson(raw))
}

// ── Gradio 网页界面 ──

interface GradioParameter {
  component?: string
  parameter_has_default?: boolean
  parameter_default?: unknown
}

interface GradioEndpoint {
  parameters?: GradioParameter[]
  returns?: { component?: string }[]
}

/** 怎么调这个界面：哪个接口、音频放第几个、其余参数填什么、结果取第几个 */
export interface GradioPlan {
  endpoint: string
  audioIndex: number
  defaults: unknown[]
  outputIndex: number
}

/**
 * 从界面自己的接口清单（`/gradio_api/info`）里读出怎么调它。
 *
 * **不写死参数**：一键包、官方 webui、各人自己改的界面，参数个数和顺序各不相同 ——
 * 有的是「音频、语言」，有的是「音频、语言、数字规整」。清单里写着每个参数是什么控件、
 * 默认值是多少，照着填就对得上：音频放进音频控件那一格，其余一律用界面自己的默认值，
 * 结果取第一个文本框（「识别结果」那一栏，后面常跟着「处理状态」「原始输出」）。
 */
export function planGradioCall(info: unknown, wanted?: string): GradioPlan {
  const endpoints = (info as { named_endpoints?: Record<string, GradioEndpoint> } | null)
    ?.named_endpoints
  if (!endpoints) throw new Error('这个地址不是 Gradio 界面（读不到接口清单），请检查地址')
  const hasAudio = (item: GradioEndpoint): boolean =>
    (item.parameters ?? []).some((param) => param.component === 'Audio')
  const name = wanted
    ? `/${wanted}`
    : Object.keys(endpoints).find((key) => hasAudio(endpoints[key]))
  const endpoint = name ? endpoints[name] : undefined
  if (!name || !endpoint) {
    throw new Error(
      wanted
        ? `Gradio 界面上没有 ${wanted} 这个接口`
        : 'Gradio 界面上没有带音频输入的接口，它可能不是语音识别服务'
    )
  }
  const parameters = endpoint.parameters ?? []
  const audioIndex = parameters.findIndex((param) => param.component === 'Audio')
  if (audioIndex < 0) throw new Error(`Gradio 接口 ${name.slice(1)} 没有音频输入`)
  const outputIndex = Math.max(
    0,
    (endpoint.returns ?? []).findIndex((item) => item.component === 'Textbox')
  )
  return {
    endpoint: name.slice(1),
    audioIndex,
    defaults: parameters.map((param) =>
      param.parameter_has_default ? param.parameter_default : null
    ),
    outputIndex
  }
}

/** 读 `/call/<接口>/<事件>` 回的那段事件流，拿出 complete 那一条的数据 */
export function parseGradioEvents(raw: string): unknown[] {
  let event = ''
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (event === 'complete') {
      const parsed = JSON.parse(data) as unknown
      if (Array.isArray(parsed)) return parsed
    }
    if (event === 'error') {
      // Gradio 出错时 data 常常就是一个 null，原话里没有可说的
      throw new Error(`Gradio 接口报错${data && data !== 'null' ? `：${data.slice(0, 200)}` : ''}`)
    }
  }
  throw new Error('Gradio 接口没有返回结果')
}

/**
 * 接口清单按地址缓存。每说一句都去读一遍，是每句话多一个来回；
 * 读失败的不缓存，服务重开之后下一句就能读到。
 */
const gradioPlans = new Map<string, Promise<GradioPlan>>()

function gradioPlan(
  config: TranscriptionConfig,
  target: TranscriptionTarget,
  signal: AbortSignal
): Promise<GradioPlan> {
  const key = `${target.url}#${target.endpoint ?? ''}`
  let plan = gradioPlans.get(key)
  if (!plan) {
    plan = send(config, `${target.url}/gradio_api/info`, { method: 'GET' }, signal).then((raw) =>
      planGradioCall(parseJson(raw), target.endpoint)
    )
    gradioPlans.set(key, plan)
    plan.catch(() => gradioPlans.delete(key))
  }
  return plan
}

/**
 * Gradio 网页界面：先传文件、再发起、再取结果，三个请求。
 *
 * 本机来回一共两三百毫秒（实测 SenseVoice + RTX 3060，2.3 秒的话 250ms），
 * 不值得为它让用户再开一个服务、多占一份显存。
 */
async function transcribeGradio(
  config: TranscriptionConfig,
  target: TranscriptionTarget,
  audio: Blob,
  signal: AbortSignal
): Promise<Transcript> {
  const plan = await gradioPlan(config, target, signal)
  const api = `${target.url}/gradio_api`

  const form = new FormData()
  form.append('files', audio, 'speech.wav')
  const uploaded = parseJson(
    await send(config, `${api}/upload`, { method: 'POST', body: form }, signal)
  )
  const path = Array.isArray(uploaded) ? uploaded[0] : undefined
  if (typeof path !== 'string') throw new Error('Gradio 界面没有收下音频文件')

  const data = [...plan.defaults]
  data[plan.audioIndex] = { path, orig_name: 'speech.wav', meta: { _type: 'gradio.FileData' } }
  const started = parseJson(
    await send(config, `${api}/call/${plan.endpoint}`, { method: 'POST', json: { data } }, signal)
  ) as { event_id?: unknown } | null
  if (typeof started?.event_id !== 'string') throw new Error('Gradio 界面没有接下这次识别')

  const raw = await send(
    config,
    `${api}/call/${plan.endpoint}/${started.event_id}`,
    { method: 'GET' },
    signal
  )
  const outputs = parseGradioEvents(raw)
  const output = outputs[plan.outputIndex]
  // 识别结果那一栏是去过标签的干净文字；标签在「原始输出」那一栏，哪栏带标签就从哪栏读
  const tagged = outputs.find(
    (item): item is string => typeof item === 'string' && /<\|[^|]*\|>/.test(item)
  )
  return readTranscript(typeof output === 'string' ? output : '', tagged)
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
  /** 连着几句没识别出来（服务那头的失败，不算没听清），见 MAX_FAILED_SENTENCES */
  let failures = 0
  /**
   * 收到了多少毫秒的音频。每句话的起止按它算（`SttAudioSpan`）。
   * 断句是按帧做的，这里只知道在哪一包里开的口、哪一包里说完的：起止按包取，宁宽勿窄
   */
  let receivedMs = 0
  /** 正在说的那句从哪一包开始 */
  let sentenceStart: number | null = null

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

  function recognize(sentence: Buffer, audioMs: SttAudioSpan): void {
    pending += 1
    queue = queue.then(async () => {
      try {
        if (closed) return
        // 这一句连重试在内一共等这么久：排着队识别，一句卡住，后面的话全跟着等
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        const transcribe = (): Promise<Transcript> =>
          transcribePcm(config, sentence, STT_INPUT_SAMPLE_RATE, signal)
        // 服务忙、限流、连接中途断了：照对方说的等一会儿，这一句再送一次
        const result = await transcribe().catch(async (error) => {
          if (closed || !isTransient(error) || error.retryAfterMs === undefined) throw error
          await wait(error.retryAfterMs, signal).catch(() => {
            throw error
          })
          return transcribe()
        })
        failures = 0
        if (result.text) {
          emit({
            type: 'user-text',
            text: result.text,
            final: true,
            ...(result.tags.length ? { asrTags: result.tags } : {}),
            audioMs
          })
        } else if (!result.tags.length) {
          // 断句判出来有人说话，识别却一个字没有、也没说那不是人声：多半是没说清，让界面说一声
          emit({ type: 'asr-failed', reason: 'unclear', audioMs })
        }
        // 识别模型自己说这段不是人声（打了 nospeech、或者只回了个标点）：当没发生，不上屏
      } catch (error) {
        if (closed) return
        if (isTransient(error)) {
          failures += 1
          console.warn(`[整段转写] 这一句没识别出来（连着第 ${failures} 句）：`, error)
          // 连着几句都这样就不是偶然了：把最后那句原因说清楚再收摊，别一直报「没听清」
          if (failures >= MAX_FAILED_SENTENCES) {
            fail(`语音识别连着 ${failures} 句都没识别出来：${error.message}`)
            return
          }
          // 只作废这一句（让用户再说一遍），不为它挂断通话
          emit({ type: 'asr-failed', reason: 'service', audioMs })
          return
        }
        // 配置错了（密钥、地址、服务没开）：说清楚再收摊，让用户去改设置
        fail(error instanceof Error ? error.message : String(error))
      } finally {
        pending -= 1
        if (flushed && pending === 0) finish()
      }
    })
  }

  return {
    appendAudio(base64) {
      if (closed || flushed) return
      const pcm = Buffer.from(base64, 'base64')
      const at = receivedMs
      receivedMs += (pcm.length / 2 / STT_INPUT_SAMPLE_RATE) * 1000
      const sentences = endpointer.push(pcm)
      for (const sentence of sentences)
        recognize(sentence, { start: sentenceStart ?? at, end: receivedMs })
      if (!endpointer.speaking) sentenceStart = null
      else if (sentences.length || sentenceStart === null) sentenceStart = at
    },
    flush() {
      if (closed || flushed) return
      flushed = true
      const tail = endpointer.end()
      if (tail) recognize(tail, { start: sentenceStart ?? receivedMs, end: receivedMs })
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
