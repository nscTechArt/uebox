import { ipcMain, BrowserWindow, app } from 'electron'
import { getAppWindows } from '../appWindows'

/**
 * 注册窗口控制相关的IPC处理函数
 */
export function registerWindowIPC(): void {
  // 最小化窗口
  ipcMain.on('window-minimize', () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (focusedWindow) {
      focusedWindow.minimize()
    }
  })

  // 最大化/还原窗口
  ipcMain.on('window-maximize', () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (focusedWindow) {
      if (focusedWindow.isMaximized()) {
        focusedWindow.unmaximize()
      } else {
        focusedWindow.maximize()
      }
    }
  })

  // 关闭窗口
  ipcMain.on('window-close', () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (focusedWindow) {
      focusedWindow.close()
    }
  })

  // 完全退出应用（包括托盘）
  ipcMain.on('app-quit', () => {
    app.quit()
  })

  // 切换开发者工具
  ipcMain.on('window-toggle-devtools', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
    if (window) {
      window.webContents.toggleDevTools()
    }
  })

  ipcMain.on('window-focus', () => {
    // 优先尝试获取主窗口（根据尺寸和类型特征）
    const allWindows = getAppWindows()
    const mainWindow = allWindows.find((win) => {
      if (win.isDestroyed()) return false
      // 排除 devtools 窗口
      if (
        win.webContents.isDevToolsOpened() &&
        allWindows.length > 1 &&
        win.getTitle().includes('DevTools')
      ) {
        return false
      }
      // 排除 QuickRecorder 和 Spotlight (通常它们是 alwaysOnTop)
      // 但如果主窗口被设置了 alwaysOnTop 怎么办？通常主窗口不会常驻置顶。
      // 这里使用尺寸判断作为辅助：主窗口通常较大
      const [width, height] = win.getSize()
      return width >= 800 && height >= 600 && !win.isAlwaysOnTop()
    })

    // 如果找不到符合条件的主窗口，回退到 focusedWindow 或第一个非销毁窗口
    const targetWindow =
      mainWindow || BrowserWindow.getFocusedWindow() || allWindows.find((win) => !win.isDestroyed())

    if (!targetWindow) return

    if (targetWindow.isMinimized()) {
      targetWindow.restore()
    }
    if (!targetWindow.isVisible()) {
      targetWindow.show()
    }

    // 强制置顶逻辑
    const wasAlwaysOnTop = targetWindow.isAlwaysOnTop()

    // 临时提升层级到 screen-saver (最高层级)
    targetWindow.setAlwaysOnTop(true, 'screen-saver')
    targetWindow.focus()

    // 再次确认可见性（应对某些系统动画）
    if (!targetWindow.isVisible()) {
      targetWindow.show()
    }

    // 强制前台（Windows 特有）
    if (process.platform === 'win32') {
      targetWindow.setSkipTaskbar(false) // 确保任务栏可见
    }

    // 延时恢复
    setTimeout(() => {
      if (!targetWindow.isDestroyed()) {
        targetWindow.setAlwaysOnTop(wasAlwaysOnTop)
      }
    }, 1200)
  })
}
