import { ipcMain } from 'electron'
import { PathManager } from '../utils/PathManager'

/**
 * 路径与URL相关的IPC
 */
export function registerPathIPC(): void {
  // 根据公共缩略图文件名构造 file:/// URL
  ipcMain.handle('path:getPublicThumbnailUrl', async (_event, filename: string) => {
    void _event
    try {
      const pm = PathManager.getInstance()
      const url = pm.getPublicThumbnailFileUrl(String(filename))
      return { success: true, data: url }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('path:getVaultThumbnailFilePath', async (_event, filename: string) => {
    void _event
    try {
      const pm = PathManager.getInstance()
      const filePath = pm.getThumbnailFilePath(String(filename))
      return { success: true, data: filePath }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
