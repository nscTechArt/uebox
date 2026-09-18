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
 * OpenAI Chat Completions 兼容或 Google Generative AI。没配就如实说去哪配，
 * 不去猜、不拿一个不支持的模型硬发。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { analyzeVideoSource } from '../../../services/videoAnalysis/videoSourceAnalysis'

const AnalyzeVideoInput = z.object({
  video_path: z
    .string()
    .min(1)
    .describe(
      '视频文件的**本地绝对路径**、HTTP(S) 视频直链或 Bilibili 完整视频页面 URL（自动解析）。`generate_video` 返回值里的 `video_path` 直接可用。' +
        '支持 mp4/mov/webm/mkv/avi/m4v'
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
}

export function createAnalyzeVideoTool(): UnrealAgentTool<AnalyzedVideoDetails> {
  return defineTool<typeof AnalyzeVideoInput, AnalyzedVideoDetails>({
    name: 'analyze_video',
    namespace: 'aigc',
    risk: 'safe',
    description: `让能看视频的模型看一段本地视频、视频直链或 Bilibili 视频，把看到的讲给你听。

【什么时候用】：
- **刚用 \`generate_video\` 出完片** —— 把返回值里的 \`video_path\` 传进来，
  你就能知道这段片子到底长什么样，而不是只能转述参数
- 用户给了一段视频文件、视频直链或 B 站完整视频链接，问里面有什么、有没有问题
- B 站链接自动解析；其他网页及 b23.tv 短链接暂不支持，请使用完整视频 URL
- 用户说「这段不太对」而你不知道他指什么时，先看一眼再问

【它不是你自己在看】：发给的是用户在 设置 → 模型 里**勾了「视频」能力**的那个模型，
回来的是那个模型写的一段描述。所以：
- 没配这样的模型时会明确报错，告诉用户去哪勾。**这时不要假装看过**
- 描述可能有出入。涉及「好不好看」这类主观判断，仍然以用户的判断为准

【要花钱、也要时间】：一整段视频发过去按 token 计费，长片子要等一会儿。
同一段视频看一次就够了，别为了确认再看一遍 —— 有新问题就在 \`question\` 里一次问清。`,
    input: AnalyzeVideoInput,
    execute: async (args, ctx) => {
      ctx.report({ text: '正在看视频…' })

      const analyzed = await analyzeVideoSource({
        source: args.video_path,
        ...(args.question ? { prompt: args.question } : {}),
        onProgress: (note) => ctx.report({ text: note })
      })

      if (!analyzed.success) {
        return { isError: true, text: analyzed.error || '视频分析失败' }
      }

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
