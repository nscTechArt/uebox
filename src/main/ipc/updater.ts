/**
 * 更新相关的 IPC 处理函数
 */
import { ipcMain } from 'electron'
import { autoUpdaterService } from '../services/updater/autoUpdater'

/**
 * 注册更新相关的IPC处理函数
 */
export function registerUpdaterIPC(): void {
  // 手动检查更新
  ipcMain.handle('updater:check-for-updates', async () => {
    try {
      await autoUpdaterService.checkForUpdates()
      return { success: true }
    } catch (error) {
      console.error('检查更新失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  })

  // 下载更新（autoDownload 是关的，必须由用户点过确认才走到这里）
  ipcMain.handle('updater:download-update', async () => {
    try {
      await autoUpdaterService.downloadUpdate()
      return { success: true }
    } catch (error) {
      console.error('下载更新失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '下载更新失败'
      }
    }
  })

  // 退出并安装更新
  ipcMain.handle('updater:quit-and-install', async () => {
    try {
      // 把服务层的结论原样带出去。无条件回 success 的话，渲染层那句
      // 「装不上就报错」永远跑不到（见 autoUpdater.quitAndInstall 的注释）
      return autoUpdaterService.quitAndInstall()
    } catch (error) {
      console.error('退出并安装更新失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '退出并安装更新失败'
      }
    }
  })

  // 获取更新状态
  ipcMain.handle('updater:get-status', async () => {
    try {
      const status = autoUpdaterService.getStatus()
      return { success: true, data: status }
    } catch (error) {
      console.error('获取更新状态失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取更新状态失败'
      }
    }
  })
}
