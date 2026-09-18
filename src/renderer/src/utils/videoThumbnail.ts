/**
 * 视频缩略图生成工具
 * 用于截取视频中间帧并生成缩略图
 */
import { toLocalResourceUrl } from './localResource'

/**
 * 视频文件扩展名列表
 */
const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.webm', '.m4v', '.flv']

/**
 * 判断文件是否为视频文件
 * @param fileName 文件名或文件路径
 * @returns 是否为视频文件
 */
export function isVideoFile(fileName: string): boolean {
  if (!fileName) return false
  const lowerName = fileName.toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => lowerName.endsWith(ext))
}

/**
 * 从视频文件截取中间帧作为缩略图
 * @param videoPath 视频文件的本地路径（file:// URL 或绝对路径）
 * @param options 配置选项
 * @returns Base64 编码的图片数据
 */
export async function captureVideoFirstFrame(
  videoPath: string,
  options: {
    width?: number
    height?: number
    quality?: number
  } = {}
): Promise<string> {
  const { width = 256, height = 256 } = options
  void options.quality // PNG 不吃 quality，保留形参只为兼容旧调用点

  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.playsInline = true
    // 只要元数据和一帧画面，不需要整段缓冲
    video.preload = 'metadata'

    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      video.onerror = null
      video.onloadedmetadata = null
      video.onseeked = null
      video.src = ''
      video.load()
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const done = (value: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    // 必须有超时：编解码器不支持时（如 ProRes、部分 HEVC），
    // onerror 和 onseeked 可能都不触发，没有超时这个 Promise 会永远挂着，
    // 调用方也就永远等不到回退路径。
    const timer = setTimeout(() => fail(new Error(`视频解码超时: ${videoPath}`)), 15000)

    // 本地路径必须转成 local-resource://：dev 模式下 <video src="file:///..."> 加载不了
    const videoUrl = toLocalResourceUrl(videoPath) ?? videoPath

    video.onerror = () => fail(new Error(`无法加载视频: ${videoPath}`))

    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        fail(new Error(`读不到视频时长: ${videoPath}`))
        return
      }
      // 取中间帧：开头常常是黑场或台标
      video.currentTime = Math.max(0.1, video.duration / 2)
    }

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height

        const ctx = canvas.getContext('2d')
        if (!ctx) {
          fail(new Error('无法获取 Canvas 2D 上下文'))
          return
        }

        // 按比例缩放并居中，不要把 16:9 硬拉成正方形
        const scale = Math.min(width / video.videoWidth, height / video.videoHeight)
        const drawWidth = video.videoWidth * scale
        const drawHeight = video.videoHeight * scale
        ctx.drawImage(
          video,
          (width - drawWidth) / 2,
          (height - drawHeight) / 2,
          drawWidth,
          drawHeight
        )

        done(canvas.toDataURL('image/png'))
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }

    video.src = videoUrl
  })
}

/**
 * 批量生成视频缩略图
 * @param videoFiles 视频文件路径数组
 * @param options 配置选项
 * @returns 视频路径到缩略图 base64 的映射
 */
export async function batchCaptureVideoFrames(
  videoFiles: Array<{ path: string; assetKey: string }>,
  options: {
    width?: number
    height?: number
    quality?: number
    onProgress?: (current: number, total: number) => void
  } = {}
): Promise<Array<{ assetKey: string; path: string; thumbnail: string; error?: string }>> {
  const results: Array<{ assetKey: string; path: string; thumbnail: string; error?: string }> = []

  for (let i = 0; i < videoFiles.length; i++) {
    const file = videoFiles[i]
    try {
      const thumbnail = await captureVideoFirstFrame(file.path, options)
      results.push({
        assetKey: file.assetKey,
        path: file.path,
        thumbnail
      })
    } catch (error) {
      console.error(`[VideoThumbnail] 截取视频首帧失败: ${file.path}`, error)
      results.push({
        assetKey: file.assetKey,
        path: file.path,
        thumbnail: '',
        error: error instanceof Error ? error.message : String(error)
      })
    }

    // 调用进度回调
    if (options.onProgress) {
      options.onProgress(i + 1, videoFiles.length)
    }
  }

  return results
}
