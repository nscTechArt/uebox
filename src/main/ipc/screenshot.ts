/**
 * 截图模式 IPC 处理
 * 提供产品截图功能，支持透明背景和窗口边框效果
 */

import { ipcMain, BrowserWindow, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { logger } from '../services'
import { getAppWindows } from '../appWindows'

/** 保存的原始窗口状态 */
interface OriginalWindowState {
  bounds: Electron.Rectangle
  backgroundColor: string
  isMaximized: boolean
}

/** 截图模式状态 */
let originalState: OriginalWindowState | null = null
let isInScreenshotMode = false

/** 截图模式扩展的边距（像素） */
const SCREENSHOT_PADDING = 100

/**
 * 状态复位辅助函数
 * 确保所有状态变量回归初始值
 */
function resetScreenshotModeState(): void {
  originalState = null
  isInScreenshotMode = false
}

/**
 * 获取主窗口
 * @returns 主窗口实例或 null
 */
function getMainWindow(): BrowserWindow | null {
  // 走 getAppWindows()：窗口清单里还可能有 Agent 浏览器（装着远程网页），
  // 它同样不是 alwaysOnTop，按原来的判据会被当成主窗口
  return getAppWindows().find((win) => !win.isAlwaysOnTop()) ?? null
}

/**
 * 进入截图模式
 * 显示确认界面，准备截图
 */
async function enterScreenshotMode(): Promise<{ success: boolean; error?: string }> {
  const win = getMainWindow()
  if (!win) {
    resetScreenshotModeState()
    return { success: false, error: '未找到主窗口' }
  }

  // 幂等处理：如果已经在模式中，重发通知并返回成功
  if (isInScreenshotMode) {
    try {
      win.webContents.send('screenshot:mode-changed', { active: true, padding: SCREENSHOT_PADDING })
      return { success: true }
    } catch (error) {
      logger.warn('[Screenshot] 重发进入截图模式通知失败，将重置状态后重试:', error)
      resetScreenshotModeState()
    }
  }

  try {
    // 保存窗口最大化状态（截图需要取消最大化以获取正确尺寸）
    const wasMaximized = win.isMaximized()
    if (wasMaximized) {
      win.unmaximize()
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    originalState = {
      bounds: win.getBounds(),
      backgroundColor: '#121212',
      isMaximized: wasMaximized
    }

    isInScreenshotMode = true

    logger.info('[Screenshot] 进入截图模式')

    // 通知渲染进程进入截图模式（显示确认 UI）
    win.webContents.send('screenshot:mode-changed', { active: true, padding: SCREENSHOT_PADDING })

    return { success: true }
  } catch (error) {
    logger.error('[Screenshot] 进入截图模式失败:', error)
    resetScreenshotModeState()
    return { success: false, error: String(error) }
  }
}

/**
 * 退出截图模式
 * 恢复窗口状态
 */
async function exitScreenshotMode(): Promise<{ success: boolean; error?: string }> {
  const win = getMainWindow()

  // 如果本来就不在模式中，直接视为成功
  if (!isInScreenshotMode) {
    resetScreenshotModeState()
    return { success: true }
  }

  if (!win) {
    resetScreenshotModeState()
    return { success: false, error: '未找到主窗口' }
  }

  try {
    // 如果原来是最大化的，恢复最大化
    if (originalState?.isMaximized) {
      win.maximize()
    }

    // 通知渲染进程退出截图模式
    win.webContents.send('screenshot:mode-changed', { active: false, padding: 0 })

    logger.info('[Screenshot] 退出截图模式')

    return { success: true }
  } catch (error) {
    logger.error('[Screenshot] 退出截图模式失败:', error)
    return { success: false, error: String(error) }
  } finally {
    // 无论成功失败，强制清理状态，保证下次能再次进入
    resetScreenshotModeState()
  }
}

/**
 * 执行截图
 * 捕获当前窗口内容并保存为 PNG（带透明边框和阴影）
 */
async function captureScreenshot(): Promise<{
  success: boolean
  filePath?: string
  error?: string
}> {
  const win = getMainWindow()
  if (!win) {
    return { success: false, error: '未找到主窗口' }
  }

  try {
    logger.info('[Screenshot] 开始截图...')

    // 捕获窗口内容
    const image = await win.webContents.capturePage()
    const originalBuffer = image.toPNG()

    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `UnrealAgent_${timestamp}.png`

    // 保存到桌面
    const desktopPath = app.getPath('desktop')
    const filePath = path.join(desktopPath, fileName)

    // 动态导入 sharp
    let finalBuffer: Buffer

    try {
      // 尝试使用 sharp 添加透明边框和阴影
      const sharp = (await import('sharp')).default

      const metadata = await sharp(originalBuffer).metadata()
      const width = metadata.width || 800
      const height = metadata.height || 600

      const padding = SCREENSHOT_PADDING

      // 创建带透明边框的画布
      const canvasWidth = width + padding * 2
      const canvasHeight = height + padding * 2
      const borderRadius = 12 // 圆角半径

      // 创建圆角遮罩 SVG（用于给截图添加圆角）
      const roundedMaskSvg = Buffer.from(`
        <svg width="${width}" height="${height}">
          <rect x="0" y="0" width="${width}" height="${height}" rx="${borderRadius}" ry="${borderRadius}" fill="white"/>
        </svg>
      `)

      // 给原始截图添加圆角
      const roundedScreenshot = await sharp(originalBuffer)
        .composite([
          {
            input: roundedMaskSvg,
            blend: 'dest-in'
          }
        ])
        .png()
        .toBuffer()

      // 定义多层阴影参数 (模拟 macOS 风格或自然光照)
      // 1. 接触阴影 (Contact Shadow): 紧贴物体，深色，清晰
      // 2. 扩散阴影 (Diffuse Shadow): 中等距离，柔和
      // 3. 环境阴影 (Ambient Shadow): 大范围，非常柔和，营造悬浮感
      const shadows = [
        { blur: 4, offset: 4, opacity: 0.6 }, // 接触
        { blur: 16, offset: 12, opacity: 0.7 }, // 扩散
        { blur: 40, offset: 30, opacity: 0.5 } // 环境
      ]

      // 并行生成阴影层
      const shadowLayers = await Promise.all(
        shadows.map(async (s) => {
          const svg = Buffer.from(`
          <svg width="${width + s.blur * 4}" height="${height + s.blur * 4}">
            <rect
              x="${s.blur * 2}"
              y="${s.blur * 2}"
              width="${width}"
              height="${height}"
              rx="${borderRadius}"
              ry="${borderRadius}"
              fill="rgba(0,0,0,${s.opacity})"
            />
          </svg>
        `)

          return sharp(svg).blur(s.blur).png().toBuffer()
        })
      )

      // 构建合成操作列表
      const compositeOps = shadowLayers.map((layer, index) => {
        const s = shadows[index]
        return {
          input: layer,
          // 计算居中位置：
          // 画布中心是 padding, padding
          // layer 大小是 width + blur*4, height + blur*4
          // layer 内容中心在 blur*2, blur*2
          // 我们希望 layer 内容中心 偏移 offset 后 对齐 padding
          top: padding - s.blur * 2 + s.offset,
          left: padding - s.blur * 2
        }
      })

      // 添加截图本体
      compositeOps.push({
        input: roundedScreenshot,
        top: padding,
        left: padding
      })

      // 合成最终图像
      finalBuffer = await sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 } // 透明背景
        }
      })
        .composite(compositeOps)
        .png()
        .toBuffer()

      logger.info('[Screenshot] 已添加多层自然阴影效果')
    } catch (sharpError) {
      // 如果 sharp 不可用，直接保存原始截图
      logger.warn('[Screenshot] sharp 不可用，保存原始截图:', sharpError)
      finalBuffer = originalBuffer
    }

    await fs.writeFile(filePath, finalBuffer)

    logger.info('[Screenshot] 截图已保存:', filePath)

    return { success: true, filePath }
  } catch (error) {
    logger.error('[Screenshot] 截图失败:', error)
    return { success: false, error: String(error) }
  }
}

/**
 * 注册截图模式相关的 IPC 处理函数
 */
export function registerScreenshotIPC(): void {
  // 进入截图模式
  ipcMain.handle('screenshot:enter-mode', async () => {
    return await enterScreenshotMode()
  })

  // 退出截图模式
  ipcMain.handle('screenshot:exit-mode', async () => {
    return await exitScreenshotMode()
  })

  // 执行截图
  ipcMain.handle('screenshot:capture', async () => {
    return await captureScreenshot()
  })

  // 获取当前截图模式状态
  ipcMain.handle('screenshot:get-state', () => {
    return {
      isActive: isInScreenshotMode,
      padding: isInScreenshotMode ? SCREENSHOT_PADDING : 0
    }
  })

  logger.info('[Screenshot] IPC 处理函数已注册')
}
