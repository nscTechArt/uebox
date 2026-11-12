export const DEFAULT_TTS_VOICE = 'zh_female_vv_uranus_bigtts'
/**
 * 这个模型走不走 OpenAI 兼容的 `/audio/speech`（本机 Kokoro、CosyVoice 封装、OpenAI 自己）。
 *
 * 豆包（seed-tts-*、openspeech 地址）、百炼（qwen-audio-*、dashscope 地址）、
 * Box Plan（uebox-*）之外的 http(s) 地址都是。发请求选路和「没填音色给哪个默认值」
 * 用的是同一份判断，免得一边按 OpenAI 发、一边塞了个豆包的音色进去。
 */
export function isOpenAiCompatibleSpeech(modelId: string, baseUrl: string): boolean {
  return (
    !isFishAudioSpeech(baseUrl) &&
    !modelId.startsWith('qwen-audio-3.0-tts-') &&
    !modelId.startsWith('seed-tts-') &&
    !modelId.startsWith('uebox-') &&
    !/openspeech\.bytedance\.com|dashscope/i.test(baseUrl) &&
    /^https?:\/\//i.test(baseUrl.trim())
  )
}

/**
 * Fish Audio（`api.fish.audio/v1/tts`）。它的模型名是 `s1`、`s2.1-pro` 这种，
 * 太泛了认不出来，只能按地址认。
 */
export function isFishAudioSpeech(baseUrl: string): boolean {
  return /(^|\/\/|\.)fish\.audio(\/|:|$)/i.test(baseUrl.trim())
}

/**
 * 模型没填音色时用哪个。
 *
 * OpenAI 兼容的服务给 OpenAI 的标准名 `alloy` —— 把豆包的音色 ID 发给本机的 Kokoro，
 * 只会换回一句「没有这个音色」。不知道地址时（老调用点）按豆包算，和以前一样。
 */
export function defaultSpeechVoice(modelId: string, baseUrl = ''): string {
  if (modelId.startsWith('qwen-audio-3.0-tts-plus')) return 'longanlingxin'
  if (modelId.startsWith('qwen-audio-3.0-tts-flash')) return 'longanfengyue'
  // Fish Audio 不带 reference_id 就用它自己的默认音色
  if (isFishAudioSpeech(baseUrl)) return ''
  if (isOpenAiCompatibleSpeech(modelId, baseUrl)) return 'alloy'
  return DEFAULT_TTS_VOICE
}
export const MAX_SPEECH_CHARS = 600

export interface SpeechRequest {
  requestId: string
  text: string
}

export interface SpeechAudio {
  base64: string
  format: 'pcm_s16le'
  sampleRate: 24000
}

export interface SpeechChunk extends SpeechAudio {
  requestId: string
}

export type SpeechResult = { success: true; data: null } | { success: false; error: string }

/** Keep every character, including supplementary Unicode characters, across requests. */
export function splitSpeechText(text: string, maxChars: number = MAX_SPEECH_CHARS): string[] {
  const chars = Array.from(text.trim())
  const chunks: string[] = []
  while (chars.length) {
    let end = Math.min(chars.length, Math.max(1, Math.floor(maxChars)))
    if (end < chars.length) {
      for (let i = end - 1; i >= end / 2; i--) {
        if (/[。！？；.!?;\n]/u.test(chars[i])) {
          end = i + 1
          break
        }
      }
    }
    chunks.push(chars.splice(0, end).join(''))
  }
  return chunks
}
