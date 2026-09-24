/**
 * Box Plan 的语音合成：`POST {base}/audio/speech`，`stream_format: 'sse'` +
 * `response_format: 'pcm'`（协议 06-audio）。
 *
 * 输出是 16-bit 小端、单声道、24000 Hz 的裸 PCM，和现有流式接口（`SpeechAudio`）同一个格式，
 * 渲染层的播放器不用改。错误沿用 `TTS_*` 错误码（`ipc/speech.ts` 只放这一类过 IPC）：
 * 套餐那几种是 `TTS_PLAN_<错误码大写>`，原文挂在 `cause` 上（`CreatorPlanCallError`）。
 */

import { MAX_SPEECH_CHARS, type SpeechAudio } from '../../../shared/speech'
import type { ProviderConfig } from '../types'
import { planCallError } from './callError'

/**
 * 单次合成的上限，按别家一段 600 字（`MAX_SPEECH_CHARS`）定的：90 秒、20 MiB 音频。
 * 套餐一段能收到清单的 `max_input_chars`（2000 字），念出来要七八分钟、二十多 MB，
 * 按字数等比放宽（见 speechLimits），不然长回复念到一半就被自己的上限掐断
 */
const REQUEST_TIMEOUT_MS = 90_000
const MAX_AUDIO_BYTES = 20 * 1024 * 1024
/** SSE 行缓冲（base64 比 PCM 大三分之一，再留余量） */
const MAX_BUFFER_BYTES = 30 * 1024 * 1024

export function speechLimits(text: string): {
  timeoutMs: number
  maxAudioBytes: number
  maxBufferBytes: number
} {
  const scale = Math.max(1, text.length / MAX_SPEECH_CHARS)
  return {
    timeoutMs: Math.ceil(REQUEST_TIMEOUT_MS * scale),
    maxAudioBytes: Math.ceil(MAX_AUDIO_BYTES * scale),
    maxBufferBytes: Math.ceil(MAX_BUFFER_BYTES * scale)
  }
}

/** 套餐的音色是虚拟 ID（`uebox-voice-*`）；别的值（落盘归一化补的豆包缺省音色）不发，服务端用 default_voice */
export function planVoice(voice: string | undefined): string | undefined {
  return voice && /^uebox-voice-/.test(voice) ? voice : undefined
}

function speechError(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause })
}

export async function requestPlanSpeech(
  provider: ProviderConfig,
  modelId: string,
  voice: string | undefined,
  text: string,
  apiKey: string,
  signal: AbortSignal,
  onAudio: (chunk: SpeechAudio) => void,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const limits = speechLimits(text)
  const response = await fetchImpl(`${provider.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: {
      ...(provider.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      model: modelId,
      input: text,
      ...(planVoice(voice) ? { voice: planVoice(voice) } : {}),
      response_format: 'pcm',
      stream_format: 'sse'
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)])
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const planError = planCallError(response.status, body, response.headers)
    if (planError) throw speechError(`TTS_PLAN_${planError.planError.toUpperCase()}`, planError)
    throw speechError(`TTS_HTTP_${response.status}`)
  }
  if (!response.body) throw speechError('TTS_EMPTY_AUDIO')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let size = 0
  let finished = false
  /** PCM16 一个采样两个字节；SSE 分片可能切在半个采样上，多出来的那个字节留给下一片 */
  let carry: Buffer | null = null

  const accept = (line: string): void => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    const event = JSON.parse(payload) as {
      type?: string
      audio?: string
      error?: { code?: string; message?: string }
    }
    if (event.type === 'speech.audio.delta' && typeof event.audio === 'string') {
      let bytes = Buffer.from(event.audio, 'base64')
      if (carry) {
        bytes = Buffer.concat([carry, bytes])
        carry = null
      }
      if (bytes.length % 2 === 1) {
        carry = bytes.subarray(bytes.length - 1)
        bytes = bytes.subarray(0, bytes.length - 1)
      }
      size += bytes.length
      if (size > limits.maxAudioBytes) throw speechError('TTS_AUDIO_TOO_LARGE')
      signal.throwIfAborted()
      if (bytes.length)
        onAudio({ base64: bytes.toString('base64'), format: 'pcm_s16le', sampleRate: 24000 })
    } else if (event.type === 'speech.audio.done') {
      finished = true
    } else if (event.type === 'error') {
      const code = String(event.error?.code || 'FAILED')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
      throw speechError(`TTS_PROVIDER_${code}`)
    }
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        accept(line.trimEnd())
        if (finished) break
      }
      if (buffer.length > limits.maxBufferBytes) throw speechError('TTS_AUDIO_TOO_LARGE')
      if (done) {
        if (buffer.trim()) accept(buffer.trimEnd())
        break
      }
    }
    if (!finished || size === 0) throw speechError('TTS_EMPTY_AUDIO')
  } finally {
    await reader.cancel().catch(() => {})
  }
}
