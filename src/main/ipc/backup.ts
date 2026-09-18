/**
 * 数据库备份 IPC 接口注册
 * 提供渲染进程调用备份功能的接口
 */

import { ipcMain } from 'electron'
import { DatabaseBackupService } from '../services/backup'
import type { BackupConfig } from '../services/backup'

/**
 * 注册备份相关的 IPC 处理程序
 */
export function registerBackupIpc(): void {
  const backupService = DatabaseBackupService.getInstance()

  /**
   * 获取备份列表
   */
  ipcMain.handle('backup:list', async () => {
    try {
      const records = backupService.listBackups()
      return { success: true, data: records }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  /**
   * 获取备份统计信息
   */
  ipcMain.handle('backup:stats', async () => {
    try {
      const stats = backupService.getStats()
      return { success: true, data: stats }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  /**
   * 手动创建备份
   */
  ipcMain.handle('backup:create', async () => {
    try {
      const result = await backupService.createFullBackup()
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, message: msg }
    }
  })

  /**
   * 恢复指定备份
   */
  ipcMain.handle('backup:restore', async (_event, backupId: string) => {
    try {
      const result = await backupService.restoreBackup(backupId)
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, message: msg }
    }
  })

  /**
   * 删除指定备份
   */
  ipcMain.handle('backup:delete', async (_event, backupId: string) => {
    try {
      const success = backupService.deleteBackup(backupId)
      return { success, message: success ? '删除成功' : '删除失败' }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, message: msg }
    }
  })

  /**
   * 获取备份配置
   */
  ipcMain.handle('backup:getConfig', async () => {
    try {
      const config = backupService.getConfig()
      return { success: true, data: config }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  /**
   * 更新备份配置
   */
  ipcMain.handle('backup:setConfig', async (_event, newConfig: Partial<BackupConfig>) => {
    try {
      backupService.setConfig(newConfig)
      return { success: true, message: '配置已更新' }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, message: msg }
    }
  })

  console.log('[BackupIPC] 备份 IPC 接口已注册')
}
