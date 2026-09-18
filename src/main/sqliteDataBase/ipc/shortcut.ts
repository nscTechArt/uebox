import { ipcMain } from 'electron'
import { getPublicDatabase } from '../index'
import { getAllShortcuts, updateShortcut, resetAllShortcuts, Shortcut } from '../models/shortcut'
import { ShortcutService } from '../../services/shortcutService'

/**
 * 注册快捷键相关的IPC处理函数
 */
export const registerShortcutIPC = (): void => {
  // 获取所有快捷键
  ipcMain.handle('db:shortcut:getAll', async () => {
    try {
      const db = getPublicDatabase()
      const shortcuts = getAllShortcuts(db)
      return { success: true, data: shortcuts }
    } catch (error) {
      console.error('获取快捷键列表失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 更新快捷键
  ipcMain.handle('db:shortcut:update', async (_, actionKey: string, updates: Partial<Shortcut>) => {
    try {
      const db = getPublicDatabase()
      const success = updateShortcut(db, actionKey, updates)

      if (!success) return { success: false, data: false }

      // 重新注册全局快捷键
      // 注意：为了简单起见，这里全量刷新，实际上可以优化
      const results = ShortcutService.getInstance().registerGlobalShortcuts()

      // 写进库了不等于用得上。这条热键要是被别的程序占着，操作系统那边根本没注册上，
      // 用户按下去不会有任何反应 —— 所以这种情况要如实回报失败，而不是「保存成功」
      const mine = results.find((r) => r.actionKey === actionKey)
      if (mine && !mine.registered) {
        return { success: false, data: false, code: 'REGISTER_FAILED', error: mine.reason }
      }

      return { success: true, data: true }
    } catch (error) {
      console.error(`更新快捷键(${actionKey})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 恢复默认快捷键
  ipcMain.handle('db:shortcut:resetAll', async () => {
    try {
      const db = getPublicDatabase()
      resetAllShortcuts(db)
      // 重新注册全局快捷键
      ShortcutService.getInstance().registerGlobalShortcuts()
      const shortcuts = getAllShortcuts(db)
      return { success: true, data: shortcuts }
    } catch (error) {
      console.error('恢复默认快捷键失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 每条全局热键有没有真的注册到操作系统。
   *
   * 界面的「快捷键冲突」横幅以前读的是 spotlightManager 里一个写死的 `registered: true`，
   * 于是它永远不会亮 —— 热键被别的程序占了，用户既看不到提示，按下去也没反应。
   */
  ipcMain.handle('db:shortcut:getRegistrationStatus', async () => {
    try {
      return { success: true, data: ShortcutService.getInstance().getRegistrationResults() }
    } catch (error) {
      console.error('获取快捷键注册状态失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
