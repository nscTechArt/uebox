/**
 * 独立对话窗口：把一条 AI 对话从主窗口的标签栏拖出来，单独成一个窗口。
 *
 * ## 数据怎么走
 *
 * 每个窗口的渲染进程各有一份对话 store。落盘只由**主窗口**来写，独立窗口的对话存储是
 * 只读的 —— 两个窗口都写同一份历史文件，就是后写的把先写的整份盖掉。
 * 两边的副本靠「同步补丁」对齐：谁改了这条对话，就把改动发过来，这里转给另一边
 * （规则见 `chatWindowRegistry.ts` 的 `relayTargets`）。流式输出时正在打字的那条气泡
 * 每秒重画约 8 次，补丁跟着走，另一边看到的就是实时的。
 *
 * Agent 事件**不发两份**：一轮由谁发起，事件就只给谁（和原来一样），由它处理、由它
 * 收尾（起标题、标完成、发通知都只做一遍），另一边只接补丁。所以拖出去的那一刻
 * 正在跑的对话不用「搬家」，也就没有接缝处丢字、重字的问题。
 *
 * 这一层只补四件事：哪些对话在别的窗口里跑（判忙、停止要用）、审批多弹一份
 * （见 `approvalChannel.ts`）、关窗时这个窗口还在跑活就先藏起来等它跑完、
 * 这条对话的 Agent 内嵌浏览器挂进小窗（见下面 `setEmbeddedHostResolver`）。
 */

import { BrowserWindow, ipcMain, screen, webContents, app, type IpcMainEvent } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'

import { findMainWindow, getAppWindows, sendToWindow } from './appWindows'
import { ChatWindowRegistry } from './chatWindowRegistry'
import { mainWindowChrome } from './mainWindowAppearance'
import { protectRendererWindow } from './security'
import { activeRunOwners, hasActiveRunsOwnedBy, onActiveRunsChanged } from './ipc/agentV3'
import {
  resendPendingApprovalsTo,
  setApprovalMirrorResolver
} from './agent-v3/host/approvalChannel'
import { rehostSessionBrowser, setEmbeddedHostResolver } from './services/agentBrowser'
import { logger } from './services'

const DEFAULT_SIZE = { width: 560, height: 780 }
const MIN_WIDTH = 420
const MIN_HEIGHT = 520

interface SizeState {
  width: number
  height: number
}

/** 新窗口的大小单独记，不和主窗口共用：对话窗口一般窄而高，主窗口一般铺满 */
function sizeStatePath(): string {
  return join(app.getPath('userData'), 'chat-window-state.json')
}

function loadSize(): SizeState {
  try {
    const path = sizeStatePath()
    if (!existsSync(path)) return DEFAULT_SIZE
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<SizeState>
    if (typeof saved.width === 'number' && typeof saved.height === 'number') {
      return {
        width: Math.max(MIN_WIDTH, Math.round(saved.width)),
        height: Math.max(MIN_HEIGHT, Math.round(saved.height))
      }
    }
  } catch (error) {
    logger.warn(`[ChatWindow] 读取窗口大小失败，用默认值: ${String(error)}`)
  }
  return DEFAULT_SIZE
}

function saveSize(size: SizeState): void {
  try {
    writeFileSync(sizeStatePath(), JSON.stringify(size))
  } catch (error) {
    logger.warn(`[ChatWindow] 保存窗口大小失败: ${String(error)}`)
  }
}

/**
 * 窗口放在哪：松手的地方。
 *
 * 光标落在窗口顶栏偏左一点，像是用户把标签「拎」出来那样；再整体收进光标所在
 * 那块屏幕的工作区，别让一半窗口跑到屏幕外。没给坐标（右键菜单打开）就在光标处。
 */
function placeAt(size: SizeState, point?: { x: number; y: number }): { x: number; y: number } {
  const anchor = point ?? screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(anchor).workArea
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  const x = Math.min(Math.max(anchor.x - 120, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(anchor.y - 16, area.y), area.y + area.height - height)
  return { x: Math.round(x), y: Math.round(y) }
}

class ChatWindowManager {
  private readonly registry = new ChatWindowRegistry()
  private readonly windows = new Map<string, BrowserWindow>()
  /** 用户点了关闭、但这个窗口还在跑活：先藏着，跑完再真关 */
  private readonly closingWhenIdle = new Set<BrowserWindow>()
  /** 正在关（含藏起来等跑完的）：内嵌浏览器不再往它里挂，先搬回主窗口 */
  private readonly leaving = new Set<BrowserWindow>()
  /** 窗口 → 它的 `webContents.id`。建窗口时钉下来，销毁后再读 `webContents` 会抛 */
  private readonly webContentsIds = new Map<BrowserWindow, number>()

  initialize(): void {
    this.registerIPC()

    setApprovalMirrorResolver((sessionId, ownerId) =>
      this.registry
        .approvalMirrors(sessionId, ownerId, findMainWindow()?.webContents.id)
        .map((id) => webContents.fromId(id))
        .filter((target): target is Electron.WebContents => Boolean(target))
    )

    /*
     * Agent 内嵌浏览器跟着对话走：对话开在小窗里，网页就挂进小窗。
     *
     * 网页是主进程挂在窗口上的一层原生视图。不搬的话它留在主窗口里 —— 而这条
     * 对话的标签已经不在主窗口了，网页没人显示，用户在小窗里看不到 Agent 在操作哪个页面。
     */
    setEmbeddedHostResolver((sessionId) => {
      if (!sessionId) return undefined
      const id = this.registry.webContentsOfAgentSession(sessionId)
      if (id === undefined) return undefined
      for (const [win, contentsId] of this.webContentsIds) {
        if (contentsId === id && !win.isDestroyed() && !this.leaving.has(win)) return win
      }
      return undefined
    })

    onActiveRunsChanged(() => {
      this.broadcastRunsElsewhere()
      this.closeIdleHiddenWindows()
    })
  }

  /** 打开（或提到前面）这条对话的独立窗口 */
  open(chatSid: string, point?: { x: number; y: number }): void {
    const existing = this.windows.get(chatSid)
    if (existing && !existing.isDestroyed()) {
      this.closingWhenIdle.delete(existing)
      // 藏着等跑完的那个又被叫回来了：不关了，网页也搬回来
      if (this.leaving.delete(existing)) this.rehostBrowserOf(existing)
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }

    const size = loadSize()
    const { x, y } = placeAt(size, point)
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x,
      y,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      ...mainWindowChrome(process.platform),
      autoHideMenuBar: true,
      backgroundColor: '#121212',
      icon: join(__dirname, '../../resources/icon.ico'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        sandbox: true,
        // 主窗口那边发起的一轮正在这里实时显示；被挡住时停止重画，切回来是半截
        backgroundThrottling: false
      }
    })

    const webContentsId = win.webContents.id
    this.windows.set(chatSid, win)
    this.webContentsIds.set(win, webContentsId)
    this.registry.register(chatSid, webContentsId)

    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    win.on('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
        const [width, height] = win.getSize()
        saveSize({ width, height })
      }, 400)
    })

    win.on('close', (event) => {
      if (globalThis.__forceQuit__) return
      /*
       * 这个窗口发起的一轮还没跑完：先藏起来，跑完再关。
       *
       * 事件只发给发起的窗口。真关掉的话后面的事件没人接，主窗口那份副本会停在
       * 半截、一直转圈，而 agent 其实还在干活；卡在提问上的那一轮还会被当成
       * 「没人能答」直接取消。藏起来的窗口照样处理事件、照样把补丁发给主窗口，
       * 用户在主窗口里看得到它跑完。
       */
      if (hasActiveRunsOwnedBy(webContentsId)) {
        event.preventDefault()
        this.closingWhenIdle.add(win)
        win.hide()
        logger.info(`[ChatWindow] ${chatSid} 还有一轮在跑，先隐藏，跑完再关`)
      }
      // 不管是真关还是先藏：网页搬回主窗口，别跟着一个看不见的窗口走
      this.leaving.add(win)
      this.rehostBrowserOf(win)
    })

    win.on('closed', () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      this.closingWhenIdle.delete(win)
      if (this.windows.get(chatSid) === win) this.windows.delete(chatSid)
      const agentSessionId = this.registry.agentSessionOf(webContentsId)
      this.registry.removeByWebContents(webContentsId)
      this.leaving.delete(win)
      this.webContentsIds.delete(win)
      // 没走 close 就没了（渲染进程崩了、跑完之后被 destroy）：兜一次，网页回主窗口
      if (agentSessionId) rehostSessionBrowser(agentSessionId)
      this.broadcastChanged()
    })

    const rendererFilePath = join(__dirname, '../renderer/index.html')
    protectRendererWindow(
      win,
      rendererFilePath,
      is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    )

    const hash = `/chat-window?sid=${encodeURIComponent(chatSid)}`
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#${hash}`)
    } else {
      void win.loadFile(rendererFilePath, { hash })
    }

    this.broadcastChanged()
    logger.info(`[ChatWindow] 打开独立窗口: ${chatSid}`)
  }

  private rehostBrowserOf(win: BrowserWindow): void {
    const contentsId = this.webContentsIds.get(win)
    const agentSessionId =
      contentsId === undefined ? undefined : this.registry.agentSessionOf(contentsId)
    if (agentSessionId) rehostSessionBrowser(agentSessionId)
  }

  private closeIdleHiddenWindows(): void {
    for (const win of [...this.closingWhenIdle]) {
      if (win.isDestroyed()) {
        this.closingWhenIdle.delete(win)
        continue
      }
      if (hasActiveRunsOwnedBy(win.webContents.id)) continue
      this.closingWhenIdle.delete(win)
      win.destroy()
    }
  }

  /** 主窗口要知道哪些对话开在独立窗口里：标签栏不再显示它们，点侧边栏是把那个窗口提上来 */
  private broadcastChanged(): void {
    sendToWindow(findMainWindow(), 'chat-window:changed', this.registry.chatSids())
  }

  /** 每个窗口收到的是「别的窗口正在跑的对话」—— 自己跑的它自己知道 */
  private runsElsewhereFor(webContentsId: number): string[] {
    return activeRunOwners()
      .filter((run) => run.senderId !== webContentsId)
      .map((run) => run.sessionId)
  }

  private broadcastRunsElsewhere(): void {
    for (const win of getAppWindows()) {
      sendToWindow(win, 'agent-v3:runs-elsewhere', this.runsElsewhereFor(win.webContents.id))
    }
  }

  private registerIPC(): void {
    ipcMain.handle(
      'chat-window:open',
      (_event, args?: { chatSid?: string; screenX?: number; screenY?: number }) => {
        const chatSid = typeof args?.chatSid === 'string' ? args.chatSid.trim() : ''
        if (!chatSid) return { success: false, error: 'missing chatSid' }
        const point =
          Number.isFinite(args?.screenX) && Number.isFinite(args?.screenY)
            ? { x: Math.round(args!.screenX!), y: Math.round(args!.screenY!) }
            : undefined
        this.open(chatSid, point)
        return { success: true }
      }
    )

    ipcMain.handle('chat-window:list', () => this.registry.chatSids())

    ipcMain.on(
      'chat-window:bind-agent-session',
      (event, args?: { chatSid?: string; agentSessionId?: string }) => {
        if (typeof args?.chatSid !== 'string') return
        const previous = this.registry.agentSessionOf(event.sender.id)
        const next = typeof args.agentSessionId === 'string' ? args.agentSessionId : ''
        this.registry.bindAgentSession(event.sender.id, args.chatSid, next)
        // 换了内核 session（清空对话）：旧的那份网页回主窗口，新的那份挂进来
        if (previous && previous !== next) rehostSessionBrowser(previous)
        if (next) rehostSessionBrowser(next)
      }
    )

    /*
     * 独立窗口里点了要去别的页面的东西（资产库定位、偏好设置、别的对话）。
     * 那些页面属于主窗口：在小窗里打开等于把整个主界面塞进一个对话窗口。
     */
    ipcMain.on('chat-window:open-in-main', (_event, args?: { path?: string }) => {
      const path = typeof args?.path === 'string' ? args.path : ''
      const main = findMainWindow()
      if (!main || !path.startsWith('/')) return
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
      sendToWindow(main, 'chat-window:navigate', { path })
    })

    ipcMain.on('chat-sync:push', (event: IpcMainEvent, patch?: { sid?: string }) => {
      if (!patch || typeof patch.sid !== 'string' || !patch.sid) return
      const targets = this.registry.relayTargets(
        event.sender.id,
        patch.sid,
        findMainWindow()?.webContents.id
      )
      for (const id of targets) {
        const target = webContents.fromId(id)
        if (target && !target.isDestroyed()) target.send('chat-sync:apply', patch)
      }
    })

    /*
     * 独立窗口刚起来，要一份这条对话的最新全量。
     *
     * 不读盘：主窗口每两秒才存一次，正在打字的那条气泡盘上是旧的。问主窗口要它
     * 内存里的那份，它用一份 `full` 补丁回过来，走上面同一条转发。
     */
    ipcMain.on('chat-sync:request-snapshot', (event, args?: { chatSid?: string }) => {
      const chatSid = typeof args?.chatSid === 'string' ? args.chatSid : ''
      if (!chatSid || this.registry.chatSidOf(event.sender.id) !== chatSid) return
      sendToWindow(findMainWindow(), 'chat-sync:snapshot-request', { sid: chatSid })
    })

    ipcMain.handle('agent-v3:runs-elsewhere', (event) => this.runsElsewhereFor(event.sender.id))

    ipcMain.handle('chat-window:resend-approvals', (event, args?: { sessionIds?: string[] }) => {
      const sessionIds = Array.isArray(args?.sessionIds)
        ? args!.sessionIds!.filter((id): id is string => typeof id === 'string' && id !== '')
        : []
      return resendPendingApprovalsTo(event.sender, sessionIds)
    })
  }
}

export const chatWindowManager = new ChatWindowManager()
