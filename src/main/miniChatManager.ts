import { MINI_CHAT_SETTINGS_ENABLED } from '../shared/miniChatPreferences'
import { BrowserWindow, ipcMain, screen, globalShortcut } from 'electron'
import { getAppWindows } from './appWindows'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { logger } from './services'
import { protectRendererWindow } from './security'
import type { SideChatContext } from '../shared/sideChat'
import type { MiniChatInitialMessage } from '../shared/editorSnapshot'

/** 固定窗口尺寸 */
const WINDOW_WIDTH = 400
const WINDOW_HEIGHT = 600
const WINDOW_MIN_WIDTH = 360
const WINDOW_MIN_HEIGHT = 520

/**
 * Mini Chat 窗口管理器
 * 管理独立的 AI 对话窗口，支持置顶和多轮对话
 */
class MiniChatWindowManager {
  private miniChatWindow: BrowserWindow | null = null
  private opacity = 1

  private normalizeOpacity(value: number): number {
    if (!Number.isFinite(value)) return 1
    return Math.min(1, Math.max(0.4, value))
  }

  private applyOpacity(opacity: number): void {
    this.opacity = MINI_CHAT_SETTINGS_ENABLED ? this.normalizeOpacity(opacity) : 1
    if (this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
      this.miniChatWindow.setOpacity(this.opacity)
    }
    logger.info(`[MiniChat] 窗口透明度已设置为 ${this.opacity}`)
  }

  /**
   * 获取窗口位置（基于聚焦窗口位置，智能保持在屏幕内）
   */
  private getWindowPosition(): { x: number; y: number } {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const cursorPoint = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursorPoint)
    const { width: screenWidth, height: screenHeight } = display.workAreaSize
    const { x: screenX, y: screenY } = display.workArea

    let x: number
    let y: number

    if (focusedWindow && !focusedWindow.isDestroyed()) {
      // 基于聚焦窗口位置计算
      const [focusX, focusY] = focusedWindow.getPosition()
      const [focusWidth, focusHeight] = focusedWindow.getSize()

      // 默认显示在聚焦窗口右侧
      x = focusX + focusWidth + 10
      y = focusY + Math.round((focusHeight - WINDOW_HEIGHT) / 2)

      // 如果右侧放不下，则显示在左侧
      if (x + WINDOW_WIDTH > screenX + screenWidth) {
        x = focusX - WINDOW_WIDTH - 10
      }
    } else {
      // 没有聚焦窗口时，使用鼠标位置
      x = cursorPoint.x - Math.round(WINDOW_WIDTH / 2)
      y = cursorPoint.y - 50
    }

    // 边界检测：确保窗口完全在屏幕内
    const rightEdge = screenX + screenWidth
    const bottomEdge = screenY + screenHeight

    // 左边界
    if (x < screenX) x = screenX + 10
    // 右边界
    if (x + WINDOW_WIDTH > rightEdge) x = rightEdge - WINDOW_WIDTH - 10
    // 上边界
    if (y < screenY) y = screenY + 10
    // 下边界
    if (y + WINDOW_HEIGHT > bottomEdge) y = bottomEdge - WINDOW_HEIGHT - 10

    return { x: Math.round(x), y: Math.round(y) }
  }

  /** MiniChat 专用快捷键 */
  private shortcut: string = 'CommandOrControl+Shift+M'

  /**
   * 初始化 Mini Chat 功能
   */
  initialize(): void {
    this.registerIPC()
    this.setGlobalShortcutEnabled(true)
    logger.info('[MiniChat] 初始化完成')
  }

  /**
   * 开关 MiniChat 的全局快捷键。
   *
   * 由 ShortcutService 在重建全局快捷键时调用，让「全局禁用快捷键」这个设置
   * 也能管到 MiniChat —— 它的快捷键不在快捷键表里，否则会成为漏网之鱼。
   */
  setGlobalShortcutEnabled(enabled: boolean): void {
    globalShortcut.unregister(this.shortcut)

    if (!enabled) {
      return
    }

    const registered = globalShortcut.register(this.shortcut, () => {
      logger.info('[MiniChat] 全局快捷键触发')
      this.toggle()
    })

    if (!registered) {
      logger.warn(`[MiniChat] 全局快捷键注册失败（可能被占用）: ${this.shortcut}`)
    }
  }

  /**
   * 注册 IPC 处理
   */
  private registerIPC(): void {
    ipcMain.on('mini-chat:close', () => {
      this.close()
    })

    ipcMain.on('mini-chat:minimize', () => {
      if (this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
        this.miniChatWindow.minimize()
      }
    })

    ipcMain.on('mini-chat:toggle-pin', () => {
      if (this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
        const isOnTop = this.miniChatWindow.isAlwaysOnTop()
        this.miniChatWindow.setAlwaysOnTop(!isOnTop)
        this.miniChatWindow.webContents.send('mini-chat:pin-changed', !isOnTop)
      }
    })

    ipcMain.on('mini-chat:set-opacity', (_event, opacity: number) => {
      this.applyOpacity(opacity)
    })

    // 渲染进程主动请求初始消息（备用机制）
    ipcMain.on('mini-chat:request-initial-message', () => {
      logger.info(`[MiniChat] 收到渲染进程请求, pendingMessage=${!!this.pendingMessage}`)
      if (this.pendingMessage && this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
        logger.info(
          `[MiniChat] 渲染进程请求初始消息: ${this.pendingMessage.text.substring(0, 50)}...`
        )
        this.miniChatWindow.webContents.send('mini-chat:initial-message', this.pendingMessage)
        this.pendingMessage = null
      }
    })

    /**
     * 主窗口把上下文交过来，开侧边对话。
     *
     * 上下文本体已经在主进程里复制好了（`agent-v3:fork-for-side-chat`），
     * 这里只负责把「用哪一份」递给小窗口。
     */
    ipcMain.on('mini-chat:open-with-context', (_event, context: SideChatContext) => {
      this.showWithContext(context)
    })

    // 和初始消息一样的备用机制：窗口挂载完了主动来要一次，
    // 免得 did-finish-load 那一发早于 Vue 组件挂载
    ipcMain.on('mini-chat:request-initial-context', () => {
      this.deliverContext()
    })

    // MiniChat 保存会话后通知主窗口刷新会话列表
    ipcMain.on('mini-chat:session-saved', (_event, sessionData: { id: string; title: string }) => {
      logger.info(`[MiniChat] 收到 mini-chat:session-saved 事件`)
      logger.info(`[MiniChat] sessionData: ${JSON.stringify(sessionData)}`)
      // 找到主窗口并发送刷新事件
      const windows = getAppWindows()
      logger.info(`[MiniChat] 当前窗口数量: ${windows.length}`)
      let sentCount = 0
      for (const win of windows) {
        // 跳过 MiniChat 窗口本身（已经在 close() 中设为 null 了，所以不需要判断）
        if (!win.isDestroyed()) {
          logger.info(`[MiniChat] 向窗口发送 chat-sessions:refresh 事件, windowId: ${win.id}`)
          win.webContents.send('chat-sessions:refresh', sessionData)
          sentCount++
        }
      }
      logger.info(`[MiniChat] 已发送到 ${sentCount} 个窗口`)
    })
  }

  /**
   * 创建 Mini Chat 窗口
   */
  private createWindow(): void {
    if (this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
      return
    }

    const { x, y } = this.getWindowPosition()

    this.miniChatWindow = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT,
      x,
      y,
      show: false,
      frame: false,
      thickFrame: true,
      transparent: false,
      backgroundColor: '#1a1a2e',
      resizable: true,
      movable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      alwaysOnTop: true,
      title: 'Unreal Box AI',
      icon: join(__dirname, '../../resources/icon.ico'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        sandbox: true,
        contextIsolation: true,
        webSecurity: true
      }
    })

    this.miniChatWindow.on('closed', () => {
      this.miniChatWindow = null
    })

    const rendererFilePath = join(__dirname, '../renderer/index.html')
    protectRendererWindow(
      this.miniChatWindow,
      rendererFilePath,
      is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    )

    this.applyOpacity(this.opacity)

    // 加载 Mini Chat 页面
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.miniChatWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/mini-chat`)
    } else {
      this.miniChatWindow.loadFile(rendererFilePath, {
        hash: '/mini-chat'
      })
    }
  }

  /**
   * 显示 Mini Chat 窗口（可带初始消息）
   */
  show(initialMessage?: MiniChatInitialMessage | string): void {
    const needsCreate = !this.miniChatWindow || this.miniChatWindow.isDestroyed()

    if (needsCreate) {
      this.createWindow()
    }

    if (!this.miniChatWindow) return

    // 如果有初始消息，设置待发送。
    // 收字符串是为了兼容 `sendMessage()` 那条老路：它没有闪存可带
    if (initialMessage) {
      this.pendingMessage =
        typeof initialMessage === 'string' ? { text: initialMessage } : initialMessage
    }

    // 如果是新创建或正在加载，等待加载完成再发送消息
    if (needsCreate || this.miniChatWindow.webContents.isLoading()) {
      this.miniChatWindow.webContents.once('did-finish-load', () => {
        logger.info('[MiniChat] 页面加载完成')
        // 添加延迟确保 Vue 组件已完成挂载（增加到 500ms）
        setTimeout(() => {
          if (this.pendingMessage && this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
            logger.info(
              `[MiniChat] 延迟发送初始消息: ${this.pendingMessage.text.substring(0, 50)}...`
            )
            this.miniChatWindow.webContents.send('mini-chat:initial-message', this.pendingMessage)
            this.pendingMessage = null
          } else {
            logger.info(`[MiniChat] 延迟后无消息需要发送: pending=${!!this.pendingMessage}`)
          }
          // 上下文和初始消息同一条路：都要等 Vue 挂载完才有人接
          this.deliverContext()
        }, 500) // 500ms 延迟确保 Vue 组件挂载完成
      })
    } else if (this.pendingMessage) {
      // 窗口已加载，直接发送
      logger.info(`[MiniChat] 直接发送消息: ${this.pendingMessage.text.substring(0, 50)}...`)
      this.miniChatWindow.webContents.send('mini-chat:initial-message', this.pendingMessage)
      this.pendingMessage = null
    }

    this.miniChatWindow.show()
    this.miniChatWindow.focus()
  }

  /**
   * 带着主对话的上下文打开侧边窗口。
   *
   * 窗口已经开着时也照样递新的上下文 —— 用户在主对话里点第二次，
   * 要的是「拿现在这一刻的情况再问一次」，而不是复用十分钟前那份。
   */
  showWithContext(context: SideChatContext): void {
    if (!context?.agentSessionId) return

    this.pendingContext = context
    this.show()

    // 窗口本来就开着（show 不会重新加载）时立刻投递；正在加载的那条路
    // 由 show() 里的 did-finish-load 和渲染层的主动索取兜底
    if (this.miniChatWindow && !this.miniChatWindow.webContents.isLoading()) {
      this.deliverContext()
    }
  }

  /** 把待投递的上下文发给小窗口，发完就清掉 —— 它只该生效一次 */
  private deliverContext(): void {
    if (!this.pendingContext) return
    if (!this.miniChatWindow || this.miniChatWindow.isDestroyed()) return

    logger.info(`[MiniChat] 投递侧边上下文: ${this.pendingContext.agentSessionId}`)
    this.miniChatWindow.webContents.send('mini-chat:initial-context', this.pendingContext)
    this.pendingContext = null
  }

  /**
   * 关闭 Mini Chat 窗口并重置会话
   */
  close(): void {
    if (this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
      // 通知渲染进程清除会话（会触发保存逻辑）
      this.miniChatWindow.webContents.send('mini-chat:reset-session')
      // 延迟关闭窗口，给渲染进程足够时间完成保存操作
      const windowToClose = this.miniChatWindow
      this.miniChatWindow = null
      setTimeout(() => {
        if (windowToClose && !windowToClose.isDestroyed()) {
          windowToClose.close()
        }
      }, 150)
    }
    this.pendingMessage = null
    // 窗口关了，借来的那份上下文也就作废 —— 下次打开是一次新的侧边对话
    this.pendingContext = null
  }

  // 待发送的初始消息
  private pendingMessage: MiniChatInitialMessage | null = null

  /** 待投递的侧边上下文。窗口还没加载完时先存着 */
  private pendingContext: SideChatContext | null = null

  /**
   * 发送消息到 Mini Chat 窗口（已弃用，请使用 show(message)）
   */
  sendMessage(message: string): void {
    // 直接调用 show 并传入消息
    this.show(message)
  }

  /**
   * 隐藏 Mini Chat 窗口（不销毁，保留会话）
   */
  hide(): void {
    if (this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
      this.miniChatWindow.hide()
      logger.info('[MiniChat] 窗口已隐藏')
    }
  }

  /**
   * 切换 Mini Chat 窗口显示状态
   * 如果窗口不存在或已销毁，则创建并显示
   * 如果窗口存在但隐藏，则显示并聚焦
   * 如果窗口正在显示，则隐藏
   */
  toggle(): void {
    if (!this.miniChatWindow || this.miniChatWindow.isDestroyed()) {
      // 窗口不存在，创建并显示
      this.show()
    } else if (this.miniChatWindow.isVisible()) {
      // 窗口正在显示，隐藏它
      this.hide()
    } else {
      // 窗口存在但隐藏，显示并聚焦
      this.miniChatWindow.show()
      this.miniChatWindow.focus()
      logger.info('[MiniChat] 窗口已恢复显示')
    }
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    // 注销全局快捷键
    globalShortcut.unregister(this.shortcut)

    if (this.miniChatWindow && !this.miniChatWindow.isDestroyed()) {
      this.miniChatWindow.close()
      this.miniChatWindow = null
    }
    logger.info('[MiniChat] 资源已清理')
  }
}

export const miniChatManager = new MiniChatWindowManager()
