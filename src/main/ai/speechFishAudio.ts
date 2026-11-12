import type { SpeechAudio } from '../../shared/speech'
import { createSpeechDecoder } from './speechOpenAi'
import type { ProviderConfig } from './types'

/**
 * Fish Audio 语音合成（`POST https://api.fish.audio/v1/tts`）。
 *
 * 模型放在 `model` 请求头里，音色是 `reference_id`（fish.audio 上任意一个音色页
 * 地址里的那串 ID）；不带就用它的默认音色。直接要 24k 单声道 PCM16，
 * 和应用里的播放格式一致，不用重采样。
 *
 * @see https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 */

const OUTPUT_RATE = 24_000
const REQUEST_TIMEOUT_MS = 90_000
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

/** 用户填到域名或 `/v1` 为止的，补上 `/v1/tts`；贴了完整接口的原样用 */
export function resolveFishAudioUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/tts$/i.test(url)) return url
  return /\/v1$/i.test(url) ? `${url}/tts` : `${url}/v1/tts`
}

/** 错误体是 `{ status, message }` */
function vendorDetail(raw: string): string {
  try {
    const body = JSON.parse(raw) as { message?: unknown }
    if (typeof body.message === 'string') return body.message.slice(0, 200)
  } catch {
    // 不是 JSON
  }
  return raw.trim().slice(0, 200)
}

export async function requestFishAudioSpeech(
  provider: ProviderConfig,
  modelId: string,
  voice: string,
  text: string,
  key: string,
  signal: AbortSignal,
  onAudio: (chunk: SpeechAudio) => void
): Promise<void> {
  const response = await fetch(resolveFishAudioUrl(provider.baseUrl), {
    method: 'POST',
    headers: {
      ...provider.headers,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      model: modelId
    },
    body: JSON.stringify({
      text,
      ...(voice ? { reference_id: voice } : {}),
      format: 'pcm',
      sample_rate: OUTPUT_RATE,
      latency: 'balanced'
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  })
  if (!response.ok) {
    const detail = vendorDetail(await response.text().catch(() => ''))
    throw new Error(`TTS_HTTP_${response.status}${detail ? `: ${detail}` : ''}`)
  }
  if (!response.body) throw new Error('TTS_EMPTY_AUDIO')

  // 按 PCM 解：包边界上落单的半个样本留到下一包
  const decoder = createSpeechDecoder('audio/pcm')
  const reader = response.body.getReader()
  let received = 0
  let produced = 0
  const emit = (pcm: Buffer): void => {
    if (!pcm.length) return
    produced += pcm.length
    signal.throwIfAborted()
    onAudio({ base64: pcm.toString('base64'), format: 'pcm_s16le', sampleRate: OUTPUT_RATE })
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      received += value.length
      if (received > MAX_AUDIO_BYTES) throw new Error('TTS_AUDIO_TOO_LARGE')
      emit(decoder.push(Buffer.from(value)))
    }
    emit(decoder.end())
    if (produced === 0) throw new Error('TTS_EMPTY_AUDIO')
  } finally {
    await reader.cancel().catch(() => {})
  }
}
