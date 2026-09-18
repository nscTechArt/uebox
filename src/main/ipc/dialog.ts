import { ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'

import { resolveLocalResourcePath } from '../utils/localResourceServer'
import { mt } from '../i18n'

/**
 * data URL 解码成字节。
 *
 * 生图模型有一半是直接回 base64 的（见 imagePollingService 的 extractImageUrlsFromResult），
 * 这种图在界面上显示得好好的，走到「另存为」却因为 `existsSync('data:image/png;...')`
 * 为假而报「源文件不存在」—— 用户看得见却存不下来。
 */
function decodeDataUrl(dataUrl: string): Buffer {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1) {
    throw new Error('不是合法的 data URL')
  }

  const params = dataUrl.slice('data:'.length, commaIndex).split(';')
  const payload = dataUrl.slice(commaIndex + 1)
  const isBase64 = params.some((param) => param.trim().toLowerCase() === 'base64')

  return isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload))
}

/**
 * 注册文件对话框相关的IPC处理函数
 */
export function registerDialogIPC(): void {
  // 显示打开文件对话框
  ipcMain.handle('dialog:showOpenDialog', async (event, options) => {
    const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
    if (!window) {
      throw new Error('没有找到活动窗口')
    }

    try {
      const result = await dialog.showOpenDialog(window, {
        title: mt('dialog.open'),
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        ...options
      })

      return result
    } catch (error) {
      console.error('文件对话框错误:', error)
      throw error
    }
  })

  // 显示保存文件对话框
  ipcMain.handle('dialog:showSaveDialog', async (event, options) => {
    const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
    if (!window) {
      throw new Error('没有找到活动窗口')
    }

    try {
      const result = await dialog.showSaveDialog(window, {
        title: mt('dialog.save'),
        ...options
      })

      return result
    } catch (error) {
      console.error('保存对话框错误:', error)
      throw error
    }
  })

  // 保存文件到用户指定位置（显示对话框 + 复制/下载）
  ipcMain.handle(
    'dialog:saveFile',
    async (
      event,
      options: {
        defaultPath?: string
        filters?: Array<{ name: string; extensions: string[] }>
        sourcePath: string // 本地路径或远程URL
      }
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
      if (!window) {
        return { success: false, error: '没有找到活动窗口' }
      }

      try {
        const dialogResult = await dialog.showSaveDialog(window, {
          title: mt('dialog.save'),
          defaultPath: options.defaultPath,
          filters: options.filters
        })

        if (dialogResult.canceled || !dialogResult.filePath) {
          return { canceled: true }
        }

        const destPath = dialogResult.filePath
        const src = options.sourcePath

        if (src.startsWith('http://') || src.startsWith('https://')) {
          // 远程URL：下载后保存
          const response = await fetch(src)
          if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)
          const buffer = Buffer.from(await response.arrayBuffer())
          await fs.writeFile(destPath, buffer)
        } else if (src.startsWith('data:')) {
          // base64 图：自己解码，不必再跑一趟网络
          await fs.writeFile(destPath, decodeDataUrl(src))
        } else if (src.startsWith('local-resource://')) {
          // 界面上的本地图走的是特权协议，还原成磁盘路径再复制
          const localPath = resolveLocalResourcePath(src)
          if (!existsSync(localPath)) {
            return { success: false, error: '源文件不存在' }
          }
          await fs.copyFile(localPath, destPath)
        } else if (existsSync(src)) {
          // 本地文件：复制
          await fs.copyFile(src, destPath)
        } else {
          return { success: false, error: '源文件不存在' }
        }

        return { success: true, filePath: destPath }
      } catch (error) {
        console.error('保存文件失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'dialog:savePdfFromHtml',
    async (
      event,
      options: {
        defaultPath?: string
        html: string
      }
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
      if (!window) {
        return { success: false, error: '没有找到活动窗口' }
      }

      let pdfWindow: BrowserWindow | null = null

      try {
        const dialogResult = await dialog.showSaveDialog(window, {
          title: mt('dialog.exportPdf'),
          defaultPath: options.defaultPath,
          filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
        })

        if (dialogResult.canceled || !dialogResult.filePath) {
          return { canceled: true }
        }

        pdfWindow = new BrowserWindow({
          show: false,
          width: 960,
          height: 1280,
          backgroundColor: '#ffffff',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
          }
        })

        await pdfWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(String(options.html || ''))}`
        )

        const pdfBuffer = await pdfWindow.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4'
        })

        await fs.writeFile(dialogResult.filePath, pdfBuffer)
        return { success: true, filePath: dialogResult.filePath }
      } catch (error) {
        console.error('导出 PDF 失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        if (pdfWindow && !pdfWindow.isDestroyed()) {
          pdfWindow.destroy()
        }
      }
    }
  )

  // 显示消息对话框
  ipcMain.handle('dialog:showMessageBox', async (event, options) => {
    const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
    if (!window) {
      throw new Error('没有找到活动窗口')
    }

    try {
      const result = await dialog.showMessageBox(window, {
        type: 'info',
        ...options
      })

      return result
    } catch (error) {
      console.error('消息对话框错误:', error)
      throw error
    }
  })

  // 显示错误对话框
  ipcMain.handle('dialog:showErrorBox', async (event, title, content) => {
    void event
    try {
      dialog.showErrorBox(title, content)
      return { success: true }
    } catch (error) {
      console.error('错误对话框错误:', error)
      throw error
    }
  })
}
