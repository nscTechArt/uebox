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
  baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
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
    expect(url).toBe(provider.baseUrl)
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

describe('OpenAI 兼容（本机 Kokoro、CosyVoice 封装等）', () => {
  const local: ProviderConfig = {
    id: 'local-tts',
    displayName: '本机语音合成',
    kind: 'tts',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:8880/v1',
    apiKey: { kind: 'none' },
    models: [{ id: 'kokoro', ttsVoice: 'zf_xiaobei' }]
  }

  /** 24k 单声道 16 位的最小 WAV：两个样本 */
  function tinyWav(): Buffer {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'latin1')
    header.writeUInt32LE(40, 4)
    header.write('WAVEfmt ', 8, 'latin1')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(24000, 24)
    header.writeUInt32LE(48000, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36, 'latin1')
    header.writeUInt32LE(4, 40)
    return Buffer.concat([header, Buffer.from([1, 0, 2, 0])])
  }

  it('本机服务没有密钥也照样合成，不报「没配好」', async () => {
    const { resolveApiKey } = await import('./credentials')
    vi.mocked(resolveApiKey).mockResolvedValueOnce('')
    const fetcher = vi.fn(async () => new Response(new Uint8Array(tinyWav())))
    vi.stubGlobal('fetch', fetcher)
    const onAudio = vi.fn()
    await requestSpeech(local, 'kokoro', '你好', signal(), onAudio)
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:8880/v1/audio/speech',
      expect.objectContaining({ method: 'POST' })
    )
    expect(onAudio).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'pcm_s16le', sampleRate: 24000 })
    )
  })

  it('豆包那几家没密钥还是报没配好', async () => {
    const { resolveApiKey } = await import('./credentials')
    vi.mocked(resolveApiKey).mockResolvedValueOnce('')
    vi.stubGlobal('fetch', vi.fn())
    await expect(requestSpeech(provider, 'seed-tts-2.0', '你好', signal())).rejects.toThrow(
      'TTS_NOT_CONFIGURED'
    )
  })
})

describe('Fish Audio', () => {
  const fish: ProviderConfig = {
    id: 'fish-audio-tts',
    displayName: 'Fish Audio',
    kind: 'tts',
    protocol: 'openai-completions',
    baseUrl: 'https://api.fish.audio/v1',
    apiKey: { kind: 'none' },
    models: [{ id: 's2.1-pro', ttsVoice: '' }]
  }

  it('模型放 model 头、要 24k PCM；没填音色就不带 reference_id', async () => {
    // 三个字节：最后半个样本要留到下一包，不能丢也不能错位
    const fetcher = vi.fn(
      async () => new Response(new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7]))
    )
    vi.stubGlobal('fetch', fetcher)
    const onAudio = vi.fn()
    await requestSpeech(fish, 's2.1-pro', '你好', signal(), onAudio)
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.fish.audio/v1/tts')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer test-speech-key',
      model: 's2.1-pro'
    })
    const body = JSON.parse(options.body as string)
    expect(body).toMatchObject({ text: '你好', format: 'pcm', sample_rate: 24000 })
    expect(body).not.toHaveProperty('reference_id')
    const bytes = Buffer.concat(
      onAudio.mock.calls.map(([frame]) => Buffer.from(frame.base64, 'base64'))
    )
    expect([...bytes]).toEqual([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0])
  })

  it('填了音色就当 reference_id 发；报错带上厂商原话', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 402, message: 'No credits' }), { status: 402 })
    )
    vi.stubGlobal('fetch', fetcher)
    await expect(
      requestSpeech(fish, 's2.1-pro', '你好', signal(), () => {}, { voice: 'abc123' })
    ).rejects.toThrow('TTS_HTTP_402: No credits')
    const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(options.body as string).reference_id).toBe('abc123')
  })

  it('没密钥报没配好', async () => {
    const { resolveApiKey } = await import('./credentials')
    vi.mocked(resolveApiKey).mockResolvedValueOnce('')
    vi.stubGlobal('fetch', vi.fn())
    await expect(requestSpeech(fish, 's2.1-pro', '你好', signal())).rejects.toThrow(
      'TTS_NOT_CONFIGURED'
    )
  })
})

describe('defaultSpeechVoice', () => {
  it('豆包和 Box Plan 沿用豆包的默认音色，OpenAI 兼容的地址给 OpenAI 的标准名', async () => {
    const { defaultSpeechVoice, DEFAULT_TTS_VOICE } = await import('../../shared/speech')
    const local = 'http://127.0.0.1:8880/v1'
    expect(defaultSpeechVoice('seed-tts-2.0', local)).toBe(DEFAULT_TTS_VOICE)
    expect(defaultSpeechVoice('uebox-tts', 'https://plan.example/v1')).toBe(DEFAULT_TTS_VOICE)
    expect(defaultSpeechVoice('qwen-audio-3.0-tts-flash')).toBe('longanfengyue')
    expect(defaultSpeechVoice('kokoro', local)).toBe('alloy')
    expect(defaultSpeechVoice('s2.1-pro', 'https://api.fish.audio/v1')).toBe('')
    // 豆包的地址上配了个认不得的模型名：还是豆包的音色
    expect(defaultSpeechVoice('1.2.6.1', 'https://openspeech.bytedance.com')).toBe(
      DEFAULT_TTS_VOICE
    )
    // 不知道地址（老调用点）：和以前一样
    expect(defaultSpeechVoice('kokoro')).toBe(DEFAULT_TTS_VOICE)
  })
})
