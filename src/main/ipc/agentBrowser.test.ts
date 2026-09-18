import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const events = new Map<string, Handler>()
const navigation = { canGoBack: false, canGoForward: false, loading: false }
const group = { tabs: [], activeTabId: null }
const browser = {
  groupState: vi.fn(() => group),
  createTab: vi.fn(),
  selectTab: vi.fn(),
  closeTab: vi.fn(),
  setMode: vi.fn(),
  toolbar: vi.fn(),
  navigationState: vi.fn(() => navigation),
  restore: vi.fn(),
  open: vi.fn(async () => ({ url: 'https://example.com/' })),
  currentUrl: vi.fn(() => 'https://example.com/'),
  close: vi.fn(),
  hasWindow: vi.fn(() => true),
  currentMode: vi.fn(() => 'embedded'),
  setEmbeddedBounds: vi.fn()
}
const getSessionBrowser = vi.fn(() => browser)
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: Handler): void => {
      handlers.set(name, handler)
    },
    on: (name: string, handler: Handler): void => {
      events.set(name, handler)
    }
  }
}))
vi.mock('../services/agentBrowser', () => ({ getSessionBrowser }))
const { registerAgentBrowserIPC } = await import('./agentBrowser')

beforeEach(() => {
  vi.clearAllMocks()
  browser.restore.mockResolvedValue(undefined)
  registerAgentBrowserIPC()
})

describe('浏览器会话 IPC', () => {
  it('普通查询不恢复；进入会话显式恢复且只接受会话 ID', async () => {
    const query = handlers.get('agent-browser:get-state')!
    await query({}, 'a')
    expect(browser.restore).not.toHaveBeenCalled()
    expect(await query({}, 'b', true)).toEqual({
      success: true,
      data: { ...group, navigation, open: true, mode: 'embedded', url: 'https://example.com/' }
    })
    expect(getSessionBrowser).toHaveBeenLastCalledWith('b')
    expect(browser.restore).toHaveBeenCalledOnce()
    await expect(query({}, { url: 'https://example.com/' }, true)).rejects.toThrow()
  })

  it('隐藏和关闭按会话路由，非法 bounds 隐藏视图', async () => {
    const bounds = events.get('agent-browser:set-bounds')!
    bounds({ sender: { id: 1 } }, { x: 1, y: 2, width: 0, height: 300 }, 'a')
    expect(getSessionBrowser).toHaveBeenLastCalledWith('a')
    expect(browser.setEmbeddedBounds).toHaveBeenLastCalledWith(null, 1)
    expect(() => bounds({}, null, {})).not.toThrow()
    await handlers.get('agent-browser:close')!({}, 'b')
    expect(getSessionBrowser).toHaveBeenLastCalledWith('b')
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('恢复失败返回可由 renderer 展示的错误', async () => {
    browser.restore.mockRejectedValue(new Error('offline'))
    expect(await handlers.get('agent-browser:get-state')!({}, 'a', true)).toMatchObject({
      success: false,
      error: 'offline'
    })
  })
})

it('用户输入按会话导航并补全协议，危险网址不会传给浏览器', async () => {
  const open = handlers.get('agent-browser:open-url')!
  expect(await open({}, 'a', 'example.com')).toEqual({
    success: true,
    data: { url: 'https://example.com/' }
  })
  expect(getSessionBrowser).toHaveBeenLastCalledWith('a')
  expect(browser.open).toHaveBeenCalledWith('https://example.com/')
  browser.open.mockClear()
  expect(await open({}, 'a', 'file:///tmp/private')).toMatchObject({ success: false })
  expect(browser.open).not.toHaveBeenCalled()
  expect(await open({}, '', 'example.com')).toMatchObject({ success: false })
})

it('工具栏命令按会话路由，只接受明确支持的动作', async () => {
  const control = handlers.get('agent-browser:toolbar')!
  for (const action of ['back', 'forward', 'reload', 'stop']) {
    expect(await control({}, 'b', action)).toMatchObject({ success: true })
    expect(getSessionBrowser).toHaveBeenLastCalledWith('b')
    expect(browser.toolbar).toHaveBeenLastCalledWith(action)
  }
  browser.toolbar.mockClear()
  expect(await control({}, 'b', 'executeJavaScript')).toMatchObject({ success: false })
  expect(browser.toolbar).not.toHaveBeenCalled()
})

it('标签操作只发送给目标会话，拒绝非法命令', async () => {
  const tab = handlers.get('agent-browser:tab')!
  for (const command of [
    { action: 'create' },
    { action: 'select', tabId: 'one' },
    { action: 'close', tabId: 'two' },
    { action: 'mode', mode: 'window' }
  ]) {
    expect(await tab({}, 'a', command)).toMatchObject({ success: true })
    expect(getSessionBrowser).toHaveBeenLastCalledWith('a')
  }
  expect(browser.createTab).toHaveBeenCalledOnce()
  expect(browser.selectTab).toHaveBeenCalledWith('one')
  expect(browser.closeTab).toHaveBeenCalledWith('two')
  expect(browser.setMode).toHaveBeenCalledWith('window')
  for (const command of [null, { action: 'select' }, { action: 'mode', mode: 'bad' }]) {
    expect(await tab({}, 'a', command)).toMatchObject({ success: false })
  }
})
