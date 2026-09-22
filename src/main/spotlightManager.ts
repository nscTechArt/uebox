import { BrowserWindow, globalShortcut, screen, ipcMain, app } from 'electron'
import { getAppWindows } from './appWindows'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { logger } from './services'
import { protectRendererWindow } from './security'

/**
 * Spotlight 窗口位置接口
 */
interface SpotlightPosition {
  x: number
  y: number
}

/**
 * Spotlight 窗口管理器
 * 管理全局快捷键和独立的 Spotlight 窗口
 */
/**
 * 快捷键注册状态接口
 */
export interface ShortcutRegistrationStatus {
  shortcut: string
  registered: boolean
  error?: string
}

/**
 * Spotlight 窗口管理器
 * 管理全局快捷键和独立的 Spotlight 窗口
 */
class SpotlightWindowManager {
  private spotlightWindow: BrowserWindow | null = null
  private shortcut: string = 'CommandOrControl+Shift+Space'
  private isReady: boolean = false
  private pendingShow: boolean = false
  private isShowing: boolean = false
  private positionConfigPath: string
  private savedPosition: SpotlightPosition | null = null
  private saveTimeout: ReturnType<typeof setTimeout> | null = null
  private fadeTimer: ReturnType<typeof setInterval> | null = null
  /**
   * 这一次显示是不是语音热键唤起的。
   *
   * **随 `spotlight:show` 一起发，不另开一条通道。** 另开一条的话渲染层会先收到
   * 「显示」再收到「开始听写」，而前者会清空输入框、重置状态 —— 两条消息之间
   * 的顺序没有任何东西保证，真错了的表现是听写偶发地开不起来。
   */
  private pendingDictate: boolean = false
  /** 快捷键注册状态 */
  private shortcutStatus: ShortcutRegistrationStatus = {
    shortcut: 'CommandOrControl+Shift+Space',
    registered: false
  }

  constructor() {
    this.positionConfigPath = join(app.getPath('userData'), 'spotlight-position.json')
    this.loadPosition()
  }

  /**
   * 加载保存的窗口位置
   */
  private loadPosition(): void {
    try {
      if (existsSync(this.positionConfigPath)) {
        const data = readFileSync(this.positionConfigPath, 'utf8')
        const pos = JSON.parse(data) as SpotlightPosition
        if (typeof pos.x === 'number' && typeof pos.y === 'number') {
          this.savedPosition = pos
          logger.info(`[Spotlight] 加载保存的位置: (${pos.x}, ${pos.y})`)
        }
      }
    } catch (error) {
      logger.warn('[Spotlight] 加载位置失败:', error)
    }
  }

  /**
   * 保存窗口位置（防抖）
   */
  private savePosition(x: number, y: number): void {
    // 清除之前的定时器，防抖保存
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }

    this.saveTimeout = setTimeout(() => {
      try {
        this.savedPosition = { x, y }
        writeFileSync(this.positionConfigPath, JSON.stringify(this.savedPosition, null, 2))
        logger.info(`[Spotlight] 保存位置: (${x}, ${y})`)
      } catch (error) {
        logger.error('[Spotlight] 保存位置失败:', error)
      }
    }, 300)
  }

  /**
   * 获取默认窗口位置（屏幕居中偏上）
   */
  private getDefaultPosition(): { x: number; y: number } {
    const cursorPoint = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursorPoint)
    const { width: screenWidth, height: screenHeight } = display.workAreaSize
    const { x: screenX, y: screenY } = display.workArea

    const windowWidth = 600
    const x = Math.round(screenX + (screenWidth - windowWidth) / 2)
    const y = Math.round(screenY + screenHeight * 0.2)

    return { x, y }
  }

  /**
   * 初始化 Spotlight 功能
   * 注册全局快捷键和 IPC 处理
   */
  initialize(): void {
    // 注意：全局快捷键由 ShortcutService 统一管理，这里不再重复注册
    // 但需要更新状态供前端查询
    this.shortcutStatus = {
      shortcut: this.shortcut,
      registered: true // ShortcutService 已注册此快捷键
    }
    this.registerIPC()
    this.registerStatusIPC()
    // 预创建窗口，避免首次显示时闪烁
    this.createWindow()
    logger.info('[Spotlight] 初始化完成')
  }

  /**
   * 注册状态查询 IPC
   */
  private registerStatusIPC(): void {
    ipcMain.handle('spotlight:getShortcutStatus', () => {
      return this.shortcutStatus
    })
  }

  /**
   * 获取快捷键注册状态
   */
  getShortcutStatus(): ShortcutRegistrationStatus {
    return this.shortcutStatus
  }

  /**
   * 注册 IPC 处理
   */
  private registerIPC(): void {
    // 关闭 Spotlight 窗口
    ipcMain.on('spotlight:close', () => {
      this.hide()
    })

    // 执行操作后关闭
    ipcMain.on('spotlight:execute', (_event, action: string, data: unknown) => {
      logger.info(`[Spotlight] 执行操作: ${action}`, data)
      this.hide()

      // AI 对话操作 → 打开 MiniChat 窗口
      if (action === 'ai' && data && typeof data === 'object' && 'message' in data) {
        const text = (data as { message: string }).message
        /*
         * 闪存就在**这一刻**抓 —— 用户按回车就是「发送」。
         *
         * 不能等小窗口起来再抓：建窗口 + 加载页面 + 500ms 等 Vue 挂载，
         * 加起来半秒多，这半秒里用户完全可能已经切回引擎换了选区。
         *
         * 抓取和建窗口**并行**：`show()` 先走，抓到了再把消息投过去，
         * 所以窗口不会因为等这 2 秒而慢半拍。抓不到就照常发，只是不带块。
         */
        Promise.all([
          import('./miniChatManager'),
          import('./ipc/agentV3').then(({ captureEditorSnapshotForSpotlight }) =>
            captureEditorSnapshotForSpotlight()
          )
        ])
          .then(([{ miniChatManager }, captured]) => {
            miniChatManager.show({ text, ...captured })
          })
          .catch((error) => {
            // 闪存出任何岔子都不该让这句话发不出去
            logger.warn(`[Spotlight] 闪存抓取失败，按无快照发送: ${(error as Error).message}`)
            import('./miniChatManager').then(({ miniChatManager }) =>
              miniChatManager.show({ text })
            )
          })
        return
      }

      // 其他操作 → 转发给主窗口
      const mainWindow = getAppWindows().find((w) => w !== this.spotlightWindow && !w.isDestroyed())
      if (mainWindow) {
        mainWindow.webContents.send('spotlight:action', action, data)
        mainWindow.show()
        mainWindow.focus()
      }
    })
  }

  /**
   * 创建 Spotlight 窗口（预创建，不显示）
   */
  private createWindow(): void {
    if (this.spotlightWindow && !this.spotlightWindow.isDestroyed()) {
      return
    }

    // 获取主显示器
    const display = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = display.workAreaSize
    const { x: screenX, y: screenY } = display.workArea

    // 窗口尺寸
    const windowWidth = 600
    const windowHeight = 400

    // 居中位置（略偏上）
    const x = Math.round(screenX + (screenWidth - windowWidth) / 2)
    const y = Math.round(screenY + screenHeight * 0.2)

    this.spotlightWindow = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      x,
      y,
      show: false, // 关键：不自动显示
      frame: false,
      transparent: true,
      backgroundColor: '#00000000', // 完全透明背景
      resizable: false,
      movable: true, // 允许拖拽移动
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false, // 透明窗口关闭阴影避免闪烁
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        sandbox: true,
        contextIsolation: true,
        webSecurity: true
      }
    })

    // 监听窗口移动事件，保存位置
    this.spotlightWindow.on('moved', () => {
      if (this.spotlightWindow && !this.spotlightWindow.isDestroyed()) {
        const [x, y] = this.spotlightWindow.getPosition()
        this.savePosition(x, y)
      }
    })

    // 页面加载完成后标记就绪
    this.spotlightWindow.webContents.on('did-finish-load', () => {
      this.isReady = true
      logger.info('[Spotlight] 页面加载完成，窗口就绪')

      // 如果在加载期间已经请求显示，立即执行显示
      if (this.pendingShow) {
        this.pendingShow = false
        this.showWindowInternal()
      }
    })

    // 失去焦点时隐藏
    this.spotlightWindow.on('blur', () => {
      this.hide()
    })

    // 窗口关闭时清理引用
    this.spotlightWindow.on('closed', () => {
      this.spotlightWindow = null
      this.isReady = false
      this.pendingShow = false
      this.isShowing = false
      // 这一条和 `pendingShow` 是一对：那次显示没发生，它要的听写态也跟着作废。
      // 漏了的话它会一直挂到**下一次**显示 —— 而下一次多半是普通打字唤起的，
      // 表现是用户按了搜索热键，窗口开着并且麦克风亮了
      this.pendingDictate = false
    })

    const rendererFilePath = join(__dirname, '../renderer/index.html')
    protectRendererWindow(
      this.spotlightWindow,
      rendererFilePath,
      is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    )

    // 加载 Spotlight 页面
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.spotlightWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/spotlight`)
    } else {
      this.spotlightWindow.loadFile(rendererFilePath, {
        hash: '/spotlight'
      })
    }
  }

  /**
   * 显示 Spotlight 窗口
   */
  show(): void {
    // 确保窗口存在
    if (!this.spotlightWindow || this.spotlightWindow.isDestroyed()) {
      this.createWindow()
    }

    // 记录显示请求，避免 did-finish-load 先于 once 注册导致的竞态
    this.pendingShow = true

    // 已经就绪则立即展示，否则等待 did-finish-load 回调
    if (!this.isReady) return

    this.pendingShow = false

    this.showWindowInternal()
  }

  /**
   * 内部显示窗口方法
   */
  /**
   * 内部显示窗口方法
   */
  private showWindowInternal(): void {
    if (!this.spotlightWindow || this.spotlightWindow.isDestroyed()) return

    let x: number, y: number

    // 优先使用保存的位置
    if (this.savedPosition) {
      // 验证保存的位置是否在有效屏幕范围内
      const displays = screen.getAllDisplays()
      const isValidPosition = displays.some((display) => {
        const { x: dx, y: dy, width, height } = display.workArea
        return (
          this.savedPosition!.x >= dx &&
          this.savedPosition!.x < dx + width - 100 && // 保证至少100px在屏幕内
          this.savedPosition!.y >= dy &&
          this.savedPosition!.y < dy + height - 100
        )
      })

      if (isValidPosition) {
        x = this.savedPosition.x
        y = this.savedPosition.y
        logger.info(`[Spotlight] 使用保存的位置: (${x}, ${y})`)
      } else {
        // 位置无效，清除并使用默认位置
        logger.warn('[Spotlight] 保存的位置不在有效屏幕范围内，使用默认位置')
        this.savedPosition = null
        const defaultPos = this.getDefaultPosition()
        x = defaultPos.x
        y = defaultPos.y
      }
    } else {
      // 没有保存的位置，使用默认位置
      const defaultPos = this.getDefaultPosition()
      x = defaultPos.x
      y = defaultPos.y
    }

    // 设置窗口位置
    this.spotlightWindow.setPosition(x, y)

    // 通知渲染进程重置状态（在显示之前）
    const dictate = this.pendingDictate
    this.pendingDictate = false
    this.spotlightWindow.webContents.send('spotlight:show', { dictate })

    // 设置初始透明度为0，避免闪烁
    this.spotlightWindow.setOpacity(0)

    // 显示窗口并聚焦
    this.spotlightWindow.showInactive() // 使用 showInactive 避免可能的焦点切换闪烁
    this.spotlightWindow.focus()

    // 渐显动画
    let opacity = 0
    const targetOpacity = 1.0
    const step = 0.2 // 5帧完成，约80ms

    // 清除可能存在的旧动画定时器
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer)
    }

    this.fadeTimer = setInterval(() => {
      if (!this.spotlightWindow || this.spotlightWindow.isDestroyed()) {
        if (this.fadeTimer) clearInterval(this.fadeTimer)
        return
      }

      opacity += step
      if (opacity >= targetOpacity) {
        opacity = targetOpacity
        this.spotlightWindow.setOpacity(opacity)
        if (this.fadeTimer) clearInterval(this.fadeTimer)
        this.fadeTimer = null
      } else {
        this.spotlightWindow.setOpacity(opacity)
      }
    }, 16)

    // 标记为显示状态
    this.isShowing = true
  }

  /**
   * 隐藏 Spotlight 窗口
   */
  hide(): void {
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer)
      this.fadeTimer = null
    }

    if (this.spotlightWindow && !this.spotlightWindow.isDestroyed()) {
      this.spotlightWindow.hide()
      // 通知渲染进程重置
      this.spotlightWindow.webContents.send('spotlight:hide')
    }
    // 标记为隐藏状态
    this.isShowing = false
  }

  /**
   * 按住不放时，两次热键回调最多隔这么久还算「同一次按住」。
   *
   * Windows 的键盘自动重复实测约 31ms 一次（2026-09-22 真机日志），首次重复前
   * 还有 250~500ms 的启动延迟，而那个延迟用户能在系统里改。所以阈值按**最慢**的
   * 那一档给足：600ms 内又来了一次就当还按着。
   *
   * 给小了的代价是把一次按住误判成两次按下 —— 录音会在用户说话中途重启。
   * 给大了的代价只是松手后多等一会儿才收尾，而收尾主要靠渲染层的 keyup，
   * 这个阈值只是收不到 keyup 时的兜底。两边不对称，所以宁可给大。
   */
  private static readonly HOLD_REPEAT_WINDOW_MS = 600

  private lastDictateFireAt = 0

  /**
   * 语音热键唤起：弹出窗口并直接进听写态。
   *
   * ## 自动重复必须在这里压掉
   *
   * 按住 Alt+Q 不放，Windows 的键盘自动重复会让 `globalShortcut` 每 31 毫秒
   * 回调一次 —— 而「按住说话」的整个前提就是用户会一直按着。不压的话每秒 31 次
   * `show()`，每次都重发 `spotlight:show`，渲染层每次都把录音推倒重来：
   * 用户对着一个反复重启的麦克风说话，一个字都留不下。
   *
   * 所以只有**第一次**按下才真去开窗口开麦；后面那一串重复只更新时间戳，
   * 渲染层据此知道「还按着」（`spotlight:hold`）。
   *
   * ## 隔开之后再按，才算新的一轮
   *
   * **不是 `toggle`。** 已经开着的时候重新按一次不该把窗口关掉 —— 那一下多半是
   * 「刚才没说清，再说一遍」。窗口留着，`spotlight:show` 再发一次，
   * 渲染层据此收掉当前这轮录音重新开始（见 `SpotlightWindow.vue`）。
   */
  showForDictation(): void {
    const now = Date.now()
    /*
     * 「还按着」要同时满足两件事：离上一次触发够近，**而且窗口真的正开着**。
     *
     * 只看时间的话有个洞：窗口刚被关掉（用户按了 Esc、或者程序退出中），
     * 600 毫秒内再按一次热键会被当成「还按着」而整个吞掉 —— 按下去什么都不发生，
     * 而用户只会以为热键坏了。而真的在按住不放时，窗口必然是开着的。
     */
    const alive = Boolean(
      this.isShowing && this.spotlightWindow && !this.spotlightWindow.isDestroyed()
    )
    const held =
      alive && now - this.lastDictateFireAt < SpotlightWindowManager.HOLD_REPEAT_WINDOW_MS
    this.lastDictateFireAt = now

    if (held) {
      // 还按着。窗口和麦克风都已经开着了，这里只报个信号，别碰它们
      this.spotlightWindow?.webContents.send('spotlight:hold')
      return
    }

    this.pendingDictate = true
    this.show()
  }

  /**
   * 切换 Spotlight 窗口显示状态
   */
  toggle(): void {
    if (this.isShowing) {
      this.hide()
    } else {
      this.show()
    }
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    globalShortcut.unregister(this.shortcut)

    if (this.spotlightWindow && !this.spotlightWindow.isDestroyed()) {
      this.spotlightWindow.close()
      this.spotlightWindow = null
    }

    this.isReady = false
    logger.info('[Spotlight] 资源已清理')
  }

  /**
   * 更新快捷键
   */
  updateShortcut(newShortcut: string): boolean {
    // 先注销旧快捷键
    globalShortcut.unregister(this.shortcut)

    // 注册新快捷键
    const success = globalShortcut.register(newShortcut, () => {
      this.toggle()
    })

    if (success) {
      this.shortcut = newShortcut
      this.shortcutStatus = {
        shortcut: newShortcut,
        registered: true
      }
      logger.info(`[Spotlight] 快捷键已更新为 ${newShortcut}`)
      return true
    } else {
      // 恢复旧快捷键
      globalShortcut.register(this.shortcut, () => {
        this.toggle()
      })
      this.shortcutStatus = {
        shortcut: newShortcut,
        registered: false,
        error: '快捷键被其他程序占用'
      }
      logger.error(`[Spotlight] 快捷键 ${newShortcut} 注册失败，已恢复旧快捷键`)
      return false
    }
  }
}

// 导出单例
export const spotlightManager = new SpotlightWindowManager()
