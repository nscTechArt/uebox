import { describe, expect, it } from 'vitest'
import { SpeechCache } from './speechCache'

const frames = [{ base64: 'AAAAAA==', format: 'pcm_s16le' as const, sampleRate: 24000 as const }]
describe('speech cache memory bounds', () => {
  it('evicts the least recently played entry when capacity is reached', () => {
    const cache = new SpeechCache(170)
    cache.set('a', frames)
    cache.set('b', frames)
    expect(cache.get('a')).toEqual(frames)
    cache.set('c', frames)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toEqual(frames)
    expect(cache.get('c')).toEqual(frames)
  })
  it('replaces entries without double-counting and skips oversized audio', () => {
    const cache = new SpeechCache(170)
    cache.set('a', frames)
    cache.set('a', frames)
    cache.set('b', frames)
    expect(cache.get('a')).toEqual(frames)
    cache.set('large', [...frames, ...frames, ...frames])
    expect(cache.get('large')).toBeUndefined()
    expect(cache.get('b')).toEqual(frames)
    cache.clear()
    expect(cache.get('a')).toBeUndefined()
  })
})
