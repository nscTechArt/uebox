/**
 * AI 生成视频工具。
 *
 * ## 与生图最大的差别：慢、贵、不可取消一半
 *
 * 一次三到十五分钟，按秒计费，失败也扣。所以这个工具与 `generate_image`
 * 有三处刻意的不同：
 *
 * 1. **不返回视频进模型上下文**。生图会把图压一压附回去让模型自己看一眼，
 *    视频没有能塞进上下文的形式，所以这里只给「存到哪了」。
 *    要看画面得再走一步 —— `analyze_video` 把它发给用户勾了「视频」能力的模型，
 *    由那个模型看完讲给它听。**不是「看不到」，是「要多花一次钱去看」。**
 * 2. **进度要往外报**。几分钟里界面上不能什么都没有，`ctx.report` 会把厂商
 *    报的状态词转出去。
 * 3. **描述里把价钱说在最前面**。模型很容易把「生成视频」当成和出图一样随手
 *    的事，一次多调几遍。
 *
 * ## 边界
 *
 * 出的是**模型重新生成的一段视频**，不是引擎渲染。用户要 Movie Render Queue、
 * 要序列帧、要带 Alpha 的成片，那是另一回事，这个工具顶不上 —— 与 generate_image
 * 那条「AI 图 ≠ 引擎渲染」是同一个坑，而视频这边更容易被混淆。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import {
  encodeVideoJob,
  generateVideo,
  resumeVideo,
  type GeneratedVideo,
  type VideoImageRole
} from '../../../ai/video'
import { readSettings } from '../../../ai/store'
import { downloadAndSaveAIGCAsset } from '../../../services/aigc/assetSaver'
import { describeMissingVideoModel, listVideoModels, pickVideoModel } from './videoModels'
import { loadReferenceImages, VIDEO_REFERENCE_BUDGET } from './references'
import type { AiProviderSettings } from '../../../ai/types'

/** 素材库文件名的长度上限。再长的提示词截断即可，资产备注里存着全文 */
const NAME_MAX_LENGTH = 40

const GenerateVideoInput = z.object({
  prompt: z
    .string()
    .optional()
    .describe(
      '视频提示词。**除了续跑，都必填** —— 各家都不接受只给图不给文字的请求。' +
        '写画面和运动：主体在做什么、镜头怎么动、光线氛围、风格。'
    ),
  reference_images: z
    .array(
      z.union([
        z.string(),
        z.object({
          path: z.string().describe('图片。本地绝对路径 / http(s) 直链 / data URI 三种都收'),
          role: z
            .enum(['first_frame', 'last_frame', 'reference'])
            .describe(
              'first_frame 当首帧（视频从这张图开始动）、last_frame 当尾帧（视频停在这张图）、' +
                'reference 当风格/主体参考'
            )
        })
      ])
    )
    .optional()
    .describe(
      '参考图。每一项要么是一个字符串（按首帧处理），要么是 `{ path, role }`。' +
        '路径收**本地绝对路径**（ue_screenshot 返回值里的 path 直接可用）、' +
        'http(s) 直链、data URI 三种 —— 与 generate_image 完全一样。太大的图会自动缩一遍再发。' +
        '**首尾帧**：给一张 first_frame 加一张 last_frame，视频就从前者过渡到后者；' +
        '首帧、尾帧各最多一张，尾帧不能单独给。' +
        '**同一张图选不同的 role 出来的东西完全不同**，不确定就问用户。'
    ),
  duration: z
    .number()
    .int()
    .min(2)
    .max(15)
    .optional()
    .describe('时长（秒）。**直接乘在账单上**，没明确要求就别加长。不填走厂商缺省（约 5 秒）'),
  resolution: z
    .enum(['480p', '720p', '1080p', '2k'])
    .optional()
    .describe(
      '分辨率。同样按秒 × 档位计费，档位越高越贵。' +
        'Seedance 最高 1080p，2K 只有 MiniMax-H3 有 —— 选了对方没有的档会明确报错，不会静默降级'
    ),
  ratio: z
    .enum(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
    .optional()
    .describe('画面比例。有参考图时多数厂商按图自己定，给了也会被忽略'),
  audio: z
    .boolean()
    .optional()
    .describe('生成有声视频。只有方舟 Seedance 有这个开关，给 MiniMax 会明确报错'),
  seed: z.number().int().optional().describe('随机种子。同样的输入 + 同样的种子结果一致'),
  model: z
    .string()
    .optional()
    .describe('指定模型。不填就用用户绑定的那个（推荐）。填错会把可选清单报回来'),
  name: z.string().optional().describe('存进素材库时的文件名。不填从提示词里取'),
  resume_job_id: z
    .string()
    .optional()
    .describe(
      '**接着取一个已经提交过的任务**，而不是重新生成。上一次失败的报错里带着这个号就用它 ——' +
        '视频按秒计费，提交那一刻钱就扣了，重新提交是再付一次全款。' +
        '给了这个参数时，其余生成参数全部忽略。'
    )
})

type ReferenceImageArg = string | { path: string; role: VideoImageRole }
interface NormalizedImage {
  path: string
  role: VideoImageRole
}

/** 字符串形式按首帧处理 —— 与厂商文档的缺省一致 */
function normalizeImages(items: ReferenceImageArg[]): NormalizedImage[] {
  return items.map((item) =>
    typeof item === 'string'
      ? { path: item, role: 'first_frame' }
      : { path: item.path, role: item.role }
  )
}

/**
 * 首帧、尾帧各最多一张，尾帧不能单独给。
 * 这三条两家都是硬规则，早一步在这里拦，比等几十秒后厂商报回来强。
 * 返回 undefined 表示没问题，否则是要报给模型的原因。
 */
export function checkImageRoles(items: ReferenceImageArg[]): string | undefined {
  const images = normalizeImages(items)
  const firsts = images.filter((image) => image.role === 'first_frame').length
  const lasts = images.filter((image) => image.role === 'last_frame').length
  if (firsts > 1)
    return `首帧只能给一张，现在给了 ${firsts} 张。多出来的图请改成 reference 或去掉。`
  if (lasts > 1) return `尾帧只能给一张，现在给了 ${lasts} 张。`
  if (lasts === 1 && firsts === 0) {
    return '只给了尾帧没给首帧。首尾帧要成对：再给一张 first_frame，或把这张改成 first_frame。'
  }
  return undefined
}

/**
 * 按首帧 → 尾帧 → 参考图排。方舟的首尾帧不带 role、靠顺序区分，
 * 所以这一步不是整洁问题，排错了首尾会对调。
 */
export function orderImages(items: ReferenceImageArg[]): NormalizedImage[] {
  const rank: Record<VideoImageRole, number> = { first_frame: 0, last_frame: 1, reference: 2 }
  return normalizeImages(items)
    .map((image, index) => ({ image, index }))
    .sort((a, b) => rank[a.image.role] - rank[b.image.role] || a.index - b.index)
    .map(({ image }) => image)
}

export interface GeneratedVideoDetails extends Record<string, unknown> {
  success: boolean
  model: string
  prompt: string
  /** 存进素材库的绝对路径。对话窗口靠它播放 */
  video_path?: string
  asset_key?: string
  /** 厂商那边的任务号。失败或超时时靠它去厂商控制台对账 */
  job_id: string
  save_error?: string
}

export function createGenerateVideoTool(): UnrealAgentTool<GeneratedVideoDetails> {
  return defineTool<typeof GenerateVideoInput, GeneratedVideoDetails>({
    name: 'generate_video',
    namespace: 'aigc',
    risk: 'mutating',
    description: `用 AI 生成一段视频，存进素材库并在对话窗口里可播放。

【非常贵，而且很慢】一次三到十五分钟，**按秒 × 分辨率计费，失败也扣**。
调用前先确认用户真的要视频；参数拿不准就问，不要靠多试几次去凑。
一次只出一条，看过之后再决定要不要重来。

【它出的不是引擎渲染】出来的是模型重新生成的一段画面，里面没有一样东西
对应工程里的资产。用户说「出片」「渲染序列」「Movie Render Queue」「MRQ」
「带 Alpha」「EXR」时要的是引擎渲染 —— 那个**没有工具**，如实说，
不要拿 AI 视频顶上。说得两边都通就先问一句。

【什么时候用】：概念片、氛围片、分镜演示、给客户看的动态效果参考。

【拿白盒截图当参考图】和生图一样：\`ue_focus_viewport\` 对准 → \`ue_screenshot\`
拍一张 → 把返回值里的 \`path\` 填进 \`reference_images\`。本地路径直接收，
不用先传到公网。

每张图的 \`role\` 决定它是首帧、尾帧还是风格参考 —— **三种出来的东西完全不同**：
first_frame 是「视频从这一帧开始动」，last_frame 是「视频停在这一帧」，
reference 是「照着这个风格/主体重新画」。不确定就问用户，别替他选。

【首尾帧】用户说「从 A 变到 B」「A 过渡到 B」「镜头从这里推到那里」这类话时，
拍两张（或拿他给的两张）：\`[{ path: A, role: 'first_frame' }, { path: B, role: 'last_frame' }]\`。
首帧、尾帧各只能一张，只给尾帧不给首帧会被拦下来。

【用哪个模型】不填 \`model\` 就用用户绑定的那个。目录里预置了火山方舟 Seedance
（2.5 / 2.0）和 MiniMax 海螺（H3 / H3-Max）。

【出完先看一眼】你自己不会自动看到这段视频。想知道它长什么样，
把返回值里的 \`video_path\` 交给 \`analyze_video\` —— 它会让用户配的视频模型看完讲给你听。
用户问「效果怎么样」「有没有问题」时就该走这一步，别拿参数当画面转述。
（没配视频模型时那个工具会明确报错，那时就如实说你没看过。）

【好不好看不是你说了算 —— 也不是你能花钱去改的】
看过一眼也不代表你能替用户判断构图和节奏。**一次调用只生成一条。**

用户说「不太行」但没说怎么改时 → **调 \`ask_user\`** 给选项
（换提示词重来 / 改时长或分辨率 / 换模型 / 就这样），而不是自己猜一个再烧一次钱。
视频按秒计费，一次重做就是一次真实账单。

【出完之后】视频存在素材库的 AIGC/视频 下，返回值里有绝对路径，
用户可以直接在对话窗口里播放。你没看过这段视频之前**不要评价画面内容** ——
要评价就先调 \`analyze_video\`。`,
    input: GenerateVideoInput,
    execute: async (args, ctx) => {
      // 续跑：跳过提交，直接去取那个已经付过钱的任务
      const resumeToken = String(args.resume_job_id ?? '').trim()
      if (resumeToken) {
        ctx.report({ text: `正在取回任务 ${resumeToken} 的结果（不重新提交、不再扣费）…` })
        const resumed = await resumeVideo({
          jobId: resumeToken,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: (note) => ctx.report({ text: `任务状态：${note}` })
        }).catch((error: unknown) => {
          throw new Error(describeVideoFailure(error, '续跑'))
        })
        return await saveAndReport(resumed, '续跑（本次未重新扣费）', args)
      }

      /*
       * `prompt` 在 schema 上是 optional，只有这里才真的必填 ——
       * 续跑那条路压根没有提示词，写成 schema 必填会让续跑连参数校验都过不去。
       */
      if (!String(args.prompt ?? '').trim()) {
        return {
          isError: true,
          text: '生成视频必须给一句提示词（prompt）。续跑请用 resume_job_id。'
        }
      }

      const settings = await readSettings()
      const available = listVideoModels(settings)
      const chosen = args.model ? pickVideoModel(available, args.model) : undefined
      if (args.model && !chosen) {
        return { isError: true, text: describeMissingVideoModel(available, args.model) }
      }

      /*
       * 参考图先读 —— 与生图共用同一个加载器：本地绝对路径读盘转 data URI、
       * 太大的先缩一遍、直链和 data URI 原样递过去。
       *
       * **两家都收 base64**（方舟文档明写 `data:image/<格式>;base64,<编码>`，
       * MiniMax 只是建议大文件走直链），所以「白盒截图 → 生成视频」是通的。
       * 路径写错、文件不在，早一步报出来比等厂商那边超时强。
       */
      const roleProblem = checkImageRoles(args.reference_images ?? [])
      if (roleProblem) return { isError: true, text: roleProblem }
      const orderedImages = orderImages(args.reference_images ?? [])
      const references = await loadReferenceImages(
        orderedImages.map((item) => item.path),
        VIDEO_REFERENCE_BUDGET
      )

      const modelLabel = describeBoundVideoModel(settings, chosen)
      ctx.report({
        text:
          `正在用 ${modelLabel} 生成视频，通常要几分钟…` +
          `${args.duration ? `（${args.duration} 秒` : '（'}${args.resolution ?? ''}）`
      })

      const images = references.map((url, index) => ({ url, role: orderedImages[index].role }))
      const generated = await generateVideo({
        // 上面那道检查已经保证它非空
        prompt: String(args.prompt),
        ...(chosen ? { providerId: chosen.providerId, modelId: chosen.modelId } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(args.duration !== undefined ? { duration: args.duration } : {}),
        ...(args.resolution ? { resolution: args.resolution } : {}),
        ...(args.ratio ? { ratio: args.ratio } : {}),
        ...(args.audio !== undefined ? { audio: args.audio } : {}),
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        // 厂商报的状态词转给界面，几分钟里不至于什么都不显示
        onProgress: (note) => ctx.report({ text: `视频生成中：${note}` })
      }).catch((error: unknown) => {
        throw new Error(describeVideoFailure(error, modelLabel))
      })

      return await saveAndReport(generated, modelLabel, args)
    }
  })
}

/**
 * 把一次生成的产物落盘并汇报。**正常生成和续跑共用这一段。**
 *
 * 地址有时效，而且短：方舟 24 小时、MiniMax 旧版 9 小时。拿到就立刻落盘 ——
 * 存这一步失败**不算整次失败**，钱已经花了，至少要把那个还能用几小时的地址交出去。
 */
async function saveAndReport(
  generated: GeneratedVideo,
  modelLabel: string,
  args: { name?: string; prompt?: string }
): Promise<{ text: string; details: GeneratedVideoDetails }> {
  const prompt = String(args.prompt ?? '').trim()
  const saved = await downloadAndSaveAIGCAsset(generated.url, 'video', {
    suggestedName: baseNameOf(args.name, prompt),
    defaultExt: '.mp4',
    // 视频文件大，下载给足时间；一段 1080p 十几秒的片子几十兆很常见
    timeout: 300_000,
    prompt
  })

  const token = encodeVideoJob(generated.job)
  const lines = [`用 ${modelLabel} 完成（任务号 ${token}）。`]
  if (saved.success && saved.localPath) {
    lines.push(`已存进素材库 AIGC/视频：${saved.localPath}`)
    lines.push('用户可以直接在对话窗口里播放。')
  } else {
    lines.push(
      `没能存进素材库（${saved.error || '原因未知'}）。` +
        `厂商那边的临时地址是 ${generated.url} —— **几小时后失效**，请用户尽快另存。`
    )
  }
  if (generated.usage !== null) lines.push(`本次用量：${generated.usage}`)
  // 任务号也说给用户听：万一后续存盘/网络又出问题，他手上得有这个号
  lines.push(`任务号 ${token} —— 万一后续出问题，用它可以直接取回结果，不用重新生成。`)
  if (saved.success && saved.localPath) {
    lines.push(
      `你还没看过这段视频。要说画面就先调 analyze_video（video_path=${saved.localPath}）；` +
        '没调之前不要描述里面有什么。'
    )
  }

  return {
    text: lines.join('\n'),
    details: {
      success: true,
      model: modelLabel,
      prompt,
      job_id: token,
      ...(saved.localPath ? { video_path: saved.localPath } : {}),
      ...(saved.assetKey ? { asset_key: saved.assetKey } : {}),
      ...(saved.error ? { save_error: saved.error } : {})
    }
  }
}

/**
 * 这次到底用的是哪个模型。
 *
 * 与生图同理：用户绑的是哪个只有他自己知道，而视频这边模型之间的差距（价格、
 * 时长上限、有没有声音）比生图大得多，「这段片子是谁生成的」是他判断值不值的依据。
 */
function describeBoundVideoModel(settings: AiProviderSettings, chosen?: { label: string }): string {
  if (chosen) return chosen.label
  const binding = settings.roles.video
  if (!binding) return '绑定的视频模型'
  const provider = settings.providers.find((item) => item.id === binding.providerId)
  return provider ? `${provider.displayName}:${binding.modelId}` : binding.modelId
}

/**
 * 失败时补上「够不够排查」。
 *
 * 视频这一类的失败尤其要说清**钱扣没扣** —— 提交成功之后的任何失败（内容审核
 * 不过、超时、存盘失败）额度都已经扣掉了，而模型默认会建议「再试一次」。
 * 不点破这一点，一次失败会变成三次扣费。
 */
function describeVideoFailure(error: unknown, modelLabel: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const parts = [raw]

  if (/任务失败|超过 \d+ 分钟/.test(raw)) {
    parts.push(
      '注意：任务已经提交出去了，**额度多半已经扣掉**。' +
        '不要直接重试 —— 先把原因告诉用户，由他决定要不要再花一次钱。'
    )
  }
  if (/没有指定视频接口形状|还没有配置/.test(raw)) {
    parts.push(`当前用的是 ${modelLabel}。这是配置问题，不是提示词问题，重试没有意义。`)
  }
  return parts.join('\n')
}

/** 文件名：用户给了就用，否则从提示词头部截一段 */
function baseNameOf(name: string | undefined, prompt: string): string {
  const explicit = String(name ?? '').trim()
  if (explicit) return explicit.slice(0, NAME_MAX_LENGTH)
  return prompt.trim().slice(0, NAME_MAX_LENGTH) || 'video'
}
