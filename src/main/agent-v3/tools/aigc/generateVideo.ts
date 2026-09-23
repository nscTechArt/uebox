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

import { promises as fs } from 'fs'
import { extname, isAbsolute } from 'path'
import { z } from 'zod'

import { assertPathAllowed } from '../builtin/pathBoundary'
import { defineTool, type UnrealAgentTool } from '../defineTool'
import {
  encodeVideoJob,
  generateVideo,
  resumeVideo,
  supportsReferenceMedia,
  type GeneratedVideo,
  type VideoImageRole
} from '../../../ai/video'
import { readSettings, readSettingsSync } from '../../../ai/store'
import { isPlanProvider } from '../../../../shared/creatorPlan'
import { downloadAndSaveAIGCAsset } from '../../../services/aigc/assetSaver'
import { describeMissingVideoModel, listVideoModels, pickVideoModel } from './videoModels'
import { loadReferenceAudio, loadReferenceImages, VIDEO_REFERENCE_BUDGET } from './references'
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
  reference_videos: z
    .array(z.string())
    .optional()
    .describe(
      '参考视频（运镜、动作、节奏参考，或拿来编辑/延长）。只有方舟 Seedance 2.x 支持。' +
        '收本地绝对路径 / http(s) 公网直链 / `asset://` 素材 ID。方舟本身只认链接，' +
        '**本地文件会先传到用户配的对象存储换成链接**；没配对象存储时会报错并说明怎么引导用户去配。' +
        '格式 mp4 / mov（H.264 / H.265）；Seedance 2.0 单个 2–15 秒、最多 3 个、合计 ≤15 秒，' +
        '2.5 单个 2–30 秒、最多 10 个、合计 ≤30 秒；单个 ≤200MB。'
    ),
  reference_audios: z
    .array(z.string())
    .optional()
    .describe(
      '参考音频（配乐、音色、节奏参考）。只有方舟 Seedance 2.x 支持。' +
        '本地绝对路径 / http(s) 直链 / `asset://` 素材 ID / data URI 都收。' +
        '只收 wav / mp3，单个 ≤15MB；Seedance 2.0 不能只给音频，至少再带一张参考图或一个参考视频。'
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

/** 方舟参考视频只认这两种容器 */
const REFERENCE_VIDEO_EXTS = ['.mp4', '.mov']

/** 方舟：单个参考视频不超过 200MB */
const REFERENCE_VIDEO_MAX_BYTES = 200 * 1024 * 1024

/** 已经是厂商能直接拉的形式：公网直链或方舟素材库的 asset:// ID */
function isLinkedVideo(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^asset:\/\//i.test(value)
}

/**
 * 本地参考视频要用、但对象存储没配时给模型的话。
 *
 * 写成「转告用户」的口吻而不是一句错误：模型拿到裸错误的第一反应是换个方案
 * 自己凑（截图当参考图），而用户要的恰恰是拿这段视频当参考 —— 缺的只是一个桶。
 */
export function objectStorageGuide(localVideos: string[]): string {
  return [
    `参考视频 ${localVideos.map((item) => `「${item}」`).join('、')} 是本地文件，` +
      '而方舟的参考视频只认链接、不收 base64。盒子可以把它传到**用户自己的对象存储**换一个链接，' +
      '但对象存储还没配好。（这一步在提交之前拦下，没有扣费。）',
    '请这样转告用户：',
    '1. 打开「偏好设置 → 对象存储」，打开「启用对象存储」；',
    '2. 选云厂商（阿里云 OSS / 腾讯云 COS / AWS S3 / Cloudflare R2 等），' +
      '填 Endpoint、Region、Bucket、AccessKey ID 和 Secret；',
    '3. 点「测试连接」，通过后保存，回来说一声就接着生成。',
    '注意：桶必须是公网可访问的地址 —— 本机或内网的 MinIO 方舟拉不到。',
    '不想配的话，也可以直接给一个公网直链，或上传到方舟素材库拿 asset:// ID。'
  ].join('\n')
}

/**
 * 把参考视频都变成方舟能拉的链接：直链和 asset:// 原样，本地文件传对象存储。
 *
 * 返回 `{ problem }` 时不提交 —— 这些都是扣费之前就能发现的问题。
 * 对象存储服务动态加载：它连着 electron 和凭据库，静态引入会让工具注册表的每个测试
 * 都去碰它（与 §7 那条 appSettingsManager 的坑同一个道理）。
 */
async function resolveReferenceVideos(
  videos: string[],
  report: (text: string) => void,
  signal?: AbortSignal
): Promise<{ urls: string[] } | { problem: string }> {
  const local = videos.filter((video) => !isLinkedVideo(video))
  if (local.length === 0) return { urls: videos }

  const storage = await import('../../../services/objectStorage/objectStorageService')
  if (!(await storage.isObjectStorageReady())) return { problem: objectStorageGuide(local) }
  // 链接的主机就是公开域名或 endpoint（见 mediaUrlFor），传之前就能判断 ——
  // 传完几百 MB 才说「方舟拉不到」，用户白等好几分钟
  // 套餐存储（uebox）的链接在套餐的公网域名下；配置里留着的是换过去之前那个桶的地址，不作数
  const config = await storage.readObjectStorageConfig()
  if (
    config.preset !== 'uebox' &&
    storage.isPrivateEndpoint(config.publicBaseUrl || config.endpoint)
  ) {
    return {
      problem:
        '对象存储是本机或内网地址，方舟从公网拉不到这段参考视频。（没有上传，也没有扣费。）' +
        '请用户在「偏好设置 → 对象存储」换成公网可访问的桶，或填一个公开访问域名。'
    }
  }

  const urls: string[] = []
  for (const video of videos) {
    if (isLinkedVideo(video)) {
      urls.push(video)
      continue
    }
    const denied = assertPathAllowed(video)
    if (denied) return { problem: denied }
    const size = await fs
      .stat(video)
      .then((stat) => stat.size)
      .catch(() => null)
    if (size === null) return { problem: `参考视频读不到：${video}。确认这个文件存在。` }
    if (size > REFERENCE_VIDEO_MAX_BYTES) {
      return {
        problem:
          `参考视频 ${Math.round(size / 1024 / 1024)}MB，超过方舟单个 200MB 的上限：${video}。` +
          '截短或降码率后再用。'
      }
    }
    try {
      const upload = storage.uploadMediaFile(video, (note) => report(note))
      const { key } = await (signal ? untilAborted(upload, signal) : upload)
      const url = await storage.mediaUrlFor(key)
      if (!url)
        return { problem: '参考视频传上去了，但对象存储现在签不出链接。请用户检查对象存储配置。' }
      urls.push(url)
    } catch (error) {
      // 用户按了停止：照实往外抛，不能说成「上传失败，去测连接」
      if (signal?.aborted) throw error
      return {
        problem:
          `参考视频传到对象存储失败（没有扣费）：${error instanceof Error ? error.message : String(error)}。` +
          '请用户到「偏好设置 → 对象存储」点「测试连接」排查。'
      }
    }
  }
  return { urls }
}

/**
 * 等上传，但用户按停止时立刻放手。
 *
 * 上传本身不掐：同一个文件可能正被另一路（输入框里拖进来的那次）等着，
 * 让它在后台传完，下次再用直接复用。
 */
function untilAborted<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * 参考视频 / 参考音频的前置检查。返回 undefined 表示没问题。
 *
 * - 本地参考视频先看格式：方舟只收 mp4 / mov，.avi 传上去也是白传。
 *   （要不要、能不能传对象存储是异步的事，在 `resolveReferenceVideos` 里。）
 * - 首帧/首尾帧与全模态参考互斥（方舟硬规则；MiniMax 压根没有视频/音频入参）。
 */
export function checkReferenceMedia(
  images: ReferenceImageArg[],
  videos: string[],
  audios: string[]
): string | undefined {
  for (const raw of videos) {
    const video = raw.trim()
    if (isLinkedVideo(video)) continue
    if (!isAbsolute(video)) {
      return `参考视频「${video}」不是绝对路径。给完整路径、公网直链或 asset:// 素材 ID。`
    }
    if (!REFERENCE_VIDEO_EXTS.includes(extname(video).toLowerCase())) {
      return (
        `参考视频「${video}」是 ${extname(video) || '无扩展名'} 格式，方舟只收 mp4 / mov（H.264 / H.265）。` +
        '先转一下格式，比如 `ffmpeg -i 输入.avi -c:v libx264 -c:a aac 输出.mp4`，' +
        '要替用户转的话先问他。'
      )
    }
  }
  const usesFrames = normalizeImages(images).some((image) => image.role !== 'reference')
  if (usesFrames && videos.length + audios.length > 0) {
    return (
      '首帧/尾帧不能和参考视频、参考音频一起给 —— 厂商把这两种定为互斥用法。' +
      '要么去掉参考视频/音频，要么把图的 role 改成 reference，在提示词里写「以图 1 为首帧」。'
    )
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

/**
 * 「视频生成」绑的是不是创作者 Token Plan。那边失败、取消都退额度（协议 05-tasks），
 * 说明里的「失败也扣」要跟着改。同步读配置，理由同 generate3dModel.ts 的 tripoIsBound；
 * 换绑之后工具表由 registry.ts 订阅配置变更重建。
 */
function planVideoBound(): boolean {
  try {
    const binding = readSettingsSync().roles.video
    return !!binding && isPlanProvider(binding.providerId)
  } catch {
    return false
  }
}

export function createGenerateVideoTool(): UnrealAgentTool<GeneratedVideoDetails> {
  const plan = planVideoBound()
  return defineTool<typeof GenerateVideoInput, GeneratedVideoDetails>({
    name: 'generate_video',
    namespace: 'aigc',
    risk: 'mutating',
    description: `用 AI 生成一段视频，存进素材库并在对话窗口里可播放。

【非常贵，而且很慢】一次三到十五分钟，${
      plan
        ? '**按秒 × 分辨率占用创作者 Token Plan 的视频额度，失败、取消都退回**'
        : '**按秒 × 分辨率计费，失败也扣**'
    }。
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

【参考视频 / 参考音频】方舟 Seedance 2.x 支持「全模态参考」：参考图（role=reference）
+ \`reference_videos\` + \`reference_audios\` 一起给，用来参考运镜、动作、配乐，或编辑/延长一段视频。
- 方舟的参考视频只认链接（公网直链或 asset:// 素材 ID），不收 base64。用户给的是**本地视频**时
  直接把路径填进 \`reference_videos\`：配了对象存储，工具会自动传上去换成链接；
  **没配时工具会在扣费之前拦下**，并告诉你怎么引导用户到「偏好设置 → 对象存储」去配 ——
  照那段话转告用户，等他配好再调一次。别自作主张退回「截几帧当参考图」，那条路要用户点头。
- 只收 mp4 / mov。用户给的是 .avi / .mkv 等，先让他转格式（或经他同意你用 ffmpeg 转）。
- 首帧/首尾帧与全模态参考是**互斥**的两种用法，不能混着给：带了参考视频/音频/参考图，
  就别再给 first_frame / last_frame（想要首帧就在提示词里写「以图 1 为首帧」）。

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
      const mediaProblem = checkReferenceMedia(
        args.reference_images ?? [],
        args.reference_videos ?? [],
        args.reference_audios ?? []
      )
      if (mediaProblem) return { isError: true, text: mediaProblem }
      const modelLabel = describeBoundVideoModel(settings, chosen)
      if ((args.reference_videos?.length ?? 0) + (args.reference_audios?.length ?? 0) > 0) {
        const providerId = chosen?.providerId ?? settings.roles.video?.providerId
        const provider = settings.providers.find((item) => item.id === providerId)
        if (provider && !supportsReferenceMedia(provider.videoApi)) {
          return {
            isError: true,
            text:
              `${modelLabel} 只收图片，不收参考视频/参考音频（没有上传，也没有扣费）。` +
              '要拿视频或音频当参考请用方舟 Seedance 2.x（model 填 seedance）。'
          }
        }
      }
      const orderedImages = orderImages(args.reference_images ?? [])
      const references = await loadReferenceImages(
        orderedImages.map((item) => item.path),
        VIDEO_REFERENCE_BUDGET
      )
      const audios: string[] = []
      for (const audio of args.reference_audios ?? []) audios.push(await loadReferenceAudio(audio))
      const resolvedVideos = await resolveReferenceVideos(
        (args.reference_videos ?? []).map((url) => url.trim()).filter(Boolean),
        (text) => ctx.report({ text }),
        ctx.signal
      )
      if ('problem' in resolvedVideos) return { isError: true, text: resolvedVideos.problem }
      const videos = resolvedVideos.urls

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
        ...(videos.length > 0 ? { videos } : {}),
        ...(audios.length > 0 ? { audios } : {}),
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
