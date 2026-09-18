import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { analyzeLocalVideoFile, type VideoFileAnalysisResult } from './videoFileAnalysis'
import {
  BILIBILI_PLAYBACK_HEADERS,
  isValidBilibiliUrl,
  resolveBilibiliVideoUrl
} from './bilibiliVideoSource'

/**
 * 远端视频一律先下到本地再发，不把 URL 转手给模型厂商。
 *
 * 两个原因，都是「转手就废」：
 * 1. B 站直链靠 Referer 挡站外播放，厂商那边发不出这个头，拿到的是 403。
 * 2. Gemini 的 `fileData.fileUri` 只收 Files API 的 URI 和 YouTube 链接，
 *    随便一个 https 地址会被 400 顶回来。
 * 下到本地之后交给 `analyzeLocalVideoFile`，超限压缩、MIME、模型选择都复用它那一套。
 */
const MAX_DOWNLOAD_MB = 500
const VIDEO_EXTENSION = /\.(mp4|mov|webm|mkv|avi|m4v)$/i

async function downloadToTempFile(
  url: string,
  headers: Record<string, string>,
  extension: string
): Promise<string> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) {
    throw new Error(`下载视频失败：HTTP ${response.status}`)
  }
  const target = path.join(tmpdir(), `uebox-video-${randomUUID()}${extension}`)
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target))
    // 服务端不一定给 content-length，所以落盘之后按实际大小兜一道，
    // 免得一条没有长度的流把临时盘写满。
    const { size } = await fs.stat(target)
    if (size > MAX_DOWNLOAD_MB * 1024 * 1024) {
      throw new Error(
        `视频有 ${(size / 1024 / 1024).toFixed(0)}MB，超过 ${MAX_DOWNLOAD_MB}MB 上限，发不出去`
      )
    }
    return target
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => {})
    throw error
  }
}

/** 本地文件、视频直链与平台页面共用的分析入口。 */
export async function analyzeVideoSource(args: {
  source: string
  prompt?: string
  onProgress?: (note: string) => void
}): Promise<VideoFileAnalysisResult> {
  const source = args.source.trim()
  if (!/^https?:\/\//i.test(source)) {
    return analyzeLocalVideoFile({
      filePath: source,
      prompt: args.prompt,
      onProgress: args.onProgress
    })
  }

  try {
    const parsed = new URL(source)
    let downloadUrl = source
    let headers: Record<string, string> = {}
    // B 站页面本身没有扩展名，直链多是 mp4/flv 流，按 mp4 落盘。
    let extension = '.mp4'

    if (isValidBilibiliUrl(source)) {
      args.onProgress?.('正在解析 B 站视频链接…')
      const resolved = await resolveBilibiliVideoUrl(source)
      if (!resolved.success) return { success: false, error: resolved.error }
      downloadUrl = resolved.data
      headers = BILIBILI_PLAYBACK_HEADERS
    } else {
      const matched = VIDEO_EXTENSION.exec(parsed.pathname)
      if (!matched) {
        return {
          success: false,
          error:
            '请提供 Bilibili 完整视频链接或视频文件直链（mp4/mov/webm/mkv/avi/m4v），暂不支持其他网页或短链接。'
        }
      }
      extension = matched[0].toLowerCase()
    }

    args.onProgress?.('正在下载视频…')
    const file = await downloadToTempFile(downloadUrl, headers, extension)
    try {
      return await analyzeLocalVideoFile({
        filePath: file,
        prompt: args.prompt,
        onProgress: args.onProgress
      })
    } finally {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '视频分析失败' }
  }
}
