/**
 * 让配好的多模态模型听一段本地音频。
 *
 * ## 为什么和视频放在一起
 *
 * 能看视频的模型基本都能听音频 —— 视频本来就带声轨，厂商那边是同一套多模态
 * 接口，只是请求分片从 `video_url` 换成 `input_audio`（Google 那边连这个都不用换）。
 * 所以这里**复用视频那一路的模型选择**：用户在 设置 → 模型 勾了「视频」的那个，
 * 就是这里要用的那个，不再单开一个「音频」开关让人多勾一次。
 *
 * 代价写在明处：勾了视频但实际不支持音频的模型会在请求那一步报错。
 * 那条错误原样透出去 —— 比事先猜「你这个模型大概不行」要诚实。
 */

import { promises as fs } from 'fs'
import path from 'path'

import {
  analyzeVideoWithConfiguredModel,
  findConfiguredVideoModel
} from './configuredVideoAnalysis'
import { NO_VIDEO_MODEL_HINT, type VideoFileAnalysisResult } from './videoFileAnalysis'
import { readSettings } from '../../ai/store'

/**
 * 音频不压缩，超了直接说。
 *
 * 视频那边超限会先用 ffmpeg 压一遍，音频这里不做：一段 100MB 的音频多半是
 * 几小时的录音，压完还是几十 MB，而且转码要 ffmpeg —— 它不一定装了。
 * 与其绕一大圈再失败，不如明说太长了。
 */
const MAX_AUDIO_SIZE_MB = 100

/** 能送去理解的音频扩展名 */
const AUDIO_EXTENSION = /\.(mp3|wav|flac|ogg|m4a|aac|opus|aiff)$/i

const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.aiff': 'audio/aiff'
}

/**
 * 让模型听一段本地音频。
 *
 * @param args.filePath 音频文件的绝对路径
 * @param args.prompt 想让它回答什么。不填走默认的「摘要 + 逐段转写」
 */
export async function analyzeLocalAudioFile(args: {
  filePath: string
  prompt?: string
  onProgress?: (note: string) => void
}): Promise<VideoFileAnalysisResult> {
  const filePath = String(args.filePath ?? '').trim()
  if (!filePath) return { success: false, error: '没有给音频路径' }
  if (!AUDIO_EXTENSION.test(filePath.split(/[?#]/)[0])) {
    return {
      success: false,
      error: `${filePath} 不像音频文件（支持 mp3/wav/flac/ogg/m4a/aac/opus/aiff）`
    }
  }

  const selected = findConfiguredVideoModel(await readSettings())
  if (!selected) return { success: false, error: NO_VIDEO_MODEL_HINT }
  const modelLabel = `${selected.provider.displayName}:${selected.model.id}`

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(filePath)
  } catch {
    return { success: false, error: `找不到音频文件：${filePath}` }
  }

  const sizeMB = stat.size / 1024 / 1024
  if (sizeMB > MAX_AUDIO_SIZE_MB) {
    return {
      success: false,
      error: `音频有 ${sizeMB.toFixed(0)}MB，超过 ${MAX_AUDIO_SIZE_MB}MB 上限，发不出去。请先剪短或压缩。`
    }
  }

  const buffer = await fs.readFile(filePath)
  args.onProgress?.(`正在让 ${modelLabel} 听这段音频…`)

  const analyzed = await analyzeVideoWithConfiguredModel({
    data: buffer.toString('base64'),
    mimeType: MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'audio/mpeg',
    kind: 'audio',
    ...(args.prompt ? { prompt: args.prompt } : {})
  })

  // 上面查过有模型，这里的 null 只可能是配置在两次读取之间被改掉了
  if (!analyzed) return { success: false, error: NO_VIDEO_MODEL_HINT }
  if (!analyzed.success) {
    return { success: false, model: modelLabel, error: analyzed.error || '音频分析失败' }
  }

  return {
    success: true,
    model: modelLabel,
    ...(analyzed.markdown ? { markdown: analyzed.markdown } : {})
  }
}
