/** @vitest-environment node */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    ipcHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
    languageListeners: [] as Array<() => void>,
    libraryListeners: [] as Array<() => void>,
    projectListeners: [] as Array<() => void>,
    willQuitHandlers: [] as Array<() => void>,
    beforeQuitHandlers: [] as Array<() => void>,
    trayHandlers: new Map<string, () => void>(),
    notifications: [] as Array<{
      options: { title: string; body: string }
      emit: (event: string, ...args: unknown[]) => void
    }>,
    notifSupported: true,
    notifConstructorThrows: false,
    notifShowThrows: false,
    mainWindow: undefined as undefined | FakeWindow,
    fileExists: true,
    listRecent: async () =>
      [] as Array<{
        projectPath: string
        projectName: string
        lastOpenTime: string
        isImported: boolean
      }>,
    findRecord: (() => undefined) as (
      dir: string
    ) => undefined | { projectKey: string; projectName?: string; originPath?: string },
    interactiveProjects: [] as Array<{ projectPath: string }>,
    openFile: (async () => ({ success: true })) as (
      path: string
    ) => Promise<{ success: boolean; error?: string; pluginFailure?: string }>,
    db: {}
  }

  class FakeNotification {
    handlers = new Map<string, (...args: unknown[]) => void>()
    options: { title: string; body: string }
    static isSupported(): boolean {
      return state.notifSupported
    }
    constructor(options: { title: string; body: string }) {
      if (state.notifConstructorThrows) throw new Error('native ctor blew up')
      this.options = options
      state.notifications.push({
        options,
        emit: (event, ...args) => this.handlers.get(event)?.(...args)
      })
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      this.handlers.set(event, cb)
      return this
    }
    show(): void {
      if (state.notifShowThrows) throw new Error('native show blew up')
    }
  }

  return {
    state,
    FakeNotification,
    listRecentCalls: vi.fn(() => state.listRecent()),
    showMainWindow: vi.fn(),
    countActiveOperations: vi.fn(() => 0),
    sendToWindow: vi.fn(),
    appQuit: vi.fn(),
    loggerWarn: vi.fn(),
    dialogShow: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(async () => ({
      response: 0
    }))
  }
})

vi.mock('electron', () => ({
  app: {
    once: (event: string, cb: () => void) =>
      (event === 'before-quit'
        ? mocks.state.beforeQuitHandlers
        : mocks.state.willQuitHandlers
      ).push(cb),
    on: (event: string, cb: () => void) =>
      (event === 'before-quit'
        ? mocks.state.beforeQuitHandlers
        : mocks.state.willQuitHandlers
      ).push(cb),
    quit: (...args: unknown[]) => mocks.appQuit(...args)
  },
  dialog: { showMessageBox: (...args: unknown[]) => mocks.dialogShow(...args) },
  ipcMain: {
    handle: (channel: string, cb: (event: unknown, payload: unknown) => unknown) => {
      mocks.state.ipcHandlers.set(channel, cb)
    }
  },
  Menu: { buildFromTemplate: (template: unknown) => template },
  Notification: mocks.FakeNotification,
  Tray: class {}
}))

vi.mock('fs', () => ({ existsSync: () => mocks.state.fileExists }))

vi.mock('../appWindows', () => ({
  findMainWindow: () => mocks.state.mainWindow,
  sendToWindow: (...args: unknown[]) => mocks.sendToWindow(...args)
}))

vi.mock('../i18n', () => ({
  mt: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  onLanguageChanged: (cb: () => void) => {
    mocks.state.languageListeners.push(cb)
  }
}))

vi.mock('../ipc/epicProjects', () => ({
  getRecentProjectsFromAllEngines: () => mocks.listRecentCalls()
}))

vi.mock('../services/project/openUproject', () => ({
  openUprojectFile: (path: string) => mocks.state.openFile(path)
}))

vi.mock('../services/project/projectLibraryEvents', () => ({
  onProjectLibraryChanged: (cb: () => void) => {
    mocks.state.libraryListeners.push(cb)
    return () => {
      mocks.state.libraryListeners = mocks.state.libraryListeners.filter((l) => l !== cb)
    }
  }
}))

vi.mock('../services/project/projectManager', () => ({
  projectManager: {
    onProjectsChanged: (cb: () => void) => {
      mocks.state.projectListeners.push(cb)
      return () => {
        mocks.state.projectListeners = mocks.state.projectListeners.filter((l) => l !== cb)
      }
    },
    getInteractiveProjects: () => mocks.state.interactiveProjects
  }
}))

vi.mock('../services', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mocks.loggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('../sqliteDataBase', () => ({ getPublicDatabase: () => mocks.state.db }))
vi.mock('../sqliteDataBase/models/project', () => ({
  getProjectByPath: (_db: unknown, dir: string) => mocks.state.findRecord(dir)
}))

import {
  TRAY_SET_RECENT_SESSIONS_CHANNEL,
  TRAY_TAKE_PENDING_CHANNEL
} from '../../shared/trayActions'
import { LAUNCH_TTL_MS } from './launchTracker'
import { startTrayMenuController } from './trayController'

const s = mocks.state

class FakeWindow extends EventEmitter {
  visible = true
  minimized = false
  destroyed = false
  webContentsDestroyed = false
  readonly webContents = { isDestroyed: () => this.webContentsDestroyed }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore = vi.fn(() => {
    this.minimized = false
  })
  show = vi.fn(() => {
    this.visible = true
  })
  focus = vi.fn()
}

interface MenuItem {
  label?: string
  enabled?: boolean
  type?: string
  click?: () => void
}

function projectEntry(
  dir: string,
  name: string,
  lastOpenTime: string
): { projectPath: string; projectName: string; lastOpenTime: string; isImported: boolean } {
  return {
    projectPath: `${dir}/${name}.uproject`,
    projectName: name,
    lastOpenTime,
    isImported: true
  }
}

function projectRecord(dir: string): {
  projectKey: string
  projectName: string
  originPath: string
} {
  const key = `k-${dir.replace(/[^a-z0-9]/gi, '')}`
  const name = dir.split('/').pop() ?? dir
  return { projectKey: key, projectName: name, originPath: `${dir}/${name}.uproject` }
}

function seedProjects(dirs: string[], times: Record<string, string>): void {
  const records = new Map(dirs.map((dir) => [dir, projectRecord(dir)]))
  s.findRecord = (dir) => records.get(dir)
  s.listRecent = async () =>
    dirs.map((dir) => projectEntry(dir, dir.split('/').pop() ?? dir, times[dir]))
}

function labelsOf(template: MenuItem[]): string[] {
  return template.map((item) => item.label ?? '---')
}

function projectItem(template: MenuItem[], name: string): MenuItem | undefined {
  return template.find((item) => item.label?.includes(name))
}

function takePending(): unknown {
  return s.ipcHandlers.get(TRAY_TAKE_PENDING_CHANNEL)!({}, undefined)
}

function newTray(): {
  setToolTip: Mock
  setContextMenu: Mock
  popUpContextMenu: Mock
  on: (event: string, cb: () => void) => void
} {
  return {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    popUpContextMenu: vi.fn(),
    on: (event: string, cb: () => void) => {
      s.trayHandlers.set(event, cb)
    }
  }
}

const realPlatform = process.platform
const hostDeps = {
  showMainWindow: mocks.showMainWindow,
  countActiveOperations: mocks.countActiveOperations
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

describe('trayController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    s.ipcHandlers.clear()
    s.trayHandlers.clear()
    s.languageListeners = []
    s.libraryListeners = []
    s.projectListeners = []
    s.willQuitHandlers = []
    s.beforeQuitHandlers = []
    s.notifications = []
    s.notifSupported = true
    s.notifConstructorThrows = false
    s.notifShowThrows = false
    s.mainWindow = undefined
    s.fileExists = true
    s.interactiveProjects = []
    s.openFile = async () => ({ success: true })
    s.listRecent = async () => []
    s.findRecord = () => undefined
    vi.clearAllMocks()
    mocks.countActiveOperations.mockReset().mockReturnValue(0)
    mocks.showMainWindow.mockReset()
    mocks.dialogShow.mockReset().mockResolvedValue({ response: 0 })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    vi.useRealTimers()
  })

  describe('非 win32 常驻菜单', () => {
    it('连接变了就作废候选缓存：TTL 内的旧名单当场换', async () => {
      setPlatform('darwin')
      seedProjects(['D:/A', 'D:/B', 'D:/C', 'D:/D'], {
        'D:/A': '2025-04-01T00:00:00',
        'D:/B': '2025-03-01T00:00:00',
        'D:/C': '2025-02-01T00:00:00',
        'D:/D': '2025-01-01T00:00:00'
      })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()

      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)
      expect(labelsOf(tray.setContextMenu.mock.calls[0][0] as MenuItem[])).toContain('A')
      expect(labelsOf(tray.setContextMenu.mock.calls[0][0] as MenuItem[])).not.toContain('D')
      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)

      seedProjects(['D:/D', 'D:/A', 'D:/B', 'D:/C'], {
        'D:/D': '2025-06-01T00:00:00',
        'D:/A': '2025-04-01T00:00:00',
        'D:/B': '2025-03-01T00:00:00',
        'D:/C': '2025-02-01T00:00:00'
      })
      s.interactiveProjects = [{ projectPath: 'D:/D' }]
      s.projectListeners.forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(250)

      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(2)
      const template = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      const d = projectItem(template, 'D')
      expect(d?.enabled).toBe(false)
      expect(d?.label).toContain('tray.running')
      expect(template.indexOf(d!)).toBeLessThan(template.findIndex((i) => i.label === 'A'))
    })

    it('库变更信号同样作废候选缓存', async () => {
      setPlatform('darwin')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()
      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)

      seedProjects(['D:/B', 'D:/A'], {
        'D:/B': '2025-05-01T00:00:00',
        'D:/A': '2025-01-01T00:00:00'
      })
      s.libraryListeners.forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(250)

      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(2)
      const template = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      expect(labelsOf(template)).toContain('B')
    })

    it('什么事件都不来：不轮询，名单不被定时重读', async () => {
      setPlatform('darwin')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()
      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)
      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)

      seedProjects(['D:/B', 'D:/A'], {
        'D:/B': '2025-05-01T00:00:00',
        'D:/A': '2025-01-01T00:00:00'
      })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)
      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)
    })

    it('等连接的标记到期自己退回可点：pending 的打开不排期', async () => {
      setPlatform('darwin')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })
      let resolveOpen!: (value: { success: boolean }) => void
      s.openFile = () => new Promise((res) => (resolveOpen = res))

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()

      const template0 = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      projectItem(template0, 'A')!.click!()
      await vi.advanceTimersByTimeAsync(250)
      const launching = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      const launchingItem = projectItem(launching, 'A')!
      expect(launchingItem.enabled).toBe(false)
      expect(launchingItem.label).toContain('tray.launching')

      await vi.advanceTimersByTimeAsync(LAUNCH_TTL_MS + 60_000)
      const pending = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      const pendingItem = projectItem(pending, 'A')!
      expect(pendingItem.enabled).toBe(false)
      expect(pendingItem.label).toContain('tray.launching')

      resolveOpen({ success: true })
      await vi.advanceTimersByTimeAsync(250)
      const waiting = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      expect(projectItem(waiting, 'A')!.label).toContain('tray.launching')

      await vi.advanceTimersByTimeAsync(LAUNCH_TTL_MS + 250)
      const reverted = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      expect(projectItem(reverted, 'A')!.enabled).not.toBe(false)
      expect(projectItem(reverted, 'A')!.label).not.toContain('tray.launching')
    })

    it('will-quit：在途的 build 不发布', async () => {
      setPlatform('darwin')
      let resolveList!: (value: Awaited<ReturnType<typeof s.listRecent>>) => void
      s.listRecent = () => new Promise((res) => (resolveList = res))

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)

      s.willQuitHandlers.forEach((cb) => cb())
      resolveList([])
      await flush()
      expect(tray.setContextMenu).not.toHaveBeenCalled()
    })

    it('will-quit：订阅摘掉、定时器停，落定路径全部不再到界面', async () => {
      setPlatform('darwin')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })
      s.openFile = async () => ({ success: true, pluginFailure: 'PLUGIN_FILES_MISSING' })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()
      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)
      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)
      const items = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]

      projectItem(items, 'A')!.click!()
      await flush()
      expect(s.notifications).toHaveLength(1)

      s.willQuitHandlers.forEach((cb) => cb())
      expect(s.projectListeners).toHaveLength(0)
      expect(s.libraryListeners).toHaveLength(0)

      s.languageListeners.forEach((cb) => cb())
      expect(tray.setToolTip).toHaveBeenCalledTimes(1)

      projectItem(items, 'A')!.click!()
      await flush()
      expect(s.notifications).toHaveLength(1)

      s.notifications[0].emit('click')
      s.notifications[0].emit('failed', {}, new Error('late'))
      expect(mocks.showMainWindow).not.toHaveBeenCalled()
      expect(takePending()).toBeNull()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)
      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)
    })

    it('语言变了：悬停提示当场重设，菜单防抖后重建', async () => {
      setPlatform('darwin')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()
      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)
      expect(tray.setToolTip).toHaveBeenCalledTimes(1)

      s.languageListeners.forEach((cb) => cb())
      expect(tray.setToolTip).toHaveBeenCalledTimes(2)
      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(250)
      expect(tray.setContextMenu).toHaveBeenCalledTimes(2)
    })

    it('界面报上来最近对话：防抖后重建，菜单里有这几条', async () => {
      setPlatform('darwin')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()
      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)

      s.ipcHandlers.get(TRAY_SET_RECENT_SESSIONS_CHANNEL)!({}, [
        { id: 's1', title: 'Chat one', updatedAt: '2025-05-01T00:00:00' }
      ])
      await vi.advanceTimersByTimeAsync(150)
      expect(tray.setContextMenu).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(100)
      expect(tray.setContextMenu).toHaveBeenCalledTimes(2)
      const template = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      expect(labelsOf(template)).toContain('Chat one')
    })
  })

  describe('菜单项接线', () => {
    async function darwinMenu(): Promise<{
      tray: ReturnType<typeof newTray>
      items: MenuItem[]
    }> {
      setPlatform('darwin')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })
      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()
      return { tray, items: tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[] }
    }

    it('点「新对话」：窗口叫到前台，动作进待取槽，取走即清', async () => {
      const { items } = await darwinMenu()

      items.find((item) => item.label === 'tray.newChat')!.click!()

      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(mocks.sendToWindow).toHaveBeenCalledTimes(1)
      expect(takePending()).toEqual({ type: 'new-session' })
      expect(takePending()).toBeNull()
    })

    it('点一条最近对话：待取槽里拿到 open-session', async () => {
      const { tray } = await darwinMenu()

      s.ipcHandlers.get(TRAY_SET_RECENT_SESSIONS_CHANNEL)!({}, [
        { id: 's1', title: 'Chat one', updatedAt: '2025-05-01T00:00:00' }
      ])
      await vi.advanceTimersByTimeAsync(250)
      const items = tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]

      items.find((item) => item.label === 'Chat one')!.click!()

      expect(takePending()).toEqual({ type: 'open-session', sessionId: 's1' })
    })

    it('点「打开虚幻盒子」：只把窗口叫到前台，不落动作', async () => {
      const { items } = await darwinMenu()

      items.find((item) => item.label === 'tray.open')!.click!()

      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(mocks.sendToWindow).not.toHaveBeenCalled()
      expect(takePending()).toBeNull()
    })
  })

  describe('win32 右键现建', () => {
    it('会话 / 语言 / 工程变化都不排定时器；右键时才现建，拿到的是新名单', async () => {
      setPlatform('win32')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      expect(s.trayHandlers.has('right-click')).toBe(true)

      s.projectListeners.forEach((cb) => cb())
      s.libraryListeners.forEach((cb) => cb())
      s.languageListeners.forEach((cb) => cb())
      s.ipcHandlers.get(TRAY_SET_RECENT_SESSIONS_CHANNEL)!({}, [
        { id: 's1', title: 'Chat one', updatedAt: '2025-05-01T00:00:00' }
      ])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(tray.setContextMenu).not.toHaveBeenCalled()
      expect(tray.popUpContextMenu).not.toHaveBeenCalled()
      expect(mocks.listRecentCalls).not.toHaveBeenCalled()
      expect(tray.setToolTip).toHaveBeenCalledTimes(2)

      seedProjects(['D:/B', 'D:/A'], {
        'D:/B': '2025-05-01T00:00:00',
        'D:/A': '2025-01-01T00:00:00'
      })
      s.trayHandlers.get('right-click')!()
      await flush()

      expect(tray.popUpContextMenu).toHaveBeenCalledTimes(1)
      const template = tray.popUpContextMenu.mock.calls[0][0] as MenuItem[]
      const labels = labelsOf(template)
      expect(labels).toContain('Chat one')
      expect(labels).toContain('B')
      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)
    })

    it('will-quit 之后右键不再弹菜单', async () => {
      setPlatform('win32')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      s.willQuitHandlers.forEach((cb) => cb())

      s.trayHandlers.get('right-click')!()
      await flush()
      expect(tray.popUpContextMenu).not.toHaveBeenCalled()
      expect(mocks.listRecentCalls).not.toHaveBeenCalled()
    })

    it('TTL 内工程起停：不作废名单缓存，下一次右键现算「运行中」', async () => {
      setPlatform('win32')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      s.trayHandlers.get('right-click')!()
      await flush()

      const idle = tray.popUpContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      expect(projectItem(idle, 'A')!.enabled).not.toBe(false)
      expect(projectItem(idle, 'A')!.label).not.toContain('tray.running')

      s.interactiveProjects = [{ projectPath: 'D:/A' }]
      await vi.advanceTimersByTimeAsync(1_000)
      s.trayHandlers.get('right-click')!()
      await flush()

      const running = tray.popUpContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      expect(projectItem(running, 'A')!.enabled).toBe(false)
      expect(projectItem(running, 'A')!.label).toContain('tray.running')

      s.interactiveProjects = []
      s.trayHandlers.get('right-click')!()
      await flush()

      const reverted = tray.popUpContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      expect(projectItem(reverted, 'A')!.enabled).not.toBe(false)
      expect(projectItem(reverted, 'A')!.label).not.toContain('tray.running')
      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)
      expect(tray.popUpContextMenu).toHaveBeenCalledTimes(3)
      expect(tray.setContextMenu).not.toHaveBeenCalled()
    })

    it('连点两下右键：只弹后一次建好的菜单', async () => {
      setPlatform('win32')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })
      let resolveList!: (value: Awaited<ReturnType<typeof s.listRecent>>) => void
      s.listRecent = () => new Promise((res) => (resolveList = res))

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)

      s.ipcHandlers.get(TRAY_SET_RECENT_SESSIONS_CHANNEL)!({}, [])
      s.trayHandlers.get('right-click')!()

      s.ipcHandlers.get(TRAY_SET_RECENT_SESSIONS_CHANNEL)!({}, [
        { id: 's2', title: 'Second', updatedAt: '2025-05-01T00:00:00' }
      ])
      s.trayHandlers.get('right-click')!()

      resolveList([
        {
          projectPath: 'D:/A/A.uproject',
          projectName: 'A',
          lastOpenTime: '2025-01-01T00:00:00',
          isImported: true
        }
      ])
      await flush()

      expect(tray.popUpContextMenu).toHaveBeenCalledTimes(1)
      const template = tray.popUpContextMenu.mock.calls[0][0] as MenuItem[]
      expect(labelsOf(template)).toContain('Second')
      expect(mocks.listRecentCalls).toHaveBeenCalledTimes(1)
    })
  })

  describe('通知落定', () => {
    async function openAndSettle(): Promise<void> {
      setPlatform('win32')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })
      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      s.trayHandlers.get('right-click')!()
      await flush()
      const items = tray.popUpContextMenu.mock.calls.at(-1)![0] as MenuItem[]
      projectItem(items, 'A')!.click!()
      await flush()
    }

    it('插件失败的系统通知弹不出来（failed）：动作照样送进待取槽', async () => {
      s.openFile = async () => ({ success: true, pluginFailure: 'PLUGIN_FILES_MISSING' })
      await openAndSettle()
      expect(s.notifications).toHaveLength(1)

      s.notifications[0].emit('failed', {}, new Error('native show failure'))
      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(mocks.sendToWindow).toHaveBeenCalledTimes(1)
      expect(takePending()).toEqual({
        type: 'plugin-failure',
        pluginFailure: 'PLUGIN_FILES_MISSING',
        originPath: 'D:/A/A.uproject',
        projectName: 'A'
      })
      expect(takePending()).toBeNull()
    })

    it('failed 之后又补一个迟到的 click：动作只落定一回', async () => {
      s.openFile = async () => ({ success: true, pluginFailure: 'PLUGIN_FILES_MISSING' })
      await openAndSettle()

      s.notifications[0].emit('failed', {}, new Error('native show failure'))
      s.notifications[0].emit('click')
      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(takePending()).toMatchObject({ type: 'plugin-failure' })
      expect(takePending()).toBeNull()
    })

    it('系统不支持通知：动作立即送到', async () => {
      s.notifSupported = false
      s.openFile = async () => ({ success: true, pluginFailure: 'PLUGIN_FILES_MISSING' })
      await openAndSettle()

      expect(s.notifications).toHaveLength(0)
      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(takePending()).toMatchObject({ type: 'plugin-failure' })
    })

    it('Notification 构造直接抛：动作照样送到', async () => {
      s.notifConstructorThrows = true
      s.openFile = async () => ({ success: true, pluginFailure: 'PLUGIN_FILES_MISSING' })
      await openAndSettle()

      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(takePending()).toMatchObject({ type: 'plugin-failure' })
    })

    it('show() 抛：照样落定，不重复', async () => {
      s.notifShowThrows = true
      s.openFile = async () => ({ success: true, pluginFailure: 'PLUGIN_FILES_MISSING' })
      await openAndSettle()

      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(takePending()).toMatchObject({ type: 'plugin-failure' })
    })

    it('普通打开失败：落定后叫起主窗口，原生错误对话框拿到标题和错误详情', async () => {
      s.notifSupported = false
      s.mainWindow = new FakeWindow()
      s.openFile = async () => ({ success: false, error: 'NO_FILE_ASSOCIATION' })
      await openAndSettle()

      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      const [parent, options] = mocks.dialogShow.mock.calls[0] as [
        unknown,
        { type: string; title: string; message: string; detail: string }
      ]
      expect(parent).toBe(s.mainWindow)
      expect(options.type).toBe('error')
      expect(options.title).toBe('tray.openFailedTitle')
      expect(options.message).toBe('tray.openFailedTitle')
      expect(options.detail).toContain('NO_FILE_ASSOCIATION')
      expect(takePending()).toBeNull()
    })

    it('主窗口已经没了：错误对话框无主弹，不炸', async () => {
      s.notifSupported = false
      s.openFile = async () => ({ success: false, error: 'NO_FILE_ASSOCIATION' })
      await openAndSettle()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      const [options] = mocks.dialogShow.mock.calls[0] as [{ type: string; title: string }]
      expect(options.type).toBe('error')
      expect(options.title).toBe('tray.openFailedTitle')
    })
  })

  describe('退出确认', () => {
    function quitItem(items: MenuItem[]): MenuItem {
      return items.find((item) => item.label === 'tray.quit')!
    }

    async function darwinMenu(): Promise<MenuItem[]> {
      setPlatform('darwin')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })
      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      await flush()
      return tray.setContextMenu.mock.calls.at(-1)![0] as MenuItem[]
    }

    it('没有会话操作：直接退，不拉窗口也不弹框', async () => {
      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      expect(mocks.dialogShow).not.toHaveBeenCalled()
      expect(mocks.showMainWindow).not.toHaveBeenCalled()
    })

    it('有会话操作：挂在可见主窗口上弹确认框，选项照翻', async () => {
      mocks.countActiveOperations.mockReturnValue(2)
      const window = new FakeWindow()
      s.mainWindow = window
      mocks.dialogShow.mockResolvedValue({ response: 1 })

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      const [parent, options] = mocks.dialogShow.mock.calls[0] as [unknown, Record<string, unknown>]
      expect(parent).toBe(window)
      expect(options).toMatchObject({
        type: 'warning',
        message: 'tray.quitConfirm:{"count":2}',
        buttons: ['tray.quitConfirmOk', 'tray.quitConfirmCancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(mocks.appQuit).not.toHaveBeenCalled()
    })

    it('按了「仍然退出」：退', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      s.mainWindow = new FakeWindow()
      mocks.dialogShow.mockResolvedValue({ response: 0 })

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })

    it('窗口藏进托盘：叫回来再弹框', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      const window = new FakeWindow()
      window.visible = false
      s.mainWindow = window
      mocks.showMainWindow.mockImplementation(() => {
        window.visible = true
      })
      mocks.dialogShow.mockResolvedValue({ response: 1 })

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow.mock.calls[0][0]).toBe(window)
      expect(mocks.appQuit).not.toHaveBeenCalled()
    })

    it('窗口没了、新建的还没 ready：等 ready-to-show 再拉起来弹框', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      const created = new FakeWindow()
      created.visible = false
      mocks.showMainWindow.mockImplementation(() => {
        s.mainWindow = created
      })
      mocks.dialogShow.mockResolvedValue({ response: 1 })

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow).not.toHaveBeenCalled()
      expect(created.show).not.toHaveBeenCalled()

      created.emit('ready-to-show')
      await flush()

      expect(created.show).toHaveBeenCalledTimes(1)
      expect(created.focus).toHaveBeenCalledTimes(1)
      expect(created.listenerCount('ready-to-show')).toBe(0)
      expect(created.listenerCount('closed')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(mocks.dialogShow.mock.calls[0][0]).toBe(created)
    })

    it('窗口销毁 / webContents 已死：改用独立确认框', async () => {
      for (const setup of [
        () => {
          s.mainWindow = new FakeWindow()
          s.mainWindow!.destroyed = true
        },
        () => {
          s.mainWindow = new FakeWindow()
          s.mainWindow!.webContentsDestroyed = true
        }
      ]) {
        vi.clearAllMocks()
        mocks.countActiveOperations.mockReturnValue(1)
        setup()

        const items = await darwinMenu()
        quitItem(items).click!()
        await flush()

        expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
        const [options] = mocks.dialogShow.mock.calls[0] as [{ message?: string }]
        expect(options.message).toContain('tray.quitConfirm')
        expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('改用独立确认框'))
        expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      }
    })

    it('拉旧窗口回来它还是藏着：改用独立确认框', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      const window = new FakeWindow()
      window.visible = false
      s.mainWindow = window

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.showMainWindow).toHaveBeenCalledTimes(1)
      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      const [options] = mocks.dialogShow.mock.calls[0] as [{ message?: string }]
      expect(options.message).toContain('tray.quitConfirm')
      expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('改用独立确认框'))
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })

    it('主窗口没了也建不回来：改用独立确认框', async () => {
      mocks.countActiveOperations.mockReturnValue(1)

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      const [options] = mocks.dialogShow.mock.calls[0] as [{ message?: string }]
      expect(options.message).toContain('tray.quitConfirm')
      expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('改用独立确认框'))
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })

    it('等 ready 期间窗口先关了：改用独立确认框，监听摘干净', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      const created = new FakeWindow()
      created.visible = false
      mocks.showMainWindow.mockImplementation(() => {
        s.mainWindow = created
      })

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      created.destroyed = true
      created.emit('closed')
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      const [options] = mocks.dialogShow.mock.calls[0] as [{ message?: string }]
      expect(options.message).toContain('tray.quitConfirm')
      expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('改用独立确认框'))
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      expect(created.listenerCount('ready-to-show')).toBe(0)
      expect(created.listenerCount('closed')).toBe(0)
    })

    it('等 ready 期间全局 before-quit：放弃等，不弹框不退出', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      const created = new FakeWindow()
      created.visible = false
      mocks.showMainWindow.mockImplementation(() => {
        s.mainWindow = created
      })

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      s.beforeQuitHandlers.forEach((cb) => cb())
      await flush()

      expect(mocks.dialogShow).not.toHaveBeenCalled()
      expect(mocks.appQuit).not.toHaveBeenCalled()
      expect(created.listenerCount('ready-to-show')).toBe(0)
      expect(created.listenerCount('closed')).toBe(0)
    })

    it('等 ready 一直不来：超时后改用独立确认框，监听和定时器摘干净，之后托盘「退出」还能用', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      const created = new FakeWindow()
      created.visible = false
      mocks.showMainWindow.mockImplementation(() => {
        s.mainWindow = created
      })

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      const [options] = mocks.dialogShow.mock.calls[0] as [{ message?: string }]
      expect(options.message).toContain('tray.quitConfirm')
      expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('等就绪超时'))
      expect(created.listenerCount('ready-to-show')).toBe(0)
      expect(created.listenerCount('closed')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)

      // 超时落定后看守已经放开：再点「退出」照常弹框
      vi.clearAllMocks()
      mocks.countActiveOperations.mockReturnValue(1)
      created.visible = true
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })

    it('原生框挂着时全局退出：abort 把在途框拒掉（取消落定）', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      s.mainWindow = new FakeWindow()
      let resolveDialog!: (value: { response: number }) => void
      mocks.dialogShow.mockImplementation(
        (...args: unknown[]) =>
          new Promise<{ response: number }>((resolve, reject) => {
            resolveDialog = resolve
            const options = args[1] as { signal: AbortSignal }
            options.signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
      )

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()
      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)

      s.beforeQuitHandlers.forEach((cb) => cb())
      await flush()

      resolveDialog({ response: 0 })
      await flush()
      expect(mocks.appQuit).not.toHaveBeenCalled()
    })

    it('原生框不吃 abort（全局退出开始后才按到「仍然退出」）：不再退第二次', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      s.mainWindow = new FakeWindow()
      let resolveDialog!: (value: { response: number }) => void
      let seenSignal: AbortSignal | undefined
      mocks.dialogShow.mockImplementation(
        (...args: unknown[]) =>
          new Promise<{ response: number }>((resolve) => {
            resolveDialog = resolve
            seenSignal = (args[1] as { signal: AbortSignal }).signal
          })
      )

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()
      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)

      s.beforeQuitHandlers.forEach((cb) => cb())
      expect(seenSignal?.aborted).toBe(true)

      resolveDialog({ response: 0 })
      await flush()
      expect(mocks.appQuit).not.toHaveBeenCalled()
    })

    it('原生框被全局退出中止后退出取消了：再点托盘「退出」拿到新的、未中止的信号，按「仍然退出」能退', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      s.mainWindow = new FakeWindow()

      const signals: AbortSignal[] = []
      mocks.dialogShow.mockImplementation((...args: unknown[]) => {
        const options = args.at(-1) as { signal: AbortSignal }
        signals.push(options.signal)
        // 模仿 Electron：框被中止信号关掉时按取消落定
        return new Promise<{ response: number }>((resolve) => {
          options.signal.addEventListener('abort', () => resolve({ response: 1 }))
        })
      })

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()
      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)

      // 全局退出把在途框收掉，但退出本身最后被取消了
      s.beforeQuitHandlers.forEach((cb) => cb())
      await flush()

      expect(mocks.appQuit).not.toHaveBeenCalled()
      expect(signals[0].aborted).toBe(true)

      mocks.dialogShow.mockImplementation((...args: unknown[]) => {
        const options = args.at(-1) as { signal: AbortSignal }
        signals.push(options.signal)
        return Promise.resolve({ response: 0 })
      })
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(2)
      expect(signals[1]).not.toBe(signals[0])
      expect(signals[1].aborted).toBe(false)
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })

    it('框弹着时再点退出：框只弹一次', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      s.mainWindow = new FakeWindow()
      let resolveDialog!: (value: { response: number }) => void
      mocks.dialogShow.mockImplementation(
        () => new Promise<{ response: number }>((resolve) => (resolveDialog = resolve))
      )

      const items = await darwinMenu()
      quitItem(items).click!()
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      resolveDialog({ response: 1 })
      await flush()
      expect(mocks.appQuit).not.toHaveBeenCalled()
    })

    it('独立确认框也弹不出来：记一笔，按用户意图直接退出', async () => {
      mocks.countActiveOperations.mockReturnValue(1)
      // 主窗口建不回来 → 退回独立框；独立框再拒 → confirmTrayQuit 记一笔直接退
      mocks.dialogShow.mockRejectedValue(new Error('native dialog gone'))

      const items = await darwinMenu()
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('改用独立确认框'))
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('直接退出'),
        expect.any(Error)
      )
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })

    it('退出被取消过（before-quit 时无框在途）：再点托盘「退出」照常弹框', async () => {
      const items = await darwinMenu()

      // 一次没走成的系统退出：当时没有确认框在途，不该毒化后来的退出
      s.beforeQuitHandlers.forEach((cb) => cb())

      mocks.countActiveOperations.mockReturnValue(1)
      s.mainWindow = new FakeWindow()
      quitItem(items).click!()
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      expect(mocks.appQuit).toHaveBeenCalledTimes(1) // 框默认回「仍然退出」

      vi.clearAllMocks()
      mocks.countActiveOperations.mockReturnValue(0)
      quitItem(items).click!()
      await flush()

      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      expect(mocks.dialogShow).not.toHaveBeenCalled()
    })

    it('win32 右键现建的菜单里点退出：有会话操作先弹框，按「仍然退出」才退', async () => {
      setPlatform('win32')
      seedProjects(['D:/A'], { 'D:/A': '2025-01-01T00:00:00' })
      mocks.countActiveOperations.mockReturnValue(1)
      const window = new FakeWindow()
      s.mainWindow = window
      mocks.dialogShow.mockResolvedValue({ response: 1 })

      const tray = newTray()
      startTrayMenuController(tray as never, hostDeps)
      s.trayHandlers.get('right-click')!()
      await flush()

      quitItem(tray.popUpContextMenu.mock.calls.at(-1)![0] as MenuItem[]).click!()
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(1)
      expect(mocks.dialogShow.mock.calls[0][0]).toBe(window)
      expect(mocks.appQuit).not.toHaveBeenCalled()

      mocks.dialogShow.mockResolvedValue({ response: 0 })
      s.trayHandlers.get('right-click')!()
      await flush()

      quitItem(tray.popUpContextMenu.mock.calls.at(-1)![0] as MenuItem[]).click!()
      await flush()

      expect(mocks.dialogShow).toHaveBeenCalledTimes(2)
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      expect(tray.setContextMenu).not.toHaveBeenCalled()
    })
  })
})
