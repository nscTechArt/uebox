import { beforeEach, describe, expect, it, vi } from 'vitest'

const broadcasts = vi.hoisted(() => vi.fn())

/**
 * 「这一次唤起要不要开麦」这一位的传递。
 *
 * 盯的不是功能好不好用，是一条**错了会吓到人**的性质：普通打字热键唤起的
 * Spotlight 绝对不能自己把麦克风打开。这一位是一次性的（读完就清），
 * 而 `show()` 有两条提前 return 的路 —— 漏一条，它就会一直挂到下一次显示。
 */

/** 每个假窗口的事件表。`closed` / `did-finish-load` 都要能手动触发 */
type Handlers = Map<string, Array<(...args: unknown[]) => void>>

/** 发给渲染层的 `spotlight:show`，连载荷一起记下来 */
const sent: Array<{ channel: string; payload: unknown }> = []
let windows: FakeWindow[] = []

class FakeWindow {
  destroyed = false
  handlers: Handlers = new Map()
  contentsHandlers: Handlers = new Map()

  webContents = {
    on: (event: string, handler: (...args: unknown[]) => void): void => {
      const list = this.contentsHandlers.get(event) ?? []
      list.push(handler)
      this.contentsHandlers.set(event, list)
    },
    send: (channel: string, payload?: unknown): void => {
      sent.push({ channel, payload })
    },
    setWindowOpenHandler: () => undefined,
    session: { setPermissionRequestHandler: () => undefined }
  }

  constructor() {
    windows.push(this)
  }

  on = (event: string, handler: (...args: unknown[]) => void): void => {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }
  isDestroyed = (): boolean => this.destroyed
  isVisible = (): boolean => false
  setPosition = (): void => undefined
  getPosition = (): number[] => [0, 0]
  setOpacity = (): void => undefined
  showInactive = (): void => undefined
  focus = (): void => undefined
  hide = (): void => undefined
  loadURL = (): Promise<void> => Promise.resolve()
  loadFile = (): Promise<void> => Promise.resolve()

  /** 页面加载完 */
  finishLoad(): void {
    this.contentsHandlers.get('did-finish-load')?.forEach((handler) => handler())
  }
  /** 窗口被关掉（用户关、或者 app 退出时清理） */
  close(): void {
    this.destroyed = true
    this.handlers.get('closed')?.forEach((handler) => handler())
  }
}

const display = {
  workAreaSize: { width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 }
}

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      return new FakeWindow() as unknown as object
    }
  },
  screen: {
    getPrimaryDisplay: () => display,
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getAllDisplays: () => [display]
  },
  globalShortcut: { register: () => true, unregister: () => undefined, isRegistered: () => false },
  ipcMain: { on: () => undefined, handle: () => undefined },
  app: { getPath: () => '/tmp' }
}))
vi.mock('./appWindows', () => ({ getAppWindows: () => [], sendToAppWindows: broadcasts }))
vi.mock('./security', () => ({ protectRendererWindow: () => undefined }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./services', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
}))
vi.mock('fs', () => {
  const fs = {
    readFileSync: () => '{}',
    writeFileSync: () => undefined,
    existsSync: () => false
  }
  // 具名和 default 都给：`spotlightManager` 走具名导入，而别处可能 `import fs from 'fs'`
  return { ...fs, default: fs }
})

import { spotlightManager } from './spotlightManager'

/** 最近一条 `spotlight:show` 的 `dictate` 位 */
function lastDictate(): boolean | undefined {
  const show = [...sent].reverse().find((item) => item.channel === 'spotlight:show')
  return (show?.payload as { dictate?: boolean } | undefined)?.dictate
}

beforeEach(() => {
  sent.length = 0
  // 上一条用例留下的窗口关掉，管理器回到「还没建窗口」那个状态
  windows.forEach((window) => !window.destroyed && window.close())
  windows = []
})

describe('Spotlight 的听写位', () => {
  it('语音热键唤起时带上 dictate，普通唤起不带', () => {
    spotlightManager.showForDictation()
    windows[0].finishLoad()
    expect(lastDictate()).toBe(true)

    spotlightManager.show()
    expect(lastDictate()).toBe(false)
  })

  /**
   * 红灯用例：按语音热键时窗口还没加载完，`show()` 在 `!isReady` 那儿就回去了，
   * 压根没走到清这一位的地方。窗口随后被关掉（退出、或者用户关的），
   * 那一位就这么挂着 —— 下一次按**普通**搜索热键，Spotlight 一开就开始录音。
   */
  it('那次显示没发生就把听写位作废，不许挂到下一次唤起', () => {
    spotlightManager.showForDictation()
    // 页面还没加载完，窗口就没了
    windows[0].close()

    // 重新建一个，这次是普通打字唤起
    spotlightManager.show()
    windows[windows.length - 1].finishLoad()

    expect(lastDictate()).toBe(false)
  })

  /**
   * 页面还在加载时先按了语音热键、紧接着又按了打字热键：最后一次按的算。
   * 原来打字那一下不清这一位，加载完一弹出来就开了麦。
   */
  it('加载中先按语音、再按打字：以打字为准，不开麦', () => {
    spotlightManager.showForDictation()
    spotlightManager.toggle()
    windows[windows.length - 1].finishLoad()

    expect(lastDictate()).toBe(false)
  })

  /** 开麦之前让别的窗口停下朗读：念出来的话会被麦克风收进去、转写成指令的一部分 */
  it('语音热键开麦时广播一声，让正在朗读的窗口停下', () => {
    broadcasts.mockClear()
    spotlightManager.showForDictation()
    expect(broadcasts).toHaveBeenCalledWith('voice:dictation-started')
  })
})
