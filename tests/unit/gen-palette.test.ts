import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/styles/palette.generated.css'),
  'utf8'
)

function primitive(name: string): string {
  return css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i'))?.[1] ?? ''
}

function contrast(a: string, b: string): number {
  const luminance = (value: string): number => {
    const channels = [1, 3, 5].map((index) => {
      const channel = Number.parseInt(value.slice(index, index + 2), 16) / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('warning solid palette', () => {
  it('keeps warning fills bright and pairs them with dark text', () => {
    const normal = primitive('warning-solid')
    const hover = primitive('warning-solid-hover')
    const text = primitive('n-950')

    expect(normal).toBe('#f7ad30')
    expect(contrast(text, normal)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(text, hover)).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', normal)).toBeLessThan(3)
    expect(contrast('#ffffff', hover)).toBeLessThan(3)
    expect(css.match(/--color-warning-on-solid:\s*var\(--n-950\);/g)).toHaveLength(2)
  })
})
