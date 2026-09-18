import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/SpotlightWindow.vue'),
  'utf8'
)

describe('SpotlightWindow theme styles', () => {
  it('paints the panel with the current theme surface', () => {
    expect(source).toMatch(/\.spotlight-container\s*{[^}]*background:\s*var\(--color-bg-surface\)/s)
  })
})
