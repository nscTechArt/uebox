/**
 * uebox 命令行的 IPC。
 *
 * 只有三个接口：查状态、加进 PATH、从 PATH 移除。
 * 修改 PATH 是用户点出来的动作，不存在自动触发的路径 —— 界面上没有任何
 * 地方会替他决定要不要动环境变量。
 */

import { ipcMain, shell } from 'electron'

import { addToUserPath, cliStatus, removeFromUserPath } from '../services/cli'
import { logger } from '../services/logger'

export function registerCliIPC(): void {
  ipcMain.handle('cli:status', async () => cliStatus())

  ipcMain.handle('cli:add-to-path', async () => addToUserPath())

  ipcMain.handle('cli:remove-from-path', async () => removeFromUserPath())

  /**
   * 在文件管理器里定位到那个可执行文件。
   *
   * 给「我知道路径了，但想自己看一眼」的用户。用 `showItemInFolder` 而不是
   * `openPath`：后者会**执行**它 —— 双击一个 .cmd 会弹出一个一闪而过的
   * 命令行窗口，什么也看不到。
   */
  ipcMain.handle('cli:reveal', async () => {
    const status = await cliStatus()
    if (!status.path) return { ok: false, message: status.reason ?? '命令行程序不可用。' }
    shell.showItemInFolder(status.path)
    return { ok: true }
  })

  logger.info('[IPC] 命令行接口已注册')
}
