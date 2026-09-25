import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 窗口枚举的唯一入口。
 *
 * 这些用例锁的是一件事：**Agent 浏览器窗口不能被当成盒子的界面**。
 * 深链接、二次实例激活、Renderer 广播全都靠它。
 */

interface FakeWindow {
  id: number
  destroyed: boolean
  alwaysOnTop: boolean
  size: [number, number]
  sent: Array<[string, unknown[]]>
}

const windows: FakeWindow[] = []

function makeWindow(init: Partial<FakeWindow> & { id: number }): FakeWindow {
  const window: FakeWindow = {
    destroyed: false,
    alwaysOnTop: false,
    size: [1400, 900],
    sent: [],
    ...init
  }
  windows.push(window)
  return window
}

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: (): unknown[] =>
      windows.map((window) => ({
        isDestroyed: () => window.destroyed,
        isAlwaysOnTop: () => window.alwaysOnTop,
        getSize: () => window.size,
        webContents: {
          id: window.id,
          send: (channel: string, ...args: unknown[]) => window.sent.push([channel, args])
        }
      }))
  }
}))

const {
  getAppWindows,
  findMainWindow,
  registerMainWindow,
  registerNonAppWindow,
  resetNonAppWindowsForTest,
  sendToAppWindows,
  unregisterNonAppWindow
} = await import('./appWindows')

beforeEach(() => {
  windows.length = 0
  resetNonAppWindowsForTest()
})

describe('getAppWindows', () => {
  it('登记过的非界面窗口不算盒子的窗口', () => {
    makeWindow({ id: 1 })
    makeWindow({ id: 2 })
    registerNonAppWindow(2)

    expect(getAppWindows().map((w) => w.webContents.id)).toEqual([1])
  })

  it('销毁的窗口不算', () => {
    makeWindow({ id: 1, destroyed: true })
    makeWindow({ id: 2 })

    expect(getAppWindows().map((w) => w.webContents.id)).toEqual([2])
  })

  it('注销之后又算回来 —— 浏览器窗口关掉后 id 可能被复用', () => {
    makeWindow({ id: 1 })
    registerNonAppWindow(1)
    unregisterNonAppWindow(1)

    expect(getAppWindows()).toHaveLength(1)
  })
})

describe('findMainWindow', () => {
  it('认登记的那个窗口，不管尺寸和排序', () => {
    makeWindow({ id: 1, size: [1280, 820] })
    makeWindow({ id: 2, size: [1024, 640] })
    registerMainWindow(2)

    expect(findMainWindow()?.webContents.id).toBe(2)
  })

  it('取消置顶又拉大的 MiniChat 不会被当成主窗口', () => {
    makeWindow({ id: 1, size: [1200, 900] })
    makeWindow({ id: 2, size: [1024, 640] })
    registerMainWindow(2)

    expect(findMainWindow()?.webContents.id).toBe(2)
  })

  it('登记的主窗口销毁后返回 undefined，调用方据此重建', () => {
    makeWindow({ id: 1, destroyed: true })
    makeWindow({ id: 2, size: [1400, 900] })
    registerMainWindow(1)

    expect(findMainWindow()).toBeUndefined()
  })

  it('没登记过就没有主窗口', () => {
    makeWindow({ id: 1 })

    expect(findMainWindow()).toBeUndefined()
  })
})

describe('sendToAppWindows', () => {
  it('不把 IPC 广播给远程页面', () => {
    const app = makeWindow({ id: 1 })
    const browser = makeWindow({ id: 2 })
    registerNonAppWindow(2)

    sendToAppWindows('asset:updated', { id: 'a' })

    expect(app.sent).toEqual([['asset:updated', [{ id: 'a' }]]])
    expect(browser.sent).toEqual([])
  })
})
