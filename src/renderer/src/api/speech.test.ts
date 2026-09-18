import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechChunk } from '@core/shared/speech'
import { speechAPI } from './speech'
vi.mock('@renderer/common/utils', () => ({
  unwrapResult: (result: { success: boolean; error?: string }) => {
    if (!result.success) throw new Error(result.error)
  }
}))
afterEach(() => vi.unstubAllGlobals())
describe('speech stream bridge', () => {
  it('subscribes before starting, filters other requests, and cleans up on completion', async () => {
    let listener!: (chunk: SpeechChunk) => void
    const unsubscribe = vi.fn()
    const chunk: SpeechChunk = {
      requestId: 'current',
      base64: 'AAAAAA==',
      format: 'pcm_s16le',
      sampleRate: 24000
    }
    vi.stubGlobal('api', {
      speech: {
        onChunk: vi.fn((callback) => {
          listener = callback
          return unsubscribe
        }),
        synthesize: vi.fn(async () => {
          listener({ ...chunk, requestId: 'old' })
          listener(chunk)
          return { success: true, data: null }
        }),
        cancel: vi.fn(async () => {})
      }
    })
    const onAudio = vi.fn()
    await speechAPI.synthesize({ requestId: 'current', text: '正文' }, onAudio)
    expect(onAudio).toHaveBeenCalledExactlyOnceWith(chunk)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('cancels on playback failure and removes the listener', async () => {
    let listener!: (chunk: SpeechChunk) => void
    const unsubscribe = vi.fn()
    const cancel = vi.fn(async () => {})
    vi.stubGlobal('api', {
      speech: {
        onChunk: (callback: typeof listener) => {
          listener = callback
          return unsubscribe
        },
        synthesize: async () => {
          listener({ requestId: 'a', base64: '', format: 'pcm_s16le', sampleRate: 24000 })
          return { success: false, error: 'TTS_FAILED' }
        },
        cancel
      }
    })
    await expect(
      speechAPI.synthesize({ requestId: 'a', text: '正文' }, () => {
        throw new Error('playback')
      })
    ).rejects.toThrow('playback')
    expect(cancel).toHaveBeenCalledWith('a')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
