import { promises as fs } from 'fs'
import path from 'path'

import { compressVideoFast, type CompressOptions } from '../videoCompressor'
import {
  analyzeVideoWithConfiguredModel,
  findConfiguredVideoModel
} from './configuredVideoAnalysis'
import { readSettings } from '../../ai/store'

/**
 * 超过这个大小就先压一遍再发。
 *
 * 与 `ipc/vision.ts` 用的是同一个数：多模态厂商那边普遍卡在 100MB 上下，
 * 而 base64 还要再胀三成。压缩参数也保持一致 —— 同一段视频，界面里能看懂的，
 * agent 这边不该看不懂。
 */
const MAX_VIDEO_SIZE_MB = 100

/** 压到能发出去为止的参数。与 `ipc/vision.ts` 里 AI 分析那一档相同 */
const COMPRESS_OPTIONS: CompressOptions = {
  targetSizeMB: MAX_VIDEO_SIZE_MB,
  fps: 24,
  width: 1920,
  audioBitrate: 128,
  monoAudio: false,
  crfMax: 28
}

/** 能送去理解的视频扩展名。别的格式厂商多半直接拒收，早一步说清比等超时强 */
const VIDEO_EXTENSION = /\.(mp4|mov|webm|mkv|avi|m4v)$/i

/** 按扩展名给 MIME。认不出来按 mp4 —— 走到这里的扩展名已经过了上面那道 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
}

/** 没有可用模型时给的话。写明去哪勾、勾哪一项，别只说「不可用」 */
export const NO_VIDEO_MODEL_HINT =
  '没有能看视频的模型。请到 设置 → 模型，在某个对话模型的「能力」里勾上「视频」并保存 ' +
  '（要那个模型本身支持视频输入，如豆包 / 通义千问 / Gemini 的多模态型号）。'

export interface VideoFileAnalysisResult {
  success: boolean
  /** 模型看完之后写的东西 */
  markdown?: string
  /** 这次是谁看的，形如 `阿里云百炼:qwen3.8-max` */
  model?: string
  /** 太大压过一遍。要如实说 —— 压过的画质和原片不是一回事 */
  compressed?: boolean
  error?: string
}

/**
 * 让配好的视频模型看一段本地视频。
 * @param args.filePath 视频文件的绝对路径
 * @param args.prompt 想让它回答什么。不填走 `configuredVideoAnalysis` 的通用提示词
 */
export async function analyzeLocalVideoFile(args: {
  filePath: string
  prompt?: string
  onProgress?: (note: string) => void
}): Promise<VideoFileAnalysisResult> {
  const filePath = String(args.filePath ?? '').trim()
  if (!filePath) return { success: false, error: '没有给视频路径' }
  if (!VIDEO_EXTENSION.test(filePath.split(/[?#]/)[0])) {
    return { success: false, error: `${filePath} 不像视频文件（支持 mp4/mov/webm/mkv/avi/m4v）` }
  }

  const selected = findConfiguredVideoModel(await readSettings())
  if (!selected) return { success: false, error: NO_VIDEO_MODEL_HINT }
  const modelLabel = `${selected.provider.displayName}:${selected.model.id}`

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(filePath)
  } catch {
    return { success: false, error: `找不到视频文件：${filePath}` }
  }

  // 太大的先压。压缩产物是临时文件，读完就删 —— 素材库里那份原片不能动
  let sourcePath = filePath
  let compressedPath: string | undefined
  const sizeMB = stat.size / 1024 / 1024
  if (sizeMB > MAX_VIDEO_SIZE_MB) {
    args.onProgress?.(`视频 ${sizeMB.toFixed(0)}MB，超过 ${MAX_VIDEO_SIZE_MB}MB，先压一遍…`)
    const compressed = await compressVideoFast(filePath, undefined, COMPRESS_OPTIONS).catch(
      (error: unknown) => ({
        success: false as const,
        error: error instanceof Error ? error.message : String(error)
      })
    )
    if (!compressed.success || !('outputPath' in compressed) || !compressed.outputPath) {
      return {
        success: false,
        error: `视频有 ${sizeMB.toFixed(0)}MB，压缩失败（${compressed.error || '原因未知'}），发不出去`
      }
    }
    sourcePath = compressed.outputPath
    compressedPath = compressed.outputPath
  }

  try {
    const buffer = await fs.readFile(sourcePath)
    args.onProgress?.(`正在让 ${modelLabel} 看这段视频…`)
    const analyzed = await analyzeVideoWithConfiguredModel({
      data: buffer.toString('base64'),
      mimeType: MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'video/mp4',
      ...(args.prompt ? { prompt: args.prompt } : {})
    })

    // 上面已经查过有模型，这里的 null 只可能是配置在两次读取之间被改掉了
    if (!analyzed) return { success: false, error: NO_VIDEO_MODEL_HINT }
    if (!analyzed.success) {
      return { success: false, model: modelLabel, error: analyzed.error || '视频分析失败' }
    }

    return {
      success: true,
      model: modelLabel,
      ...(analyzed.markdown ? { markdown: analyzed.markdown } : {}),
      ...(compressedPath ? { compressed: true } : {})
    }
  } finally {
    if (compressedPath) await fs.unlink(compressedPath).catch(() => {})
  }
}
