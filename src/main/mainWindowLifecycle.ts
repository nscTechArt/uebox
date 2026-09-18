import type { BrowserWindow } from 'electron'

type MainWindow = Pick<
  BrowserWindow,
  'focus' | 'hide' | 'isDestroyed' | 'isMinimized' | 'minimize' | 'restore' | 'show'
>

interface PreventableCloseEvent {
  preventDefault: () => void
}

type FindMainWindow = () => MainWindow | undefined

/** 关闭按钮隐藏主窗口；系统或托盘发起应用退出时允许真正销毁。 */
export function keepMainWindowInTray(
  event: PreventableCloseEvent,
  mainWindow: MainWindow,
  forceQuit: boolean
): void {
  if (forceQuit) return

  event.preventDefault()
  if (!mainWindow.isDestroyed()) mainWindow.hide()
}

/** 从托盘唤起当前主窗口；若窗口意外丢失，则重新创建，避免操作失效对象。 */
export function showOrCreateMainWindow(
  findMainWindow: FindMainWindow,
  createWindow: () => void
): void {
  const mainWindow = findMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 托盘菜单只操作当前仍存活的主窗口。 */
export function minimizeCurrentMainWindow(findMainWindow: FindMainWindow): void {
  const mainWindow = findMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.minimize()
}
