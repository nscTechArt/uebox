import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const antdOverrideCss = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/styles/antd-override.css'),
  'utf8'
)

describe('全局 Toast 样式', () => {
  it('使用独立浮层背景，避免与后景文字混读', () => {
    // Toast 是浮在页面之上的一层，用 raised（浮层）而不是 surface（卡片）：
    // 它要压住底下滚动的内容，跟下拉菜单、右键菜单同一档。
    expect(antdOverrideCss).toMatch(
      /\.ant-message \.ant-message-notice-content[\s\S]*background: var\(--color-bg-raised\) !important;/
    )
    expect(antdOverrideCss).toContain('backdrop-filter: blur(var(--blur-lg));')
  })

  it('为状态图标和消息正文保留明确间距', () => {
    expect(antdOverrideCss).toMatch(
      /\.ant-message \.ant-message-custom-content[\s\S]*gap: var\(--space-2\);/
    )
    expect(antdOverrideCss).toMatch(
      /\.ant-message \.ant-message-custom-content > \.anticon[\s\S]*margin-inline-end: 0;/
    )
  })
})
