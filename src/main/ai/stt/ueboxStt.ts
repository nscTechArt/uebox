import WebSocket from 'ws'
import { planCallError } from '../creatorPlan/callError'
import {
  STT_FLUSH_GRACE_MS,
  STT_INPUT_SAMPLE_RATE,
  type SttEvent,
  type SttSessionConfig
} from './types'
import type { SttSessionHandle } from './types'

/**
 * 创作者 Token Plan 的流式识别（听写）：`wss {base}/audio/transcriptions/stream`（协议 06-audio）。
 *
 * 桌面端直接带 `Authorization` 头，不用换临时令牌（那是给浏览器的）。
 *
 *   我们 → 服务端   session.start（第一帧）→ 二进制 PCM 帧 … → audio.commit → session.finish
 *   服务端 → 我们   session.started → transcript.partial / transcript.final … → session.finished
 *
 * 事件和中性形状一一对应：`session.started` → ready，`partial` / `final` → user-text。
 * 上行 16k PCM 直接发二进制帧（协议：等同一条 audio.append），省掉 base64 的三分之一。
 *
 * 松手（flush）先发 `audio.commit` 让这一句立刻出终稿、不等静音判定，再发 `session.finish`；
 * 服务端把剩下的结果发完回 `session.finished` 并关闭。
 *
 * 错误：Key 失效握手就回 401；订阅失效、额度用完、套餐不含这些是**先连上、发一条 error、
 * 再以 1008 关闭**（协议写明，浏览器拿不到握手状态码）。两种都换成说清下一步的文案。
 * 保活由服务端每 25 秒 ping 一次，ws 库自动回 pong，这边不用另发。
 */

/** 判停静音。与豆包、百炼那两支取同一个数，三家的停顿手感一致 */
const END_SILENCE_MS = 800
/** 关会话时最多等服务端回 session.finished 这么久 */
const CLOSE_GRACE_MS = 1_000

export function ueboxSttUrl(baseUrl: string, model: string): string {
  const base = baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')
  return `${base}/audio/transcriptions/stream?model=${encodeURIComponent(model)}`
}

interface ServerEvent {
  type?: string
  text?: string
  error?: { code?: string; message?: string }
}

/** 服务端事件 → 中性事件。回 null 表示这条不上屏。导出只为可测 */
export function ueboxSttEvent(event: ServerEvent): SttEvent | null {
  switch (event.type) {
    case 'session.started':
      return { type: 'ready' }
    case 'transcript.partial':
    case 'transcript.final': {
      const text = event.text?.trim()
      return text ? { type: 'user-text', text, final: event.type === 'transcript.final' } : null
    }
    default:
      return null
  }
}

/** 连接里的 error 事件 → 一句能说给用户的话。套餐那几种（订阅、额度、套餐不含）说清下一步 */
export function ueboxSttErrorMessage(error: ServerEvent['error']): string {
  const code = error?.code
  const planStatus =
    code === 'subscription_inactive' || code === 'quota_exhausted'
      ? 402
      : code === 'daily_limit_reached'
        ? 429
        : code === 'role_not_in_plan'
          ? 403
          : code === 'unauthorized'
            ? 401
            : 0
  const plan = planStatus ? planCallError(planStatus, { error: { code } }) : null
  if (plan) return plan.message
  if (code === 'idle_timeout') return '一分钟没收到声音，识别已结束。'
  return [code, error?.message].filter(Boolean).join('：') || '识别失败'
}

export function openUeboxSttSession(config: SttSessionConfig): SttSessionHandle {
  const socket = new WebSocket(ueboxSttUrl(config.baseUrl, config.model), {
    headers: { ...config.headers, Authorization: `Bearer ${config.apiKey}` },
    handshakeTimeout: 15_000,
    // 上行是 PCM，压不动；压缩还会让后面的 send 排在 zlib 的回调后面（同百炼那支）
    perMessageDeflate: false
  })

  let closed = false
  let flushed = false
  let started = false
  let finished = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (event: SttEvent): void => {
    if (closed && event.type !== 'closed') return
    config.onEvent(event)
  }

  function finish(): void {
    if (finished) return
    finished = true
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    socket.removeAllListeners()
    socket.on('error', () => {})
    socket.terminate()
    config.onEvent({ type: 'closed' })
  }

  const fail = (message: string): void => {
    if (closed) return
    closed = true
    // 直接交给上层，不走 emit：emit 在 closed 之后只放 closed 过去，报错会被自己挡掉
    config.onEvent({ type: 'error', message })
    finish()
  }

  const sendJson = (payload: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(payload), (error) => {
      if (error) fail(error.message)
    })
  }

  socket.on('open', () => {
    if (closed) return
    sendJson({
      type: 'session.start',
      audio: { format: 'pcm_s16le', sample_rate: STT_INPUT_SAMPLE_RATE, channels: 1 },
      punctuation: true,
      end_silence_ms: END_SILENCE_MS
    })
  })

  // 握手就被拒：401 是 Key 失效，429 是限流 / 并发超限（每个账户最多 4 路语音）
  socket.on('unexpected-response', (_request, response) => {
    const status = response.statusCode ?? 0
    const plan = planCallError(status, null)
    fail(
      plan
        ? plan.message
        : status === 429
          ? '语音识别的并发或频率超限了，稍等几秒再试。'
          : `语音识别连接被拒：HTTP ${status}`
    )
  })

  socket.on('message', (data, isBinary) => {
    if (closed || isBinary) return
    let event: ServerEvent
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      event = JSON.parse(bytes.toString('utf8')) as ServerEvent
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      return
    }
    if (event.type === 'error') {
      fail(ueboxSttErrorMessage(event.error))
      return
    }
    if (event.type === 'session.finished') {
      closed = true
      finish()
      return
    }
    const next = ueboxSttEvent(event)
    if (!next) return
    if (next.type === 'ready') {
      if (started) return
      started = true
    }
    emit(next)
  })

  socket.on('error', (error) => fail(error.message))
  socket.on('close', () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    closed = true
    finish()
  })

  const handle: SttSessionHandle = {
    appendAudio: (base64: string) => {
      // session.started 之前、松手之后的音频都不送（同另外两支）
      if (closed || flushed || !started || socket.readyState !== WebSocket.OPEN) return
      const pcm = Buffer.from(base64, 'base64')
      if (pcm.length) socket.send(pcm)
    },
    /** 音频到此为止，但继续等终稿（见 SttSessionHandle.flush）。不置 closed */
    flush: () => {
      if (closed || flushed) return
      flushed = true
      if (!started || socket.readyState !== WebSocket.OPEN) {
        handle.close()
        return
      }
      sendJson({ type: 'audio.commit' })
      sendJson({ type: 'session.finish' })
      closeTimer = setTimeout(() => handle.close(), STT_FLUSH_GRACE_MS)
    },
    close: () => {
      if (closed) return
      closed = true
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = null
      // 好好收尾：不发 session.finish 的话这一路要等空闲超时才结束
      if (started && !flushed) sendJson({ type: 'session.finish' })
      closeTimer = setTimeout(finish, CLOSE_GRACE_MS)
      socket.once('close', finish)
      if (socket.readyState === WebSocket.OPEN) socket.close()
      else finish()
    }
  }
  return handle
}
