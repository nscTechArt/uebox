import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { protectRendererWindow } from '../../security'
import type {
  BrowserGroupState,
  BrowserNavigationState,
  BrowserToolbarAction
} from '../../../shared/agentBrowser'
import { BrowserWindow, session, WebContentsView, type Session, type WebContents } from 'electron'

import { appSettingsManager, type AgentBrowserMode } from '../../appSettingsManager'
import {
  findMainWindow,
  registerNonAppWindow,
  sendToAppWindows,
  sendToWindow,
  unregisterNonAppWindow
} from '../../appWindows'
import { getSharp } from '../../utils/sharpLoader'
import { logger } from '../logger'
import { extractWebContentFromHtml } from './extract'
import {
  AGENT_BROWSER_WORLD_ID,
  buildPageAgentScript,
  formatSnapshot,
  type PageAgentCommand,
  type PageAgentResult,
  type PageScanResult
} from './pageScan'
import { checkNavigationUrl, checkResolvedAddresses } from './urlPolicy'
import { loadBrowserGroup, saveBrowserGroup, saveBrowserUrl } from './sessionState'

/**
 * Agent 浏览器。
 *
 * 一个用户看得见、随时能自己接管的 Chromium 窗口，由主进程独占管理；
 * Agent 只能通过 `browser_*` 六个工具碰它，拿不到任意 JavaScript 执行能力。
 *
 * 设计与取舍。几条最容易被后来者改错的：
 *
 * 1. **窗口按需创建**。社区版承诺冷启动完全离线，所以在用户批准第一次
 *    `browser_open` 之前，这里不创建窗口、不发任何请求。
 * 2. **输入不抢焦点**。`webContents.sendInputEvent()` 要求窗口获得焦点
 *    （Electron 官方文档明写），那会打断用户正在 UE 里的操作 —— 所以走
 *    `webContents.debugger` 的 CDP Input 域，它不需要前台焦点。
 * 3. **点击前校验命中**。坐标上盖着什么由页面说了算，不校验就会出现
 *    「审批说点 A、实际点了 Cookie 横幅」。校验在 `pageScan.ts` 里。
 * 4. **远程页面不配 preload**，也不给任何自定义协议。
 */

const PARTITION = 'persist:unreal-box-agent-browser'
const securedSessions = new WeakSet<Session>()

/** 窗口标题前缀。页面改不掉它，见 `installWindowPolicy` 里的说明 */
const BROWSER_WINDOW_TITLE = 'Unreal Box · Agent 浏览器'

/** 顶层导航硬超时。超过就把当前状态交还给用户，不无限等 */
const LOAD_TIMEOUT_MS = 30_000

/** `did-stop-loading` 之后的静默期，给 SPA 完成首屏渲染 */
const LOAD_SETTLE_MS = 750

/** 正文提取上限。比单次读取大得多 —— 分页要靠它才准 */
const CONTENT_EXTRACT_MAX_CHARS = 400_000

const SCREENSHOT_MAX_WIDTH = 768
const SCREENSHOT_JPEG_QUALITY = 65

/** 压缩后仍超过这个体积就不塞进上下文。经验值，与 UE 截图工具一致的量级 */
const SCREENSHOT_MAX_BYTES = 180_000

/** 加载被主动取消。重定向和用户中途点链接都会走到这里，不是错误 */
const ERR_ABORTED = -3

export type BrowserErrorCode =
  | 'BROWSER_NOT_OPEN'
  | 'BROWSER_BUSY'
  | 'NAVIGATION_BLOCKED'
  | 'PAGE_LOAD_TIMEOUT'
  | 'PAGE_LOAD_FAILED'
  | 'PAGE_CHANGED'
  | 'INTERACTION_UNAVAILABLE'
  | 'UNSUPPORTED_ELEMENT'
  | 'SENSITIVE_FIELD'
  | 'CONTENT_EMPTY'
  | 'SCREENSHOT_TOO_LARGE'

/**
 * 工具层认这个错误。
 *
 * 错误码是给模型看的「下一步该干什么」，所以每个码都对应一条明确的应对方式
 * （见设计文档 §13）。文案里绝不能带 Cookie、认证头或用户输入。
 */
export class AgentBrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentBrowserError'
  }
}

export interface BrowserPageOverview {
  title: string
  url: string
  snapshot: string
  hasIframe: boolean
}

export interface BrowserContentResult {
  title: string
  url: string
  content: string
  offset: number
  nextOffset: number | null
  totalChars: number
}

export interface BrowserScreenshot {
  data: Buffer
  mimeType: 'image/jpeg'
  bytes: number
}

export type BrowserNavigateAction =
  | { action: 'back' | 'forward' | 'reload' }
  | { action: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { action: 'follow'; ref: number }

export type BrowserInteractAction =
  | { action: 'click'; ref: number; label: string }
  | { action: 'type'; ref: number; label: string; value: string }
  | { action: 'select'; ref: number; label: string; value: string }

/**
 * debugger 附没附上。
 *
 * `contents.debugger` 在 contents 销毁之后会抛，而「当前页面换人」这件事
 * 恰好会在销毁之后发生（关窗、页面自关）。销毁了就是没附上。
 */
function debuggerAttachedOn(contents: WebContents | undefined): boolean {
  if (!contents || contents.isDestroyed()) return false
  return contents.debugger.isAttached()
}

/**
 * 页面挂在哪儿。
 *
 * 三档显示方式共用同一套 Session、策略、CDP 和页面脚本，差别只有「这块
 * webContents 摆在什么容器里」—— 所以抽的是容器，不是三份实现。
 */
interface BrowserSurface {
  id: string
  mode: AgentBrowserMode
  contents: WebContents
  /**
   * 创建时记下的 `webContents.id`。
   *
   * 注意别把这条和窗口那条搞混：**`BrowserWindow.webContents` 销毁之后再读会抛**
   * （`ensureGroupWindow` 里缓存 id 就是为了这个），但 `webContents.id` 本身不会 ——
   * 它是创建时钉在实例上的自有属性。这里存一份纯粹是图个稳，注销时不必再穿过
   * 一层可能已经没了的对象。
   */
  contentsId: number
  /** 独立窗口 / 隐藏模式下的宿主窗口 */
  window: BrowserWindow | null
  /** 远程页面始终使用视图，可在主窗口与组窗口之间移动 */
  view: WebContentsView | null
}

/** 嵌入模式下渲染层报上来的位置。单位是主窗口内容区的 DIP */
export interface EmbeddedBounds {
  x: number
  y: number
  width: number
  height: number
}

export class AgentBrowserService {
  private surface: BrowserSurface | null = null
  private tabs = new Map<string, BrowserSurface>()
  private groupWindow: BrowserWindow | null = null
  /**
   * 组窗口的 `webContents.id`，建窗口时钉下来。
   *
   * 销毁之后再穿 `window.webContents` 会抛，而注销登记恰好都发生在销毁前后 ——
   * 抛在 Electron 的事件派发里就是主进程整个退出（同 `ensureGroupWindow` 里
   * `closed` 回调那段注释）。存一份就不用再赌读的时候它还在。
   */
  private groupWindowContentsId: number | null = null
  private mode: AgentBrowserMode | null = null
  private browserSession: Session | null = null
  private debuggerAttached = false
  private busy = false
  private embeddedBounds: EmbeddedBounds | null = null
  private embeddedVisible = false
  private persistence: Promise<void> = Promise.resolve()
  private restoring: Promise<void> | null = null
  private restoreGeneration = 0

  constructor(readonly sessionId?: string) {}

  private persistUrl(url: string | null): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId || (this.restoring && url !== null)) return Promise.resolve()
    const surfaces = [...this.tabs.values()]
    const state = {
      urls: surfaces.map(
        (surface) =>
          (surface.contents.isDestroyed() ? '' : surface.contents.getURL()) || 'about:blank'
      ),
      activeIndex: Math.max(0, surfaces.indexOf(this.surface!)),
      mode: this.currentMode()
    }
    const write = this.persistence.then(() =>
      url === null ? saveBrowserUrl(sessionId, null) : saveBrowserGroup(sessionId, state)
    )
    this.persistence = write.catch((error: unknown) => {
      logger.warn(`[AgentBrowser] 保存会话浏览器状态失败：${String(error)}`)
    })
    return write
  }

  /** 仅在用户进入会话时恢复；冷启动不创建窗口或加载远程页面。 */
  async restore(): Promise<void> {
    if (!this.sessionId || this.hasWindow() || this.busy) return
    if (this.restoring) return this.restoring
    const sessionId = this.sessionId
    const generation = this.restoreGeneration
    this.restoring = (async () => {
      await this.persistence
      const saved = await loadBrowserGroup(sessionId)
      if (!saved || this.hasWindow() || this.busy || generation !== this.restoreGeneration) return
      try {
        if (saved.mode) this.mode = saved.mode
        for (const url of saved.urls) {
          if (generation !== this.restoreGeneration) return
          this.createTab()
          if (url !== 'about:blank') await this.open(url)
        }
        const active = [...this.tabs.keys()][saved.activeIndex]
        if (active) this.selectTab(active)
      } catch (error) {
        if (generation !== this.restoreGeneration) return
        // 网络失败保留磁盘记录，让下次进入会话还能重试。
        this.detachDebugger()
        while (this.surface) this.releaseSurface({ destroy: true })
        this.notifyState()
        throw error
      }
    })().finally(() => {
      this.restoring = null
    })
    return this.restoring
  }

  /**
   * 这个窗口是不是 Agent 浏览器。
   *
   * 只比对实例，不按尺寸/标题/URL 猜 —— 用户可以把浏览器窗口拉到任意大小，
   * 任何基于尺寸的启发式迟早会把它当成主窗口（`index.ts` 的深链接查找就是
   * 这么写的，所以那里必须改成走 `appWindows.ts`）。
   *
   * 嵌入模式没有自己的窗口，这里恒为 false —— 那时候页面就挂在主窗口上，
   * 主窗口本来就该被当成主窗口。
   */
  isAgentBrowserWindow(candidate: BrowserWindow): boolean {
    if (
      !this.sessionId &&
      [...sessionBrowsers.values()].some((browser) => browser.isAgentBrowserWindow(candidate))
    )
      return true
    const window = this.surface?.window
    return Boolean(window && !window.isDestroyed() && candidate === window)
  }

  hasWindow(): boolean {
    return this.surface !== null && !this.surface.contents.isDestroyed()
  }

  /**
   * 没窗口、没在忙、也没有正在跑的恢复 —— 这个实例除了占位什么都不做，
   * 可以直接从表里丢掉。磁盘上的地址记录不受影响，下次进来照样恢复。
   */
  isIdle(): boolean {
    return !this.hasWindow() && !this.busy && this.restoring === null
  }

  navigationState(): BrowserNavigationState {
    const contents = this.surface?.contents
    if (!contents || contents.isDestroyed()) {
      return { canGoBack: false, canGoForward: false, loading: false }
    }
    return {
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading()
    }
  }

  /** 用户直接操作原生导航，不等待页面扫描；加载中也能立即停止。 */
  toolbar(action: BrowserToolbarAction): void {
    const contents = this.requireContents()
    const history = contents.navigationHistory
    switch (action) {
      case 'back':
        if (history.canGoBack()) history.goBack()
        break
      case 'forward':
        if (history.canGoForward()) history.goForward()
        break
      case 'reload':
        contents.reload()
        break
      case 'stop':
        contents.stop()
        break
    }
    this.notifyState()
  }

  currentUrl(): string {
    const contents = this.surface?.contents
    return contents && !contents.isDestroyed() ? contents.getURL() : ''
  }

  /** 当前用的是哪一档显示方式。没开着时按设置里的值回答 */
  currentMode(): AgentBrowserMode {
    return this.mode ?? this.surface?.mode ?? appSettingsManager.getAgentBrowserMode()
  }

  /** 应用退出时调用。窗口不销毁的话进程退不干净 */
  dispose(): void {
    if (!this.sessionId) for (const browser of sessionBrowsers.values()) browser.dispose()
    this.restoreGeneration++
    this.detachDebugger()
    while (this.surface) this.releaseSurface({ destroy: true })
  }

  /**
   * 关掉当前页面。
   *
   * 嵌入模式下用户点面板上的「关闭」走这条；独立窗口模式他直接关窗口就行。
   */
  close(): Promise<void> {
    this.restoreGeneration++
    this.detachDebugger()
    while (this.surface) this.releaseSurface({ destroy: true })
    this.notifyState()
    return this.persistUrl(null)
  }

  /**
   * 松开当前容器。
   *
   * **登记表一定要注销。** `appWindows.ts` 按 `webContents.id` 记「这不是盒子的
   * 窗口」，留着不清的话，将来某个 id 相同的 webContents 会被误判成远程页面 ——
   * 表现是主窗口收不到广播、深链接找不到主窗口，而且极难查。
   */
  private releaseSurface(options: { destroy?: boolean } = {}): void {
    const surface = this.surface
    this.surface = null
    this.debuggerAttached = false
    if (!surface) return
    // 拆干净这件事只写一份（见 `dropSurface`）。上一版在这儿抄了一遍，
    // 而两份已经漂了：那一份把注销登记关在 `if (surface.view)` 里，
    // 于是没有 view 的 surface 会在登记表里留一条永远清不掉的记录
    this.dropSurface(surface, options)
    this.surface = [...this.tabs.values()].at(-1) ?? null
    this.debuggerAttached = debuggerAttachedOn(this.surface?.contents)
    if (!this.surface) this.destroyGroupWindow()
    this.applyEmbeddedBounds()
  }

  private destroyGroupWindow(): void {
    const window = this.groupWindow
    const contentsId = this.groupWindowContentsId
    this.groupWindow = null
    this.groupWindowContentsId = null
    // 注销用存下来的 id，不现读 `window.webContents` —— 窗口和它的 webContents
    // 是两个独立的销毁标记，只查前一个的话销毁中途那一小段照样抛，
    // 而这个方法是从 `contents.on('destroyed')` 里调进来的：抛在那儿主进程就没了
    if (contentsId !== null) unregisterNonAppWindow(contentsId)
    if (window && !window.isDestroyed()) window.destroy()
  }

  groupState(): BrowserGroupState {
    return {
      activeTabId: this.surface?.id ?? null,
      // 页面自己 `window.close()` 之后 `contents` 就销毁了，而它还在表里
      // （`destroyed` 回调把它摘掉之前）。销毁之后 `getURL()` 这些一律抛，
      // 而这个方法是从 Electron 的事件派发里调进来的 —— 抛在那儿就是主进程退出。
      tabs: [...this.tabs.values()].map(({ id, contents }) =>
        contents.isDestroyed()
          ? { id, url: '', title: '', loading: false }
          : {
              id,
              url: contents.getURL(),
              title: contents.getTitle(),
              loading: contents.isLoading()
            }
      )
    }
  }

  createTab(): void {
    if (this.busy) throw new AgentBrowserError('BROWSER_BUSY', '浏览器正在操作，请稍后重试')
    if (this.tabs.size >= 100) throw new AgentBrowserError('BROWSER_BUSY', '标签页数量已达到上限')
    const previous = this.surface
    this.surface = null
    try {
      this.ensureSurface()
    } catch (error) {
      this.surface = previous
      throw error
    }
    this.applyEmbeddedBounds()
    if (this.currentMode() === 'window') this.groupWindow?.showInactive()
    void this.persistUrl('about:blank').catch(() => undefined)
    this.notifyState()
  }

  selectTab(tabId: string): void {
    if (this.busy) throw new AgentBrowserError('BROWSER_BUSY', '浏览器正在操作，请稍后重试')
    const surface = this.tabs.get(tabId)
    if (!surface) throw new AgentBrowserError('BROWSER_NOT_OPEN', '标签页已关闭')
    this.surface = surface
    this.debuggerAttached = debuggerAttachedOn(surface.contents)
    void this.persistUrl(this.currentUrl() || 'about:blank').catch(() => undefined)
    this.applyEmbeddedBounds()
    this.notifyState()
  }

  async closeTab(tabId: string): Promise<void> {
    const previous = this.surface?.id
    this.selectTab(tabId)
    this.detachDebugger()
    this.releaseSurface({ destroy: true })
    if (previous && previous !== tabId && this.tabs.has(previous)) this.selectTab(previous)
    await this.persistUrl(this.hasWindow() ? this.currentUrl() || 'about:blank' : null)
    this.notifyState()
  }

  /** 移动已有的视图，保留 DOM、历史、滚动位置和正在填写的内容。 */
  setMode(mode: AgentBrowserMode): void {
    if (mode === this.currentMode()) return
    if (!this.hasWindow()) {
      this.mode = mode
      return
    }
    const main = findMainWindow()
    if (mode === 'embedded' && !main) {
      throw new AgentBrowserError('BROWSER_NOT_OPEN', '找不到主窗口')
    }
    const oldHost = this.groupWindow ?? main
    this.mode = mode
    const host = mode === 'embedded' ? main : this.ensureGroupWindow()
    for (const surface of this.tabs.values()) {
      if (surface.view) {
        oldHost?.contentView.removeChildView(surface.view)
        host?.contentView.addChildView(surface.view)
      }
      surface.mode = mode
      surface.window = mode === 'embedded' ? null : this.groupWindow
    }
    if (mode === 'embedded') this.destroyGroupWindow()
    this.embeddedBounds = null
    this.embeddedVisible = false
    this.applyEmbeddedBounds()
    if (mode === 'window') this.groupWindow?.showInactive()
    else if (mode === 'hidden') this.groupWindow?.hide()
    void this.persistUrl(this.hasWindow() ? this.currentUrl() || 'about:blank' : null).catch(
      () => undefined
    )
    this.notifyState()
  }

  applyModeChange(): void {
    if (!this.sessionId) for (const browser of sessionBrowsers.values()) browser.applyModeChange()
    this.setMode(appSettingsManager.getAgentBrowserMode())
  }

  async openInNewTab(url: string): Promise<BrowserPageOverview> {
    return this.open(url, { newTab: true })
  }

  async open(
    url: string,
    options: { resetSession?: boolean; newTab?: boolean } = {}
  ): Promise<BrowserPageOverview> {
    return this.exclusive(async () => {
      const generation = this.restoreGeneration
      const target = this.validateUrl(url)

      if (options.resetSession) await this.resetSession()
      await this.assertPublicHost(target)

      if (generation !== this.restoreGeneration)
        throw new AgentBrowserError('BROWSER_NOT_OPEN', '浏览器已关闭')
      const previous = this.surface
      if (options.newTab) {
        if (this.tabs.size >= 100)
          throw new AgentBrowserError('BROWSER_BUSY', '标签页数量已达到上限')
        this.surface = null
      }
      let surface: BrowserSurface
      try {
        surface = this.ensureSurface()
      } catch (error) {
        this.surface = previous
        throw error
      }
      await this.loadAndWait(surface.contents, target.toString())
      this.reveal(surface)

      const overview = await this.overview()
      if (generation !== this.restoreGeneration)
        throw new AgentBrowserError('BROWSER_NOT_OPEN', '浏览器已关闭')
      await this.persistUrl(overview.url)
      this.notifyState(overview)
      return overview
    })
  }

  /**
   * 让页面露出来。
   *
   * `showInactive()` 而不是 `show()`：窗口要出现（用户得看得见 agent 在哪个
   * 页面上操作），但不该把前台焦点抢过去 —— 抢焦点和 §7.4 拒绝用
   * `sendInputEvent` 是同一件事的两半，一轮里可能连开好几个页面。
   *
   * `hidden` 档什么都不做：那一档就是要它不出现。
   */
  private reveal(surface: BrowserSurface): void {
    if (
      surface.mode === 'window' &&
      surface.window &&
      !surface.window.isDestroyed() &&
      !surface.window.isVisible()
    ) {
      surface.window.showInactive()
    }
    if (surface.mode === 'embedded') this.applyEmbeddedBounds()
  }

  async readContent(input: { offset: number; maxChars: number }): Promise<BrowserContentResult> {
    return this.exclusive(async () => {
      const page = (await this.runPageAgent({ kind: 'html' })) as { html: string; url: string }
      const extracted = await extractWebContentFromHtml(page.html, page.url, {
        maxChars: CONTENT_EXTRACT_MAX_CHARS
      })

      if (!extracted.success || !extracted.content) {
        throw new AgentBrowserError(
          'CONTENT_EMPTY',
          '这个页面提取不到可读正文，可以改用交互快照或截图看看。'
        )
      }

      const total = extracted.content.length
      const offset = Math.min(Math.max(input.offset, 0), total)
      const slice = extracted.content.slice(offset, offset + input.maxChars)
      const end = offset + slice.length

      return {
        title: extracted.title ?? '',
        url: page.url,
        content: slice,
        offset,
        nextOffset: end < total ? end : null,
        totalChars: total
      }
    })
  }

  async readInteractive(): Promise<BrowserPageOverview> {
    return this.exclusive(() => this.overview())
  }

  async navigate(input: BrowserNavigateAction): Promise<BrowserPageOverview> {
    return this.exclusive(async () => {
      const contents = this.requireContents()

      if (input.action === 'scroll') {
        const amount = input.amount ?? this.viewportHeight()
        await this.runPageAgent({
          kind: 'scroll',
          direction: input.direction,
          amount: Math.min(Math.max(amount, 100), 5000)
        })
        return this.overview()
      }

      if (input.action === 'follow') {
        const link = (await this.runPageAgent({ kind: 'linkHref', ref: input.ref })) as {
          href: string
        }
        const target = this.validateUrl(link.href)
        await this.assertPublicHost(target)
        await this.loadAndWait(contents, target.toString())
        return this.overview()
      }

      const history = contents.navigationHistory
      if (input.action === 'back') {
        if (!history.canGoBack()) {
          throw new AgentBrowserError('UNSUPPORTED_ELEMENT', '已经是最早一页，无法后退。')
        }
        const wait = this.waitForLoad(contents)
        history.goBack()
        await wait
      } else if (input.action === 'forward') {
        if (!history.canGoForward()) {
          throw new AgentBrowserError('UNSUPPORTED_ELEMENT', '已经是最新一页，无法前进。')
        }
        const wait = this.waitForLoad(contents)
        history.goForward()
        await wait
      } else {
        const wait = this.waitForLoad(contents)
        contents.reload()
        await wait
      }

      return this.overview()
    })
  }

  /**
   * 点击、输入、选择。
   *
   * 三件事都先在页面里做一遍校验（ref 还在不在、标签对不对得上、是不是敏感
   * 字段、点击位置有没有被遮挡），过了才动手。校验逻辑在隔离世界里跑，
   * 真正的输入走 CDP。
   */
  async interact(
    input: BrowserInteractAction
  ): Promise<{ overview: BrowserPageOverview; label: string }> {
    return this.exclusive(async () => {
      const contents = this.requireContents()

      if (input.action === 'select') {
        const result = (await this.runPageAgent({
          kind: 'select',
          ref: input.ref,
          label: input.label,
          value: input.value
        })) as { label: string }
        return { overview: await this.overview(), label: result.label }
      }

      if (input.action === 'click') {
        const point = (await this.runPageAgent({
          kind: 'prepareClick',
          ref: input.ref,
          label: input.label
        })) as { x: number; y: number; label: string }

        await this.dispatchClick(contents, point.x, point.y)
        await this.settleAfterInteraction(contents)
        return { overview: await this.overview(), label: point.label }
      }

      const prepared = (await this.runPageAgent({
        kind: 'prepareType',
        ref: input.ref,
        label: input.label
      })) as { label: string }

      await this.sendCommand(contents, 'Input.insertText', { text: input.value })
      await this.settleAfterInteraction(contents)
      return { overview: await this.overview(), label: prepared.label }
    })
  }

  async screenshot(): Promise<BrowserScreenshot> {
    return this.exclusive(async () => {
      const contents = this.requireContents()
      const image = await contents.capturePage()

      const sharp = await getSharp()
      const jpeg = await sharp(image.toPNG())
        .resize({ width: SCREENSHOT_MAX_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: SCREENSHOT_JPEG_QUALITY })
        .toBuffer()

      if (jpeg.byteLength > SCREENSHOT_MAX_BYTES) {
        throw new AgentBrowserError(
          'SCREENSHOT_TOO_LARGE',
          '这张截图压缩后仍然太大，没有发给模型。可以先滚动到关心的区域再截。'
        )
      }

      return { data: jpeg, mimeType: 'image/jpeg', bytes: jpeg.byteLength }
    })
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  /**
   * 一次只让一个调用碰页面。
   *
   * 工具已经声明了 `sequential`，但那只管同一批工具调用；两条会话各自跑到
   * 浏览器工具时仍会撞上。撞上就直接拒绝而不是排队 —— 排队会让第二个调用
   * 在一个已经被别人改过的页面上执行，ref 早就不是它看到的那份了。
   */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new AgentBrowserError('BROWSER_BUSY', '浏览器正在执行上一个操作，请稍后重试。')
    }
    this.busy = true
    try {
      return await work()
    } finally {
      this.busy = false
    }
  }

  private validateUrl(raw: string): URL {
    const checked = checkNavigationUrl(raw)
    if (!checked.ok) {
      throw new AgentBrowserError('NAVIGATION_BLOCKED', checked.reason)
    }
    return checked.url
  }

  private requireContents(): WebContents {
    if (!this.surface || this.surface.contents.isDestroyed()) {
      throw new AgentBrowserError('BROWSER_NOT_OPEN', '浏览器还没有打开，请先用 browser_open。')
    }
    return this.surface.contents
  }

  /** 滚动一屏是多高。嵌入模式没有窗口可问，用渲染层报上来的面板高度 */
  private viewportHeight(): number {
    const surface = this.surface
    if (surface?.window && !surface.window.isDestroyed()) return surface.window.getContentSize()[1]
    return this.embeddedBounds?.height ?? 820
  }

  private getSession(): Session {
    if (!this.browserSession) {
      this.browserSession = session.fromPartition(PARTITION)
    }
    if (!securedSessions.has(this.browserSession)) {
      this.installSessionPolicy(this.browserSession)
      securedSessions.add(this.browserSession)
    }
    return this.browserSession
  }

  /**
   * Session 级安全策略。
   *
   * 全部返回拒绝，不做白名单 —— 这个浏览器的用途是读网页和点普通按钮，
   * 摄像头、剪贴板、USB 一个都用不上，而其中任何一个被网页拿到都是真伤害。
   *
   * `openExternal` 要单独强调：不挡住它，页面可以跳 `uebox://`，
   * 那会被盒子自己的深链接处理器接走，等于让远程页面触发本地流程。
   */
  private installSessionPolicy(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setBluetoothPairingHandler((_details, callback) => {
      callback({ confirmed: false })
    })

    // 设备选择器不走 permission handler，要单独挡
    const denyDevice = (event: { preventDefault: () => void }, callback: unknown): void => {
      event.preventDefault()
      if (typeof callback === 'function') callback('')
    }
    browserSession.on(
      'select-usb-device' as never,
      ((event: { preventDefault: () => void }, _details: unknown, callback: unknown) =>
        denyDevice(event, callback)) as never
    )
    browserSession.on(
      'select-serial-port' as never,
      ((event: { preventDefault: () => void }, _ports: unknown, _wc: unknown, callback: unknown) =>
        denyDevice(event, callback)) as never
    )
    browserSession.on(
      'select-hid-device' as never,
      ((event: { preventDefault: () => void }, _details: unknown, callback: unknown) =>
        denyDevice(event, callback)) as never
    )

    // 这一版不做下载：没有保存路径 UI，也没有对下载内容的任何检查
    browserSession.on('will-download', (event) => {
      event.preventDefault()
    })
  }

  /**
   * 远程页面的 webPreferences。
   *
   * 三档显示方式共用同一份 —— 换个容器不该换一套安全设置，那正是这种代码
   * 最容易出事的地方（有人给新容器抄了一份，少抄一行 sandbox）。
   */
  private webPreferences(): Electron.WebPreferences {
    return {
      session: this.getSession(),
      // 远程页面不给 preload，也不给 Node —— 它拿到的应该和普通浏览器一样多
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // 后台窗口被节流的话，Agent 在用户切走之后读到的会是一个停住的页面。
      // 隐藏和嵌入两档更依赖这条
      backgroundThrottling: false
    }
  }

  private ensureSurface(): BrowserSurface {
    if (this.surface && !this.surface.contents.isDestroyed()) return this.surface
    // 当前 surface 已经死了：先摘掉再建新的，否则它会永远留在 `this.tabs` 里，
    // 把后面每一次 `groupState()` / `persistUrl()` 都变成一次主进程退出。
    //
    // **摘完要连引用一起断。** 下面几步都可能抛（找不到主窗口就直接 throw），
    // 抛出去时 `this.surface` 还指着一条已经不在 `this.tabs` 里的 surface ——
    // 之后 `groupState()` 报的 `activeTabId` 在它自己给的 tabs 列表里找不到，
    // `persistUrl` 的 `indexOf` 回 -1 被夹成 0，而 `debuggerAttached` 停在死值上
    if (this.surface) {
      this.dropSurface(this.surface)
      this.surface = null
      this.debuggerAttached = false
    }

    const mode = this.currentMode()
    const host = mode === 'embedded' ? findMainWindow() : this.ensureGroupWindow()
    if (!host) throw new AgentBrowserError('BROWSER_NOT_OPEN', '找不到主窗口')
    const view = new WebContentsView({ webPreferences: this.webPreferences() })
    view.setVisible(false)
    host.contentView.addChildView(view)
    const surface: BrowserSurface = {
      id: randomUUID(),
      mode,
      view,
      contents: view.webContents,
      contentsId: view.webContents.id,
      window: mode === 'embedded' ? null : this.groupWindow
    }
    this.installContentsPolicy(surface)
    this.attachDebugger(surface.contents)
    registerNonAppWindow(surface.contentsId)
    this.tabs.set(surface.id, surface)
    this.surface = surface
    this.applyEmbeddedBounds()
    return surface
  }

  private ensureGroupWindow(): BrowserWindow {
    if (this.groupWindow && !this.groupWindow.isDestroyed()) return this.groupWindow
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 820,
      title: BROWSER_WINDOW_TITLE,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    })
    this.groupWindow = window
    /*
     * 先把 id 存下来。窗口销毁之后 `window.webContents` 会抛
     * （"Object has been destroyed"），而下面的 `closed` 回调正是在那之后跑的 ——
     * 在那里现读 id 会把异常扔进 Electron 的事件派发，主进程未捕获，整个盒子退出；
     * 更糟的是 `close()` 也就没跑，磁盘上还留着这个会话的浏览器地址，
     * 下次打开又给恢复出来。
     */
    const windowContentsId = window.webContents.id
    this.groupWindowContentsId = windowContentsId
    registerNonAppWindow(windowContentsId)
    if (process.platform !== 'darwin') window.setMenu(null)
    const rendererFile = join(__dirname, '../renderer/index.html')
    const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    protectRendererWindow(window, rendererFile, devUrl)
    const hash = `/agent-browser?sessionId=${encodeURIComponent(this.sessionId ?? '')}`
    const loaded = devUrl
      ? window.loadURL(`${devUrl}/#${hash}`)
      : window.loadFile(rendererFile, { hash })
    void loaded.catch((error: unknown) =>
      logger.warn(`[AgentBrowser] 窗口加载失败：${String(error)}`)
    )
    window.on('closed', () => {
      if (this.groupWindow !== window) return
      this.groupWindow = null
      this.groupWindowContentsId = null
      unregisterNonAppWindow(windowContentsId)
      void this.close().catch((error: unknown) => logger.warn(String(error)))
    })
    return window
  }

  /**
   * 渲染层报来的面板位置。
   *
   * 面板不可见（切到别的页面、窗口太窄、用户折叠了）时 `bounds` 传 null，
   * 视图跟着隐藏 —— 它是浮在界面之上的一层，不隐藏就会盖住别的东西。
   */
  setEmbeddedBounds(bounds: EmbeddedBounds | null, senderId?: number): void {
    if (senderId !== undefined) {
      const expected = this.currentMode() === 'embedded' ? findMainWindow() : this.groupWindow
      if (!expected || expected.isDestroyed() || expected.webContents.id !== senderId) return
    }
    this.embeddedBounds = bounds
    this.embeddedVisible = bounds !== null
    this.applyEmbeddedBounds()
  }

  private applyEmbeddedBounds(): void {
    for (const surface of this.tabs.values()) {
      const visible = surface === this.surface && this.embeddedVisible && surface.mode !== 'hidden'
      if (this.embeddedBounds) surface.view?.setBounds(this.embeddedBounds)
      surface.view?.setVisible(visible)
    }
  }

  /** 把当前状态推给界面，嵌入面板据此显示网址和「关闭」按钮 */
  private notifyState(overview?: Pick<BrowserPageOverview, 'url' | 'title'>): void {
    const state = {
      ...this.groupState(),
      sessionId: this.sessionId,
      navigation: this.navigationState(),
      open: this.hasWindow(),
      mode: this.currentMode(),
      url: overview?.url ?? this.currentUrl(),
      title: overview?.title ?? ''
    }
    sendToAppWindows('agent-browser:state', state)
    sendToWindow(this.groupWindow, 'agent-browser:state', state)
  }

  private installContentsPolicy(surface: BrowserSurface): void {
    const { contents } = surface

    const rememberNavigation = (_event: unknown, url: string): void => {
      if (!this.tabs.has(surface.id) || !checkNavigationUrl(url).ok) return
      void this.persistUrl(url).catch(() => undefined)
      this.notifyState()
    }
    const updateNavigation = (): void => {
      if (this.tabs.has(surface.id)) this.notifyState()
    }
    contents.on('did-start-loading', updateNavigation)
    contents.on('did-stop-loading', updateNavigation)
    contents.on('did-finish-load', updateNavigation)
    contents.on('did-navigate', rememberNavigation)
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) rememberNavigation(_event, url)
    })

    /**
     * 标题栏永远表明这是谁的窗口。
     *
     * 默认行为是页面想叫什么就叫什么 —— 那意味着一个网页可以把自己的标题写成
     * 「虚幻盒子 · 请输入授权码」，而用户看到的是一个长得像盒子自己的窗口。
     * 页面标题仍然显示（用户要知道自己在看哪一页），但前面钉死我们的名字。
     *
     * 嵌入模式没有自己的标题栏，这一条自然不适用。
     */
    contents.on('page-title-updated', (event) => {
      event.preventDefault()
      this.notifyState()
    })

    contents.setWindowOpenHandler((details) => {
      const checked = checkNavigationUrl(details.url)
      if (checked.ok) {
        void this.openInNewTab(checked.url.toString()).catch((error: unknown) => {
          logger.warn(`[AgentBrowser] 新标签页未打开：${String(error)}`)
        })
      }
      return { action: 'deny' }
    })

    const blockUnsafe = (event: { preventDefault: () => void }, url: string): void => {
      const checked = checkNavigationUrl(url)
      if (checked.ok) return
      event.preventDefault()
      logger.warn(`[AgentBrowser] 拦截导航：${checked.reason}`)
    }

    contents.on('will-navigate', (event, url) => blockUnsafe(event, url))
    contents.on('will-redirect', (event, url) => blockUnsafe(event, url))
    contents.on('will-frame-navigate', (event) => blockUnsafe(event, event.url))

    contents.on('render-process-gone', (_event, details) => {
      logger.warn(`[AgentBrowser] 渲染进程退出：${details.reason}`)
      if (this.surface === surface) {
        this.releaseSurface({ destroy: true })
        this.notifyState()
      } else if (this.tabs.has(surface.id)) {
        this.dropSurface(surface, { destroy: true })
        this.notifyState()
      }
    })

    /*
     * 页面可以自己把自己关掉（`window.close()`）。那一下 `contents` 直接销毁，
     * **`render-process-gone` 不会触发**，于是这个 surface 会一直挂在 `this.tabs` 里，
     * 而它上面的每一个读操作（`getURL`、`debugger`……）从此都抛。后果不是某个功能坏了，
     * 是下一次从 Electron 事件派发里调到 `notifyState()` / `persistUrl()` 的地方
     * 把整个主进程带走。所以死了就当场摘掉，别留在表里。
     */
    contents.on('destroyed', () => {
      if (this.surface === surface) {
        this.releaseSurface()
        this.notifyState()
      } else if (this.tabs.has(surface.id)) {
        this.dropSurface(surface)
        this.notifyState()
      }
    })
  }

  /** 把一个非当前的 surface 从表里摘干净：视图、登记表、必要时连 contents 一起关掉 */
  private dropSurface(surface: BrowserSurface, options: { destroy?: boolean } = {}): void {
    this.tabs.delete(surface.id)
    const host = surface.window ?? findMainWindow()
    // `contentView` 和 `webContents` 一样，窗口销毁之后再读会抛
    if (surface.view && host && !host.isDestroyed()) host.contentView.removeChildView(surface.view)
    unregisterNonAppWindow(surface.contentsId)
    if (options.destroy && !surface.contents.isDestroyed()) surface.contents.close()
  }

  /**
   * debugger 只在创建窗口时附一次。
   *
   * 每次交互都 attach/detach 既慢，也会和用户手动打开的 DevTools 反复抢占。
   * 附不上不是致命错误 —— 读页面、截图、导航都还能用，只有 `browser_interact`
   * 会返回 `INTERACTION_UNAVAILABLE`。
   */
  private attachDebugger(contents: WebContents): void {
    try {
      contents.debugger.attach('1.3')
      this.debuggerAttached = true
      contents.debugger.on('detach', () => {
        if (this.surface?.contents === contents) this.debuggerAttached = false
      })
    } catch (error) {
      this.debuggerAttached = false
      logger.warn(`[AgentBrowser] debugger 附加失败：${String(error)}`)
    }
  }

  private detachDebugger(): void {
    const contents = this.surface?.contents
    if (!contents || contents.isDestroyed() || !this.debuggerAttached) return
    try {
      contents.debugger.detach()
    } catch {
      // 已经断开就没什么可做的
    }
    this.debuggerAttached = false
  }

  private async sendCommand(
    contents: WebContents,
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    if (!this.debuggerAttached) {
      // 最常见的原因是用户按了 F12：DevTools 占着调试端口，debugger 附不上
      throw new AgentBrowserError(
        'INTERACTION_UNAVAILABLE',
        '现在没法在后台操作这个页面（通常是浏览器窗口的开发者工具开着）。请关掉开发者工具后重试，或者直接手动完成这一步。'
      )
    }
    try {
      await contents.debugger.sendCommand(method, params)
    } catch (error) {
      throw new AgentBrowserError(
        'INTERACTION_UNAVAILABLE',
        `页面操作没能送达（${String(error)}）。请手动完成这一步。`
      )
    }
  }

  private async dispatchClick(contents: WebContents, x: number, y: number): Promise<void> {
    // 先移过去：不少菜单和按钮的展开依赖 hover
    await this.sendCommand(contents, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0
    })
    await this.sendCommand(contents, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    })
    await this.sendCommand(contents, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    })
  }

  /**
   * 交互之后给页面一点反应时间。
   *
   * 点击常常触发导航，也常常只是展开一个菜单。等一小会儿再重扫，模型拿到的
   * 才是操作后的页面；真发生了导航就走完整的加载等待。
   */
  private async settleAfterInteraction(contents: WebContents): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (contents.isLoading()) await this.waitForLoad(contents)
  }

  private async loadAndWait(contents: WebContents, url: string): Promise<void> {
    const wait = this.waitForLoad(contents)
    try {
      await contents.loadURL(url)
    } catch (error) {
      // loadURL 在重定向和中途取消时也会 reject，真正的失败由 did-fail-load 判定
      logger.info(`[AgentBrowser] loadURL 返回异常，交给加载事件判定：${String(error)}`)
    }
    await wait
  }

  /**
   * 页面「可以读了」的判定。
   *
   * `loadURL` 返回只意味着文档到了，SPA 这时候常常还是个空壳。所以等
   * `did-stop-loading` 之后再留一段静默期；静默期内又开始加载就重新等。
   */
  private waitForLoad(contents: WebContents): Promise<void> {
    const waiting = new Promise<void>((resolve, reject) => {
      let settleTimer: NodeJS.Timeout | null = null

      const cleanup = (): void => {
        if (settleTimer) clearTimeout(settleTimer)
        clearTimeout(hardTimer)
        contents.off('did-stop-loading', onStop)
        contents.off('did-start-loading', onStart)
        contents.off('did-fail-load', onFail)
      }

      const onStop = (): void => {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          cleanup()
          resolve()
        }, LOAD_SETTLE_MS)
      }

      const onStart = (): void => {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = null
      }

      const onFail = (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean
      ): void => {
        if (!isMainFrame || errorCode === ERR_ABORTED) return
        cleanup()
        reject(
          new AgentBrowserError(
            'PAGE_LOAD_FAILED',
            `页面加载失败：${errorDescription}（${errorCode}）`
          )
        )
      }

      const hardTimer = setTimeout(() => {
        cleanup()
        reject(
          new AgentBrowserError(
            'PAGE_LOAD_TIMEOUT',
            '页面 30 秒内没有加载完。窗口还开着，可以截图看看当前状态，或者交给用户处理。'
          )
        )
      }, LOAD_TIMEOUT_MS)

      contents.on('did-stop-loading', onStop)
      contents.on('did-start-loading', onStart)
      contents.on('did-fail-load', onFail)

      if (!contents.isLoading()) onStop()
    })

    /*
     * **先认领一次 rejection，然后原样返回。**
     *
     * 这个 promise 是在调用方 await 它**之前**就开始监听事件的 —— `loadAndWait`
     * 里中间还隔着一次 `await contents.loadURL(...)`。真机上打不开的网页
     * （`ERR_CONNECTION_CLOSED`）会在那次 await 期间触发 `did-fail-load`，
     * 于是这个 promise 在**还没有人 await 它**的时刻就 reject 了。
     *
     * Node 在那一刻判定它是 unhandledRejection，而主进程把 unhandledRejection
     * 当致命信号（`services/index.ts` 的 `setupGracefulShutdown`）—— 结果是
     * **一个打不开的网页把整个应用关掉**，日志里紧跟着还会出现
     * `PromiseRejectionHandledWarning`（因为一个 tick 之后它其实被接住了）。
     *
     * 挂一个空 catch 不会吞掉错误：下面 `await waiting` 照样能拿到那个 reject。
     * 它只是告诉 Node「这个 rejection 有人管」。
     */
    waiting.catch(() => undefined)
    return waiting
  }

  /**
   * 导航前查一次 DNS。
   *
   * 这是**尽力而为**的 SSRF 防护：解析和 Chromium 真正建连之间存在 TOCTOU，
   * 挡不住 DNS rebinding。挡掉的是「域名直接解析到内网/云元数据」这一类
   * 常见情况。解析本身失败不拦 —— 那是网络问题，交给加载流程报真实错误。
   */
  private async assertPublicHost(url: URL): Promise<void> {
    let addresses: string[] = []
    try {
      const resolved = await this.getSession().resolveHost(url.hostname)
      addresses = (resolved?.endpoints ?? []).map((endpoint) => endpoint.address)
    } catch (error) {
      logger.info(`[AgentBrowser] DNS 预检未完成，继续加载：${String(error)}`)
      return
    }

    const rejection = checkResolvedAddresses(addresses)
    if (rejection && !rejection.ok) {
      throw new AgentBrowserError('NAVIGATION_BLOCKED', rejection.reason)
    }
  }

  private async runPageAgent(command: PageAgentCommand): Promise<unknown> {
    const contents = this.requireContents()
    const raw = await contents.executeJavaScriptInIsolatedWorld(AGENT_BROWSER_WORLD_ID, [
      { code: buildPageAgentScript(command) }
    ])

    const result = raw as PageAgentResult | undefined
    if (!result || typeof result !== 'object' || !('ok' in result)) {
      throw new AgentBrowserError('PAGE_CHANGED', '页面没有返回可用结果，请重新读取交互快照。')
    }
    if (!result.ok) throw new AgentBrowserError(result.code, result.message)
    return result.data
  }

  private async overview(): Promise<BrowserPageOverview> {
    const scan = (await this.runPageAgent({ kind: 'scan' })) as PageScanResult
    return {
      title: scan.title,
      url: scan.url,
      snapshot: formatSnapshot(scan),
      hasIframe: scan.hasIframe
    }
  }

  /**
   * 清掉这个分区的登录态。
   *
   * `clearAuthCache()` 不能省：HTTP 摘要和 NTLM 认证不在 storage 里，
   * 只清 storage 和 cache 会留下「已经登出却仍自动认证」的状态。
   */
  private async resetSession(): Promise<void> {
    const browserSession = this.getSession()
    this.detachDebugger()
    while (this.surface) this.releaseSurface({ destroy: true })

    await browserSession.clearStorageData()
    await browserSession.clearCache()
    await browserSession.clearAuthCache()
    logger.info('[AgentBrowser] 已清理浏览器登录态与缓存')
  }
}

/**
 * 兼容默认实例，并负责所有会话实例的退出和显示模式切换。
 *
 * 类本身也导出：测试要能造一个干净的实例，否则用例之间会隔着窗口状态互相污染。
 */
export const agentBrowser = new AgentBrowserService()

const sessionBrowsers = new Map<string, AgentBrowserService>()

/** 同一会话复用页面；后台会话的工具不会操作到前台会话的页面。 */
export function getSessionBrowser(sessionId?: string): AgentBrowserService {
  if (!sessionId) return agentBrowser
  let browser = sessionBrowsers.get(sessionId)
  if (!browser) {
    // 新建之前先清掉空转的实例。界面每切一次会话就来问一次状态，
    // 不清的话这张表会跟着用户开会话一直长到退出应用为止。
    for (const [id, idle] of sessionBrowsers) {
      if (id !== sessionId && idle.isIdle()) sessionBrowsers.delete(id)
    }
    browser = new AgentBrowserService(sessionId)
    sessionBrowsers.set(sessionId, browser)
  }
  return browser
}

export async function deleteSessionBrowser(sessionId: string): Promise<void> {
  const browser = sessionBrowsers.get(sessionId)
  if (browser) await browser.close()
  else await saveBrowserUrl(sessionId, null)
  sessionBrowsers.delete(sessionId)
}
