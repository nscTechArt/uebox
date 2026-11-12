import { randomUUID } from 'node:crypto'
import {
  defaultSpeechVoice,
  isFishAudioSpeech,
  isOpenAiCompatibleSpeech,
  MAX_SPEECH_CHARS,
  type SpeechAudio
} from '../../shared/speech'
import { requestQwenAudioSpeech } from './speechQwenAudio'
import { requestOpenAiSpeech } from './speechOpenAi'
import { requestFishAudioSpeech } from './speechFishAudio'
import { isPlanProvider } from '../../shared/creatorPlan'
import { requestPlanSpeech } from './creatorPlan/speech'
import { resolveApiKey } from './credentials'
import { readSettings } from './store'
import type { ProviderConfig } from './types'

export interface SpeechOptions {
  /** 不用模型上填的音色，换这一个（项目角色音色表里设计出来的） */
  voice?: string
  /** 演法。只有百炼的 qwen-audio 认，见 `supportsSpeechInstruction` */
  instruction?: string
}

/** 百炼数演法长度的算法：汉字等全角字符算 2，其余算 1。上限 100，超了整句报错 */
export function instructionWidth(text: string): number {
  return Array.from(text).reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0)
}

/** 这个模型认不认演法。其余家拿到了也只会忽略，调用方要如实告诉模型没生效 */
export function supportsSpeechInstruction(modelId: string): boolean {
  return modelId.startsWith('qwen-audio-3.0-tts-')
}

/** Stream PCM from the configured TTS provider.
 * https://github.com/bytedance/agentkit-samples/blob/main/skills/byted-text-to-speech/scripts/text_to_speech.py
 */
export async function requestSpeech(
  provider: ProviderConfig,
  modelId: string,
  text: string,
  signal: AbortSignal,
  onAudio: (chunk: SpeechAudio) => void = () => {},
  options: SpeechOptions = {}
): Promise<void> {
  // Box Plan 单次上限按清单的 max_input_chars（协议 06-audio，导入时写进模型），其余家 600 字
  const plan = isPlanProvider(provider.id)
  const limit = plan
    ? (provider.models.find((model) => model.id === modelId)?.ttsMaxInputChars ?? MAX_SPEECH_CHARS)
    : MAX_SPEECH_CHARS
  if (!text.trim() || Array.from(text).length > limit) {
    throw new Error('TTS_INVALID_TEXT')
  }
  /*
   * 豆包、百炼两家按模型名认，Fish Audio 按地址认；其余 http(s) 地址按 OpenAI 兼容的 /audio/speech 走
   * （本机 Kokoro、CosyVoice 封装、OpenAI 自己）。豆包、百炼的地址配了个认不得的
   * 模型名时照旧报不支持 —— 拿 OpenAI 的形状去打它们只会换来一句看不懂的 400。
   */
  const openAiCompatible = !plan && isOpenAiCompatibleSpeech(modelId, provider.baseUrl)
  const key = await resolveApiKey(provider.apiKey)
  // 本机服务不要密钥；另外几家没密钥就是没配好
  if (!key && !openAiCompatible) throw new Error('TTS_NOT_CONFIGURED')
  signal.throwIfAborted()
  const voice =
    options.voice ||
    provider.models.find((model) => model.id === modelId)?.ttsVoice ||
    defaultSpeechVoice(modelId, provider.baseUrl)
  if (plan) return requestPlanSpeech(provider, modelId, voice, text, key, signal, onAudio)
  if (isFishAudioSpeech(provider.baseUrl)) {
    return requestFishAudioSpeech(provider, modelId, voice, text, key, signal, onAudio)
  }
  if (openAiCompatible) {
    return requestOpenAiSpeech(provider, modelId, voice, text, key, signal, onAudio)
  }
  if (modelId.startsWith('qwen-audio-3.0-tts-')) {
    return requestQwenAudioSpeech(
      provider,
      modelId,
      voice,
      text,
      key,
      signal,
      onAudio,
      options.instruction
    )
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
