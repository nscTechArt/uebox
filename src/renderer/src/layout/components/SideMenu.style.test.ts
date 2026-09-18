import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/layout/components/SideMenu.vue'),
  'utf8'
)

describe('SideMenu surface', () => {
  it('uses a subtle vertical gradient derived from semantic surface colors', () => {
    expect(source).toMatch(
      /linear-gradient\(\s*to bottom,\s*var\(--color-bg-page\) 0%,\s*color-mix\(in srgb, var\(--color-bg-page\) 33\.333%, var\(--color-bg-sunken\)\) 100%/s
    )
  })

  it('keeps the new-chat icon and label centered as one group', () => {
    expect(source).toMatch(
      /\.new-chat-btn\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s
    )
  })
})
