/**
 * 看一段视频。
 *
 * ## 为什么补这个工具
 *
 * 后端一直有这条能力：用户在 设置 → 模型 里给某个模型勾上「视频」，
 * `services/videoAnalysis/` 就能把一段视频发过去让它看。界面上的视频理解走的就是它。
 *
 * 但工具箱里没有对应的入口，于是 `generate_video` 出完片只能说一句「这段视频你看不到，
 * 好不好看你自己判断」—— 用户看到的是「盒子明明配了能看视频的模型，AI 却说它瞎」。
 * 这正是「工具不许比后端窄」那条：后端有的能力，模型必须够得着。
 *
 * ## 边界
 *
 * 只有**用户显式勾了「视频」能力的模型**才做得了这件事，而且要那家的协议是
 * OpenAI Chat Completions 兼容或 Google Generative AI。不拿一个不支持的模型硬发。
 *
 * ## 看不成时改看关键帧
 *
 * 没配视频模型、或者它这次没看成（厂商拒收、超时……），用户要的仍然是「AI 看一眼」。
 * 真机上这时 agent 只能自己去 shell 里找 ffmpeg，落进 WSL 失败，最后请用户「补几张截图」——
 * 把盒子该干的活推回给了用户。所以这里直接抽帧拼联系表交回去（盒子自带 Chromium 解码，
 * 不依赖用户装什么），并写明这是静帧：没有声音、看不到帧间运动。
 */

import { z } from 'zod'

import path from 'node:path'
import { promises as fs } from 'node:fs'

import { defineTool, type ToolOutcome, type UnrealAgentTool } from '../defineTool'
import { CONTACT_SHEET_MAX_WIDTH, compressForContext } from '../contextImage'
import { NO_VIDEO_MODEL_HINT } from '../../../services/videoAnalysis/videoFileAnalysis'
import { analyzeVideoSource } from '../../../services/videoAnalysis/videoSourceAnalysis'
import {
  cleanupContactSheets,
  describeContactSheets,
  type VideoFramesResult
} from '../../../services/videoAnalysis/videoFrameFallback'

const AnalyzeVideoInput = z.object({
  video_path: z
    .string()
    .min(1)
    .describe(
      '视频或音频文件的**本地绝对路径**、HTTP(S) 视频直链或 Bilibili 完整视频页面 URL（自动解析）。`generate_video` 返回值里的 `video_path` 直接可用。' +
        '视频支持 mp4/mov/webm/mkv/avi/m4v，音频支持 mp3/wav/flac/ogg/m4a/aac/opus/aiff'
    ),
  question: z
    .string()
    .optional()
    .describe(
      '想让它回答什么。不填就给一份通用的内容摘要。' +
        '**问得越具体越有用**：「镜头是怎么运动的」「人物有没有变形」「节奏是不是太慢」'
    )
})

export interface AnalyzedVideoDetails extends Record<string, unknown> {
  success: boolean
  video_path: string
  /** 这次是谁看的。看走眼时用户得知道该换谁 */
  model?: string
  /** 视频太大压过一遍再发的。画质与原片不同，要说 */
  compressed?: boolean
  /** 视频模型没看成，看的是抽帧联系表 */
  frames?: boolean
}

export function createAnalyzeVideoTool(): UnrealAgentTool<AnalyzedVideoDetails> {
  return defineTool<typeof AnalyzeVideoInput, AnalyzedVideoDetails>({
    name: 'analyze_video',
    namespace: 'aigc',
    risk: 'safe',
    description: `让多模态模型看一段视频、或听一段音频，把内容讲给你听。
支持本地文件、视频直链和 Bilibili 视频；音频只收本地文件。

【什么时候用】：
- **刚用 \`generate_video\` 出完片** —— 把返回值里的 \`video_path\` 传进来，
  你就能知道这段片子到底长什么样，而不是只能转述参数
- 用户给了一段视频文件、视频直链或 B 站完整视频链接，问里面有什么、有没有问题
- 用户给了一段音频（录音、配音、BGM），问里面说了什么 —— 音频走同一批模型，
  默认会给一份摘要加逐段转写
- B 站链接自动解析；其他网页及 b23.tv 短链接暂不支持，请使用完整视频 URL
- 用户说「这段不太对」而你不知道他指什么时，先看一眼再问

【它不是你自己在看】：发给的是用户在 设置 → 模型 里**勾了「视频」能力**的那个模型，
回来的是那个模型写的一段描述。描述可能有出入，「好不好看」仍以用户的判断为准。

【看不成时自动改看关键帧】：没配视频模型、或它这次没看成，会直接把视频抽成带时间标记的
联系表图片交给你 —— 不用再自己找 ffmpeg 抽帧，也**不要请用户截图**。
静帧没有声音、看不到帧间运动，涉及节奏、音效、运镜的判断要说明是凭静帧推测的。

【要花钱、也要时间】：一整段视频发过去按 token 计费，长片子要等一会儿。
同一段视频看一次就够了，别为了确认再看一遍 —— 有新问题就在 \`question\` 里一次问清。`,
    input: AnalyzeVideoInput,
    execute: async (args, ctx) => {
      ctx.report({ text: '正在看视频…' })

      const analyzed = await analyzeVideoSource({
        source: args.video_path,
        ...(args.question ? { prompt: args.question } : {}),
        onProgress: (note) => ctx.report({ text: note }),
        framesFallback: true
      })

      if (!analyzed.success) {
        return { isError: true, text: analyzed.error || '视频分析失败' }
      }
      if (analyzed.frames) return framesOutcome(args.video_path, analyzed.frames, analyzed.error)

      const lines: string[] = []
      if (analyzed.compressed) {
        lines.push(
          '（视频太大，压缩后才发出去的，画质比原片低 —— 画质本身的判断不要基于这段描述。）'
        )
      }
      lines.push(`${analyzed.model} 看完这段视频后的描述：`)
      lines.push(analyzed.markdown || '（模型没有给出内容）')

      return {
        text: lines.join('\n'),
        details: {
          success: true,
          video_path: args.video_path,
          ...(analyzed.model ? { model: analyzed.model } : {}),
          ...(analyzed.compressed ? { compressed: true } : {})
        }
      }
    }
  })
}

/** 视频模型没看成的原因，压成一句话放进联系表说明的开头 */
function modelMissReason(error?: string): string {
  const first = (error ?? '').split('\n')[0].trim()
  if (!first) return '视频模型这次没看成'
  return first === NO_VIDEO_MODEL_HINT
    ? '没有配置能看视频的模型'
    : `视频模型这次没看成（${first.slice(0, 160)}）`
}

/** 联系表读进上下文，读完就删 */
async function framesOutcome(
  videoPath: string,
  frames: VideoFramesResult,
  modelError?: string
): Promise<ToolOutcome<AnalyzedVideoDetails>> {
  const sheetPaths = frames.sheetPaths ?? []
  try {
    const images: { data: string; mimeType: string }[] = []
    for (const sheet of sheetPaths) {
      const compressed = await compressForContext(await fs.readFile(sheet), {
        maxWidth: CONTACT_SHEET_MAX_WIDTH
      })
      if (compressed) images.push({ data: compressed.data, mimeType: compressed.mimeType })
    }
    const lines = [
      describeContactSheets(frames, path.basename(videoPath), modelMissReason(modelError))
    ]
    if (images.length < sheetPaths.length) {
      lines.push(`（${sheetPaths.length - images.length} 张联系表没能压进上下文，你看到的不全。）`)
    }
    if (modelError === NO_VIDEO_MODEL_HINT) {
      lines.push(
        '想连声音和动作一起看，可以告诉用户：到 设置 → 模型 给一个支持视频的模型勾上「视频」。'
      )
    }
    return {
      text: lines.join('\n'),
      images,
      details: { success: true, video_path: videoPath, frames: true }
    }
  } finally {
    await cleanupContactSheets(sheetPaths)
  }
}
