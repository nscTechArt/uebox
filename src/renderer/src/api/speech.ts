import { unwrapResult } from '@renderer/common/utils'
import type { SpeechRequest, SpeechAudio } from '@core/shared/speech'

export const speechAPI = {
  async synthesize(request: SpeechRequest, onAudio: (audio: SpeechAudio) => void): Promise<void> {
    let playbackError: unknown
    const unsubscribe = window.api.speech.onChunk((chunk) => {
      if (chunk.requestId !== request.requestId || playbackError) return
      try {
        onAudio(chunk)
      } catch (error) {
        playbackError = error
        void window.api.speech.cancel(request.requestId).catch(() => {})
      }
    })
    try {
      const result = await window.api.speech.synthesize(request)
      if (playbackError) throw playbackError
      unwrapResult({ ...result, data: result.success ? result.data : undefined })
    } finally {
      unsubscribe()
    }
  },
  cancel(requestId: string): Promise<void> {
    return window.api.speech.cancel(requestId)
  }
}
