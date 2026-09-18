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
  it('浏览器窗口不会被当成主窗口，哪怕它排在前面又足够大', () => {
    // 这是真会出事的那个场景：二次实例激活按「非置顶且 ≥800×600」找主窗口，
    // 浏览器默认就是 1280×820，直接命中 —— 用户双击图标会被弹出一个网页
    makeWindow({ id: 1, size: [1280, 820] })
    registerNonAppWindow(1)
    makeWindow({ id: 2, size: [1400, 850] })

    expect(findMainWindow()?.webContents.id).toBe(2)
  })

  it('主窗口被拉到 1400×850 也还找得到 —— 尺寸判据不该兼职排除浏览器', () => {
    makeWindow({ id: 1, size: [1400, 850] })

    expect(findMainWindow()?.webContents.id).toBe(1)
  })

  it('置顶的小窗口（MiniChat / Spotlight）不是主窗口', () => {
    makeWindow({ id: 1, alwaysOnTop: true, size: [400, 600] })
    makeWindow({ id: 2, size: [1400, 950] })

    expect(findMainWindow()?.webContents.id).toBe(2)
  })

  it('只剩浏览器窗口时没有主窗口，调用方据此重建', () => {
    makeWindow({ id: 1, size: [1920, 1080] })
    registerNonAppWindow(1)

    expect(findMainWindow()).toBeUndefined()
    expect(getAppWindows()).toHaveLength(0)
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
