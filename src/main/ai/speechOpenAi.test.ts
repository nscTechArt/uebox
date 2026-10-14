/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpeechDecoder, requestOpenAiSpeech, resolveSpeechUrl } from './speechOpenAi'
import type { SpeechAudio } from '../../shared/speech'

/** 拼一个 WAV。`samples` 按声道交错 */
function wav(
  samples: number[],
  options: { rate: number; channels?: number; bits?: 16 | 32; float?: boolean; extra?: boolean }
): Buffer {
  const channels = options.channels ?? 1
  const bits = options.bits ?? 16
  const bytes = bits / 8
  const data = Buffer.alloc(samples.length * bytes)
  samples.forEach((value, i) => {
    if (options.float) data.writeFloatLE(value, i * 4)
    else if (bits === 16) data.writeInt16LE(Math.round(value * 0x7fff), i * 2)
    else data.writeInt32LE(Math.round(value * 0x7fffffff), i * 4)
  })
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'latin1')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(options.float ? 3 : 1, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(options.rate, 12)
  fmt.writeUInt32LE(options.rate * channels * bytes, 16)
  fmt.writeUInt16LE(channels * bytes, 20)
  fmt.writeUInt16LE(bits, 22)
  // 有的服务在 fmt 和 data 之间塞一个 LIST 块
  const list = options.extra
    ? Buffer.concat([
        Buffer.from('LIST', 'latin1'),
        Buffer.from([3, 0, 0, 0]),
        Buffer.from('abc\0')
      ])
    : Buffer.alloc(0)
  const dataHead = Buffer.alloc(8)
  dataHead.write('data', 0, 'latin1')
  // 流式输出的 WAV 不知道总长，常见写法是 0xFFFFFFFF
  dataHead.writeUInt32LE(0xffffffff, 4)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(0xffffffff, 4)
  riff.write('WAVE', 8, 'latin1')
  return Buffer.concat([riff, fmt, list, dataHead, data])
}

const samples = (pcm: Buffer): number => pcm.length / 2

describe('resolveSpeechUrl', () => {
  it('填到 /v1 为止的补上 /audio/speech，完整地址原样用', () => {
    expect(resolveSpeechUrl('http://127.0.0.1:8880/v1/')).toBe(
      'http://127.0.0.1:8880/v1/audio/speech'
    )
    expect(resolveSpeechUrl('https://api.openai.com/v1/audio/speech')).toBe(
      'https://api.openai.com/v1/audio/speech'
    )
  })
})

describe('createSpeechDecoder', () => {
  it('24k 单声道 16 位：原样交出', () => {
    const decoder = createSpeechDecoder('audio/wav')
    const out = decoder.push(wav([0.5, -0.5, 0.25, 0], { rate: 24_000 }))
    expect(samples(out)).toBe(4)
    expect(out.readInt16LE(0)).toBeCloseTo(0.5 * 0x7fff, -1)
  })

  /** CosyVoice 原生 22.05k：按 24k 播就是变调的快放，必须换算 */
  it('别的采样率换算成 24k，时长不变', () => {
    const decoder = createSpeechDecoder('audio/wav')
    const oneSecond = new Array(16_000).fill(0.1)
    const out = decoder.push(wav(oneSecond, { rate: 16_000 }))
    // 线性插值最后一个样本要等下一包，差一两个样本
    expect(Math.abs(samples(out) - 24_000)).toBeLessThanOrEqual(2)
  })

  it('立体声取平均成单声道', () => {
    const decoder = createSpeechDecoder('audio/wav')
    const out = decoder.push(wav([0.5, 0.1, 0.5, 0.1], { rate: 24_000, channels: 2 }))
    expect(samples(out)).toBe(2)
    expect(out.readInt16LE(0) / 0x8000).toBeCloseTo(0.3, 2)
  })

  it('32 位浮点也认', () => {
    const decoder = createSpeechDecoder('audio/wav')
    const out = decoder.push(wav([0.5, -0.25], { rate: 24_000, bits: 32, float: true }))
    expect(out.readInt16LE(2) / 0x8000).toBeCloseTo(-0.25, 3)
  })

  it('头被切成好几包、中间还夹着 LIST 块：照样读得出', () => {
    const decoder = createSpeechDecoder('audio/wav')
    const whole = wav([0.1, 0.2, 0.3, 0.4], { rate: 24_000, extra: true })
    const out: Buffer[] = []
    // 一个字节一个字节地喂：头、块边界、样本都被切开
    for (let i = 0; i < whole.length; i += 1) out.push(decoder.push(whole.subarray(i, i + 1)))
    expect(samples(Buffer.concat(out))).toBe(4)
  })

  it('跨包重采样接得上：分包和整包结果一样长', () => {
    const tone = Array.from({ length: 2205 }, (_, i) => Math.sin(i / 10) * 0.5)
    const whole = createSpeechDecoder('audio/wav').push(wav(tone, { rate: 22_050 }))
    const split = createSpeechDecoder('audio/wav')
    const bytes = wav(tone, { rate: 22_050 })
    const parts: Buffer[] = []
    for (let i = 0; i < bytes.length; i += 333) parts.push(split.push(bytes.subarray(i, i + 333)))
    expect(samples(Buffer.concat(parts))).toBe(samples(whole))
  })

  it('Content-Type 说是 pcm、没有头：按 OpenAI 的约定当 24k', () => {
    const decoder = createSpeechDecoder('audio/pcm')
    const pcm = Buffer.alloc(48)
    expect(samples(decoder.push(pcm))).toBe(24)
  })

  it('服务不理 response_format、回了 mp3：明说，不当 PCM 播', () => {
    const decoder = createSpeechDecoder('audio/mpeg')
    expect(() =>
      decoder.push(
        Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000', 'latin1')
      )
    ).toThrow(/mp3.*response_format=wav/)
  })

  it('200 回了一段文字：把那段话带出来', () => {
    const decoder = createSpeechDecoder('application/json')
    expect(() => decoder.push(Buffer.from('{"detail":"voice not found"}'))).toThrow(
      /voice not found/
    )
  })
})

describe('requestOpenAiSpeech', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const provider = {
    id: 'local-tts',
    displayName: '本机语音合成',
    kind: 'tts',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:8880/v1',
    apiKey: { kind: 'none' },
    models: []
  } as never

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('发 OpenAI 的形状、要 WAV；没密钥不带 Authorization；吐 24k PCM', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(wav([0.1, 0.2], { rate: 24_000 }))))
    const chunks: SpeechAudio[] = []
    await requestOpenAiSpeech(
      provider,
      'kokoro',
      'zf_xiaobei',
      '你好',
      '',
      new AbortController().signal,
      (chunk) => chunks.push(chunk)
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8880/v1/audio/speech')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'kokoro',
      input: '你好',
      voice: 'zf_xiaobei',
      response_format: 'wav'
    })
    expect(init?.headers).not.toHaveProperty('Authorization')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ format: 'pcm_s16le', sampleRate: 24000 })
  })

  it('有密钥就带上', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(wav([0.1], { rate: 24_000 }))))
    await requestOpenAiSpeech(
      provider,
      'tts-1',
      'alloy',
      '你好',
      'sk',
      new AbortController().signal,
      () => {}
    )
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk'
    )
  })

  it('厂商报错：带上原话（音色不对这类，用户照着就能改）', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Voice 'xx' not found" }), { status: 400 })
    )
    await expect(
      requestOpenAiSpeech(
        provider,
        'kokoro',
        'xx',
        '你好',
        '',
        new AbortController().signal,
        () => {}
      )
    ).rejects.toThrow("TTS_HTTP_400: Voice 'xx' not found")
  })

  it('服务没开：说连不上', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    )
    await expect(
      requestOpenAiSpeech(
        provider,
        'kokoro',
        'v',
        '你好',
        '',
        new AbortController().signal,
        () => {}
      )
    ).rejects.toThrow(/连不上语音合成服务/)
  })

  it('回包只有头、没有声音：报空音频', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(wav([], { rate: 24_000 }))))
    await expect(
      requestOpenAiSpeech(
        provider,
        'kokoro',
        'v',
        '你好',
        '',
        new AbortController().signal,
        () => {}
      )
    ).rejects.toThrow('TTS_EMPTY_AUDIO')
  })
})
