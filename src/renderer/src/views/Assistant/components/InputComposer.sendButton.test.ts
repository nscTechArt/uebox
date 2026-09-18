import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Assistant/components/InputComposer.vue'),
  'utf8'
)

describe('InputComposer send button', () => {
  it('uses a theme-inverted up arrow without a hover change', () => {
    expect(source).toContain('<PhArrowUp v-if="!isUploading" />')
    expect(source).not.toContain('SendOutlined')
    expect(source).not.toContain('assistant-send-btn')
    expect(source).toContain('--send-button-bg: var(--color-bg-inverse)')
    expect(source).toContain('--send-button-color: var(--color-text-inverse)')
    expect(source).toMatch(
      /&:hover:not\(:disabled\),[\s\S]*?background: var\(--send-button-bg\) !important;[\s\S]*?box-shadow: var\(--shadow-soft\);[\s\S]*?transform: none;/
    )
  })
})
