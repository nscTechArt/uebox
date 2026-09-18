import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Assistant/components/ChatLog.vue'),
  'utf8'
)

describe('ChatLog 布局', () => {
  it('内容不满一屏时靠视觉顶部对齐，而不是悬在底部', () => {
    expect(source).toMatch(
      /\.messages-container\s*{[^}]*min-height:\s*100%[^}]*justify-content:\s*flex-end/s
    )
  })
})
