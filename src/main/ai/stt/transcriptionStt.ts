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

/** 单次识别最多等多久。本机识别是百毫秒级，云端一段 30 秒的话也就一两秒 */
const REQUEST_TIMEOUT_MS = 30_000

/** 「测试连接」送多长的静音。OpenAI 那家短于 0.1 秒直接拒，留足余量 */
const PROBE_AUDIO_MS = 500

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
  } catch (error) {
    // 我们自己撤的（会话关了）原样抛，调用方认得出；超时和网络错误翻成人话
    if (signal.aborted && (signal.reason as Error | undefined)?.name !== 'TimeoutError') throw error
    throw new Error(describeNetworkFailure(error, url))
  }
  const raw = await response.text()
  if (!response.ok) throw new Error(describeHttpFailure(response.status, vendorDetail(raw)))
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
        const result = await transcribePcm(
          config,
          sentence,
          STT_INPUT_SAMPLE_RATE,
          controller.signal
        )
        if (result.text) {
          emit({
            type: 'user-text',
            text: result.text,
            final: true,
            ...(result.tags.length ? { asrTags: result.tags } : {})
          })
        } else if (!result.tags.length) {
          // 断句判出来有人说话，识别却一个字没有、也没说那不是人声：多半是没说清，让界面说一声
          emit({ type: 'asr-failed' })
        }
        // 识别模型自己说这段不是人声（打了 nospeech、或者只回了个标点）：当没发生，不上屏
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
