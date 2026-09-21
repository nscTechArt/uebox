import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Service 的安全面。
 *
 * 这些用例盯的不是「功能能不能用」，而是几条**改坏了没人会发现、出事时代价很大**
 * 的性质：窗口的 webPreferences、权限一律拒绝、危险地址进不来、没批准前不创建
 * 窗口、输入不走抢焦点的那条 API。它们在真机上都要点开一个网页才验得了，
 * 所以必须在这里锁住。
 */

interface FakeContents {
  id: number
  handlers: Map<string, Array<(...args: unknown[]) => void>>
  windowOpenHandler?: (details: { url: string }) => { action: string }
  loadedUrls: string[]
  commands: Array<{ method: string; params: Record<string, unknown> }>
}

/** 页面（隔离世界）按顺序返回这些结果。测试在调用之前排好队 */
const pageResults: unknown[] = []
/**
 * 下一次 loadURL 会失败。
 *
 * 复刻真机顺序：`loadURL` **挂起**着先触发 `did-fail-load`，然后自己才 reject。
 * 那一个 tick 正是出事的地方 —— 等加载的 promise 在还没人 await 它的时候就 reject 了。
 */
let loadUrlFailure: { errorCode: number; description: string } | null = null
const created: Array<{ options: Record<string, unknown>; contents: FakeContents }> = []
const windowEvents = new Map<string, Array<(...args: unknown[]) => void>>()
/** 窗口是被 show() 还是 showInactive() 显示出来的 —— 差别在抢不抢焦点 */
const shown: string[] = []
const menus: unknown[] = []
const titles: string[] = []
const hosts: FakeBrowserWindow[] = []
let contentsId = 0
vi.mock('../../security', () => ({ protectRendererWindow: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const sessionStub = {
  permissionRequest: undefined as undefined | ((...args: unknown[]) => void),
  permissionCheck: undefined as undefined | (() => boolean),
  devicePermission: undefined as undefined | (() => boolean),
  bluetooth: undefined as undefined | ((details: unknown, cb: (r: unknown) => void) => void),
  events: new Map<string, Array<(...args: unknown[]) => void>>(),
  resolvedAddress: '93.184.216.34',
  cleared: [] as string[]
}

class FakeBrowserWindow {
  /**
   * 真机上 `window.webContents` 在窗口销毁之后**会抛**（"Object has been destroyed"）。
   * 假窗口原来照常返回对象，于是 `closed` 回调里读 id 的那种写法在用例里一路绿灯，
   * 在真机上却是一个主进程未捕获异常 —— 整个盒子跟着退出。这里照抄真实行为。
   */
  private contentsHandle: Record<string, unknown>
  get webContents(): Record<string, unknown> {
    if (this.destroyed) throw new TypeError('Object has been destroyed')
    return this.contentsHandle
  }
  private destroyed = false
  private visible = false

  options: Record<string, unknown>
  children: unknown[] = []
  contentView = {
    addChildView: (view: unknown): void => {
      this.children.push(view)
    },
    removeChildView: (view: unknown): void => {
      this.children = this.children.filter((item) => item !== view)
    }
  }
  loadURL = async (): Promise<void> => undefined
  loadFile = async (): Promise<void> => undefined
  hide = (): void => {
    this.visible = false
  }

  constructor(options: Record<string, unknown>) {
    this.options = options
    const contents: FakeContents = {
      id: ++contentsId,
      handlers: new Map(),
      loadedUrls: [],
      commands: []
    }

    const on = (event: string, handler: (...args: unknown[]) => void): void => {
      const list = contents.handlers.get(event) ?? []
      list.push(handler)
      contents.handlers.set(event, list)
    }

    this.contentsHandle = {
      id: contents.id,
      on,
      off: () => undefined,
      isDestroyed: () => this.destroyed,
      close: () => {
        this.destroyed = true
      },
      isLoading: () => false,
      getTitle: () => '示例',
      send: () => undefined,
      getURL: () => contents.loadedUrls.at(-1) ?? '',
      loadURL: async (url: string) => {
        contents.loadedUrls.push(url)
        if (!loadUrlFailure) return

        const failure = loadUrlFailure
        loadUrlFailure = null

        // 真机上这两件事**跨 tick**：`did-fail-load` 先到，`loadURL` 自己晚一步才
        // reject。跨不跨 tick 是关键 —— Node 在 tick 末尾才判定 unhandledRejection，
        // 挤在同一个 tick 里的话这个 bug 根本复现不出来（第一版用例就栽在这儿）。
        await new Promise((resolve) => setTimeout(resolve, 10))
        contents.handlers
          .get('did-fail-load')
          ?.forEach((handler) => handler({}, failure.errorCode, failure.description, url, true))
        await new Promise((resolve) => setTimeout(resolve, 10))
        throw new Error(`${failure.description} (${failure.errorCode}) loading '${url}'`)
      },
      reload: vi.fn(),
      stop: vi.fn(),
      navigationHistory: {
        canGoBack: () => true,
        canGoForward: () => false,
        goBack: () => undefined,
        goForward: () => undefined
      },
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
        contents.windowOpenHandler = handler
      },
      executeJavaScriptInIsolatedWorld: async () => pageResults.shift(),
      capturePage: async () => ({ toPNG: () => Buffer.from('png') }),
      debugger: {
        isAttached: () => true,
        attach: () => undefined,
        detach: () => undefined,
        on: () => undefined,
        sendCommand: async (method: string, params: Record<string, unknown>) => {
          contents.commands.push({ method, params })
        }
      }
    }

    if ((options.webPreferences as Record<string, unknown>)?.preload) hosts.push(this)
    else created.push({ options, contents })
  }

  on = (event: string, handler: (...args: unknown[]) => void): void => {
    const list = windowEvents.get(event) ?? []
    list.push(handler)
    windowEvents.set(event, list)
  }
  isDestroyed = (): boolean => this.destroyed
  isVisible = (): boolean => this.visible
  show = (): void => {
    this.visible = true
    shown.push('show')
  }
  showInactive = (): void => {
    this.visible = true
    shown.push('showInactive')
  }
  setMenu = (menu: unknown): void => {
    menus.push(menu)
  }
  setTitle = (title: string): void => {
    titles.push(title)
  }
  destroy = (): void => {
    this.destroyed = true
  }
  getContentSize = (): number[] => [1280, 820]
}

/** 嵌入模式：挂在主窗口上的那层视图 */
class FakeWebContentsView {
  webContents: Record<string, unknown>
  bounds: Record<string, number> | null = null
  visible: boolean | null = null

  constructor(options: Record<string, unknown>) {
    const host = new FakeBrowserWindow(options)
    this.webContents = host.webContents
    views.push(this)
  }

  setBounds = (bounds: Record<string, number>): void => {
    this.bounds = bounds
  }
  setVisible = (visible: boolean): void => {
    this.visible = visible
  }
}

const views: FakeWebContentsView[] = []
/** 主窗口的 contentView 上挂了哪些子视图 */
const attachedViews: unknown[] = []

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: (handler: (...args: unknown[]) => void) => {
        sessionStub.permissionRequest = handler
      },
      setPermissionCheckHandler: (handler: () => boolean) => {
        sessionStub.permissionCheck = handler
      },
      setDevicePermissionHandler: (handler: () => boolean) => {
        sessionStub.devicePermission = handler
      },
      setBluetoothPairingHandler: (handler: (d: unknown, cb: (r: unknown) => void) => void) => {
        sessionStub.bluetooth = handler
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        const list = sessionStub.events.get(event) ?? []
        list.push(handler)
        sessionStub.events.set(event, list)
      },
      resolveHost: async () => ({
        endpoints: [{ address: sessionStub.resolvedAddress, family: 'ipv4' }]
      }),
      clearStorageData: async () => {
        sessionStub.cleared.push('storage')
      },
      clearCache: async () => {
        sessionStub.cleared.push('cache')
      },
      clearAuthCache: async () => {
        sessionStub.cleared.push('auth')
      }
    })
  }
}))

vi.mock('../logger', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
}))

/** 「这不是盒子的窗口」登记表的调用记录 */
const registry = { registered: [] as number[], unregistered: [] as number[] }

vi.mock('../../appWindows', () => ({
  registerNonAppWindow: (id: number) => registry.registered.push(id),
  unregisterNonAppWindow: (id: number) => registry.unregistered.push(id),
  sendToAppWindows: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
  findMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { id: 9999 },
    contentView: {
      addChildView: (view: unknown) => attachedViews.push(view),
      removeChildView: (view: unknown) => {
        const index = attachedViews.indexOf(view)
        if (index >= 0) attachedViews.splice(index, 1)
      }
    }
  })
}))

/** 推给界面的状态事件 */
const broadcasts: Array<{ channel: string; payload: unknown }> = []

/** 设置里当前选的显示方式 */
const settings = { mode: 'window' as 'window' | 'embedded' | 'hidden' }

vi.mock('../../appSettingsManager', () => ({
  appSettingsManager: {
    getAgentBrowserMode: () => settings.mode
  }
}))

const savedUrls = new Map<string, string>()
const savedGroups = new Map<
  string,
  { urls: string[]; activeIndex: number; mode?: 'embedded' | 'window' | 'hidden' }
>()
vi.mock('./sessionState', () => ({
  loadBrowserGroup: vi.fn(
    async (id: string) =>
      savedGroups.get(id) ??
      (savedUrls.has(id) ? { urls: [savedUrls.get(id)], activeIndex: 0 } : undefined)
  ),
  saveBrowserGroup: vi.fn(async (id: string, state: { urls: string[]; activeIndex: number }) => {
    savedGroups.set(id, state)
    savedUrls.set(id, state.urls[state.activeIndex])
  }),
  saveBrowserUrl: vi.fn(async (id: string, url: string | null) => {
    if (url === null) {
      savedUrls.delete(id)
      savedGroups.delete(id)
    } else savedUrls.set(id, url)
  })
}))

const { AgentBrowserService, AgentBrowserError } = await import('./index')

type Service = InstanceType<typeof AgentBrowserService>

const SCAN_OK = {
  ok: true,
  data: { title: '示例', url: 'https://example.com/', elements: [], hasIframe: false }
}

/**
 * 跑完一个会等定时器的调用。
 *
 * Service 在 `did-stop-loading` 之后留了 750ms 静默期给 SPA 渲染，交互后还有
 * 300ms 缓冲。用假时钟推过去，比让每个用例真等一秒快得多。
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  // 先接住结果再推时钟：直接 `await advance(...)` 再返回 promise 的话，
  // 推时钟期间的失败没有人接，vitest 会报成 unhandled rejection
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  await vi.advanceTimersByTimeAsync(2000)

  const result = await settled
  if (result.ok) return result.value
  throw result.error
}

function openPage(instance: Service, url = 'https://example.com/'): Promise<unknown> {
  pageResults.push(SCAN_OK)
  return settle(instance.open(url))
}

function lastContents(): FakeContents {
  return created[created.length - 1].contents
}

beforeEach(() => {
  hosts.length = 0
  savedGroups.clear()
  savedUrls.clear()
  vi.useFakeTimers()
  created.length = 0
  pageResults.length = 0
  loadUrlFailure = null
  windowEvents.clear()
  sessionStub.events.clear()
  sessionStub.cleared.length = 0
  sessionStub.resolvedAddress = '93.184.216.34'
  registry.registered.length = 0
  registry.unregistered.length = 0
  shown.length = 0
  menus.length = 0
  titles.length = 0
  views.length = 0
  attachedViews.length = 0
  broadcasts.length = 0
  settings.mode = 'window'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('按需创建', () => {
  it('没人调用时不创建窗口 —— 社区版承诺冷启动零网络', () => {
    new AgentBrowserService()

    expect(created).toHaveLength(0)
  })

  it('没打开过就读页面，明确告诉模型先 browser_open', async () => {
    await expect(new AgentBrowserService().readInteractive()).rejects.toMatchObject({
      code: 'BROWSER_NOT_OPEN'
    })
    expect(created).toHaveLength(0)
  })

  it('URL 被拒时不创建窗口', async () => {
    await expect(new AgentBrowserService().open('http://127.0.0.1:8766/')).rejects.toMatchObject({
      code: 'NAVIGATION_BLOCKED'
    })
    expect(created).toHaveLength(0)
  })
})

describe('窗口与 Session 安全', () => {
  let instance: Service

  beforeEach(async () => {
    instance = new AgentBrowserService()
    await openPage(instance)
  })

  it('远程页面拿不到 Node、preload 和 webview', () => {
    const prefs = created[0].options.webPreferences as Record<string, unknown>

    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.sandbox).toBe(true)
    expect(prefs.webSecurity).toBe(true)
    expect(prefs.allowRunningInsecureContent).toBe(false)
    expect(prefs.webviewTag).toBe(false)
    expect(prefs.preload).toBeUndefined()
  })

  it('所有网页权限一律拒绝', () => {
    const granted = vi.fn()
    sessionStub.permissionRequest?.({}, 'media', granted)

    expect(granted).toHaveBeenCalledWith(false)
    expect(sessionStub.permissionCheck?.()).toBe(false)
    expect(sessionStub.devicePermission?.()).toBe(false)
  })

  it('蓝牙配对和设备选择器也挡住 —— 光设权限 handler 挡不住选择流程', () => {
    const reply = vi.fn()
    sessionStub.bluetooth?.({}, reply)

    expect(reply).toHaveBeenCalledWith({ confirmed: false })
    for (const event of ['select-usb-device', 'select-serial-port', 'select-hid-device']) {
      expect(sessionStub.events.has(event)).toBe(true)
    }
  })

  it('下载一律取消', () => {
    const event = { preventDefault: vi.fn() }
    sessionStub.events.get('will-download')?.[0]?.(event)

    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('弹窗一律 deny，自定义协议更是', async () => {
    const handler = lastContents().windowOpenHandler

    pageResults.push(SCAN_OK)
    expect(handler?.({ url: 'https://example.com/popup' }).action).toBe('deny')
    expect(handler?.({ url: 'uebox://notebook/import/x' }).action).toBe('deny')
    await vi.advanceTimersByTimeAsync(2000)
    expect(instance.groupState().tabs).toHaveLength(2)
  })

  it('导航到危险地址被拦下，普通网址放行', () => {
    const navigate = lastContents().handlers.get('will-navigate')?.[0]

    const blocked = { preventDefault: vi.fn() }
    navigate?.(blocked, 'file:///C:/Windows/win.ini')
    expect(blocked.preventDefault).toHaveBeenCalled()

    const allowed = { preventDefault: vi.fn() }
    navigate?.(allowed, 'https://www.electronjs.org/docs')
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })

  it('重定向走同一套判据 —— 少接一个入口就能被一次跳转带进内网', () => {
    const redirect = lastContents().handlers.get('will-redirect')?.[0]
    const event = { preventDefault: vi.fn() }

    redirect?.(event, 'http://169.254.169.254/latest/meta-data/')

    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('用户可以随时接管：窗口是可见的真窗口', () => {
    expect(instance.hasWindow()).toBe(true)
    expect(hosts[0].options.show).toBe(false)
  })

  /**
   * 窗口要出现，但不能抢前台。
   *
   * 这和「输入不走 sendInputEvent」是同一件事的两半：用户可能正在 UE 里打字，
   * 而一轮里 agent 可能连开好几个页面 —— 每开一个就把焦点抢走一次，
   * 那是没法一边干活一边看着它的。
   */
  it('用 showInactive 显示，不抢用户的前台焦点', () => {
    expect(shown).toEqual(['showInactive'])
  })

  it('去掉默认菜单栏：那上面的开发者工具会把 CDP 抢走', () => {
    // macOS 是全局菜单，没有 per-window 菜单可去
    if (process.platform === 'darwin') return
    expect(menus).toEqual([null])
  })

  /**
   * 标题里永远有我们的名字。
   *
   * 默认行为是页面想叫什么就叫什么 —— 那意味着一个网页可以把标题写成
   * 「虚幻盒子 · 请输入授权码」，而用户看到的窗口长得像盒子自己的。
   */
  it('页面标题被钉上前缀，页面改不掉', () => {
    const updated = lastContents().handlers.get('page-title-updated')?.[0]
    const event = { preventDefault: vi.fn() }

    updated?.(event, '虚幻盒子 · 请输入授权码')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(hosts[0].options.title).toBe('Unreal Box · Agent 浏览器')
    expect(titles).toEqual([])
  })
})

describe('DNS 预检', () => {
  it('域名解析到内网时拒绝，且不创建窗口', async () => {
    sessionStub.resolvedAddress = '10.1.2.3'

    await expect(
      settle(new AgentBrowserService().open('https://internal.example.com/'))
    ).rejects.toMatchObject({ code: 'NAVIGATION_BLOCKED' })
    expect(created).toHaveLength(0)
  })
})

describe('串行化', () => {
  it('第二个调用直接拒绝而不是排队 —— 排队会在被别人改过的页面上执行', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)

    pageResults.push(SCAN_OK)
    const first = instance.readInteractive()
    await expect(instance.readInteractive()).rejects.toMatchObject({ code: 'BROWSER_BUSY' })

    await first
  })
})

describe('正文分页', () => {
  const html = `<html><body><article><p>${'字'.repeat(500)}</p></article></body></html>`

  it('按 offset 切片，读到头时 nextOffset 为 null', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)

    pageResults.push({ ok: true, data: { html, url: 'https://example.com/' } })
    const first = await instance.readContent({ offset: 0, maxChars: 100 })

    expect(first.content).toHaveLength(100)
    expect(first.nextOffset).toBe(100)
    expect(first.totalChars).toBeGreaterThan(100)

    pageResults.push({ ok: true, data: { html, url: 'https://example.com/' } })
    const rest = await instance.readContent({ offset: 100, maxChars: 12_000 })

    expect(rest.nextOffset).toBeNull()
    expect(rest.offset + rest.content.length).toBe(rest.totalChars)
  })

  it('提取不到正文时给 CONTENT_EMPTY，让模型改用快照或截图', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)

    pageResults.push({
      ok: true,
      data: { html: '<html><body><div id="root"></div></body></html>', url: 'https://example.com/' }
    })

    await expect(instance.readContent({ offset: 0, maxChars: 100 })).rejects.toMatchObject({
      code: 'CONTENT_EMPTY'
    })
  })
})

describe('交互', () => {
  it('点击走 CDP 的坐标派发，不用要抢焦点的 sendInputEvent', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)

    pageResults.push({ ok: true, data: { x: 12, y: 34, label: '下一页' } }, SCAN_OK)
    const result = await settle(instance.interact({ action: 'click', ref: 1, label: '下一页' }))

    const commands = lastContents().commands
    expect(commands.map((c) => c.method)).toContain('Input.dispatchMouseEvent')
    expect(commands.some((c) => c.params.x === 12 && c.params.y === 34)).toBe(true)
    expect(result.label).toBe('下一页')
  })

  it('输入走 Input.insertText', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)

    pageResults.push({ ok: true, data: { label: '搜索' } }, SCAN_OK)
    await settle(instance.interact({ action: 'type', ref: 1, label: '搜索', value: '材质' }))

    const insert = lastContents().commands.find((c) => c.method === 'Input.insertText')
    expect(insert?.params.text).toBe('材质')
  })

  it('debugger 没附上时说清楚是开发者工具占着，而不是回退去抢焦点', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)
    ;(instance as unknown as { debuggerAttached: boolean }).debuggerAttached = false

    pageResults.push({ ok: true, data: { x: 1, y: 1, label: '确定' } })

    await expect(
      settle(instance.interact({ action: 'click', ref: 1, label: '确定' }))
    ).rejects.toMatchObject({ code: 'INTERACTION_UNAVAILABLE' })
  })

  it('页面侧的拒绝（遮挡、失效、敏感字段）原样透出', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)

    pageResults.push({
      ok: false,
      code: 'PAGE_CHANGED',
      message: '该位置被其他元素遮挡（接受所有 Cookie），没有点击。'
    })

    const failure = settle(instance.interact({ action: 'click', ref: 1, label: '下一页' }))
    await expect(failure).rejects.toBeInstanceOf(AgentBrowserError)
    await expect(failure).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    // 没有任何输入被派发出去
    expect(lastContents().commands).toEqual([])
  })
})

/**
 * 加载失败的时序。
 *
 * 2026-09-04 真机上，Agent 浏览器打开一个连不上的站点（ERR_CONNECTION_CLOSED），
 * **整个应用退出了** —— 因为加载失败的 promise 比 await 它的那行代码早了一个 tick，
 * Node 判成 unhandledRejection，而主进程把它当致命信号。
 *
 * 这一组锁的就是那个时序：失败要变成一个正常的 reject 交给调用方，
 * 中途不许漏出 unhandledRejection。
 */
describe('加载失败', () => {
  it('页面打不开时抛给调用方，而不是漏出 unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', capture)

    try {
      loadUrlFailure = { errorCode: -100, description: 'ERR_CONNECTION_CLOSED' }

      const instance = new AgentBrowserService()
      const settled = instance.open('https://example.com/').then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      )
      await vi.advanceTimersByTimeAsync(2000)
      const result = await settled

      // 调用方拿到的是一个正常的失败
      expect(result.ok).toBe(false)
      expect((result as { error: { code?: string } }).error.code).toBe('PAGE_LOAD_FAILED')

      // 中途一次都不许漏出去 —— 漏一次，主进程就把整个应用关了。
      // unhandledRejection 是在真实的 tick 末尾判定的，假计时器推不动它，
      // 所以这里换回真计时器让事件循环真的转一圈
      vi.useRealTimers()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', capture)
    }
  })
})

describe('生命周期', () => {
  it('用户关掉窗口后引用被清理，下次调用回到 BROWSER_NOT_OPEN', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)
    expect(instance.hasWindow()).toBe(true)

    windowEvents.get('closed')?.forEach((handler) => handler())

    expect(instance.hasWindow()).toBe(false)
    await expect(instance.readInteractive()).rejects.toMatchObject({ code: 'BROWSER_NOT_OPEN' })
  })

  /**
   * 真机上 `closed` 回调跑的时候窗口**已经销毁**了，这时候读 `window.webContents`
   * 会抛。抛在 Electron 的事件派发里就是主进程未捕获异常 —— 用户看到的是
   * 「关掉独立浏览器窗口，整个盒子跟着没了」；而且 `close()` 没跑完，磁盘上还留着
   * 这个会话的地址，下次打开窗口又回来了。
   */
  it('窗口销毁后再收到 closed：不抛，且记录照样清掉', async () => {
    const instance = new AgentBrowserService('crash')
    await openPage(instance)
    expect(savedUrls.get('crash')).toBe('https://example.com/')

    hosts.at(-1)?.destroy()
    expect(() => windowEvents.get('closed')?.forEach((handler) => handler())).not.toThrow()
    await settle(Promise.resolve())

    expect(instance.hasWindow()).toBe(false)
    expect(savedUrls.has('crash')).toBe(false)
  })

  it('resetSession 连认证缓存一起清 —— 只清 storage 会留下自动认证', async () => {
    const instance = new AgentBrowserService()
    pageResults.push(SCAN_OK)

    await settle(instance.open('https://example.com/', { resetSession: true }))

    expect(sessionStub.cleared).toEqual(['storage', 'cache', 'auth'])
  })

  it('dispose 销毁窗口，退出时不留下进程', async () => {
    const instance = new AgentBrowserService()
    await openPage(instance)

    instance.dispose()

    expect(instance.hasWindow()).toBe(false)
  })

  /**
   * 窗口没了就要从「非界面窗口」登记表里注销。
   *
   * 留着不清的后果很隐蔽：`appWindows.ts` 按 `webContents.id` 记，将来某个 id
   * 相同的 webContents 会被误判成远程页面 —— 表现是主窗口收不到广播、深链接
   * 找不到主窗口，而且极难查到这里。
   */
  it.each([
    ['用户关掉窗口', (): void => windowEvents.get('closed')?.forEach((handler) => handler())],
    ['dispose', null]
  ])('%s 之后从窗口登记表里注销', async (_label, close) => {
    const instance = new AgentBrowserService()
    await openPage(instance)
    const id = created[0].contents.id
    expect(registry.registered).toContain(id)

    if (close) close()
    else instance.dispose()

    expect(registry.unregistered).toContain(id)
  })
})

/**
 * 三档显示方式。
 *
 * 共用同一套 Session、策略、CDP 和页面脚本，差别只有「这块 webContents 摆在
 * 什么容器里」—— 所以这里盯的是容器对不对，以及**安全设置有没有跟着走**。
 */
describe('显示方式', () => {
  it('独立窗口：出现，但不抢焦点', async () => {
    settings.mode = 'window'
    const instance = new AgentBrowserService()

    await openPage(instance)

    expect(shown).toEqual(['showInactive'])
    expect(attachedViews).toHaveLength(0)
  })

  it('隐藏：窗口照建，但一次都不显示', async () => {
    settings.mode = 'hidden'
    const instance = new AgentBrowserService()

    await openPage(instance)

    // 窗口还是真窗口（capturePage 和 CDP 都要它），只是不露面
    expect(created).toHaveLength(1)
    expect(shown).toEqual([])
    expect(instance.hasWindow()).toBe(true)
  })

  it('嵌入：挂到主窗口上，不另开窗口', async () => {
    settings.mode = 'embedded'
    const instance = new AgentBrowserService()

    await openPage(instance)

    expect(attachedViews).toHaveLength(1)
    expect(shown).toEqual([])
    // 没有独立窗口，所以它不该被任何「找主窗口」的逻辑当成候选
    expect(instance.isAgentBrowserWindow({ isDestroyed: () => false } as never)).toBe(false)
  })

  it('三档共用同一份安全设置 —— 换容器不该换一套 webPreferences', async () => {
    const prefsOf = async (
      mode: 'window' | 'embedded' | 'hidden'
    ): Promise<Record<string, unknown>> => {
      created.length = 0
      settings.mode = mode
      await openPage(new AgentBrowserService())
      return created[0].options.webPreferences as Record<string, unknown>
    }

    for (const mode of ['window', 'embedded', 'hidden'] as const) {
      const prefs = await prefsOf(mode)
      expect(prefs.nodeIntegration, mode).toBe(false)
      expect(prefs.contextIsolation, mode).toBe(true)
      expect(prefs.sandbox, mode).toBe(true)
      expect(prefs.webSecurity, mode).toBe(true)
      expect(prefs.preload, mode).toBeUndefined()
    }
  })

  it('嵌入模式按界面报来的位置摆放，报 null 就藏起来', async () => {
    settings.mode = 'embedded'
    const instance = new AgentBrowserService()
    instance.setEmbeddedBounds({ x: 700, y: 64, width: 600, height: 800 })

    await openPage(instance)

    expect(views[0].bounds).toEqual({ x: 700, y: 64, width: 600, height: 800 })
    expect(views[0].visible).toBe(true)

    // 切到别的页面：那层网页浮在界面之上，不藏起来会盖住别人
    instance.setEmbeddedBounds(null)
    expect(views[0].visible).toBe(false)
  })

  it('改显示方式移动原页面，保留页面实例', async () => {
    settings.mode = 'window'
    const instance = new AgentBrowserService()
    await openPage(instance)
    expect(instance.hasWindow()).toBe(true)

    settings.mode = 'embedded'
    const contents = lastContents()
    instance.applyModeChange()

    expect(instance.hasWindow()).toBe(true)
    expect(lastContents()).toBe(contents)
    expect(instance.currentMode()).toBe('embedded')
    expect(attachedViews).toHaveLength(1)
  })

  it('嵌入模式下摘掉视图，不把它留在主窗口上', async () => {
    settings.mode = 'embedded'
    const instance = new AgentBrowserService()
    await openPage(instance)

    instance.close()

    expect(attachedViews).toHaveLength(0)
  })

  it('开关状态推给界面，面板据此决定要不要占位', async () => {
    settings.mode = 'embedded'
    const instance = new AgentBrowserService()
    await openPage(instance)

    expect(broadcasts.at(-1)).toMatchObject({
      channel: 'agent-browser:state',
      payload: { open: true, mode: 'embedded' }
    })

    instance.close()
    expect(broadcasts.at(-1)?.payload).toMatchObject({ open: false })
  })
})

describe('会话页面恢复', () => {
  it('重新进入复用现有页面，进程重建后按保存的网址恢复', async () => {
    const first = new AgentBrowserService('persistent')
    await openPage(first)
    await first.restore()
    expect(created).toHaveLength(1)
    first.dispose()
    expect(savedUrls.get('persistent')).toBe('https://example.com/')
    const second = new AgentBrowserService('persistent')
    pageResults.push(SCAN_OK)
    await settle(second.restore())
    expect(lastContents().loadedUrls).toEqual(['https://example.com/'])
    expect(second.hasWindow()).toBe(true)
    expect(broadcasts.at(-1)?.payload).toMatchObject({ sessionId: 'persistent', open: true })
    second.dispose()
  })

  it('用户导航更新记录，主动关闭后重进不恢复', async () => {
    const instance = new AgentBrowserService('closed')
    await openPage(instance)
    lastContents().loadedUrls.push('https://example.com/#next')
    lastContents()
      .handlers.get('did-navigate-in-page')
      ?.forEach((handler) => {
        handler({}, 'https://example.com/#next', true)
      })
    await Promise.resolve()
    expect(savedUrls.get('closed')).toBe('https://example.com/#next')
    expect(broadcasts.at(-1)?.payload).toMatchObject({
      sessionId: 'closed',
      url: 'https://example.com/#next'
    })
    await instance.close()
    await instance.restore()
    expect(savedUrls.has('closed')).toBe(false)
    expect(instance.hasWindow()).toBe(false)
    expect(created).toHaveLength(1)
  })

  it('切换会话的隐藏消息只影响所属视图', async () => {
    settings.mode = 'embedded'
    const a = new AgentBrowserService('a')
    const b = new AgentBrowserService('b')
    await openPage(a)
    await openPage(b)
    a.setEmbeddedBounds({ x: 0, y: 0, width: 400, height: 600 })
    b.setEmbeddedBounds({ x: 0, y: 0, width: 400, height: 600 })
    a.setEmbeddedBounds(null)
    expect(views[0].visible).toBe(false)
    expect(views[1].visible).toBe(true)
    await a.close()
    expect(b.hasWindow()).toBe(true)
    a.dispose()
    b.dispose()
  })

  it('恢复失败保留记录，下次进入可以重试', async () => {
    savedUrls.set('offline', 'https://example.com/')
    const instance = new AgentBrowserService('offline')
    loadUrlFailure = { errorCode: -105, description: 'ERR_NAME_NOT_RESOLVED' }
    await expect(settle(instance.restore())).rejects.toThrow()
    expect(savedUrls.get('offline')).toBe('https://example.com/')
    expect(instance.hasWindow()).toBe(false)
    pageResults.push(SCAN_OK)
    await settle(instance.restore())
    expect(instance.hasWindow()).toBe(true)
    instance.dispose()
  })

  it('没有保存记录时不会创建窗口，读取记录期间关闭也不会重新打开', async () => {
    const instance = new AgentBrowserService('none')
    await instance.restore()
    expect(created).toHaveLength(0)
    savedUrls.set('none', 'https://example.com/')
    const pending = instance.restore()
    await instance.close()
    await pending
    expect(created).toHaveLength(0)
  })
})

it('多个会话共享 Cookie partition 时只安装一次 Session 安全策略', async () => {
  const { session } = await import('electron')
  const shared = session.fromPartition('test')
  const fromPartition = vi.spyOn(session, 'fromPartition').mockReturnValue(shared)
  const a = new AgentBrowserService('shared-a')
  const b = new AgentBrowserService('shared-b')
  try {
    await openPage(a)
    await openPage(b)
    expect(sessionStub.events.get('will-download')).toHaveLength(1)
    expect(sessionStub.events.get('select-usb-device')).toHaveLength(1)
  } finally {
    a.dispose()
    b.dispose()
    fromPartition.mockRestore()
  }
})

it('原生工具栏导航尊重历史边界，刷新和停止无需等待页面扫描', async () => {
  settings.mode = 'embedded'
  const instance = new AgentBrowserService('toolbar')
  await openPage(instance)
  const contents = views[0].webContents as unknown as import('electron').WebContents
  const history = contents.navigationHistory
  const back = vi.spyOn(history, 'goBack')
  const forward = vi.spyOn(history, 'goForward')
  instance.toolbar('back')
  instance.toolbar('forward')
  expect(back).toHaveBeenCalledOnce()
  expect(forward).not.toHaveBeenCalled()
  vi.spyOn(history, 'canGoBack').mockReturnValue(false)
  vi.spyOn(history, 'canGoForward').mockReturnValue(true)
  vi.spyOn(contents, 'isLoading').mockReturnValue(true)
  instance.toolbar('forward')
  instance.toolbar('reload')
  expect(forward).toHaveBeenCalledOnce()
  expect(contents.reload).toHaveBeenCalledOnce()
  expect(instance.navigationState()).toEqual({
    canGoBack: false,
    canGoForward: true,
    loading: true
  })
  instance.toolbar('stop')
  expect(contents.stop).toHaveBeenCalledOnce()
  vi.spyOn(contents, 'isLoading').mockReturnValue(false)
  lastContents()
    .handlers.get('did-stop-loading')
    ?.forEach((handler) => handler())
  expect(broadcasts.at(-1)?.payload).toMatchObject({
    sessionId: 'toolbar',
    navigation: { loading: false }
  })
  instance.dispose()
  expect(instance.navigationState()).toEqual({
    canGoBack: false,
    canGoForward: false,
    loading: false
  })
  expect(() => instance.toolbar('reload')).toThrow()
})

describe('会话 Tab 组', () => {
  it('多个 Tab 共用一个窗口，整组来回切换保留内容和选中项', async () => {
    const instance = new AgentBrowserService('tabs')
    await openPage(instance)
    const first = instance.groupState().activeTabId!
    pageResults.push(SCAN_OK)
    await settle(instance.openInNewTab('https://example.org/'))
    expect(hosts).toHaveLength(1)
    expect(instance.groupState().tabs).toHaveLength(2)
    instance.selectTab(first)
    instance.setEmbeddedBounds({ x: 0, y: 80, width: 600, height: 500 })
    expect(views.map((view) => view.visible)).toEqual([true, false])
    const originalContents = views.map((view) => view.webContents)
    instance.setMode('embedded')
    expect(attachedViews).toHaveLength(2)
    expect(hosts[0].isDestroyed()).toBe(true)
    instance.setEmbeddedBounds({ x: 500, y: 80, width: 600, height: 500 }, 9999)
    expect(views[0].visible).toBe(true)
    instance.setMode('window')
    expect(attachedViews).toHaveLength(0)
    expect(hosts[1].children).toHaveLength(2)
    instance.setEmbeddedBounds(
      { x: 0, y: 80, width: 600, height: 500 },
      hosts[1].webContents.id as number
    )
    instance.setEmbeddedBounds(null, 9999)
    expect(views[0].visible).toBe(true)
    expect(instance.groupState().activeTabId).toBe(first)
    expect(views.map((view) => view.webContents)).toEqual(originalContents)
    expect(created.map((entry) => entry.contents.loadedUrls)).toEqual([
      ['https://example.com/'],
      ['https://example.org/']
    ])
    await instance.close()
    expect(views.every((view) => (view.webContents.isDestroyed as () => boolean)())).toBe(true)
  })

  it('关闭后台标签保留当前选择，未知标签不会影响页面，最后一个关闭才收起窗口', async () => {
    const instance = new AgentBrowserService('close-tabs')
    instance.createTab()
    const first = instance.groupState().activeTabId!
    instance.createTab()
    const second = instance.groupState().activeTabId!
    instance.createTab()
    const third = instance.groupState().activeTabId!
    instance.selectTab(first)
    await instance.closeTab(second)
    expect(instance.groupState().activeTabId).toBe(first)
    expect(() => instance.selectTab('missing')).toThrow()
    await instance.closeTab(third)
    expect(instance.hasWindow()).toBe(true)
    await instance.closeTab(first)
    expect(instance.hasWindow()).toBe(false)
    expect(hosts[0].isDestroyed()).toBe(true)
  })

  it('危险网址不会新增标签，加载过程中不会被切换到另一页', async () => {
    const instance = new AgentBrowserService('busy-tabs')
    await openPage(instance)
    const id = instance.groupState().activeTabId!
    await expect(instance.openInNewTab('file:///private')).rejects.toThrow()
    expect(instance.groupState().tabs).toHaveLength(1)
    pageResults.push(SCAN_OK)
    const pending = instance.openInNewTab('https://example.org/')
    expect(() => instance.selectTab(id)).toThrow()
    await settle(pending)
    expect(instance.groupState().tabs).toHaveLength(2)
    await instance.close()
  })
})

it('重建会话恢复整组地址和选中项，恢复过程中关闭不会复活', async () => {
  settings.mode = 'embedded'
  const first = new AgentBrowserService('restore-group')
  await openPage(first)
  const selected = first.groupState().activeTabId!
  pageResults.push(SCAN_OK)
  await settle(first.openInNewTab('https://example.org/'))
  first.selectTab(selected)
  await Promise.resolve()
  await Promise.resolve()
  first.dispose()
  const second = new AgentBrowserService('restore-group')
  pageResults.push(SCAN_OK, SCAN_OK)
  await settle(second.restore())
  expect(second.groupState().tabs.map((tab) => tab.url)).toEqual([
    'https://example.com/',
    'https://example.org/'
  ])
  expect(second.currentUrl()).toBe('https://example.com/')
  second.dispose()
  const third = new AgentBrowserService('restore-group')
  const restoring = third.restore()
  await third.close()
  await restoring
  expect(third.hasWindow()).toBe(false)
  expect(savedGroups.has('restore-group')).toBe(false)
})
