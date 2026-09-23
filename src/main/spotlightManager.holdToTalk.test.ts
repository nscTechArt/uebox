/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「按住 Alt+Q 说话」时，热键回调会被键盘自动重复刷爆。
 *
 * 真机实测（2026-09-22，主进程日志）：按住不放，`globalShortcut` **每 31 毫秒**
 * 回调一次。而「按住说话」的整个前提就是用户会一直按着。
 *
 * ```
 * [热键探针] voice.spotlight_dictate 触发，距上次 31ms
 * [Spotlight] 使用保存的位置: (1093, 1143)
 * [热键探针] voice.spotlight_dictate 触发，距上次 31ms
 * [Spotlight] 使用保存的位置: (1093, 1143)   ← 每秒 31 次重新显示 + 重启录音
 * ```
 *
 * 不压的话，渲染层每秒把录音推倒重来 31 次 —— 用户对着一个反复重启的麦克风
 * 说话，一个字都留不下。而且**不报错**：窗口看着好好的，状态条也写着「正在听」。
 */

const DISPLAY = {
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaSize: { width: 1920, height: 1080 }
}

/** 发给渲染层的每一条：[channel, payload] */
let sent: Array<[string, unknown]> = []

const webContents = {
  send: (channel: string, payload?: unknown) => sent.push([channel, payload]),
  isLoading: () => false,
  once: vi.fn(),
  on: vi.fn(),
  setWindowOpenHandler: vi.fn()
}

const fakeWindow = {
  webContents,
  isDestroyed: () => false,
  on: vi.fn(),
  show: vi.fn(),
  showInactive: vi.fn(),
  focus: vi.fn(),
  hide: vi.fn(),
  setOpacity: vi.fn(),
  setPosition: vi.fn(),
  isAlwaysOnTop: () => true,
  setAlwaysOnTop: vi.fn(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  getBounds: () => ({ x: 0, y: 0, width: 600, height: 400 })
}

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      return fakeWindow
    }
    static getAllWindows = (): unknown[] => []
    static getFocusedWindow = (): unknown => null
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  screen: {
    getPrimaryDisplay: () => DISPLAY,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => DISPLAY,
    getAllDisplays: () => [DISPLAY]
  },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  app: { getPath: () => 'C:/tmp' }
}))

vi.mock('node:fs', () => ({
  existsSync: () => false,
  readFileSync: vi.fn(),
  writeFileSync: vi.fn()
}))
vi.mock('fs', () => ({ existsSync: () => false, readFileSync: vi.fn(), writeFileSync: vi.fn() }))
vi.mock('./appWindows', () => ({ getAppWindows: () => [] }))
vi.mock('./services', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./security', () => ({ protectRendererWindow: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

async function loadManager(): Promise<{ showForDictation: () => void }> {
  vi.resetModules()
  const { spotlightManager } = await import('./spotlightManager')
  const manager = spotlightManager as unknown as {
    showForDictation: () => void
    isReady?: boolean
  }
  // 预创建的窗口平时要等 did-finish-load 才显示；测试里直接当它已经就绪
  manager.isReady = true
  return manager
}

function shows(): number {
  return sent.filter(([channel]) => channel === 'spotlight:show').length
}

function holds(): number {
  return sent.filter(([channel]) => channel === 'spotlight:hold').length
}

beforeEach(() => {
  sent = []
  vi.useFakeTimers()
})

describe('语音热键按住不放', () => {
  it('只开一次麦：后面那一串自动重复不再重新显示窗口', async () => {
    const manager = await loadManager()

    manager.showForDictation()
    // 按住三秒 ≈ 31 毫秒一次
    for (let i = 0; i < 96; i += 1) {
      vi.advanceTimersByTime(31)
      manager.showForDictation()
    }

    expect(shows()).toBe(1)
    // 其余的都只是「还按着」的信号
    expect(holds()).toBe(96)
  })

  it('第一下就带着听写标记，渲染层据此直接进录音态', async () => {
    const manager = await loadManager()
    manager.showForDictation()
    expect(sent).toContainEqual(['spotlight:show', { dictate: true }])
  })

  /**
   * 松手之后隔一会儿再按，那是**新的一轮**（「刚才没说清，再说一遍」）。
   * 判成同一次按住的话，第二次按下去什么都不会发生。
   */
  it('隔开之后再按，算新的一轮', async () => {
    const manager = await loadManager()
    manager.showForDictation()
    vi.advanceTimersByTime(1_000)
    manager.showForDictation()

    expect(shows()).toBe(2)
    expect(holds()).toBe(0)
  })
})
