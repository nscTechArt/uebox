import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'browser-session-'))
vi.mock('electron', () => ({ app: { getPath: (): string => root } }))
import { loadBrowserUrl, saveBrowserUrl, loadBrowserGroup, saveBrowserGroup } from './sessionState'

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('会话浏览器持久化', () => {
  it('从磁盘读取每条会话的最后页面，关闭只删除该会话', async () => {
    await saveBrowserUrl('a', 'https://example.com/first')
    await saveBrowserUrl('a', 'https://example.com/last#section')
    await saveBrowserUrl('b', 'https://example.org/')
    expect(await loadBrowserUrl('a')).toBe('https://example.com/last#section')
    await saveBrowserUrl('a', null)
    expect(await loadBrowserUrl('a')).toBeUndefined()
    expect(await loadBrowserUrl('b')).toBe('https://example.org/')
    await saveBrowserUrl('missing', null)
  })

  it('旧会话无记录，不恢复任何页面', async () => {
    expect(await loadBrowserUrl('legacy')).toBeUndefined()
  })

  it('损坏或危险地址拒绝恢复，不能通过磁盘记录绕过 URL 策略', async () => {
    await saveBrowserUrl('broken', 'https://example.com/')
    for (const content of [
      '{',
      '{}',
      '{"url":"file:///tmp/private"}',
      '{"url":"http://127.0.0.1"}'
    ]) {
      writeFileSync(join(root, 'agent-v3-sessions', 'broken.browser.json'), content)
      await expect(loadBrowserUrl('broken')).rejects.toThrow()
    }
    await expect(saveBrowserUrl('unsafe', 'javascript:alert(1)')).rejects.toThrow()
  })
})

it('整组保存全部标签、选中项和显示模式，并兼容旧的单页面记录', async () => {
  const state = {
    urls: ['https://example.com/', 'about:blank', 'https://example.org/'],
    activeIndex: 2,
    mode: 'window' as const
  }
  await saveBrowserGroup('group', state)
  expect(await loadBrowserGroup('group')).toEqual(state)
  await saveBrowserUrl('old', 'https://example.com/')
  expect(await loadBrowserGroup('old')).toEqual({ urls: ['https://example.com/'], activeIndex: 0 })
  await saveBrowserGroup('group', { urls: [], activeIndex: 0 })
  expect(await loadBrowserGroup('group')).toBeUndefined()
  await expect(
    saveBrowserGroup('unsafe-group', { urls: ['file:///private'], activeIndex: 0 })
  ).rejects.toThrow()
})
