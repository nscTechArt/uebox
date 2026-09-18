import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechPcmPlayer } from './speechPcmPlayer'

function audioContext(): {
  context: {
    currentTime: number
    close: ReturnType<typeof vi.fn>
    suspend: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
  }
  sources: {
    buffer: AudioBuffer | null
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    onended: (() => void) | null
  }[]
} {
  const sources: {
    buffer: AudioBuffer | null
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    onended: (() => void) | null
  }[] = []
  const context = {
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createBuffer: (_channels: number, length: number, rate: number) => {
      const data = new Float32Array(length)
      return { duration: length / rate, getChannelData: () => data }
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null
      }
      sources.push(source)
      return source
    }
  }
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context
    })
  )
  return { context, sources }
}
const frame = (bytes: number[]): { base64: string; format: 'pcm_s16le'; sampleRate: 24000 } => ({
  base64: btoa(String.fromCharCode(...bytes)),
  format: 'pcm_s16le',
  sampleRate: 24000
})
afterEach(() => vi.unstubAllGlobals())
describe('PCM streaming playback', () => {
  it('pauses the audio clock without discarding queued audio and resumes in place', async () => {
    const { context, sources } = audioContext()
    const player = new SpeechPcmPlayer()
    player.enqueue(frame([0, 0, 0, 0]))
    await player.pause()
    expect(context.suspend).toHaveBeenCalledTimes(1)
    expect(sources[0].stop).not.toHaveBeenCalled()
    await player.resume()
    expect(context.resume).toHaveBeenCalledTimes(2)
    expect(sources[0].start).toHaveBeenCalledTimes(1)
    player.stop()
    await player.resume()
    expect(context.resume).toHaveBeenCalledTimes(2)
  })
  it('schedules audio immediately, preserves samples split across frames, and drains on playback end', async () => {
    const { sources } = audioContext()
    const player = new SpeechPcmPlayer()
    await player.ready
    expect(player.enqueue(frame([0, 0, 255, 127, 0]))).toBe(true)
    expect(sources[0].start).toHaveBeenCalledWith(0.04)
    expect(Array.from(sources[0].buffer!.getChannelData(0))).toEqual([0, 32767 / 32768])
    player.enqueue(frame([128, 0, 0]))
    expect(Array.from(sources[1].buffer!.getChannelData(0))).toEqual([-1, 0])
    expect(sources[1].start).toHaveBeenCalledWith(0.04 + 2 / 24000)
    let ended = false
    const drain = player.drain().then(() => {
      ended = true
    })
    await Promise.resolve()
    expect(ended).toBe(false)
    sources.forEach((source) => source.onended?.())
    await drain
    expect(ended).toBe(true)
    player.stop()
  })
  it('stopping releases queued playback and backpressure waiters, and drops late frames', async () => {
    const { context, sources } = audioContext()
    const player = new SpeechPcmPlayer()
    player.enqueue({
      base64: btoa('\0'.repeat(24000 * 40)),
      format: 'pcm_s16le',
      sampleRate: 24000
    })
    let room = false
    const waiting = player.waitForRoom().then(() => {
      room = true
    })
    await Promise.resolve()
    expect(room).toBe(false)
    player.stop()
    await waiting
    expect(sources[0].stop).toHaveBeenCalled()
    expect(context.close).toHaveBeenCalled()
    expect(player.enqueue(frame([0, 0, 0, 0]))).toBe(false)
  })
  it('rejects compressed headers and truncated PCM samples', async () => {
    audioContext()
    const player = new SpeechPcmPlayer()
    player.enqueue(frame([82, 73]))
    expect(() => player.enqueue(frame([70, 70]))).toThrow('TTS_INVALID_AUDIO')
    player.stop()
    const incomplete = new SpeechPcmPlayer()
    incomplete.enqueue(frame([0, 0, 0, 0, 1]))
    await expect(incomplete.drain()).rejects.toThrow('TTS_INVALID_AUDIO')
    incomplete.stop()
  })
})
