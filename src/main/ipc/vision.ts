import { ipcMain, net } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import {
  analyzeImageWithConfiguredModel,
  hasConfiguredVisionModel,
  NO_VISION_MODEL_HINT
} from '../services/configuredImageAnalysis'
import { analyzeVideoWithConfiguredModel } from '../services/videoAnalysis/configuredVideoAnalysis'

const VIDEO_UNAVAILABLE =
  '没有已配置的视频理解模型。请在 设置 → 模型 的模型能力中勾选“视频”并保存。'

/** 视觉/音频识别请求参数 */
interface VisionAnalyzeArgs {
  mediaUrl?: string
  mediaPath?: string // 本地文件路径
  mediaType: 'image' | 'video'
  prompt?: string
}

/** 视觉识别结果 */
interface VisionResult {
  success: boolean
  markdown?: string
  content?: string
  /** 文档图片分析用这个字段，见 `vision:analyzeDocumentImage` */
  description?: string
  error?: string
  /** 媒体 URL（用于视频的 临时媒体 URL） */
  mediaUrl?: string
}

/**
 * 根据文件扩展名推断 MIME 类型
 */
function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeMap: Record<string, string> = {
    // 图片
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.bmp': 'image/bmp',
    // 视频
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    // 音频
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/m4a',
    '.aac': 'audio/aac',
    '.wma': 'audio/x-ms-wma'
  }
  return mimeMap[ext] || 'application/octet-stream'
}

/**
 * 读取本地文件并转换为 Base64
 */
async function readFileAsBase64(filePath: string): Promise<{ data: string; mimeType: string }> {
  const buffer = await fs.readFile(filePath)
  const data = buffer.toString('base64')
  const mimeType = inferMimeType(filePath)
  return { data, mimeType }
}

/**
 * 从 URL 下载并转换为 Base64
 */
async function downloadAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url })
    const chunks: Buffer[] = []
    let mimeType = 'application/octet-stream'

    request.on('response', (response) => {
      mimeType = (response.headers['content-type'] as string) || mimeType

      response.on('data', (chunk) => {
        chunks.push(chunk)
      })

      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const data = buffer.toString('base64')
        resolve({ data, mimeType })
      })

      response.on('error', (error) => {
        reject(error)
      })
    })

    request.on('error', (error) => {
      reject(error)
    })

    request.end()
  })
}

/**
 * 注册视觉/音频识别相关 IPC 处理器
 */
export function registerVisionIPC(): void {
  /** 分析图片、视频或音频内容 */
  ipcMain.handle(
    'vision:analyze',
    async (_event, args: VisionAnalyzeArgs): Promise<VisionResult> => {
      const { mediaUrl, mediaPath, mediaType, prompt } = args

      if (!mediaUrl && !mediaPath) {
        return { success: false, error: '媒体 URL 或路径不能为空' }
      }

      console.log(`[Vision IPC] 开始分析 ${mediaType}: ${mediaPath || mediaUrl?.slice(0, 50)}...`)

      try {
        // 获取 Base64 数据
        let mediaData: string
        let mimeType: string

        if (mediaPath) {
          // 从本地文件读取
          const fileInfo = await readFileAsBase64(mediaPath)
          mediaData = fileInfo.data
          mimeType = fileInfo.mimeType
          console.log(
            `[Vision IPC] 本地文件读取完成，大小: ${((mediaData.length * 0.75) / 1024 / 1024).toFixed(2)} MB`
          )
        } else if (mediaUrl) {
          // 如果是 Data URL，直接解析
          if (mediaUrl.startsWith('data:')) {
            const match = mediaUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              mimeType = match[1]
              mediaData = match[2]
            } else {
              return { success: false, error: '无效的 Data URL 格式' }
            }
          } else {
            // 从 URL 下载
            const downloadInfo = await downloadAsBase64(mediaUrl)
            mediaData = downloadInfo.data
            mimeType = downloadInfo.mimeType
            console.log(
              `[Vision IPC] URL 下载完成，大小: ${((mediaData.length * 0.75) / 1024 / 1024).toFixed(2)} MB`
            )
          }
        } else {
          return { success: false, error: '未提供有效的媒体来源' }
        }

        // 检查文件大小（100MB 限制）
        const sizeInBytes = mediaData.length * 0.75 // Base64 编码后约增大 33%
        if (sizeInBytes > 100 * 1024 * 1024) {
          return {
            success: false,
            error: `文件过大 (${(sizeInBytes / 1024 / 1024).toFixed(1)} MB)，限制 100MB`
          }
        }

        // 图片：用**用户自己配的模型**就地识别，不经过任何服务端，也不绑任何一家厂商
        if (mediaType === 'image') {
          const analyzed = await analyzeImageWithConfiguredModel({
            imageData: mediaData,
            mimeType,
            prompt
          })
          if (!analyzed) return { success: false, error: NO_VISION_MODEL_HINT }
          if (analyzed.success) {
            console.log(`[Vision IPC] 图片分析成功，结果长度: ${analyzed.markdown?.length || 0}`)
          }
          return analyzed
        }

        if (mediaType === 'video') {
          const result = await analyzeVideoWithConfiguredModel({
            data: mediaData,
            mimeType,
            prompt
          })
          return result ?? { success: false, error: VIDEO_UNAVAILABLE }
        }

        return { success: false, error: '不支持的媒体类型' }
      } catch (error) {
        console.error('[Vision IPC] 分析异常:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '分析请求失败'
        }
      }
    }
  )

  /** 简化的文档图片分析（用于 DOCX 内嵌图片） */
  ipcMain.handle(
    'vision:analyzeDocumentImage',
    async (
      _event,
      args: { imageUrl?: string; imagePath?: string; context?: string }
    ): Promise<{ success: boolean; description?: string; error?: string }> => {
      const { imageUrl, imagePath, context } = args
      console.log('[Vision IPC] 分析文档图片:', imagePath || imageUrl?.slice(0, 50))

      try {
        let imageData: string
        let mimeType: string

        if (imagePath) {
          const fileInfo = await readFileAsBase64(imagePath)
          imageData = fileInfo.data
          mimeType = fileInfo.mimeType
        } else if (imageUrl) {
          if (imageUrl.startsWith('data:')) {
            const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              mimeType = match[1]
              imageData = match[2]
            } else {
              return { success: false, error: '无效的 Data URL' }
            }
          } else {
            const downloadInfo = await downloadAsBase64(imageUrl)
            imageData = downloadInfo.data
            mimeType = downloadInfo.mimeType
          }
        } else {
          return { success: false, error: '请提供 imagePath 或 imageUrl' }
        }

        const analyzed = await analyzeImageWithConfiguredModel({ imageData, mimeType, context })
        return analyzed ?? { success: false, error: NO_VISION_MODEL_HINT }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '分析失败' }
      }
    }
  )

  /** 简化的 PDF 页面分析（用于扫描版 PDF） */
  ipcMain.handle(
    'vision:analyzePdfPage',
    async (
      _event,
      args: { imageUrl?: string; imagePath?: string; pageNumber?: number }
    ): Promise<{ success: boolean; content?: string; error?: string }> => {
      const { imageUrl, imagePath, pageNumber } = args
      console.log('[Vision IPC] 分析 PDF 页面:', pageNumber)

      try {
        let imageData: string
        let mimeType: string

        if (imagePath) {
          const fileInfo = await readFileAsBase64(imagePath)
          imageData = fileInfo.data
          mimeType = fileInfo.mimeType
        } else if (imageUrl) {
          if (imageUrl.startsWith('data:')) {
            const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              mimeType = match[1]
              imageData = match[2]
            } else {
              return { success: false, error: '无效的 Data URL' }
            }
          } else {
            const downloadInfo = await downloadAsBase64(imageUrl)
            imageData = downloadInfo.data
            mimeType = downloadInfo.mimeType
          }
        } else {
          return { success: false, error: '请提供 imagePath 或 imageUrl' }
        }

        const analyzed = await analyzeImageWithConfiguredModel({ imageData, mimeType })
        return analyzed ?? { success: false, error: NO_VISION_MODEL_HINT }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '分析失败' }
      }
    }
  )

  /** 检查视觉服务状态 */
  ipcMain.handle('vision:status', async () => {
    // 「有没有」要能回答，不能自己先炸。调用方本来就准备好处理 available:false。
    //
    // 判据是**用户有没有绑一个看得懂图的模型**，不是有没有某一家的 Key。
    // 主模型支持图片的话它自己就算数，不需要额外绑「视觉」。
    if (await hasConfiguredVisionModel()) {
      return { available: true }
    }
    return { available: false, error: NO_VISION_MODEL_HINT }
  })

  console.log('[Vision IPC] 处理器已注册')
}
