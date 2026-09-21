/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「Spotlight 说完一句话，Mini Chat 里空空如也」这条真机故障的回归用例。
 *
 * 日志（2026-09-22）：
 *
 * ```
 * 03:16:12.313  [MiniChat] 延迟发送初始消息: 我这个场景怎么是个黑的?...
 * 03:16:12.508  [MiniChat] 收到渲染进程请求, pendingMessage=false
 * ```
 *
 * 主进程按「页面加载完成 + 500ms」猜渲染层挂好了没有，猜早了 200 毫秒，
 * 消息推给一个还没注册监听的通道，顺手把 `pendingMessage` 清了。**两头都以为
 * 对方拿到了**，界面是个空对话框，日志里一条 error 都没有。
 *
 * 赌赢过很多次（同一份日志里 02:49:57 那次渲染层先到，就是好的），所以调大延迟
 * 修不好它 —— 只能不猜。这条用例钉的就是「不猜」。
 */

/** 一块假屏幕。`workAreaSize` 和 `workArea` 都要有，算窗口落点时两个都读 */
const DISPLAY = {
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaSize: { width: 1920, height: 1080 }
}

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
/** 发给渲染层的每一条：[channel, payload] */
let sent: Array<[string, unknown]> = []
/** `did-finish-load` 的回调。测试里手动触发，代表页面加载完了 */
let finishLoad: (() => void) | null = null
let loading = true

const webContents = {
  send: (channel: string, payload: unknown) => sent.push([channel, payload]),
  isLoading: () => loading,
  once: (event: string, callback: () => void) => {
    if (event === 'did-finish-load') finishLoad = callback
  },
  on: vi.fn(),
  setWindowOpenHandler: vi.fn()
}

const fakeWindow = {
  webContents,
  isDestroyed: () => false,
  on: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  setOpacity: vi.fn(),
  isAlwaysOnTop: () => true,
  setAlwaysOnTop: vi.fn(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  getBounds: () => ({ x: 0, y: 0, width: 400, height: 600 })
}

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      return fakeWindow
    }
    static getAllWindows = (): unknown[] => []
    static getFocusedWindow = (): unknown => null
  },
  ipcMain: {
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
      ipcHandlers.set(channel, handler)
    },
    handle: vi.fn()
  },
  screen: {
    getPrimaryDisplay: () => DISPLAY,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => DISPLAY
  },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() }
}))

vi.mock('./appWindows', () => ({ getAppWindows: () => [] }))
vi.mock('./services', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./security', () => ({ protectRendererWindow: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

async function loadManager(): Promise<{
  show: (message?: unknown) => void
}> {
  vi.resetModules()
  const { miniChatManager } = await import('./miniChatManager')
  miniChatManager.initialize()
  return miniChatManager as unknown as { show: (message?: unknown) => void }
}

/** 渲染层挂载完成：注册了监听，然后开口要一次。两件事在 onMounted 里同步挨着 */
function rendererMounts(): void {
  ipcHandlers.get('mini-chat:request-initial-message')?.({})
}

/**
 * 页面加载完，并且把主进程那个 500ms 的定时器跑完。
 *
 * **必须把时间推过去**，否则这几条用例在旧实现下也是绿的 —— 旧实现是在
 * `did-finish-load + 500ms` 才推的，定时器没跑到就什么都没发生，
 * 测试看到的和「不推」一模一样。红灯用例得让那一下真的有机会发生。
 */
function pageLoads(): void {
  finishLoad?.()
  vi.advanceTimersByTime(500)
}

beforeEach(() => {
  vi.useFakeTimers()
  ipcHandlers.clear()
  sent = []
  finishLoad = null
  loading = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Mini Chat 的初始消息', () => {
  it('新建窗口时不抢跑：页面加载完也不推，等渲染层自己来取', async () => {
    const manager = await loadManager()
    manager.show({ text: '我这个场景怎么是个黑的?' })

    // 页面加载完了 —— 但渲染层的 Vue 还没挂上，这时候推就是丢
    pageLoads()
    expect(sent.filter(([channel]) => channel === 'mini-chat:initial-message')).toEqual([])

    // 渲染层挂好了，开口要
    rendererMounts()
    expect(sent).toContainEqual([
      'mini-chat:initial-message',
      { text: '我这个场景怎么是个黑的?' }
    ])
  })

  /**
   * 慢一拍挂好的渲染层照样拿得到。
   *
   * 说清楚这条**不是**那个故障的红灯（在旧实现下它也是绿的）：测试看到的是
   * 「发出去了几条」，而真机上丢消息丢在「发出去了但没人接」—— 那一层在这里
   * 模拟不出来，`sent` 不知道对面有没有注册监听。上面那条「页面加载完也不推」
   * 才是钉住修复的那一条。这条守的是另一件事：无论渲染层什么时候来，
   * 拿到的必须**不多不少正好一条**。
   */
  it('页面加载完成之后再来取，照样拿得到（不多不少一条）', async () => {
    const manager = await loadManager()
    manager.show({ text: '把选中的 actor 缩放两倍' })

    pageLoads()
    // 渲染层慢了一拍才挂好 —— 真机上就是慢了 200 毫秒
    rendererMounts()

    expect(
      sent.filter(([channel]) => channel === 'mini-chat:initial-message').map(([, payload]) => payload)
    ).toEqual([{ text: '把选中的 actor 缩放两倍' }])
  })

  /** 只该送一次。取过之后再问（渲染层重挂）不能把同一句话又发一遍 */
  it('取走之后就没了，不会重复投递', async () => {
    const manager = await loadManager()
    manager.show({ text: '打开那个蓝图' })
    pageLoads()
    rendererMounts()
    rendererMounts()

    expect(sent.filter(([channel]) => channel === 'mini-chat:initial-message')).toHaveLength(1)
  })

  /**
   * 窗口早就开着、渲染层也早就挂好了：这时候**必须直接推**。
   * 不会有新的 `onMounted`，也就不会有人来取。
   */
  it('窗口已经加载好时直接推给它', async () => {
    const manager = await loadManager()
    // 先建起来并走完加载
    manager.show({ text: '第一句' })
    pageLoads()
    rendererMounts()
    loading = false
    sent = []

    manager.show({ text: '第二句' })
    expect(sent).toContainEqual(['mini-chat:initial-message', { text: '第二句' }])
  })
})
