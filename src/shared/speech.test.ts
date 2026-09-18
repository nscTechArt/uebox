import { describe, expect, it } from 'vitest'
import { MAX_SPEECH_CHARS, splitSpeechText } from './speech'

describe('朗读分段', () => {
  it('preserves a long reply without breaking Unicode characters', () => {
    const text = '你好😀。'.repeat(500)
    const chunks = splitSpeechText(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => Array.from(chunk).length <= MAX_SPEECH_CHARS)).toBe(true)
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith('。'))).toBe(true)
  })
  it('handles empty text and long text without punctuation', () => {
    expect(splitSpeechText(' \n')).toEqual([])
    expect(splitSpeechText('x'.repeat(601))).toEqual(['x'.repeat(600), 'x'])
  })
})
