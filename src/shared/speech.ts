export const DEFAULT_TTS_VOICE = 'zh_female_vv_uranus_bigtts'
export function defaultSpeechVoice(modelId: string): string {
  if (modelId.startsWith('qwen-audio-3.0-tts-plus')) return 'longanlingxin'
  if (modelId.startsWith('qwen-audio-3.0-tts-flash')) return 'longanfengyue'
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
export function splitSpeechText(text: string): string[] {
  const chars = Array.from(text.trim())
  const chunks: string[] = []
  while (chars.length) {
    let end = Math.min(chars.length, MAX_SPEECH_CHARS)
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
