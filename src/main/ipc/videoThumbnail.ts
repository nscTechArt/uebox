import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { PathManager } from '../utils/PathManager'
import { findFFmpeg, getFFmpegStatus, resetFFmpegCache } from '../services/ffmpegPath'
import { uploadThumbnailToRemoteIfNeeded } from '../sqliteDataBase/ipc/assetData/thumbnails'

// FFmpeg 相关导入

let ffmpeg: typeof import('fluent-ffmpeg') | null = null
let ffmpegPath: string | null = null

/**
 * 初始化 FFmpeg
 * 延迟加载以避免启动时的依赖问题
 */
/**
 * 初始化 FFmpeg
 * 延迟加载以避免启动时的依赖问题
 */
async function initFFmpeg(): Promise<boolean> {
  if (ffmpeg && ffmpegPath) return true

  try {
    // 动态导入 fluent-ffmpeg
    const fluentFFmpeg = await import('fluent-ffmpeg')
    // @ts-ignore - 处理默认导出和命名导出的差异
    ffmpeg = fluentFFmpeg.default || fluentFFmpeg

    // 路径解析统一交给 services/ffmpegPath —— 此前这里另有一份候选清单，
    // 与另外三处各不相同，改一处修不干净
    ffmpegPath = await findFFmpeg()

    if (ffmpegPath && ffmpeg) {
      // @ts-ignore - setFfmpegPath 是 fluent-ffmpeg 的方法
      ffmpeg.setFfmpegPath(ffmpegPath)
      console.log('[VideoThumbnail] FFmpeg 初始化成功:', ffmpegPath)
      return true
    }
  } catch (error) {
    console.error('[VideoThumbnail] FFmpeg 初始化失败:', error)
  }

  return false
}

/**
 * 视频文件扩展名列表
 */
const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.webm', '.m4v', '.flv']

/**
 * 注册视频缩略图相关的 IPC 处理函数
 */
export function registerVideoThumbnailIPC(): void {
  /**
   * 获取视频时长（秒）
   * @param videoPath 视频文件路径
   * @returns 视频时长（秒）
   */
  async function getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg!.ffprobe(
        videoPath,
        (err: Error | null, metadata: { format?: { duration?: number } }) => {
          if (err) {
            reject(err)
            return
          }
          const duration = metadata?.format?.duration || 0
          resolve(duration)
        }
      )
    })
  }

  /**
   * 将秒数转换为 HH:MM:SS.mmm 格式
   * @param seconds 秒数
   * @returns 时间字符串
   */
  function formatTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`
  }

  /**
   * 使用 FFmpeg 提取视频中间帧并保存为缩略图。
   *
   * 返回的是**纯文件名**，不带 `thumbnails/` 前缀 —— 渲染层要拿它写 customPoster，
   * 而 `db:assetData:update` 的字段闸只收纯文件名（见 assetData/updateGuard.ts）。
   * 目录前缀本来也不该进库：本地库是 `thumbnails/`，SMB 网络库是 `.thumbnails/`。
   *
   * @param videoPath 视频文件的绝对路径
   * @param assetKey 资产的唯一键
   * @returns 缩略图文件名
   */
  ipcMain.handle(
    'video:extractAndSaveThumbnail',
    async (_event, videoPath: string, assetKey: string) => {
      try {
        console.log('[VideoThumbnail] 开始提取视频缩略图:', assetKey, videoPath)

        // 初始化 FFmpeg
        const ffmpegReady = await initFFmpeg()
        if (!ffmpegReady || !ffmpeg) {
          throw new Error('FFmpeg 初始化失败')
        }

        // 获取当前 vault 路径
        const pathManager = PathManager.getInstance()
        const vaultPath = pathManager.getCurrentVaultPath()

        if (!vaultPath) {
          throw new Error('无法获取保管库路径')
        }

        // 处理相对路径：如果传入的路径不是绝对路径，则拼接 vaultPath
        // 检测绝对路径：Windows 盘符 (如 C:/) 或 Unix 根路径 (/)
        const isAbsolutePath = /^[a-zA-Z]:[\\/]/.test(videoPath) || videoPath.startsWith('/')
        const absoluteVideoPath = isAbsolutePath ? videoPath : path.join(vaultPath, videoPath)

        console.log('[VideoThumbnail] 使用绝对路径:', absoluteVideoPath)

        // 创建缩略图目录 - 使用 getThumbnailsPath 正确处理网络库
        const thumbnailsDir = pathManager.getThumbnailsPath()
        await fs.mkdir(thumbnailsDir, { recursive: true })

        // 生成文件名
        const timestamp = Date.now()
        const fileName = `video-${assetKey.substring(0, 8)}-${timestamp}.png`
        const outputPath = path.join(thumbnailsDir, fileName)

        // 获取视频时长并计算中间帧时间点
        let middleTimestamp = '00:00:00.100' // 默认回退值
        try {
          const duration = await getVideoDuration(absoluteVideoPath)
          const middleTime = Math.max(0.1, duration / 2) // 最少0.1秒，避开黑帧
          middleTimestamp = formatTimestamp(middleTime)
          console.log(`[VideoThumbnail] 视频时长: ${duration}s, 中间帧时间点: ${middleTimestamp}`)
        } catch (probeError) {
          console.warn('[VideoThumbnail] 获取视频时长失败，使用默认时间点:', probeError)
        }

        // 使用 FFmpeg 提取中间帧
        await new Promise<void>((resolve, reject) => {
          ffmpeg!(absoluteVideoPath)
            .screenshots({
              timestamps: [middleTimestamp], // 截取中间帧
              filename: fileName,
              folder: thumbnailsDir,
              size: '256x256'
            })
            .on('end', () => {
              console.log('[VideoThumbnail] FFmpeg 缩略图生成成功:', outputPath)
              resolve()
            })
            .on('error', (err: Error) => {
              console.error('[VideoThumbnail] FFmpeg 缩略图生成失败:', err)
              reject(err)
            })
        })

        // 远程库要先把文件推上去再让渲染层写库，否则库里留的是一条本机才看得见的引用
        await uploadThumbnailToRemoteIfNeeded(fileName)

        return {
          success: true,
          data: fileName,
          absolutePath: outputPath
        }
      } catch (error) {
        console.error('[VideoThumbnail] 提取视频缩略图失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  /**
   * 检查文件是否为视频文件
   * @param filePath 文件路径
   * @returns 是否为视频文件
   */
  ipcMain.handle('video:isVideoFile', async (_event, filePath: string) => {
    try {
      const ext = path.extname(filePath).toLowerCase()
      const isVideo = VIDEO_EXTENSIONS.includes(ext)

      return {
        success: true,
        data: isVideo,
        extension: ext
      }
    } catch (error) {
      console.error('[VideoThumbnail] 检查视频文件失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  /**
   * 检查 FFmpeg 是否可用
   */
  /**
   * FFmpeg 是否可用，以及不可用时该怎么装。
   *
   * 每次调用都先 resetFFmpegCache：用户很可能是**看到提示后刚装完**再回来点
   * 一下重试的，若沿用缓存会一直显示「未检测到」，逼他重启应用。
   */
  ipcMain.handle('video:checkFFmpegAvailable', async () => {
    try {
      resetFFmpegCache()
      const status = await getFFmpegStatus()
      return {
        success: true,
        // data 保留布尔值，兼容既有调用点
        data: status.available,
        ...status
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  console.log('[VideoThumbnail] IPC 处理器注册完成')
}
