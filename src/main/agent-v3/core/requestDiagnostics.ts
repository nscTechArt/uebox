/**
 * 每一次模型请求留一行本地诊断。
 *
 * ## 为什么要有它
 *
 * 真机上一条会话两次死在 `net::ERR_CONNECTION_CLOSED`，回头查时手里只有两样东西：
 * transcript 里那条失败消息的**开始**时间，和一句错误原文。断在哪一段（没接通、
 * 接通了没首包、吐到一半）、从发出到断开隔了多久、每次是不是都断在同一个时长上、
 * 请求有多大、走的是直连还是系统代理 —— 一样都没有。于是只能猜「套餐并发」
 * 「上下文太长」，而这些猜测没有一个能被证实或排除。
 *
 * （`createAgent.ts` 里那句重发的 `console.warn` 也帮不上：主进程的 console
 * 不进 `unreal-agent.log`，打包后的应用里它等于没写。）
 *
 * ## 记什么、不记什么
 *
 * 记：请求开始、响应头、首个内容、最后一个内容、结束（全是相对开始的毫秒数，
 * 一眼能看出是不是固定时长断开），模型，请求体字节数，状态码，错误原文前 300 字，
 * 同一请求的第几次尝试（卡死重发）、这一轮第几次自动续跑，以及服务端给的请求标识
 * （响应头里的 request-id 一类、流里的 responseId）—— 拿去找厂商对账只需要它。
 *
 * **不记**密钥、请求头、请求体、对话内容。响应头只挑白名单里那几个标识。
 * 唯一的例外是「400 什么都没说」的请求：请求体（去掉内联媒体）单独落到
 * `rejected-requests`，只留最近几份，见 `dumpRejectedRequest`。
 *
 * ## 放在哪一层
 *
 * 包在 `runtime.streamFn` 外面、`requestGate` 的里面：卡死重发的每一次尝试都是一次
 * 真实的 HTTP 请求，都该有自己的一行。同一次请求的几次尝试拿到的是同一个
 * `context` 对象，按它数第几次。
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEvent,
  type TranscriptContext,
  type Model
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

import { classifyProviderError } from '../host/providerError'
import { failedAssistantMessage } from './team/requestGate'

/** 值得记的响应头：各家用来追踪单次请求的标识。别的一概不记 */
const REQUEST_ID_HEADERS = [
  'x-request-id',
  'request-id',
  'x-trace-id',
  'trace-id',
  'x-amzn-requestid',
  'x-ms-request-id',
  'x-log-id',
  'x-tt-logid',
  'cf-ray'
]

const ERROR_TEXT_LIMIT = 300
/** 失败响应体：有的网关把真正的原因放在一层层包着的 JSON 后半截 */
const ERROR_BODY_LIMIT = 2000

/** 失败响应的头全记（定位「400 没响应体」只能靠它），这几个除外 */
const SECRET_HEADER = /cookie|auth|token|key|secret/i

export interface RequestRecord {
  sessionId?: string
  provider: string
  model: string
  /** 只到主机名。路径、查询串里可能有令牌 */
  host?: string
  /** 同一次请求的第几次尝试，从 1 开始（大于 1 = 卡死重发） */
  attempt: number
  /** 这一轮第几次自动续跑，0 = 没有 */
  resume: number
  /** 请求开始的绝对时间（ISO） */
  startedAt: string
  /** 以下全是相对请求开始的毫秒数 */
  responseMs?: number
  firstContentMs?: number
  lastContentMs?: number
  endMs: number
  /** 收到的内容事件个数（增量、工具调用片段） */
  contentEvents: number
  payloadBytes?: number
  status?: number
  outcome: 'ok' | 'error' | 'aborted' | 'unfinished'
  stopReason?: string
  error?: string
  statusCode?: number
  errorCode?: string
  responseId?: string
  requestIds?: Record<string, string>
  /** 这个地址走直连还是系统代理（PAC 原文，如 `PROXY 127.0.0.1:7890`） */
  route?: string
  /**
   * 非 2xx 时的响应头和响应体开头。pi 出错时不调 `onResponse`，报错里只剩一句
   * `400 status code (no body)` —— 是哪一层回的、上游的 request-id，全在这里
   */
  errorResponse?: { headers: Record<string, string>; body?: string }
}

export interface DiagnosticsDeps {
  sessionId?: string
  /** 这一轮第几次自动续跑 */
  resumeAttempt?: () => number
  /** 写一行。宿主接到本地日志文件 */
  sink: (record: RequestRecord) => void
  /** 查这个地址怎么走（直连 / 代理）。没有就不记 */
  describeRoute?: (url: string) => Promise<string | undefined>
  /**
   * 上游回 400（参数被拒）时，把这次的完整请求体交出去存档。
   * 400 不说是哪个参数，只能拿原样的请求体逐段删减重发去定位
   */
  dumpRejected?: (record: RequestRecord, payload: unknown) => void
  now?: () => number
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return new URL(baseUrl).host
  } catch {
    return undefined
  }
}

function pickRequestIds(headers: Record<string, string>): Record<string, string> | undefined {
  const picked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (REQUEST_ID_HEADERS.includes(key) && value) picked[key] = String(value).slice(0, 200)
  }
  return Object.keys(picked).length ? picked : undefined
}

function byteLength(payload: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8')
  } catch {
    return undefined
  }
}

const CONTENT_EVENTS = new Set<AssistantMessageEvent['type']>([
  'text_delta',
  'thinking_delta',
  'toolcall_delta',
  'text_start',
  'thinking_start',
  'toolcall_start'
])

export function diagnosedStreamFn(inner: StreamFn, deps: DiagnosticsDeps): StreamFn {
  const now = deps.now ?? Date.now
  const attempts = new WeakMap<TranscriptContext, number>()

  return async (model: Model<Api>, context: TranscriptContext, options) => {
    const attempt = (attempts.get(context) ?? 0) + 1
    attempts.set(context, attempt)

    const started = now()
    const record: RequestRecord = {
      ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
      provider: model.provider,
      model: model.id,
      ...(hostOf(model.baseUrl) ? { host: hostOf(model.baseUrl) } : {}),
      attempt,
      resume: deps.resumeAttempt?.() ?? 0,
      startedAt: new Date(started).toISOString(),
      endMs: 0,
      contentEvents: 0,
      outcome: 'unfinished'
    }

    const previousOnPayload = options?.onPayload
    const previousOnResponse = options?.onResponse
    let written = false
    let sentPayload: unknown
    const finish = async (): Promise<void> => {
      if (written) return
      written = true
      record.endMs = now() - started
      // 卡死检测到点掐掉的（`requestGate` 以 `stalled` 中止）不是用户停下，是一次失败
      const reason = options?.signal?.reason
      if (record.outcome !== 'ok' && reason instanceof Error && reason.message === 'stalled') {
        record.outcome = 'error'
        record.error = 'stalled: 卡死检测到点掐断'
      }
      // 成功的也记：只记失败的话，没法拿来对比「走代理是不是更容易出事」
      if (deps.describeRoute && model.baseUrl) {
        record.route = await deps.describeRoute(model.baseUrl).catch(() => undefined)
      }
      // 只留「400 什么都没说」的那种：带了错误原文的 400（上下文超长、参数不对）看原文就够定位，
      // 不该为它把整段对话落盘
      if (record.statusCode === 400 && sentPayload !== undefined && !record.errorResponse?.body) {
        try {
          deps.dumpRejected?.(record, sentPayload)
        } catch {
          // 存不下来不影响这次请求
        }
      }
      try {
        deps.sink(record)
      } catch {
        // 诊断写不进去不该影响这次请求
      }
    }

    const baseFetch = options?.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const observedFetch: typeof fetch = async (input, init) => {
      const response = await baseFetch(input, init)
      if (!response.ok) {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, name) => {
          if (!SECRET_HEADER.test(name)) headers[name] = value.slice(0, 200)
        })
        const body = await response
          .clone()
          .text()
          .catch(() => '')
        record.errorResponse = {
          headers,
          ...(body ? { body: body.slice(0, ERROR_BODY_LIMIT) } : {})
        }
      }
      return response
    }

    const observe = observeInto(record, started)
    let stream: Awaited<ReturnType<StreamFn>>
    try {
      stream = await inner(model, context, {
        ...options,
        // Google 两个适配器见到非全局 fetch 直接抛错，那边只能不看失败响应体
        ...(String(model.api).startsWith('google-') ? {} : { fetch: observedFetch }),
        onPayload: async (payload, payloadModel) => {
          const upstream = await previousOnPayload?.(payload, payloadModel)
          sentPayload = upstream === undefined ? payload : upstream
          record.payloadBytes = byteLength(sentPayload)
          return upstream
        },
        onResponse: async (response, responseModel) => {
          record.responseMs = now() - started
          record.status = response.status
          const ids = pickRequestIds(response.headers ?? {})
          if (ids) record.requestIds = ids
          await previousOnResponse?.(response, responseModel)
        }
      })
    } catch (error) {
      // 契约上 streamFn 不抛，但包装层要当它可能抛：记下来再原样抛回去
      record.outcome = 'error'
      record.error = (error instanceof Error ? error.message : String(error)).slice(
        0,
        ERROR_TEXT_LIMIT
      )
      await finish()
      throw error
    }

    // 原样转发，只在旁边看。不改事件、不改顺序。转进一条新流而不是改原流的迭代器：
    // 下游（`requestGate`）要的是一条完整的事件流，`result()` 这些也得照常能用
    const out = createAssistantMessageEventStream()
    void (async () => {
      try {
        for await (const event of stream) {
          observe(event)
          out.push(event)
        }
      } catch (error) {
        // 同上，契约外的情况：变成一条失败事件交给下游，别让它在那边悬着
        const message = error instanceof Error ? error.message : String(error)
        const event: AssistantMessageEvent = {
          type: 'error',
          reason: options?.signal?.aborted ? 'aborted' : 'error',
          error: failedAssistantMessage(model, message)
        }
        observe(event)
        out.push(event)
      } finally {
        out.end()
        await finish()
      }
    })()
    return out
  }

  function observeInto(record: RequestRecord, started: number) {
    return (event: AssistantMessageEvent): void => {
      const at = now() - started
      if (CONTENT_EVENTS.has(event.type)) {
        record.firstContentMs ??= at
        record.lastContentMs = at
        record.contentEvents += 1
      }
      if (event.type === 'done') {
        record.outcome = 'ok'
        record.stopReason = event.reason
        if (event.message.responseId) record.responseId = event.message.responseId
      } else if (event.type === 'error') {
        const message = event.error
        record.outcome = event.reason === 'aborted' ? 'aborted' : 'error'
        record.stopReason = event.reason
        if (message.responseId) record.responseId = message.responseId
        const text = message.errorMessage ?? ''
        record.error = text.slice(0, ERROR_TEXT_LIMIT)
        const facts = classifyProviderError(text)
        if (facts.statusCode !== undefined) record.statusCode = facts.statusCode
        if (facts.code) record.errorCode = facts.code
      }
    }
  }
}

/** 一行日志的样子：前缀固定，后面是 JSON，方便 grep 和逐行解析 */
export function formatRequestRecord(record: RequestRecord): string {
  return `[模型请求] ${JSON.stringify(record)}`
}

/** 被拒请求最多留几份：够对比，又不至于把一堆对话原文攒在盘上 */
const REJECTED_KEEP = 5
/** 一份最多多大：去掉内联媒体之后还这么大的，不值得落盘 */
const REJECTED_MAX_CHARS = 2_000_000
/** 多长的纯 base64 / data: 串算内联媒体 */
const INLINE_MEDIA_MIN = 2_000

/**
 * 把一次被上游拒掉（400）的请求体写进 `dir`，只留最近几份。
 *
 * 里面是这次对话的原文（不含密钥：鉴权在请求头里，不在请求体），只落在本机日志目录
 */
export async function dumpRejectedRequest(
  dir: string,
  record: RequestRecord,
  payload: unknown
): Promise<void> {
  const { mkdir, readdir, rm, writeFile } = await import('fs/promises')
  const { join } = await import('path')
  await mkdir(dir, { recursive: true })
  const stamp = record.startedAt.replace(/[:.]/g, '-')
  const name = `${stamp}-${record.provider}-${record.model}-a${record.attempt}.json`.replace(
    /[^\w.-]/g,
    '_'
  )
  // 内联的图片 / 音视频（data: URL、长 base64）只留长度：定位靠结构，不靠像素，
  // 留原样一份就是几 MB 的截图落盘
  const text = JSON.stringify({ record, payload }, (_key, value: unknown) =>
    typeof value === 'string' &&
    value.length > INLINE_MEDIA_MIN &&
    /^(data:|[A-Za-z0-9+/=]+$)/.test(value)
      ? `[已省略 ${value.length} 字符的内联数据]`
      : value
  )
  if (text.length > REJECTED_MAX_CHARS) return
  await writeFile(join(dir, name), text, 'utf8')
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort()
  for (const old of files.slice(0, Math.max(0, files.length - REJECTED_KEEP))) {
    await rm(join(dir, old), { force: true })
  }
}
