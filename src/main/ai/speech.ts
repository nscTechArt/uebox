import { randomUUID } from 'node:crypto'
import { defaultSpeechVoice, MAX_SPEECH_CHARS, type SpeechAudio } from '../../shared/speech'
import { requestQwenAudioSpeech } from './speechQwenAudio'
import { resolveApiKey } from './credentials'
import { readSettings } from './store'
import type { ProviderConfig } from './types'

/** Stream PCM from the configured TTS provider.
 * https://github.com/bytedance/agentkit-samples/blob/main/skills/byted-text-to-speech/scripts/text_to_speech.py
 */
export async function requestSpeech(
  provider: ProviderConfig,
  modelId: string,
  text: string,
  signal: AbortSignal,
  onAudio: (chunk: SpeechAudio) => void = () => {}
): Promise<void> {
  if (!text.trim() || Array.from(text).length > MAX_SPEECH_CHARS) {
    throw new Error('TTS_INVALID_TEXT')
  }
  const key = await resolveApiKey(provider.apiKey)
  if (!key) throw new Error('TTS_NOT_CONFIGURED')
  signal.throwIfAborted()
  const voice =
    provider.models.find((model) => model.id === modelId)?.ttsVoice || defaultSpeechVoice(modelId)
  if (modelId.startsWith('qwen-audio-3.0-tts-')) {
    return requestQwenAudioSpeech(provider, modelId, voice, text, key, signal, onAudio)
  }
  if (!modelId.startsWith('seed-tts-')) throw new Error('TTS_UNSUPPORTED_MODEL')
  const response = await fetch(provider.baseUrl, {
    method: 'POST',
    headers: {
      ...provider.headers,
      'Content-Type': 'application/json',
      'X-Api-Key': key,
      'X-Api-Resource-Id': modelId,
      'X-Api-Request-Id': randomUUID()
    },
    body: JSON.stringify({
      user: { uid: 'unreal-box' },
      req_params: {
        text,
        speaker: voice,
        audio_params: { format: 'pcm', sample_rate: 24000 },
        additions: JSON.stringify({ disable_markdown_filter: false })
      }
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)])
  })
  if (!response.ok) throw new Error(`TTS_HTTP_${response.status}`)
  if (!response.body) throw new Error('TTS_EMPTY_AUDIO')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let size = 0
  let finished = false
  const acceptLine = (line: string): void => {
    if (!line.startsWith('data:')) return
    const event = JSON.parse(line.slice(5).trim()) as { code?: number; data?: string }
    if (event.code !== 0 && event.code !== 20000000) {
      throw new Error(`TTS_PROVIDER_${event.code ?? 'INVALID'}`)
    }
    const data = event.data
    if (data) {
      const bytes = Buffer.from(data, 'base64')
      size += bytes.length
      if (size > 20 * 1024 * 1024) throw new Error('TTS_AUDIO_TOO_LARGE')
      signal.throwIfAborted()
      if (bytes.length)
        onAudio({ base64: bytes.toString('base64'), format: 'pcm_s16le', sampleRate: 24000 })
    }
    if (event.code === 20000000) finished = true
  }
  try {
    while (!finished) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) acceptLine(line.trimEnd())
      if (buffer.length > 30 * 1024 * 1024) throw new Error('TTS_AUDIO_TOO_LARGE')
      if (done) {
        if (buffer.trim()) acceptLine(buffer.trimEnd())
        break
      }
    }
    if (!finished || size === 0) throw new Error('TTS_EMPTY_AUDIO')
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function synthesizeSpeech(
  text: string,
  signal: AbortSignal,
  onAudio: (chunk: SpeechAudio) => void
): Promise<void> {
  const settings = await readSettings()
  const binding = settings.roles.tts
  const provider = settings.providers.find((item) => item.id === binding?.providerId)
  if (!binding || !provider || provider.kind !== 'tts') throw new Error('TTS_NOT_CONFIGURED')
  return requestSpeech(provider, binding.modelId, text, signal, onAudio)
}
