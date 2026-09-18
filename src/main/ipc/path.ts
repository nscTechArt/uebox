import { ipcMain } from 'electron'
import { PathManager } from '../utils/PathManager'
import { ThumbnailManager } from '../utils/ThumbnailManager'

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

  /**
   * 保存图片到公共 thumbnails 目录（用于项目封面等）
   * @param imageData number[] 格式的图片二进制数据
   * @param prefix 文件名前缀
   * @returns { success, data: filename }
   */
  ipcMain.handle(
    'path:savePublicThumbnail',
    async (_event, imageData: number[], prefix: string) => {
      void _event
      try {
        const uint8Array = new Uint8Array(imageData)
        const fileName = await ThumbnailManager.savePublicThumbnail(uint8Array, prefix)
        if (fileName) {
          return { success: true, data: fileName }
        }
        return { success: false, error: '保存封面失败' }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

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
