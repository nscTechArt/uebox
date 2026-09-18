import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/MiniChat/MiniChatWindow.vue'),
  'utf8'
)

describe('MiniChatWindow theme styles', () => {
  it('paints the window with the current theme page background', () => {
    expect(source).toMatch(/\.mini-chat-window\s*{[^}]*background:\s*var\(--color-bg-surface\)/s)
  })
})
