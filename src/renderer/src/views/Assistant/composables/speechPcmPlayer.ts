import type { SpeechAudio } from '@core/shared/speech'

/** Schedule raw PCM on the audio clock, without waiting for a complete audio file. */
export class SpeechPcmPlayer {
  private readonly context = new AudioContext()
  private readonly sources = new Set<AudioBufferSourceNode>()
  private readonly waiters = new Set<() => void>()
  private cursor = 0
  private carry: number | null = null
  private stopped = false
  private header: number[] = []
  private headerChecked = false
  readonly ready = this.context.resume()

  async pause(): Promise<void> {
    await this.ready
    if (!this.stopped) await this.context.suspend()
  }

  async resume(): Promise<void> {
    await this.ready
    if (!this.stopped) await this.context.resume()
  }

  enqueue(chunk: SpeechAudio): boolean {
    if (this.stopped) return false
    if (chunk.format !== 'pcm_s16le' || chunk.sampleRate !== 24000)
      throw new Error('TTS_INVALID_AUDIO')
    let bytes = Array.from(atob(chunk.base64), (char) => char.charCodeAt(0))
    // Inspect the first bytes even when the header is split across transport frames.
    if (!this.headerChecked) {
      this.header = this.header.concat(bytes)
      if (this.header.length < 4) return false
      const magic = String.fromCharCode(...this.header.slice(0, 4))
      if (magic === 'RIFF' || magic === 'OggS' || magic.startsWith('ID3'))
        throw new Error('TTS_INVALID_AUDIO')
      bytes = this.header
      this.header = []
      this.headerChecked = true
    }
    if (this.carry !== null) bytes.unshift(this.carry)
    this.carry = bytes.length % 2 ? bytes.pop()! : null
    if (!bytes.length) return false
    const buffer = this.context.createBuffer(1, bytes.length / 2, chunk.sampleRate)
    const samples = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) {
      const value = bytes[i * 2] | (bytes[i * 2 + 1] << 8)
      samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000
    }
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)
    source.onended = () => {
      source.disconnect()
      this.sources.delete(source)
      this.waiters.forEach((wake) => wake())
    }
    this.sources.add(source)
    this.cursor = Math.max(this.cursor, this.context.currentTime + 0.04)
    source.start(this.cursor)
    this.cursor += buffer.duration
    return true
  }

  /** Prefetch the next text segment with 15 seconds left, keeping the queue bounded. */
  waitForRoom(): Promise<void> {
    return this.waitUntil(() => this.cursor - this.context.currentTime <= 15)
  }

  drain(): Promise<void> {
    if (this.carry !== null || this.header.length)
      return Promise.reject(new Error('TTS_INVALID_AUDIO'))
    return this.waitUntil(() => this.sources.size === 0)
  }

  private waitUntil(done: () => boolean): Promise<void> {
    if (this.stopped || done()) return Promise.resolve()
    return new Promise((resolve) => {
      const wake = (): void => {
        if (this.stopped || done()) {
          this.waiters.delete(wake)
          resolve()
        }
      }
      this.waiters.add(wake)
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const source of this.sources) {
      source.onended = null
      source.stop()
      source.disconnect()
    }
    this.sources.clear()
    this.waiters.forEach((wake) => wake())
    void this.context.close().catch(() => {})
  }
}
