/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestSpeech, synthesizeSpeech } from './speech'
import { readSettings } from './store'
import type { ProviderConfig } from './types'

vi.mock('./credentials', () => ({ resolveApiKey: vi.fn(async () => 'test-speech-key') }))
vi.mock('./store', () => ({ readSettings: vi.fn() }))
const provider: ProviderConfig = {
  id: 'doubao',
  displayName: 'Doubao',
  kind: 'tts',
  protocol: 'openai-completions',
  baseUrl: 'https://speech.example/api/v3/tts/unidirectional/sse',
  apiKey: { kind: 'none' },
  models: [{ id: 'seed-tts-2.0', ttsVoice: 'custom-voice' }]
}
const signal = (): AbortSignal => new AbortController().signal
const event = (code: number, data?: string): string => `data: ${JSON.stringify({ code, data })}\n\n`
const complete = event(0, 'YWJj') + event(0, 'ZA==') + event(20000000)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('豆包 TTS 2.0', () => {
  it('rejects removed models without sending a request to another provider', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(requestSpeech(provider, 'qwen3-tts-flash', '你好', signal())).rejects.toThrow(
      'TTS_UNSUPPORTED_MODEL'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses the selected resource, voice and Speech API key; decodes each base64 frame separately', async () => {
    const fetcher = vi.fn(async () => new Response(complete))
    vi.stubGlobal('fetch', fetcher)
    const onAudio = vi.fn()
    await requestSpeech(provider, 'seed-tts-2.0', '你好', signal(), onAudio)
    expect(onAudio.mock.calls.map(([frame]) => frame.base64)).toEqual(['YWJj', 'ZA=='])
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://speech.example/api/v3/tts/unidirectional/sse')
    expect(options.headers).toMatchObject({
      'X-Api-Key': 'test-speech-key',
      'X-Api-Resource-Id': 'seed-tts-2.0'
    })
    expect(options.headers).not.toHaveProperty('Authorization')
    expect(JSON.parse(options.body as string).req_params).toMatchObject({
      text: '你好',
      speaker: 'custom-voice',
      audio_params: { format: 'pcm', sample_rate: 24000 }
    })
  })

  it('parses SSE records split across transport chunks and rejects incomplete audio', async () => {
    const bytes = new TextEncoder().encode(complete)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
                controller.close()
              }
            })
          )
      )
    )
    const onAudio = vi.fn()
    await requestSpeech(provider, 'seed-tts-2.0', '你好', signal(), onAudio)
    expect(onAudio).toHaveBeenCalledTimes(2)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(event(0, 'YWJj')))
    )
    await expect(requestSpeech(provider, 'seed-tts-2.0', '你好', signal())).rejects.toThrow(
      'TTS_EMPTY_AUDIO'
    )
  })

  it('delivers audio while the provider stream is still open', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(current) {
                controller = current
              }
            })
          )
      )
    )
    let received!: () => void
    const firstFrame = new Promise<void>((resolve) => {
      received = resolve
    })
    let completed = false
    const run = requestSpeech(provider, 'seed-tts-2.0', '你好', signal(), () => received()).then(
      () => {
        completed = true
      }
    )
    await vi.waitFor(() => expect(controller).toBeDefined())
    controller.enqueue(new TextEncoder().encode(event(0, 'AAAAAA==')))
    await firstFrame
    expect(completed).toBe(false)
    controller.enqueue(new TextEncoder().encode(event(20000000)))
    await run
  })

  it.each([
    [new Response('denied', { status: 401 }), 'TTS_HTTP_401'],
    [new Response(event(55000000)), 'TTS_PROVIDER_55000000'],
    [new Response(event(20000000)), 'TTS_EMPTY_AUDIO']
  ])('surfaces HTTP, provider and empty-audio failures', async (response, error) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    )
    await expect(requestSpeech(provider, 'seed-tts-2.0', '你好', signal())).rejects.toThrow(error)
  })

  it('never falls back to a chat or realtime binding', async () => {
    vi.mocked(readSettings).mockResolvedValue({ version: 3, providers: [provider], roles: {} })
    await expect(synthesizeSpeech('你好', signal(), vi.fn())).rejects.toThrow('TTS_NOT_CONFIGURED')
    vi.mocked(readSettings).mockResolvedValue({
      version: 3,
      providers: [provider],
      roles: { tts: { providerId: 'doubao', modelId: 'seed-tts-2.0' } }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(complete))
    )
    await expect(synthesizeSpeech('你好', signal(), vi.fn())).resolves.toBeUndefined()
  })

  it('rejects empty, oversized and cancelled input before making a request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    for (const text of ['', '字'.repeat(601)]) {
      await expect(requestSpeech(provider, 'seed-tts-2.0', text, signal())).rejects.toThrow(
        'TTS_INVALID_TEXT'
      )
    }
    const controller = new AbortController()
    controller.abort()
    await expect(
      requestSpeech(provider, 'seed-tts-2.0', '你好', controller.signal)
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
