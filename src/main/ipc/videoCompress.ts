/**
 * 视频压缩 IPC 处理器
 * 提供视频压缩功能的前端接口
 */

import { ipcMain } from 'electron'
import {
  compressVideo,
  compressVideoFast,
  CompressOptions,
  CompressResult
} from '../services/videoCompressor'

/**
 * 注册视频压缩相关的 IPC 处理函数
 */
export function registerVideoCompressIPC(): void {
  /**
   * 压缩视频到 100MB 以下（双遍编码，精确控制大小）
   *
   * @param inputPath - 输入视频路径
   * @param outputPath - 输出视频路径（可选）
   * @param options - 压缩配置
   */
  ipcMain.handle(
    'video:compress',
    async (
      _event,
      inputPath: string,
      outputPath?: string,
      options?: Omit<CompressOptions, 'onProgress'>
    ): Promise<CompressResult> => {
      console.log('[VideoCompress IPC] 开始压缩:', inputPath)
      const result = await compressVideo(inputPath, outputPath, options)
      console.log(
        '[VideoCompress IPC] 压缩结果:',
        result.success ? `${result.outputSizeMB?.toFixed(2)} MB` : result.error
      )
      return result
    }
  )

  /**
   * 快速压缩视频（单遍，速度更快）
   * 适用于不需要严格控制大小的场景
   */
  ipcMain.handle(
    'video:compressFast',
    async (
      _event,
      inputPath: string,
      outputPath?: string,
      options?: Omit<CompressOptions, 'onProgress'>
    ): Promise<CompressResult> => {
      console.log('[VideoCompress IPC] 快速压缩:', inputPath)
      const result = await compressVideoFast(inputPath, outputPath, options)
      console.log(
        '[VideoCompress IPC] 压缩结果:',
        result.success ? `${result.outputSizeMB?.toFixed(2)} MB` : result.error
      )
      return result
    }
  )

  /**
   * 为 AI 分析压缩视频（预设参数优化）
   * 使用最佳参数配置，确保视频适合发送给多模态大模型
   */
  ipcMain.handle(
    'video:compressForAI',
    async (_event, inputPath: string, outputPath?: string): Promise<CompressResult> => {
      console.log('[VideoCompress IPC] AI 分析压缩:', inputPath)

      // AI 分析优化参数
      const aiOptions: Omit<CompressOptions, 'onProgress'> = {
        targetSizeMB: 70, // Base64 膨胀后约 93MB，确保不超 100MB 限制
        fps: 15, // 15fps 足够 AI 理解画面
        width: 1280, // 720p 是 VLM 推荐分辨率
        audioBitrate: 96, // 96k AAC 足够语音识别
        monoAudio: true, // 单声道节省带宽
        crfMax: 32 // 允许较高压缩
      }

      // 如果未指定输出路径，使用系统临时目录（便于清理且不污染用户文件夹）
      if (!outputPath) {
        const { app } = await import('electron')
        const path = await import('path')
        const tempDir = app.getPath('temp')
        const timestamp = Date.now()
        const randomSuffix = Math.random().toString(36).substring(2, 8)
        outputPath = path.join(tempDir, `unreal_agent_ai_video_${timestamp}_${randomSuffix}.mp4`)
        console.log('[VideoCompress IPC] 使用临时目录输出:', outputPath)
      }

      const result = await compressVideo(inputPath, outputPath, aiOptions)
      console.log(
        '[VideoCompress IPC] AI 压缩结果:',
        result.success ? `${result.outputSizeMB?.toFixed(2)} MB` : result.error
      )
      return result
    }
  )

  console.log('[VideoCompress] IPC 处理器注册完成')
}
