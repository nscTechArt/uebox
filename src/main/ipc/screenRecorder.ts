import { ipcMain, desktopCapturer, dialog, app, BrowserWindow, screen } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { spawn } from 'child_process'
import type { Rectangle } from 'electron'
import { logger } from '../services'
import { protectRendererWindow } from '../security'
import { requireFFmpeg } from '../services/ffmpegPath'
import { assertScreenCaptureAllowed } from '../services/mediaPermissions'
import { mt } from '../i18n'

let selectionWindow: BrowserWindow | null = null
let quickRecorderWindow: BrowserWindow | null = null
type SelectionResult = { selection: Rectangle; displayBounds: Rectangle } | null

let selectionPromise: {
  resolve: (value: SelectionResult) => void
  reject: (reason?: unknown) => void
} | null = null

const QUICK_WINDOW_WIDTH = 360
const QUICK_WINDOW_HEIGHT = 220
const QUICK_WINDOW_COLLAPSED_WIDTH = 56
const QUICK_WINDOW_COLLAPSED_HEIGHT = 160

const getRecordingsDir = (): string => {
  return path.join(app.getPath('videos'), 'UnrealAgent', 'Recordings')
}

const ensureRecordingsDir = async (): Promise<string> => {
  const dir = getRecordingsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const isPathInside = (parent: string, target: string): boolean => {
  const resolvedParent = path.resolve(parent)
  const resolvedTarget = path.resolve(target)
  if (process.platform === 'win32') {
    const parentLower = resolvedParent.toLowerCase()
    const targetLower = resolvedTarget.toLowerCase()
    return targetLower === parentLower || targetLower.startsWith(parentLower + path.sep)
  }
  return resolvedTarget === resolvedParent || resolvedTarget.startsWith(resolvedParent + path.sep)
}

const recordingExtensions = new Set(['.webm', '.mp4', '.mov', '.mkv', '.gif'])

type ExportFormat = 'mp4' | 'gif'
type ExportQuality = 'high' | 'balanced' | 'fast'
type ExportResolution = 'original' | '1080p' | '720p'

interface ExportOptions {
  inputPath: string
  format: ExportFormat
  quality: ExportQuality
  resolution: ExportResolution
  fps: number
  bitrate: number
  includeAudio: boolean
  highQualityScale: boolean
  trimStart: number
  trimEnd: number
  outputPath?: string
}

const getPresetByQuality = (quality: ExportQuality): string => {
  if (quality === 'high') return 'slow'
  if (quality === 'fast') return 'veryfast'
  return 'medium'
}

const getScaleFilter = (resolution: ExportResolution, highQuality: boolean): string => {
  if (resolution === 'original') return ''
  const width = resolution === '1080p' ? 1920 : 1280
  const flags = highQuality ? ':flags=lanczos' : ''
  return `scale=${width}:-2${flags}`
}

const buildFilter = (fps: number, scaleFilter: string): string => {
  const filters: string[] = []
  if (fps > 0) filters.push(`fps=${fps}`)
  if (scaleFilter) filters.push(scaleFilter)
  return filters.join(',')
}

const runFfmpeg = async (args: string[]): Promise<void> => {
  const binary = await requireFFmpeg()
  await new Promise<void>((resolve, reject) => {
    const processRef = spawn(binary, args, { windowsHide: true })
    let stderr = ''
    processRef.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    processRef.on('error', (error) => reject(error))
    processRef.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.slice(-800) || `ffmpeg exit ${code}`))
    })
  })
}

const getQuickWindowPosition = (
  position: 'center' | 'bottom-right' | 'right-center',
  size: { width: number; height: number }
): { x: number; y: number } => {
  const display = screen.getPrimaryDisplay()
  const { x: screenX, y: screenY, width: screenW, height: screenH } = display.workArea
  if (position === 'bottom-right') {
    const margin = 16
    const x = Math.round(screenX + screenW - size.width - margin)
    const y = Math.round(screenY + screenH - size.height - margin)
    return { x, y }
  }
  if (position === 'right-center') {
    const margin = 12
    const x = Math.round(screenX + screenW - size.width - margin)
    const y = Math.round(screenY + (screenH - size.height) / 2)
    return { x, y }
  }
  const x = Math.round(screenX + (screenW - size.width) / 2)
  const y = Math.round(screenY + (screenH - size.height) / 2)
  return { x, y }
}

const ensureQuickWindowTopLayer = (): void => {
  if (!quickRecorderWindow || quickRecorderWindow.isDestroyed()) {
    return
  }
  quickRecorderWindow.setVisibleOnAllWorkspaces(true)
  quickRecorderWindow.setAlwaysOnTop(true, 'screen-saver')
}

const bringQuickWindowToFront = (): void => {
  if (!quickRecorderWindow || quickRecorderWindow.isDestroyed()) {
    return
  }
  ensureQuickWindowTopLayer()
  quickRecorderWindow.show()
  quickRecorderWindow.focus()
}

const setQuickWindowMode = (mode: 'expanded' | 'collapsed'): void => {
  if (!quickRecorderWindow || quickRecorderWindow.isDestroyed()) {
    return
  }
  const size =
    mode === 'collapsed'
      ? { width: QUICK_WINDOW_COLLAPSED_WIDTH, height: QUICK_WINDOW_COLLAPSED_HEIGHT }
      : { width: QUICK_WINDOW_WIDTH, height: QUICK_WINDOW_HEIGHT }
  const position = mode === 'collapsed' ? 'right-center' : 'bottom-right'
  const { x, y } = getQuickWindowPosition(position, size)
  quickRecorderWindow.setBounds({ x, y, width: size.width, height: size.height })
  ensureQuickWindowTopLayer()
}

const ensureQuickRecorderWindow = (): BrowserWindow => {
  if (quickRecorderWindow && !quickRecorderWindow.isDestroyed()) {
    return quickRecorderWindow
  }
  const { x, y } = getQuickWindowPosition('center', {
    width: QUICK_WINDOW_WIDTH,
    height: QUICK_WINDOW_HEIGHT
  })
  quickRecorderWindow = new BrowserWindow({
    width: QUICK_WINDOW_WIDTH,
    height: QUICK_WINDOW_HEIGHT,
    x,
    y,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })
  protectRendererWindow(
    quickRecorderWindow,
    path.join(__dirname, '../renderer/index.html'),
    process.env.ELECTRON_RENDERER_URL
  )
  ensureQuickWindowTopLayer()

  quickRecorderWindow.on('closed', () => {
    quickRecorderWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    quickRecorderWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/#/screen-recorder-quick`)
  } else {
    quickRecorderWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
      hash: '/screen-recorder-quick'
    })
  }
  return quickRecorderWindow
}

export function registerScreenRecorderIPC(): void {
  // 获取屏幕源
  ipcMain.handle('screen-recorder:get-sources', async () => {
    try {
      assertScreenCaptureAllowed()
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 300, height: 300 }
      })
      assertScreenCaptureAllowed()
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL()
      }))
    } catch (error) {
      logger.error('获取屏幕源失败:', error)
      throw error
    }
  })

  // 保存录制文件
  ipcMain.handle('screen-recorder:save-file', async (_, { buffer, extension = 'webm' }) => {
    try {
      const recordingsDir = await ensureRecordingsDir()
      const { filePath } = await dialog.showSaveDialog({
        title: mt('dialog.saveRecording'),
        defaultPath: path.join(recordingsDir, `recording-${Date.now()}.${extension}`),
        filters: [{ name: 'Video Files', extensions: [extension] }]
      })

      if (filePath) {
        await fs.writeFile(filePath, Buffer.from(buffer))
        return { success: true, filePath }
      }
      return { success: false, error: '用户取消保存' }
    } catch (error) {
      logger.error('保存录制文件失败:', error)
      return { success: false, error: String(error) }
    }
  })

  // 自动保存录制文件（无对话框）
  ipcMain.handle('screen-recorder:auto-save', async (_, { buffer, extension = 'webm' }) => {
    let filePath = ''
    try {
      const recordingsDir = await ensureRecordingsDir()
      const safeExtension = extension?.replace(/^\./, '') || 'webm'
      filePath = path.join(recordingsDir, `recording-${Date.now()}.${safeExtension}`)
      await fs.writeFile(filePath, Buffer.from(buffer))
      return { success: true, filePath }
    } catch (error) {
      logger.error('自动保存录制文件失败:', error)
      return filePath
        ? { success: false, error: String(error), filePath }
        : { success: false, error: String(error) }
    }
  })

  ipcMain.handle('screen-recorder:export', async (_, options: ExportOptions) => {
    try {
      if (!options?.inputPath) {
        return { success: false, error: '文件路径为空' }
      }

      await fs.access(options.inputPath)

      const inputExt = path.extname(options.inputPath)
      const baseName = path.basename(options.inputPath, inputExt) || `recording-${Date.now()}`
      const extension = options.format === 'gif' ? 'gif' : 'mp4'
      let filePath = options.outputPath || ''
      if (!filePath) {
        const recordingsDir = await ensureRecordingsDir()
        const result = await dialog.showSaveDialog({
          title: mt('dialog.exportRecording'),
          defaultPath: path.join(recordingsDir, `${baseName}-export-${Date.now()}.${extension}`),
          filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
        })
        filePath = result.filePath || ''
      }

      if (!filePath) {
        return { success: false, error: '用户取消导出' }
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true })

      const args: string[] = ['-y']
      if (options.trimStart > 0) {
        args.push('-ss', options.trimStart.toFixed(2))
      }
      if (options.trimEnd > options.trimStart) {
        args.push('-to', options.trimEnd.toFixed(2))
      }
      args.push('-i', options.inputPath)

      const scaleFilter = getScaleFilter(options.resolution, options.highQualityScale)
      const vf = buildFilter(options.fps, scaleFilter)
      if (vf) {
        args.push('-vf', vf)
      }

      if (options.format === 'gif') {
        args.push('-loop', '0')
        args.push('-an')
      } else {
        args.push('-c:v', 'libx264')
        args.push('-preset', getPresetByQuality(options.quality))
        if (Number.isFinite(options.bitrate) && options.bitrate > 0) {
          args.push('-b:v', `${options.bitrate}M`)
        }
        args.push('-pix_fmt', 'yuv420p')
        args.push('-movflags', '+faststart')
        if (options.includeAudio) {
          args.push('-c:a', 'aac', '-b:a', '128k')
        } else {
          args.push('-an')
        }
      }

      args.push(filePath)
      await runFfmpeg(args)

      return { success: true, filePath }
    } catch (error) {
      logger.error('导出录制文件失败:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('screen-recorder:open-quick-window', async () => {
    ensureQuickRecorderWindow()
    bringQuickWindowToFront()
    return { success: true }
  })

  ipcMain.handle('screen-recorder:close-quick-window', async () => {
    if (quickRecorderWindow && !quickRecorderWindow.isDestroyed()) {
      quickRecorderWindow.close()
    }
    return { success: true }
  })

  ipcMain.handle(
    'screen-recorder:move-quick-window',
    async (_, payload: { position: 'center' | 'bottom-right' }) => {
      if (!quickRecorderWindow || quickRecorderWindow.isDestroyed()) {
        return { success: false, error: '窗口未创建' }
      }
      const { x, y } = getQuickWindowPosition(payload?.position || 'center', {
        width: QUICK_WINDOW_WIDTH,
        height: QUICK_WINDOW_HEIGHT
      })
      quickRecorderWindow.setPosition(x, y)
      ensureQuickWindowTopLayer()
      return { success: true }
    }
  )

  ipcMain.handle(
    'screen-recorder:set-quick-window-mode',
    async (_, payload: { mode: 'expanded' | 'collapsed' }) => {
      if (!quickRecorderWindow || quickRecorderWindow.isDestroyed()) {
        return { success: false, error: '窗口未创建' }
      }
      setQuickWindowMode(payload?.mode || 'expanded')
      return { success: true }
    }
  )

  ipcMain.handle('screen-recorder:get-recordings-dir', async () => {
    try {
      const dirPath = await ensureRecordingsDir()
      return { success: true, dirPath }
    } catch (error) {
      logger.error('获取录制目录失败:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('screen-recorder:list-recordings', async () => {
    try {
      const dirPath = await ensureRecordingsDir()
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const items = await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const extension = path.extname(entry.name).toLowerCase()
            if (!recordingExtensions.has(extension)) {
              return null
            }
            const fullPath = path.join(dirPath, entry.name)
            const stats = await fs.stat(fullPath)
            return {
              name: entry.name,
              path: fullPath,
              size: stats.size,
              mtime: stats.mtime.toISOString(),
              extension: extension.replace('.', '')
            }
          })
      )
      const recordings = items
        .filter((item): item is NonNullable<typeof item> => !!item)
        .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime())

      return { success: true, dirPath, data: recordings }
    } catch (error) {
      logger.error('读取录制列表失败:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('screen-recorder:delete-recording', async (_, filePath: string) => {
    try {
      if (!filePath) {
        return { success: false, error: '文件路径为空' }
      }
      const dirPath = await ensureRecordingsDir()
      if (!isPathInside(dirPath, filePath)) {
        return { success: false, error: '路径不在录制目录内' }
      }
      await fs.unlink(filePath)
      return { success: true }
    } catch (error) {
      logger.error('删除录制文件失败:', error)
      return { success: false, error: String(error) }
    }
  })

  // 开启选区模式
  ipcMain.handle('screen-recorder:start-selection', async () => {
    return new Promise<SelectionResult>((resolve, reject) => {
      // 如果已有窗口，先关闭
      if (selectionWindow) {
        selectionWindow.close()
        selectionWindow = null
      }

      // 保存 Promise 用于后续 resolve
      selectionPromise = { resolve, reject }

      const primaryDisplay = screen.getPrimaryDisplay()
      // 使用 bounds 而不是 workAreaSize，以便覆盖任务栏
      const { width, height, x, y } = primaryDisplay.bounds

      selectionWindow = new BrowserWindow({
        width,
        height,
        x,
        y,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        fullscreen: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        hasShadow: false,
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true
        }
      })
      protectRendererWindow(
        selectionWindow,
        path.join(__dirname, '../renderer/index.html'),
        process.env.ELECTRON_RENDERER_URL
      )
      selectionWindow.setVisibleOnAllWorkspaces(true)
      selectionWindow.setAlwaysOnTop(true, 'screen-saver')

      // 加载选区页面
      if (process.env.ELECTRON_RENDERER_URL) {
        selectionWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/#/screen-selection`)
      } else {
        selectionWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
          hash: 'screen-selection'
        })
      }

      selectionWindow.on('closed', () => {
        selectionWindow = null
        if (selectionPromise) {
          selectionPromise.resolve(null) // 用户直接关闭窗口视为取消
          selectionPromise = null
        }
      })
    })
  })

  // 选区完成
  ipcMain.on('screen-recorder:selection-complete', (_, bounds: Rectangle) => {
    if (selectionWindow) {
      selectionWindow.close()
    }
    if (selectionPromise) {
      // 获取当前选区所在屏幕的 bounds（这里假设是在主屏幕，因为 start-selection 是在主屏幕创建的窗口）
      // 如果将来支持多屏选区，这里需要根据 selectionWindow 的位置来获取对应的 display
      const primaryDisplay = screen.getPrimaryDisplay()

      selectionPromise.resolve({
        selection: bounds,
        displayBounds: primaryDisplay.bounds
      })
      selectionPromise = null
    }
    bringQuickWindowToFront()
  })

  // 选区取消
  ipcMain.on('screen-recorder:selection-cancelled', () => {
    if (selectionWindow) {
      selectionWindow.close()
    }
    if (selectionPromise) {
      selectionPromise.resolve(null)
      selectionPromise = null
    }
    bringQuickWindowToFront()
  })
}
