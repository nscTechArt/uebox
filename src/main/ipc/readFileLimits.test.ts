import { describe, expect, it } from 'vitest'
import { applyReadFileLimits } from './readFileLimits'

describe('applyReadFileLimits', () => {
  it('honors maxLines 0 as no line limit for JSON reports', () => {
    const content = Array.from({ length: 20 }, (_, index) => `"line${index}": true`).join('\n')

    const result = applyReadFileLimits(content, {
      maxLines: 0,
      maxBytes: 10 * 1024 * 1024
    })

    expect(result.content).toBe(content)
    expect(result.truncated).toBe(false)
  })

  it('still applies the default preview line limit when maxLines is omitted', () => {
    const content = Array.from({ length: 20 }, (_, index) => `line${index}`).join('\n')

    const result = applyReadFileLimits(content)

    expect(result.content.split('\n')).toHaveLength(10)
    expect(result.truncated).toBe(true)
  })
})
