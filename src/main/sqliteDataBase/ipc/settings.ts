import { ipcMain } from 'electron'
import { getPublicDatabase } from '../index'
import { getSetting, setSetting } from '../models/settings'
import { ShortcutService } from '../../services/shortcutService'

export const registerSettingsIPC = (): void => {
  // 获取设置
  ipcMain.handle('db:settings:get', (_, key: string, defaultValue: any) => {
    try {
      const db = getPublicDatabase()
      return { success: true, data: getSetting(db, key, defaultValue) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 更新设置
  ipcMain.handle('db:settings:set', (_, key: string, value: any) => {
    try {
      const db = getPublicDatabase()
      setSetting(db, key, value)

      // 如果是快捷键总开关更新，触发快捷键刷新
      if (key === 'shortcuts_enabled') {
        ShortcutService.getInstance().registerGlobalShortcuts()
      }

      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
