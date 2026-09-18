import type { BrowserWindow } from 'electron'
import { globalShortcut, Menu, MenuItemConstructorOptions } from 'electron'
import { getAppWindows } from '../appWindows'
import { getPublicDatabase } from '../sqliteDataBase'
import { getAllShortcuts } from '../sqliteDataBase/models/shortcut'
import { getSetting } from '../sqliteDataBase/models/settings'
import { spotlightManager } from '../spotlightManager'
import { miniChatManager } from '../miniChatManager'

/** 一条全局热键向操作系统注册的结果 */
export interface ShortcutRegistrationResult {
  actionKey: string
  accelerator: string
  registered: boolean
  /** 没注册上的原因。`OCCUPIED` 表示被别的程序占了，其余是异常原文 */
  reason?: string
}

export class ShortcutService {
  private static instance: ShortcutService

  /**
   * 本服务自己注册过的快捷键。
   *
   * 存在的理由：globalShortcut 是全进程共享的，MiniChat 之类的模块也在上面
   * 注册了自己的快捷键。以前这里用 unregisterAll() 清场，会把别人的一并注销，
   * 而且没有人再注册回来 —— MiniChat 的 Ctrl+Shift+M 从开机那一刻起就是废的。
   * 记住自己注册了什么，就只注销自己的。
   */
  private registeredAccelerators: string[] = []

  /** 最近一次注册的结果，供界面显示「哪条没注册上」 */
  private lastRegistration: ShortcutRegistrationResult[] = []

  private constructor() {}

  /** 最近一次注册的结果。界面据此显示冲突，不要再另外猜一个 true */
  public getRegistrationResults(): ShortcutRegistrationResult[] {
    return this.lastRegistration
  }

  static getInstance(): ShortcutService {
    if (!ShortcutService.instance) {
      ShortcutService.instance = new ShortcutService()
    }
    return ShortcutService.instance
  }

  /**
   * 注册全局热键，**并回报每一条的真实结果**。
   *
   * 注册结果以前只写进 console：用户把热键改成一个已被别的程序占用的组合，界面照样显示
   * 成功，按下去没反应，设置页那条「冲突」横幅也永远不出现（它读的是另一处写死的 true）。
   */
  public registerGlobalShortcuts(): ShortcutRegistrationResult[] {
    const results: ShortcutRegistrationResult[] = []
    try {
      const db = getPublicDatabase()
      const shortcutsEnabled = getSetting(db, 'shortcuts_enabled', true)

      // 先注销上一轮由本服务注册的快捷键（不要用 unregisterAll，见字段注释）
      this.unregisterOwnShortcuts()

      // Update Application Menu (for local shortcuts)
      this.updateApplicationMenu(db, shortcutsEnabled)

      // MiniChat 的快捷键不在快捷键表里，由它自己注册；这里同步「全局禁用」这个开关
      miniChatManager.setGlobalShortcutEnabled(Boolean(shortcutsEnabled))

      if (!shortcutsEnabled) {
        console.log('Shortcuts are globally disabled')
        this.lastRegistration = results
        return results
      }

      const shortcuts = getAllShortcuts(db)

      console.log(
        '[ShortcutService] 准备注册的快捷键:',
        shortcuts.map((s) => `${s.action_key}(${s.accelerator})`)
      )

      shortcuts.forEach((s) => {
        if (s.type === 'global' && s.enabled && s.accelerator) {
          try {
            console.log(`[ShortcutService] 正在注册: ${s.action_key} -> ${s.accelerator}`)
            const ret = globalShortcut.register(s.accelerator, () => {
              this.handleShortcutAction(s.action_key)
            })
            if (!ret) {
              console.warn(`[ShortcutService] 注册失败 (可能被占用): ${s.accelerator}`)
              results.push({
                actionKey: s.action_key,
                accelerator: s.accelerator,
                registered: false,
                reason: 'OCCUPIED'
              })
            } else {
              this.registeredAccelerators.push(s.accelerator)
              console.log(`[ShortcutService] 注册成功: ${s.accelerator}`)
              results.push({
                actionKey: s.action_key,
                accelerator: s.accelerator,
                registered: true
              })
            }
          } catch (err) {
            console.error(`[ShortcutService] 注册异常 ${s.accelerator}:`, err)
            results.push({
              actionKey: s.action_key,
              accelerator: s.accelerator,
              registered: false,
              reason: err instanceof Error ? err.message : String(err)
            })
          }
        }
      })
      console.log('Global shortcuts registered')
      this.lastRegistration = results
      return results
    } catch (error) {
      console.error('Failed to register global shortcuts:', error)
      return results
    }
  }

  /**
   * 注销本服务注册过的全局快捷键，不动别的模块注册的
   */
  private unregisterOwnShortcuts(): void {
    for (const accelerator of this.registeredAccelerators) {
      try {
        globalShortcut.unregister(accelerator)
      } catch (err) {
        console.error(`[ShortcutService] 注销异常 ${accelerator}:`, err)
      }
    }
    this.registeredAccelerators = []
  }

  private updateApplicationMenu(db: any, enabled: boolean): void {
    const shortcuts = getAllShortcuts(db)
    const shortcutMap = new Map(shortcuts.map((s) => [s.action_key, s]))

    const getAccelerator = (key: string): string | undefined => {
      if (!enabled) return undefined
      const s = shortcutMap.get(key)
      // If shortcut is disabled or doesn't exist, return undefined (no shortcut)
      // Note: Menu item will still be clickable, but no keyboard shortcut
      return s && s.enabled ? s.accelerator : undefined
    }

    const template: MenuItemConstructorOptions[] = [
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          /**
           * 「刷新 / 强制刷新」只在开发环境出现。
           *
           * 用户看到的是一个应用，不是网页 —— 「刷新页面」这个概念在他那边不存在，
           * 而误按一次会把正在进行的对话和导入连同渲染进程一起扔掉。
           * 这两项本来是我们自己调试用的，跟 Agent V3 调试台同一类东西。
           *
           * 偏好设置里那两条对应的可改绑项也跟着只在开发环境列出（见 ProfileShortcuts）。
           *
           * 直接读 NODE_ENV 而不是 `@electron-toolkit/utils` 的 `is.dev`：那个包会去取
           * electron 的具名导出，本文件的单元测试跑在 node 环境里，一引就整个模块加载失败。
           */
          ...(process.env.NODE_ENV === 'development'
            ? ([
                {
                  label: 'Reload',
                  accelerator: getAccelerator('app.reload'),
                  click: (_menuItem, focusedWindow?: BrowserWindow) => {
                    focusedWindow?.reload()
                  }
                },
                {
                  label: 'Force Reload',
                  accelerator: getAccelerator('app.force_reload'),
                  click: (_menuItem, focusedWindow?: BrowserWindow) => {
                    focusedWindow?.webContents.reloadIgnoringCache()
                  }
                },
                { type: 'separator' }
              ] as MenuItemConstructorOptions[])
            : []),
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { role: 'help' }
    ]

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)
  }

  private handleShortcutAction(actionKey: string): void {
    console.log(`Triggered global shortcut action: ${actionKey}`)
    // 找到主窗口：主窗口特征是尺寸较大（minWidth=1350, minHeight=800），且不是 alwaysOnTop
    // Spotlight 窗口特征：固定 600x400，alwaysOnTop=true
    const mainWindow = getAppWindows().find((w) => {
      if (w.isDestroyed()) return false
      const [width, height] = w.getSize()
      return !w.isAlwaysOnTop() && width >= 1000 && height >= 900
    })

    if (!mainWindow) return

    switch (actionKey) {
      case 'app.toggle_main_window':
        // 呼出/隐藏主界面
        if (mainWindow.isVisible() && mainWindow.isFocused()) {
          mainWindow.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
        break
      case 'app.toggle_window':
        // 呼出/隐藏 Spotlight 聚焦窗口
        spotlightManager.toggle()
        break
      case 'app.screenshot_mode':
        // 进入截图模式
        mainWindow.webContents.send('screenshot:enter-via-shortcut')
        break
      case 'voice.interrupt':
        // 打断正在说话的语音助手。窗口不抢焦点 —— 用这个键的场景多半是
        // 手在别处、眼睛没看屏幕，把窗口弹到最前面反而是打扰
        mainWindow.webContents.send('voice:interrupt-via-shortcut')
        break
      // Add other global actions
    }
  }
}
