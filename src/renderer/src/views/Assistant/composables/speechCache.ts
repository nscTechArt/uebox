import type { SpeechAudio } from '@core/shared/speech'

/** Completed playback only; bounded window-local cache, shared across conversation views. */
export class SpeechCache {
  private readonly entries = new Map<string, { frames: SpeechAudio[]; size: number }>()
  private size = 0
  constructor(readonly capacity = 64 * 1024 * 1024) {}

  get(key: string): SpeechAudio[] | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.frames
  }

  set(key: string, frames: SpeechAudio[]): void {
    const size =
      key.length * 2 + frames.reduce((total, frame) => total + frame.base64.length * 2 + 64, 0)
    if (!frames.length || size > this.capacity) return
    const previous = this.entries.get(key)
    if (previous) {
      this.size -= previous.size
      this.entries.delete(key)
    }
    while (this.size + size > this.capacity) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.size -= oldest[1].size
    }
    this.entries.set(key, { frames, size })
    this.size += size
  }

  clear(): void {
    this.entries.clear()
    this.size = 0
  }
}

export const speechCache = new SpeechCache()
