import type { SpeechAudio } from '../../shared/speech'
import type { ProviderConfig } from './types'

/**
 * OpenAI 兼容的语音合成（`POST /v1/audio/speech`）。
 *
 * 本机跑的 Kokoro-FastAPI、CosyVoice / GPT-SoVITS 的各种 OpenAI 兼容封装、LocalAI、
 * 以及 OpenAI 自己，都是这一个形状：发 `{ model, input, voice, response_format }`，
 * 回一段音频。
 *
 * ## 为什么要 WAV，不要 PCM
 *
 * 应用里所有朗读、通话都按 **24k 单声道 PCM16** 播（`SpeechAudio.sampleRate`）。
 * OpenAI 的 `pcm` 正好是这个格式，但它**不带采样率**：本机那几家原生采样率五花八门
 * （CosyVoice 22.05k、有的 44.1k），按 24k 播出来就是变调的快放慢放，而且不报错。
 * WAV 头里写着采样率和声道数，读出来、换算成 24k 再交出去，各家就都对了。
 *
 * 不认的格式（服务不理 `response_format`，照样回 mp3）明说，不硬播 ——
 * 压缩流当 PCM 播是满幅噪声。
 *
 * @see https://platform.openai.com/docs/api-reference/audio/createSpeech
 */

/** 交出去的格式。和另外几家合成一致，见 `SpeechAudio` */
const OUTPUT_RATE = 24_000

/** 一次合成最多等多久。本机首包几百毫秒，长句整段合成也就几秒 */
const REQUEST_TIMEOUT_MS = 90_000

/** 防一个失控的服务一直往回灌。和豆包那条线同一个上限 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

/** 用户填到 `/v1` 为止的，补上 `/audio/speech`；贴了完整接口的原样用 */
export function resolveSpeechUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  return /\/audio\/speech$/i.test(url) ? url : `${url}/audio/speech`
}

interface WavFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
  float: boolean
}

/**
 * 边收边换算的线性重采样。
 *
 * 跨包要接得上：上一包最后一个样本留下来当这一包的起点，小数位置也带过去，
 * 不然每个包的接缝处都是一下咔哒。
 */
function createResampler(from: number, to: number): (samples: Float32Array) => Float32Array {
  if (from === to) return (samples) => samples
  const step = from / to
  let carry: number | null = null
  let position = 0
  return (samples) => {
    let input = samples
    if (carry !== null) {
      input = new Float32Array(samples.length + 1)
      input[0] = carry
      input.set(samples, 1)
    }
    const out: number[] = []
    while (position + 1 < input.length) {
      const index = Math.floor(position)
      const frac = position - index
      out.push(input[index] + (input[index + 1] - input[index]) * frac)
      position += step
    }
    if (input.length) {
      carry = input[input.length - 1]
      position -= input.length - 1
    }
    return Float32Array.from(out)
  }
}

function toPcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), i * 2)
  }
  return out
}

/** 认一下开头几个字节是不是压缩格式。认出来就明说，别当 PCM 播 */
function compressedFormat(head: Buffer): string | null {
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3'
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3 / aac'
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'opus / ogg'
  if (head.subarray(0, 4).toString('latin1') === 'fLaC') return 'flac'
  return null
}

/**
 * 把服务回的字节流换成 24k 单声道 PCM16。
 *
 * 认三种开头：WAV（读头里的格式）、没有头的 PCM（Content-Type 说是 pcm 时，
 * 按 OpenAI 的约定当 24k 单声道 16 位）、其余一律报错。
 */
export function createSpeechDecoder(contentType: string): {
  push: (chunk: Buffer) => Buffer
  end: () => Buffer
} {
  let pending = Buffer.alloc(0)
  let format: WavFormat | null = null
  let resample: ((samples: Float32Array) => Float32Array) | null = null

  function convert(bytes: Buffer, wav: WavFormat): Buffer {
    const bytesPerSample = wav.bitsPerSample / 8
    const frameBytes = bytesPerSample * wav.channels
    const frames = Math.floor(bytes.length / frameBytes)
    const mono = new Float32Array(frames)
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0
      for (let channel = 0; channel < wav.channels; channel += 1) {
        const offset = frame * frameBytes + channel * bytesPerSample
        sum +=
          wav.bitsPerSample === 16
            ? bytes.readInt16LE(offset) / 0x8000
            : wav.bitsPerSample === 24
              ? bytes.readIntLE(offset, 3) / 0x800000
              : wav.float
                ? bytes.readFloatLE(offset)
                : bytes.readInt32LE(offset) / 0x80000000
      }
      // 多声道取平均：语音合成的立体声两边是同一个声音
      mono[frame] = sum / wav.channels
    }
    pending = Buffer.from(bytes.subarray(frames * frameBytes))
    return toPcm16(resample!(mono))
  }

  /** 读 WAV 头，读到 data 块为止。头没收全回 null，等下一包 */
  function readHeader(bytes: Buffer): { wav: WavFormat; dataStart: number } | null {
    let offset = 12
    let wav: WavFormat | null = null
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString('latin1', offset, offset + 4)
      const size = bytes.readUInt32LE(offset + 4)
      if (id === 'data') {
        if (!wav) throw new Error('TTS_UNSUPPORTED_AUDIO: WAV 缺少 fmt 块')
        return { wav, dataStart: offset + 8 }
      }
      if (offset + 8 + size > bytes.length) return null
      if (id === 'fmt ') {
        const tag = bytes.readUInt16LE(offset + 8)
        const bitsPerSample = bytes.readUInt16LE(offset + 22)
        // 0xFFFE 是扩展格式，真正的编码在子格式里；16/24 位当整数，32 位看子格式
        const subFormat = tag === 0xfffe && size >= 40 ? bytes.readUInt16LE(offset + 32) : tag
        wav = {
          channels: bytes.readUInt16LE(offset + 10),
          sampleRate: bytes.readUInt32LE(offset + 12),
          bitsPerSample,
          float: subFormat === 3
        }
        const supported =
          (subFormat === 1 && [16, 24, 32].includes(bitsPerSample)) ||
          (subFormat === 3 && bitsPerSample === 32)
        if (!supported || wav.channels < 1 || !wav.sampleRate) {
          throw new Error(
            `TTS_UNSUPPORTED_AUDIO: WAV 编码 ${subFormat}、${bitsPerSample} 位暂不支持，请让服务输出 16 位 PCM`
          )
        }
      }
      // 块长是奇数时后面补一个字节
      offset += 8 + size + (size % 2)
    }
    return null
  }

  return {
    push(chunk) {
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk
      if (format) return convert(bytes, format)
      pending = Buffer.from(bytes)
      if (bytes.length < 12) return Buffer.alloc(0)

      if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE') {
        const header = readHeader(bytes)
        if (!header) return Buffer.alloc(0)
        format = header.wav
        resample = createResampler(format.sampleRate, OUTPUT_RATE)
        return convert(bytes.subarray(header.dataStart), format)
      }
      if (/pcm|l16/i.test(contentType)) {
        format = { sampleRate: OUTPUT_RATE, channels: 1, bitsPerSample: 16, float: false }
        resample = createResampler(OUTPUT_RATE, OUTPUT_RATE)
        return convert(bytes, format)
      }
      const compressed = compressedFormat(bytes)
      if (compressed) {
        throw new Error(
          `TTS_UNSUPPORTED_AUDIO: 服务返回的是 ${compressed}，请确认它支持 response_format=wav`
        )
      }
      // 200 回了一段文字：多半是网关的报错页或 JSON 错误
      throw new Error(`TTS_UNSUPPORTED_AUDIO: ${bytes.toString('utf8', 0, 160).trim()}`)
    },
    end() {
      // 头都没收全就结束了：回包太短，算没有音频，由调用方报 TTS_EMPTY_AUDIO
      return Buffer.alloc(0)
    }
  }
}

/** 网络层失败。本机服务最常见的是没开 */
function describeNetworkFailure(error: unknown, url: string): string {
  const code = (error as { cause?: { code?: string } })?.cause?.code
  if (code === 'ECONNREFUSED') return `连不上语音合成服务（${url}），请确认它正在运行`
  if (code === 'ENOTFOUND') return `找不到语音合成服务的地址（${url}）`
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'TTS_TIMEOUT'
  return error instanceof Error ? error.message : String(error)
}

/** 厂商错误的原话。OpenAI 是 error.message，FastAPI 一系是 detail */
function vendorDetail(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown } | string; detail?: unknown }
    const detail =
      typeof body.error === 'object' ? body.error?.message : (body.error ?? body.detail)
    if (typeof detail === 'string') return detail.slice(0, 200)
    if (detail !== undefined) return JSON.stringify(detail).slice(0, 200)
  } catch {
    // 不是 JSON
  }
  return raw.trim().slice(0, 200)
}

export async function requestOpenAiSpeech(
  provider: ProviderConfig,
  modelId: string,
  voice: string,
  text: string,
  key: string,
  signal: AbortSignal,
  onAudio: (chunk: SpeechAudio) => void
): Promise<void> {
  const url = resolveSpeechUrl(provider.baseUrl)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        ...provider.headers,
        'Content-Type': 'application/json',
        // 本机服务多半不要密钥。空着就不带
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify({ model: modelId, input: text, voice, response_format: 'wav' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(describeNetworkFailure(error, url))
  }
  if (!response.ok) {
    const detail = vendorDetail(await response.text().catch(() => ''))
    throw new Error(`TTS_HTTP_${response.status}${detail ? `: ${detail}` : ''}`)
  }
  if (!response.body) throw new Error('TTS_EMPTY_AUDIO')

  const decoder = createSpeechDecoder(response.headers.get('content-type') ?? '')
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
