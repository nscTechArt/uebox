import { describe, expect, it, vi } from 'vitest'
import { Stream } from './nodeStream'

type StreamApi = {
  on(event: string, listener: (...args: unknown[]) => void): StreamApi
  emit(event: string, ...args: unknown[]): boolean
  removeAllListeners(event?: string): StreamApi
}

describe('浏览器 stream 兼容层', () => {
  it('支持 SAX 解析器需要的订阅、派发和清理', () => {
    const stream = new Stream() as unknown as StreamApi
    const listener = vi.fn()

    expect(stream.on('data', listener)).toBe(stream)
    expect(stream.emit('data', 'payload')).toBe(true)
    expect(listener).toHaveBeenCalledWith('payload')

    stream.removeAllListeners('data')
    expect(stream.emit('data', 'ignored')).toBe(false)
  })
})
