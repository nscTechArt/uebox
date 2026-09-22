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

  /*
   * 全局 border-box 下，带内边距的 svg 图标会把画图区挤没：18px 的回形针扣掉上下
   * 8px 内边距只剩 2px 高，输入框左边就只剩一个点。
   */
  it('keeps the paperclip icon drawable under global border-box', () => {
    expect(source).toMatch(/\.attach-btn\s*{[^}]*box-sizing:\s*content-box/s)
  })
})

describe('MiniChatWindow read aloud', () => {
  it('mounts the auto read-aloud watcher with the storage-synced switch', () => {
    expect(source).toMatch(/useAutoReadAloud\(\(\) => voiceAutoPlayEnabled\.value\)/)
  })
})
