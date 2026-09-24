import { resolveApiKey } from './credentials'
import { ModelNotConfiguredError } from './resolveModel'
import { readSettings } from './store'
import type { VideoApi } from '../../shared/aiProvider'
import type { ModelConfig, ProviderConfig } from './types'
import {
  filesOfRole,
  resumePlanTask,
  runPlanTask,
  settlePlanTask,
  type PlanTask,
  type PlanTaskBody
} from './creatorPlan/tasks'

/**
 * 本地直连的视频生成。
 *
 * 与 `model3d.ts` 是同一类东西：**异步任务式**，产出的不是文本。区别只有一处 ——
 * 视频**只有两段**（提交 → 轮询），地址就在轮询响应里，没有单独的取文件那一步。
 *
 * ## 为什么三段导出而不是一个大函数
 *
 * 与 3D 同理，但这里更要命：视频一次要**三到十五分钟**（方舟官方说复杂场景更久），
 * 而且比 3D 贵得多。应用重启、对话被压缩、用户关窗口之后，调用方拿着存下来的
 * 任务号应该能接着轮询，而不是重付一次。
 *
 * `generateVideo` 只是把两段串起来的便利封装。
 *
 * ## 边界
 *
 * 只做「一句话/几张图进、一个视频地址出」。**不下载、不入库、不转码。**
 *
 * ⚠️ 地址有时效：方舟 24 小时，MiniMax 旧版 9 小时。拿到就该落盘。
 *
 * ## 参考图收本地文件
 *
 * 两家都接受 `data:image/...;base64,...`（方舟文档明写这一条，MiniMax 只是
 * 建议大文件走直链）。所以「白盒截图 → 生成视频」这条路是通的 ——
 * 上层用 `tools/aigc/references.ts` 把本地路径读成 data URI，与生图共用一份。
 *
 * ## 参考视频 / 参考音频（方舟 Seedance 2.x 全模态参考）
 *
 * 方舟的 `content[]` 还收 `video_url`（role `reference_video`）和 `audio_url`
 * （role `reference_audio`）。**两者收的来源不一样，这一条最容易踩：**
 *
 * - 视频**只收公网直链或 `asset://` 素材 ID，不收 base64**。本地视频文件没法
 *   直接带上去 —— 得先放到一个厂商能拉到的地址上。
 * - 音频收公网直链、`data:audio/...;base64,...`、`asset://` 三种。
 *
 * MiniMax 没有这两种入参，给了就报错。
 */

const SUBMIT_TIMEOUT_MS = 120_000
const POLL_TIMEOUT_MS = 30_000

/**
 * 整个任务的上限。
 *
 * 比 3D 宽得多：方舟官方给的经验值是 3–15 分钟，复杂场景更久，并建议最多等约
 * 20 分钟。取 30 分钟留一点余量 —— 超时报错时任务号会带出来，还能接着查。
 */
const JOB_TIMEOUT_MS = 1_800_000

/**
 * 两次轮询之间的间隔。
 *
 * 比 3D 的 5 秒长：视频动辄几分钟，5 秒一次纯属把自己打成限流。
 * 方舟文档建议 5–10 秒并做退避，这里取 10 秒定频 —— 退避的复杂度换不来什么，
 * 一次视频等几分钟，多等 10 秒没人在乎。
 */
const POLL_INTERVAL_MS = 10_000

/** 单次请求最多连几次（含首次）。与 model3d.ts 同一条理由，见那边的长注释 */
const NETWORK_ATTEMPTS = 3

/**
 * 轮询阶段能容忍连续几次失败。
 *
 * 比 3D 给得更宽：视频一次几分钟到几十分钟，轮询次数多得多，撞上抖动的概率
 * 也高得多；而提交后失败的代价（按秒计费的一整条片子）比 3D 还大。
 */
const POLL_FAILURE_TOLERANCE = 8

/**
 * 内联（base64）参考图的总字节上限。
 *
 * 两家的请求体上限都是 64MB，base64 撑到 4/3，所以原始字节留 45MB 的余量 ——
 * 剩下的给提示词和其余字段。**只算 data URI**：公网直链在请求体里只是一个
 * 几十字节的地址，不占这个额度。
 */
const MAX_INLINE_PAYLOAD_BYTES = 45 * 1024 * 1024

export const VIDEO_CONFIG_ERROR_MARKER = '设置 → 模型'

export class VideoNotConfiguredError extends ModelNotConfiguredError {
  constructor() {
    super(
      `还没有配置「视频生成」模型。请到 ${VIDEO_CONFIG_ERROR_MARKER} 添加一个用途为` +
        '「视频生成」的 Provider，再把它的模型绑定给「视频生成」角色。',
      'video'
    )
    this.name = 'VideoNotConfiguredError'
  }
}

export class VideoUnavailableError extends Error {
  constructor() {
    super(
      `这次指定的视频模型已经不可用。请到 ${VIDEO_CONFIG_ERROR_MARKER} ` +
        '检查 Provider、密钥和模型，再重新选择。'
    )
    this.name = 'VideoUnavailableError'
  }
}

/**
 * Provider 没写 `videoApi` 时抛这个。
 *
 * 与 3D 同理**不猜缺省值**：视频这一类同样没有事实标准，猜错的表现是一串 404，
 * 那看上去像 Base URL 填错了。
 */
export class VideoApiUnknownError extends Error {
  constructor(readonly providerId: string) {
    super(
      `Provider「${providerId}」没有指定视频接口形状。请到 ${VIDEO_CONFIG_ERROR_MARKER} ` +
        `打开它的详情，选一个接口形状（目前支持：${Object.keys(ADAPTERS).join(' / ')}）。`
    )
    this.name = 'VideoApiUnknownError'
  }
}

/** 提示词是所有家的必填。**先在本地拦掉**，不然是一次白花钱的 400 */
export class VideoEmptyPromptError extends Error {
  constructor() {
    super('生成视频必须给一句提示词 —— 各家都不接受只有参考图没有文字的请求。')
    this.name = 'VideoEmptyPromptError'
  }
}

/**
 * 参考图加起来太大，请求体会超过厂商的上限。
 *
 * 两家的上限都是 **64MB 的请求体**，而 base64 会把体积撑到 4/3 —— 也就是说
 * 实际能带的字节只有 48MB 左右。超了得到的是一次 413，而 413 在界面上表现为
 * 「生成失败」，没人猜得到问题出在参考图上。所以在本地先算一遍。
 */
export class VideoPayloadTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number
  ) {
    super(
      `内联的参考图和参考音频加起来约 ${Math.round(bytes / 1024 / 1024)}MB，超过厂商 ` +
        `${Math.round(limit / 1024 / 1024)}MB 的请求体上限（base64 会把体积撑到 4/3）。` +
        '请减少参考图/参考音频数量，或者改用公网直链 —— 直链不计入请求体。'
    )
    this.name = 'VideoPayloadTooLargeError'
  }
}

/** 这家没有对应这个参数的入参。**必须报错，不能静默丢掉** —— 与 3D 同一条理由 */
export class VideoParamUnsupportedError extends Error {
  constructor(
    readonly api: string,
    readonly param: string,
    hint: string
  ) {
    super(`«${api}» 不支持 ${param}。${hint}`)
    this.name = 'VideoParamUnsupportedError'
  }
}

export class VideoRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
    readonly url = ''
  ) {
    super(`视频接口报错 HTTP ${status}（${path}）：${detail.slice(0, 200) || '厂商没有给出说明'}`)
    this.name = 'VideoRequestError'
  }
}

/** 厂商说这个任务失败了。额度多半已经扣了，所以把厂商那句话原样带出来 */
export class VideoJobFailedError extends Error {
  constructor(detail: string) {
    super(`视频生成任务失败：${detail || '厂商没有给出原因'}`)
    this.name = 'VideoJobFailedError'
  }
}

/**
 * 提交成功之后，查询这一端断了。任务**大概率还在跑**，钱也已经扣了。
 *
 * 与「任务失败」分开，是因为这个区别决定了下一步该不该重试 ——
 * 重新提交是再付一次全款，而视频那一次全款很贵。
 */
export class VideoInterruptedError extends Error {
  constructor(
    readonly job: VideoJob,
    readonly cause: unknown
  ) {
    super(
      `视频任务已经提交成功（任务号 ${encodeVideoJob(job)}），但连着查不到它的状态：` +
        `${cause instanceof Error ? cause.message : String(cause)}。` +
        '**任务多半还在厂商那边跑，额度也已经扣了** —— 不要重新提交。'
    )
    this.name = 'VideoInterruptedError'
  }
}

/**
 * 用户在**提交之后**按了停止。取消的是我们这边的等待，不是厂商那边的任务 ——
 * 那个还在跑，而且按秒计费的钱已经扣了。任务号必须救出来。
 */
export class VideoCancelledError extends Error {
  constructor(readonly job: VideoJob) {
    super(
      `已停止等待（任务号 ${encodeVideoJob(job)}）。` +
        '**厂商那边的任务还在跑，额度已经扣了** —— 想要结果的话用这个任务号取回。'
    )
    this.name = 'VideoCancelledError'
  }
}

/** 超时。任务号带出来，调用方可以稍后接着轮询 —— 视频很贵，不能就这么丢了 */
export class VideoTimeoutError extends Error {
  constructor(readonly job: VideoJob) {
    super(
      `视频生成超过 ${Math.round(JOB_TIMEOUT_MS / 60_000)} 分钟仍未完成。` +
        `任务可能还在厂商那边排队，可以稍后用任务号 ${encodeVideoJob(job)} 继续查。`
    )
    this.name = 'VideoTimeoutError'
  }
}

/** 任务说成功了，但响应里没有视频地址 —— 多半是厂商改了响应结构 */
export class VideoNoOutputError extends Error {
  constructor(readonly raw: string) {
    super('视频任务已完成，但响应里没有视频地址（厂商可能改了响应结构）。')
    this.name = 'VideoNoOutputError'
  }
}

// ── 对外的形状 ─────────────────────────────────────────────────────────────

/**
 * 分辨率档。
 *
 * 用档而不是像素：各家的档名不一样（方舟是 `480p/720p/1080p`，MiniMax 是
 * `480P/768P/2K`），换算留在适配器里。
 */
export type VideoResolution = '480p' | '720p' | '1080p' | '2k'

/** 宽高比。`adaptive` 表示交给厂商按输入自己定 */
export type VideoRatio = 'adaptive' | '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16'

/**
 * 参考图的用法。
 *
 * 这一位不能省：同一张图当「首帧」还是当「风格参考」，出来的东西完全不同，
 * 而两家都是靠 `role` 区分的。
 */
export type VideoImageRole = 'first_frame' | 'last_frame' | 'reference'

export interface VideoImageInput {
  /**
   * 公网直链或 `data:` URI。
   *
   * **两家都收 base64**（方舟文档明写 `data:image/<格式>;base64,<编码>`，
   * MiniMax 只是建议大文件走直链）。所以本地截图能直接用 ——
   * 「白盒截图 → 生成视频」这条路不需要用户先把图传到公网上去。
   *
   * 直链不计入请求体，base64 计入，见 `MAX_INLINE_PAYLOAD_BYTES`。
   */
  url: string
  role?: VideoImageRole
}

/**
 * 参考视频。**只收公网直链或 `asset://<ID>`**，方舟不收视频的 base64。
 * 格式 mp4 / mov（H.264 / H.265），Seedance 2.0 单个 2–15 秒、最多 3 个，
 * 2.5 单个 2–30 秒、最多 10 个。
 */
export type VideoReferenceUrl = string

/** 参考音频。公网直链、`data:audio/...;base64,...`、`asset://<ID>` 三种都收 */
export type AudioReferenceUrl = string

export interface GenerateVideoRequest {
  /** 提示词。**必填** —— 各家都不接受只有图没有文字的请求 */
  prompt: string
  /** 参考图。不给就是文生视频 */
  images?: VideoImageInput[]
  /** 参考视频（全模态参考）。只有方舟有 */
  videos?: VideoReferenceUrl[]
  /** 参考音频（全模态参考）。只有方舟有 */
  audios?: AudioReferenceUrl[]
  providerId?: string
  modelId?: string
  /** 时长（秒）。不给时 MiniMax 会用缺省 5，方舟交给模型自己定 */
  duration?: number
  resolution?: VideoResolution
  ratio?: VideoRatio
  /** 生成有声视频。方舟支持，MiniMax 不支持这个开关 */
  audio?: boolean
  /** 随机种子 */
  seed?: number
  signal?: AbortSignal
}

/** 一次已经提交出去的任务 */
export interface VideoJob {
  /** 任务号。两段共用同一个 */
  id: string
  /**
   * 这个任务是哪个 Provider 下的。
   *
   * 存它是为了续跑：任务号只在**产生它的那家**有意义。用户在生成和续跑之间
   * 改过「视频生成」的绑定（从方舟换到 MiniMax 很常见），拿方舟的任务号去问
   * MiniMax 得到的是一句「任务不存在」—— 而真正的任务好好地在方舟那边跑着。
   */
  providerId?: string
}

/**
 * 把任务打包成一个能带走的字符串：`providerId:任务号`。
 *
 * 带上厂商是为了续跑不认错家。但**裸任务号也收** —— 用户从厂商控制台复制回来的
 * 就是裸的，那种情况回落到当前绑定。
 */
export function encodeVideoJob(job: VideoJob): string {
  return job.providerId ? `${job.providerId}:${job.id}` : job.id
}

/** 反过来。没有 `:` 就当是裸任务号 */
export function decodeVideoJob(token: string): { id: string; providerId?: string } {
  const raw = String(token || '').trim()
  const at = raw.indexOf(':')
  if (at <= 0) return { id: raw }
  return { providerId: raw.slice(0, at), id: raw.slice(at + 1) }
}

export interface GeneratedVideo {
  /** 有时效的视频地址，拿到就该立刻落盘 */
  url: string
  job: VideoJob
  /** 厂商报的用量（方舟给 token 数）。拿不到就是 null */
  usage: number | null
}

// ── 适配器 ─────────────────────────────────────────────────────────────────

interface AdapterInput {
  modelId: string
  prompt: string
  images: VideoImageInput[]
  videos: VideoReferenceUrl[]
  audios: AudioReferenceUrl[]
  duration?: number
  resolution?: VideoResolution
  ratio?: VideoRatio
  audio?: boolean
  seed?: number
}

interface HttpRequest {
  method?: 'GET' | 'POST'
  path: string
  body?: string
}

interface JobProgress {
  done: boolean
  failed: boolean
  /** 给用户看的一句话，如厂商报的状态词。没有就留空 */
  note: string
  /** 完成时的视频地址 */
  url?: string
  usage?: number | null
}

interface VideoAdapter {
  /** 这家的官方文档。要改下面的字段，先去看它 */
  doc: string
  submit(input: AdapterInput): HttpRequest
  /** 从提交响应里取任务号。取不到返回 null */
  job(payload: unknown): VideoJob | null
  poll(job: VideoJob): HttpRequest
  progress(payload: unknown): JobProgress
}

/**
 * 两家共用的 `content[]` 构造。
 *
 * 方舟和 MiniMax 的多模态入参**是同一个形状**，这是这一类里少有的好消息：
 * 一个 `text` 元素 + 若干 `image_url` 元素，每个带一个 `role`。
 * 唯一的差别是 role 的取值，所以那一位由调用方给。
 */
function contentArray(
  input: AdapterInput,
  roleOf: (role: VideoImageRole | undefined) => string | undefined
): unknown[] {
  const content: unknown[] = [{ type: 'text', text: input.prompt }]
  for (const image of input.images) {
    const role = roleOf(image.role)
    content.push({
      type: 'image_url',
      image_url: { url: image.url },
      ...(role ? { role } : {})
    })
  }
  return content
}

/** 各家把我们的分辨率档叫什么 */
const ARK_RESOLUTION: Readonly<Record<VideoResolution, string>> = Object.freeze({
  '480p': '480p',
  '720p': '720p',
  '1080p': '1080p',
  // 方舟没有 2K 这一档，最高是 1080p。不静默降级 —— 见 submit 里的检查
  '2k': '2k'
})

const MINIMAX_RESOLUTION: Readonly<Record<VideoResolution, string>> = Object.freeze({
  '480p': '480P',
  // MiniMax 没有 720P，它那一档叫 768P
  '720p': '768P',
  '1080p': '768P',
  '2k': '2K'
})

/** Box Plan（`uebox-tasks`）不走这张表，走共用的任务客户端，见文件末尾 */
const ADAPTERS: Record<Exclude<VideoApi, 'uebox-tasks'>, VideoAdapter> = {
  /**
   * 火山方舟内容生成任务（Seedance 2.5 / 2.0）。
   *
   * 标量参数（resolution / duration 等）既能当顶层字段发，也能写在提示词末尾的
   * `--参数` 里，效果一样。这里一律走顶层字段 —— 拼进提示词是给人手敲用的，
   * 程序拼字符串只会在提示词本身含 `--` 时出诡异的错。
   *
   * @see https://www.volcengine.com/docs/82379/1520757
   */
  'ark-video': {
    doc: 'https://www.volcengine.com/docs/82379/1520757',

    submit(input) {
      if (input.resolution === '2k') {
        throw new VideoParamUnsupportedError(
          'ark-video',
          '2K 分辨率',
          'Seedance 最高是 1080p。要 2K 请换用 MiniMax-H3。'
        )
      }
      /*
       * 方舟把「首帧」「首尾帧」「全模态参考（参考图 / 视频 / 音频）」定为三种
       * **互斥**场景，混着发要等任务跑起来才异步报错 —— 那时候已经排了几分钟队。
       */
      const hasFrame = input.images.some((image) => image.role !== 'reference')
      const hasOmni =
        input.videos.length > 0 ||
        input.audios.length > 0 ||
        input.images.some((image) => image.role === 'reference')
      if (hasFrame && hasOmni) {
        throw new VideoParamUnsupportedError(
          'ark-video',
          '首帧/尾帧与参考图、参考视频、参考音频混用',
          '方舟把这两类定为互斥场景。要么只给首帧（+尾帧），要么全部改成参考素材、' +
            '在提示词里写「以图 1 为首帧」这类话。'
        )
      }
      // 方舟的参考图 role 叫 reference_image；首/尾帧则不带 role（靠顺序）
      const content = contentArray(input, (role) =>
        role === 'reference' ? 'reference_image' : undefined
      )
      for (const url of input.videos) {
        content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
      }
      for (const url of input.audios) {
        content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
      }
      const body: Record<string, unknown> = { model: input.modelId, content }
      if (input.resolution) body.resolution = ARK_RESOLUTION[input.resolution]
      if (input.duration !== undefined) body.duration = input.duration
      if (input.ratio) body.ratio = input.ratio
      if (input.audio !== undefined) body.generate_audio = input.audio
      if (input.seed !== undefined) body.seed = input.seed
      return { path: '/contents/generations/tasks', body: JSON.stringify(body) }
    },

    job(payload) {
      // 方舟的任务号在顶层 `id`（形如 cgt-20260414114820-xxxxx）
      const id = (payload as { id?: unknown })?.id
      return typeof id === 'string' && id ? { id } : null
    },

    poll(job) {
      return {
        method: 'GET',
        path: `/contents/generations/tasks/${encodeURIComponent(job.id)}`
      }
    },

    progress(payload) {
      const data = payload as {
        status?: unknown
        content?: { video_url?: unknown }
        usage?: { total_tokens?: unknown }
        error?: { message?: unknown }
      }
      const status = String(data?.status ?? '')
      const url = data?.content?.video_url
      return {
        done: status === 'succeeded',
        failed: status === 'failed' || status === 'cancelled',
        note: String(data?.error?.message ?? status ?? ''),
        url: typeof url === 'string' ? url : undefined,
        usage: typeof data?.usage?.total_tokens === 'number' ? data.usage.total_tokens : null
      }
    }
  },

  /**
   * MiniMax v2（MiniMax-H3 / H3-Max）。
   *
   * 与方舟三处不同，每一处踩错都是一次失败：任务号叫 `task_id`、轮询响应多包
   * 一层 `task`、`resolution` 与 `duration` 是**必填**。
   *
   * 必填那一条最容易漏：方舟不给这两个参数会用模型缺省，照着方舟写过来
   * 就是一次 422。所以这里补缺省值而不是不发。
   *
   * @see https://platform.minimax.io/docs/api-reference/video-generation-v2-create
   */
  'minimax-video': {
    doc: 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',

    submit(input) {
      if (input.audio !== undefined) {
        throw new VideoParamUnsupportedError(
          'minimax-video',
          '有声/无声开关',
          'MiniMax-H3 的音轨由模型自己决定，没有这个参数。要显式控制请用方舟 Seedance。'
        )
      }
      if (input.videos.length > 0 || input.audios.length > 0) {
        throw new VideoParamUnsupportedError(
          'minimax-video',
          '参考视频/参考音频',
          'MiniMax 只收图片。要拿视频或音频当参考请用方舟 Seedance 2.x。'
        )
      }
      const body: Record<string, unknown> = {
        model: input.modelId,
        content: contentArray(input, (role) =>
          role === 'reference' ? 'reference_image' : (role ?? 'first_frame')
        ),
        // 这两个是必填。缺省取各家文档里的最低档，省钱且一定被接受
        resolution: MINIMAX_RESOLUTION[input.resolution ?? '720p'],
        duration: input.duration ?? 5
      }
      // 文生视频时 ratio 必填且不能是 adaptive；有图时它被忽略，给了也不报错
      if (input.ratio && input.ratio !== 'adaptive') body.ratio = input.ratio
      else if (input.images.length === 0) body.ratio = '16:9'
      return { path: '/video_generation', body: JSON.stringify(body) }
    },

    job(payload) {
      const id = (payload as { task_id?: unknown })?.task_id
      return typeof id === 'string' && id ? { id } : null
    },

    poll(job) {
      return { method: 'GET', path: `/query/video_generation/${encodeURIComponent(job.id)}` }
    },

    progress(payload) {
      // 比方舟多包一层 `task`
      const task = (payload as { task?: Record<string, unknown> })?.task ?? {}
      const status = String(task.status ?? '')
      const url = (task.content as { url?: unknown } | undefined)?.url
      return {
        done: status === 'succeeded',
        failed: status === 'failed' || status === 'cancelled',
        note: status,
        url: typeof url === 'string' ? url : undefined,
        usage: null
      }
    }
  }
}

/**
 * 这家收不收参考视频 / 参考音频。MiniMax 只收图片（见它那个适配器）。
 * 工具在传对象存储**之前**问一句：几百 MB 的视频传完了才被适配器拒掉，白等好几分钟
 */
export function supportsReferenceMedia(api: VideoApi | undefined): boolean {
  return api !== 'minimax-video'
}

function adapterOf(provider: ProviderConfig): VideoAdapter {
  const api = provider.videoApi
  if (!api || api === 'uebox-tasks' || !(api in ADAPTERS)) {
    throw new VideoApiUnknownError(provider.id)
  }
  return ADAPTERS[api]
}

// ── 发请求 ─────────────────────────────────────────────────────────────────

function looksLikeHtml(body: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html|<\?xml|<head|<body)/i.test(body)
}

function describeError(body: string): string {
  if (looksLikeHtml(body)) return '返回的是 HTML 网页而不是 JSON'
  try {
    const payload = JSON.parse(body) as {
      error?: { message?: unknown } | string
      message?: unknown
      base_resp?: { status_msg?: unknown }
    }
    const error = payload.error
    const message =
      typeof error === 'string'
        ? error
        : // MiniMax 把错误放在 base_resp.status_msg 里，不在 error 下
          (error?.message ?? payload.message ?? payload.base_resp?.status_msg)
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    // 不是 JSON 也不是 HTML
  }
  return body.trim().slice(0, 200)
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/** data URI 里那段 base64 解码后的字节数。不真的解码，按 3/4 估就够 */
function inlineByteLength(dataUri: string): number {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1)
  return Math.floor((base64.length * 3) / 4)
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** 发一次请求并把 JSON 解出来。两段共用，因为它们的失败方式完全一样 */
async function send(
  provider: ProviderConfig,
  request: HttpRequest,
  signal: AbortSignal
): Promise<unknown> {
  const apiKey = await resolveApiKey(provider.apiKey)
  const method = request.method ?? 'POST'
  const url = `${provider.baseUrl.replace(/\/+$/, '')}${request.path}`

  /*
   * **网络异常也要重试**。`fetch` 在连接层出问题时是抛异常而不是返回状态码，
   * 只判 `response.status` 的重试对它完全无效 —— 而视频的轮询要跑几分钟到
   * 几十分钟，中间只要抖一下，一条已经付过钱的片子就没了。
   */
  let response: Response | null = null
  let networkError: unknown = null
  for (let attempt = 0; attempt < NETWORK_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...provider.headers
        },
        ...(request.body ? { body: request.body } : {}),
        signal
      })
      networkError = null
    } catch (error) {
      // 用户按了停止不该被当成抖动重试
      if (signal.aborted) throw error
      networkError = error
      response = null
    }
    if (response && (response.ok || !isRetryable(response.status))) break
    if (attempt === NETWORK_ATTEMPTS - 1) break
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
  }

  if (networkError) {
    throw new VideoRequestError(
      0,
      `${method} ${request.path}`,
      `连了 ${NETWORK_ATTEMPTS} 次都没连上：${networkError instanceof Error ? networkError.message : String(networkError)}`,
      url
    )
  }
  if (!response) throw new VideoRequestError(0, request.path, '请求没有发出去', url)
  const raw = await response.text()
  if (!response.ok) {
    throw new VideoRequestError(
      response.status,
      `${method} ${request.path}`,
      describeError(raw),
      url
    )
  }

  try {
    return JSON.parse(raw)
  } catch {
    throw new VideoRequestError(
      response.status,
      `${method} ${request.path}`,
      '返回的不是 JSON，多半是 Base URL 指到了网页而不是 API',
      url
    )
  }
}

/**
 * 提交一次生成，拿到任务号。**这一步就开始扣额度了。**
 *
 * @throws {VideoApiUnknownError} Provider 没写 videoApi
 * @throws {VideoEmptyPromptError} 没给提示词
 * @throws {VideoParamUnsupportedError} 这家没有对应这个参数的入参
 */
export async function submitVideo(
  provider: ProviderConfig,
  modelId: string,
  request: Omit<GenerateVideoRequest, 'providerId' | 'modelId'>
): Promise<VideoJob> {
  const adapter = adapterOf(provider)

  const prompt = String(request.prompt ?? '').trim()
  if (!prompt) throw new VideoEmptyPromptError()

  const images = (request.images ?? []).filter((item) => String(item?.url || '').trim())
  for (const image of images) {
    const url = image.url.trim()
    if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) {
      throw new VideoRequestError(
        0,
        'submit',
        `参考图「${url.slice(0, 60)}」既不是公网直链也不是 data URI。` +
          '本地文件请先经 loadReferenceImage 读成 data URI。'
      )
    }
  }
  const videos = (request.videos ?? []).map((url) => String(url || '').trim()).filter(Boolean)
  for (const url of videos) {
    // 方舟不收视频的 base64，本地文件更不用说 —— 在这里拦掉，别等厂商几十秒后回一句 400
    if (!/^https?:\/\//i.test(url) && !/^asset:\/\//i.test(url)) {
      throw new VideoRequestError(
        0,
        'submit',
        `参考视频「${url.slice(0, 60)}」不是公网直链也不是 asset:// 素材 ID。` +
          '方舟的参考视频只收这两种，不收 base64，本地视频文件没法直接带上去。'
      )
    }
  }
  const audios = (request.audios ?? []).map((url) => String(url || '').trim()).filter(Boolean)
  for (const url of audios) {
    if (!/^https?:\/\//i.test(url) && !/^asset:\/\//i.test(url) && !/^data:audio\//i.test(url)) {
      throw new VideoRequestError(
        0,
        'submit',
        `参考音频「${url.slice(0, 60)}」既不是公网直链、asset:// 素材 ID，也不是 data URI。` +
          '本地文件请先经 loadReferenceAudio 读成 data URI。'
      )
    }
  }

  // base64 撑到 4/3，超了是一次 413 —— 而 413 只表现为「生成失败」，查不出来
  const inlineBytes = [...images.map((image) => image.url), ...audios]
    .filter((url) => /^data:/i.test(url))
    .reduce((sum, url) => sum + inlineByteLength(url), 0)
  if (inlineBytes > MAX_INLINE_PAYLOAD_BYTES) {
    throw new VideoPayloadTooLargeError(inlineBytes, MAX_INLINE_PAYLOAD_BYTES)
  }

  const signal = withTimeout(request.signal, SUBMIT_TIMEOUT_MS)
  const httpRequest = adapter.submit({
    modelId,
    prompt,
    images,
    videos,
    audios,
    duration: request.duration,
    resolution: request.resolution,
    ratio: request.ratio,
    audio: request.audio,
    seed: request.seed
  })

  const payload = await send(provider, httpRequest, signal)
  const parsed = adapter.job(payload)
  const job = parsed ? { ...parsed, providerId: provider.id } : null
  if (!job) {
    throw new VideoRequestError(
      200,
      httpRequest.path,
      '提交成功但响应里没有任务号（厂商可能改了响应结构）'
    )
  }
  return job
}

/** 查一次任务状态。不阻塞、不重试 —— 循环由调用方掌握 */
export async function pollVideo(
  provider: ProviderConfig,
  job: VideoJob,
  signal?: AbortSignal
): Promise<JobProgress> {
  const adapter = adapterOf(provider)
  const payload = await send(provider, adapter.poll(job), withTimeout(signal, POLL_TIMEOUT_MS))
  return adapter.progress(payload)
}

/** 取本次指定的模型；未指定时沿用全局「视频生成」角色绑定 */
async function resolveVideoBinding(request: { providerId?: string; modelId?: string }): Promise<{
  provider: ProviderConfig
  modelId: string
  model?: ModelConfig
}> {
  const settings = await readSettings()
  const requestedProviderId = request.providerId?.trim()
  const requestedModelId = request.modelId?.trim()

  if (requestedProviderId || requestedModelId) {
    if (!requestedProviderId || !requestedModelId) throw new VideoUnavailableError()
    const provider = settings.providers.find((item) => item.id === requestedProviderId)
    // 能力不再看模型上的位，看 Provider 的用途
    if (!provider || provider.kind !== 'video') throw new VideoUnavailableError()
    return {
      provider,
      modelId: requestedModelId,
      model: provider.models.find((item) => item.id === requestedModelId)
    }
  }

  const binding = settings.roles.video
  if (!binding) throw new VideoNotConfiguredError()

  const provider = settings.providers.find((item) => item.id === binding.providerId)
  if (!provider) throw new VideoNotConfiguredError()

  return {
    provider,
    modelId: binding.modelId,
    model: provider.models.find((item) => item.id === binding.modelId)
  }
}

/**
 * 提交 → 轮询到完成，拿到视频地址。
 *
 * **要断点续传就别用这个**，用上面那两段：一旦被取消或超时，已经付掉的钱只能靠
 * `VideoTimeoutError.job` 里的任务号去捞。
 *
 * @throws {VideoNotConfiguredError} 没有绑定视频模型
 * @throws {VideoJobFailedError} 厂商说这个任务失败了
 * @throws {VideoTimeoutError} 超过 30 分钟仍未完成
 */
export async function generateVideo(
  request: GenerateVideoRequest & {
    onProgress?: (note: string) => void
    /** 套餐任务提交之后回一次任务令牌：调用方据此在「用户按停止」时报出任务号 */
    onSubmitted?: (jobToken: string) => void
  }
): Promise<GeneratedVideo> {
  const { provider, modelId } = await resolveVideoBinding(request)
  if (provider.videoApi === 'uebox-tasks') return runPlanVideo(provider, modelId, request)
  const job = await submitVideo(provider, modelId, request)

  const deadline = Date.now() + JOB_TIMEOUT_MS
  // 提交之后钱已经扣了，任务也在跑。查询失败只是「这一次没查到」，熬着 ——
  // 详见 model3d.ts 里同一处的长注释
  let consecutiveFailures = 0
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

    let progress: JobProgress
    try {
      progress = await pollVideo(provider, job, request.signal)
      consecutiveFailures = 0
    } catch (error) {
      // 用户按了停止：任务还在跑、钱已经扣了，任务号必须活着出来
      if (request.signal?.aborted) throw new VideoCancelledError(job)
      consecutiveFailures += 1
      if (consecutiveFailures >= POLL_FAILURE_TOLERANCE) throw new VideoInterruptedError(job, error)
      request.onProgress?.(`查询任务状态失败（第 ${consecutiveFailures} 次），任务还在跑，继续等…`)
      if (Date.now() > deadline) throw new VideoTimeoutError(job)
      continue
    }

    if (progress.failed) throw new VideoJobFailedError(progress.note)
    if (progress.done) {
      if (!progress.url) throw new VideoNoOutputError(JSON.stringify(progress).slice(0, 500))
      return { url: progress.url, job, usage: progress.usage ?? null }
    }
    if (progress.note) request.onProgress?.(progress.note)
    if (Date.now() > deadline) throw new VideoTimeoutError(job)
  }
}

/**
 * 接着查一个**已经提交出去**的视频任务，拿它的地址。
 *
 * 与 3D 同一条理由，而且更迫切：视频按秒计费，一条 1080p 的片子扔掉的钱
 * 比 3D 大一个量级。任务在厂商那边跑完了，我们这边因为一次抖动丢了它 ——
 * 有了这条路就是把任务号交回来取货，而不是重新付一次全款。
 *
 * 视频的任务号只有一位（不像 Rodin 的 3D 有两位），所以直接就是那个 id。
 */
export async function resumeVideo(
  request: { jobId: string; providerId?: string; modelId?: string; signal?: AbortSignal } & {
    onProgress?: (note: string) => void
  }
): Promise<GeneratedVideo> {
  const decoded = decodeVideoJob(request.jobId)
  if (!decoded.id) throw new VideoRequestError(0, 'resume', '任务号是空的，没法接着查')

  /*
   * 任务号里带的厂商优先 —— 绑定可能在生成之后被改过。
   *
   * 找不到那个 Provider（用户删了它）要**明说是哪一个**：这时候任务还在厂商
   * 那边、钱也扣了，用户至少得知道该去哪个控制台找。
   */
  const provider = decoded.providerId
    ? (await readSettings()).providers.find((item) => item.id === decoded.providerId)
    : (await resolveVideoBinding({})).provider
  if (!provider) {
    throw new VideoRequestError(
      0,
      'resume',
      `任务号里写的 Provider「${decoded.providerId}」已经不在配置里了。` +
        '任务本身还在那家厂商那边 —— 把它加回来，或者直接去它的控制台取结果。'
    )
  }
  const job: VideoJob = { id: decoded.id, providerId: provider.id }
  if (provider.videoApi === 'uebox-tasks') {
    const task = await resumePlanTask(provider, 'video', job.id, {
      signal: request.signal,
      onProgress: request.onProgress,
      label: (id) => `任务号 ${encodeVideoJob({ id, providerId: provider.id })}`
    })
    return planVideoResult(task, job)
  }

  const deadline = Date.now() + JOB_TIMEOUT_MS
  let consecutiveFailures = 0
  for (;;) {
    let progress: JobProgress
    try {
      progress = await pollVideo(provider, job, request.signal)
      consecutiveFailures = 0
    } catch (error) {
      // 用户按了停止：任务还在跑、钱已经扣了，任务号必须活着出来
      if (request.signal?.aborted) throw new VideoCancelledError(job)
      consecutiveFailures += 1
      if (consecutiveFailures >= POLL_FAILURE_TOLERANCE) throw new VideoInterruptedError(job, error)
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      continue
    }

    if (progress.failed) throw new VideoJobFailedError(progress.note)
    if (progress.done) {
      if (!progress.url) throw new VideoNoOutputError(JSON.stringify(progress).slice(0, 500))
      return { url: progress.url, job, usage: progress.usage ?? null }
    }
    if (progress.note) request.onProgress?.(progress.note)
    if (Date.now() > deadline) throw new VideoTimeoutError(job)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export interface VideoModelStatus {
  configured: boolean
  /** 形如 `火山方舟:doubao-seedance-2-5-260628` */
  model: string | null
}

/** 当前的视频配置。与其余几档一样只看绑定、**不发请求** */
export async function getVideoStatus(): Promise<VideoModelStatus> {
  try {
    const settings = await readSettings()
    const binding = settings.roles.video
    if (!binding) return { configured: false, model: null }

    const provider = settings.providers.find((item) => item.id === binding.providerId)
    // 绑定在、但没写接口形状 = 发出去必然 404，对界面来说等于没配
    if (!provider?.videoApi) return { configured: false, model: null }

    return { configured: true, model: `${provider.displayName}:${binding.modelId}` }
  } catch {
    return { configured: false, model: null }
  }
}

// ── Box Plan（videoApi: 'uebox-tasks'）──────────────────────────────

/**
 * 我们的视频请求 → 协议 05-tasks 的 `uebox-video` 输入。字段几乎一一对应，`audio` → `generate_audio`。
 *
 * 参考图只收 https 链接或 data URI；参考视频只收 https 链接（协议不收视频的 base64，
 * 也没有方舟的 `asset://`）；参考音频收 https 或 data URI。首尾帧与参考素材互斥、
 * 时长范围这些组合规则由服务端按清单判（400 不计额度），这里只拦形状。
 */
export function planVideoBody(
  modelId: string,
  request: Omit<GenerateVideoRequest, 'providerId' | 'modelId'>
): PlanTaskBody {
  const prompt = String(request.prompt ?? '').trim()
  if (!prompt) throw new VideoEmptyPromptError()

  const images = (request.images ?? [])
    .filter((item) => String(item?.url || '').trim())
    .map((item) => ({ url: item.url.trim(), role: item.role ?? 'first_frame' }))
  for (const image of images) {
    if (!/^https:\/\//i.test(image.url) && !/^data:image\//i.test(image.url)) {
      throw new VideoRequestError(
        0,
        'submit',
        `参考图「${image.url.slice(0, 60)}」不是 https 链接也不是 data URI。` +
          '本地文件请先经 loadReferenceImage 读成 data URI。'
      )
    }
  }
  const videos = (request.videos ?? []).map((url) => String(url || '').trim()).filter(Boolean)
  for (const url of videos) {
    if (!/^https:\/\//i.test(url)) {
      throw new VideoParamUnsupportedError(
        'uebox-tasks',
        `参考视频「${url.slice(0, 60)}」`,
        'Box Plan 的参考视频只收 https 链接（不收 base64，也没有 asset:// 素材 ID）。'
      )
    }
  }
  const audios = (request.audios ?? []).map((url) => String(url || '').trim()).filter(Boolean)
  for (const url of audios) {
    if (!/^https:\/\//i.test(url) && !/^data:audio\//i.test(url)) {
      throw new VideoParamUnsupportedError(
        'uebox-tasks',
        `参考音频「${url.slice(0, 60)}」`,
        'Box Plan 的参考音频只收 https 链接或 data URI。'
      )
    }
  }

  return {
    model: modelId,
    input: {
      prompt,
      ...(images.length > 0 ? { images } : {}),
      ...(videos.length > 0 ? { videos: videos.map((url) => ({ url })) } : {}),
      ...(audios.length > 0 ? { audios: audios.map((url) => ({ url })) } : {}),
      ...(request.duration !== undefined ? { duration: request.duration } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.ratio ? { ratio: request.ratio } : {}),
      ...(request.audio !== undefined ? { generate_audio: request.audio } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {})
    }
  }
}

function planVideoResult(task: PlanTask, job: VideoJob): GeneratedVideo {
  const [video] = filesOfRole(task, 'video')
  if (!video) throw new VideoNoOutputError(JSON.stringify(task.files).slice(0, 500))
  // 2026-09-24 起是 Credits；更早的服务端给的是秒数
  const used = task.usage?.credits ?? task.usage?.video_seconds
  return { url: video.url, job, usage: typeof used === 'number' ? used : null }
}

/**
 * 套餐那一支：提交（带幂等键、崩溃后按账本续上）→ 按 10 秒轮询 → 拿视频链接（7 天有效）。
 * 失败、超时退回额度；用户按停止时服务端取消，只有还在排队时才退。见 creatorPlan/tasks.ts。
 */
async function runPlanVideo(
  provider: ProviderConfig,
  modelId: string,
  request: GenerateVideoRequest & {
    onProgress?: (note: string) => void
    /** 套餐任务提交之后回一次任务令牌：调用方据此在「用户按停止」时报出任务号 */
    onSubmitted?: (jobToken: string) => void
  }
): Promise<GeneratedVideo> {
  const body = planVideoBody(modelId, request)
  const task = await runPlanTask(provider, 'video', body, {
    signal: request.signal,
    onProgress: request.onProgress,
    onSubmitted: (task) =>
      request.onSubmitted?.(encodeVideoJob({ id: task.id, providerId: provider.id })),
    label: (id) => `任务号 ${encodeVideoJob({ id, providerId: provider.id })}`
  })
  const result = planVideoResult(task, { id: task.id, providerId: provider.id })
  await settlePlanTask(body)
  return result
}
