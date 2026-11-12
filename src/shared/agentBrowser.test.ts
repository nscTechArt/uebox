import { describe, expect, it } from 'vitest'
import { resolveBrowserShortcut, type BrowserKeyInput } from './agentBrowser'

const press = (key: string, mods: Partial<BrowserKeyInput> = {}): BrowserKeyInput => ({
  key,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods
})

describe('浏览器快捷键', () => {
  it.each([
    [press('t', { control: true }), { name: 'newTab' }],
    [press('W', { control: true }), { name: 'closeTab' }],
    [press('T', { control: true, shift: true }), { name: 'reopenTab' }],
    [press('Tab', { control: true }), { name: 'nextTab' }],
    [press('Tab', { control: true, shift: true }), { name: 'previousTab' }],
    [press('3', { control: true }), { name: 'selectTab', index: 2 }],
    [press('9', { control: true }), { name: 'lastTab' }],
    [press('l', { control: true }), { name: 'focusAddress' }],
    [press('d', { alt: true }), { name: 'focusAddress' }],
    [press('F5'), { name: 'reload' }],
    [press('F5', { control: true }), { name: 'hardReload' }],
    [press('ArrowLeft', { alt: true }), { name: 'back' }],
    [press('f', { control: true }), { name: 'find' }],
    [press('=', { control: true }), { name: 'zoomIn' }],
    [press('0', { control: true }), { name: 'zoomReset' }]
  ])('Windows：%o', (input, expected) => {
    expect(resolveBrowserShortcut(input, 'win32')).toEqual(expected)
  })

  it('普通输入、Ctrl+C 这些不拦', () => {
    for (const input of [press('a'), press('c', { control: true }), press('v', { control: true })])
      expect(resolveBrowserShortcut(input, 'win32')).toBeNull()
  })

  it('macOS 用 ⌘，Ctrl 不算', () => {
    expect(resolveBrowserShortcut(press('t', { meta: true }), 'darwin')).toEqual({ name: 'newTab' })
    expect(resolveBrowserShortcut(press('t', { control: true }), 'darwin')).toBeNull()
    expect(resolveBrowserShortcut(press('[', { meta: true }), 'darwin')).toEqual({ name: 'back' })
  })
})
