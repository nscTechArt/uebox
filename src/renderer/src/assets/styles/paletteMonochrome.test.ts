import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { palette } from './palette.generated'

const css = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/styles/palette.generated.css'),
  'utf8'
)
const globalCss = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/styles/global.css'),
  'utf8'
)
const inputComposer = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Assistant/components/InputComposer.vue'),
  'utf8'
)

function rgb(value: string): number[] {
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16))
}

function expectGray(value: string): void {
  const [red, green, blue] = rgb(value)
  expect(red).toBe(green)
  expect(green).toBe(blue)
}

describe('monochrome accent palette', () => {
  it('keeps every primitive accent step neutral from near-white to near-black', () => {
    const values = [
      ...css.matchAll(/--accent-(?:50|100|200|300|400|500|600|700|800|900|950):\s*(#[0-9a-f]{6});/g)
    ].map((match) => match[1])

    expect(values).toHaveLength(11)
    values.forEach(expectGray)
    expect(rgb(values[0])).toEqual([252, 252, 252])
    expect(rgb(values.at(-1)!)).toEqual([17, 17, 17])
  })

  it.each(['dark', 'light'] as const)('%s accent surfaces stay monochrome', (mode) => {
    expectGray(palette[mode].accentText)
    expectGray(palette[mode].accentBg)
    expectGray(palette[mode].accentBorder)
  })

  it.each(['dark', 'light'] as const)(
    '%s strong actions and checked controls stay blue',
    (mode) => {
      for (const value of [palette[mode].accentSolid, palette[mode].switchChecked]) {
        const [red, green, blue] = rgb(value)
        expect(blue).toBeGreaterThan(red)
        expect(blue).toBeGreaterThan(green)
      }
      expect(palette[mode].accentSolid).toBe(palette[mode].switchChecked)
      expect(palette[mode].accentSolidHover).toBe(palette[mode].switchCheckedHover)
    }
  )

  it('uses the strong action token for generation and active tabs', () => {
    const imagePanel = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/views/AIGCStudio/components/ImagePanel.vue'),
      'utf8'
    )
    const tabsHeader = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/layout/components/TabsHeader.vue'),
      'utf8'
    )

    expect(imagePanel).toMatch(
      /\.generate-btn\s*\{[\s\S]*?background:\s*var\(--color-accent-solid\);/
    )
    expect(tabsHeader).toMatch(/&::after\s*\{[\s\S]*?background:\s*var\(--color-accent-solid\);/)
  })

  it.each(['dark', 'light'] as const)('%s text selection stays blue', (mode) => {
    expect(palette[mode].selectionBg).toBe(palette[mode].switchChecked)
    expect(palette[mode].selectionText).toBe('#ffffff')
  })

  it('applies the text selection tokens globally', () => {
    expect(globalCss).toMatch(
      /::selection\s*\{[\s\S]*?color:\s*var\(--color-selection-text\);[\s\S]*?background:\s*var\(--color-selection-bg\);/
    )
  })

  it('keeps selected rows neutral while their indicators use blue', () => {
    expect(inputComposer).toMatch(
      /\.mode-option[\s\S]*?&\.active\s*\{\s*background:\s*var\(--color-bg-selected\);/
    )
    expect(inputComposer).toMatch(
      /&::before\s*\{[\s\S]*?background:\s*var\(--color-accent-solid\);/
    )
    expect(inputComposer).toMatch(
      /\.mode-option-icon-wrap[\s\S]*?&\.active\s*\{[\s\S]*?background:\s*var\(--color-accent-solid\);[\s\S]*?color:\s*var\(--color-text-on-solid\);/
    )
    expect(inputComposer).toMatch(
      /\.mode-option-check\s*\{[\s\S]*?background:\s*var\(--color-accent-solid\);[\s\S]*?color:\s*var\(--color-text-on-solid\);/
    )
  })
})
