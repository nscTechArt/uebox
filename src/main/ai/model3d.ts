import { resolveApiKey } from './credentials'
import { ModelNotConfiguredError } from './resolveModel'
import { readSettings } from './store'
import type { Model3dApi } from '../../shared/aiProvider'
import type { ModelConfig, ProviderConfig } from './types'
import { cachedPlanSpec } from './creatorPlan/cachedSpec'
import {
  fileNameOfUrl,
  filesOfRole,
  resumePlanTask,
  runPlanTask,
  settlePlanTask,
  type PlanTask,
  type PlanTaskBody
} from './creatorPlan/tasks'

/**
 * 本地直连的 3D 网格生成。
 *
 * 与 `embedding.ts` / `imageGeneration.ts` 是同一类东西：**产出的不是文本**，
 * 所以不走 resolveModelSelection 那条 LanguageModel 的路，而是自己发请求。
 *
 * ## 与前面几类唯一的结构性差别：异步
 *
 * 生图和语音是「发一次、等着、拿结果」；3D 一次要几十秒到几分钟，各家一律做成
 * **提交 → 轮询 → 取文件**三段。所以适配器比那边多两个方法，也所以这里把三段
 * 分别导出（`submitModel3d` / `pollModel3d` / `fetchModel3dFiles`），而不是只留
 * 一个大函数：**重新提交是要花钱的**。应用重启、对话上下文被压缩、用户关了窗口
 * 之后，调用方拿着存下来的 job id 应该能接着轮询，而不是重付一次额度。
 *
 * `generateModel3d` 只是把这三段串起来的便利封装，给不需要断点续传的调用方用。
 *
 * ## 为什么不按 ProviderProtocol 卡
 *
 * 见 `Model3dApi` 的注释：那个字段回答的是「用哪套对话接口」，而 3D 厂商压根不提供
 * 对话。拿它去卡只会逼用户在配置里随便选一个对不上的协议来骗过校验。
 *
 * ## 边界
 *
 * 只做「一句话/几张图进、一组文件地址出」。**不下载、不入库、不导引擎** ——
 * 那几件事与厂商无关，属于上层。这里返回地址而不是字节，也是因为一次生成往往是
 * 网格 + 若干张贴图，全缓进主进程内存没有道理。
 *
 * ⚠️ 地址是**有时效的**，而且短得超出直觉：**Tripo 只有 5 分钟**，Rodin / Meshy
 * 是小时级。调用方拿到之后应当立刻落盘，不要先存地址再慢慢下。
 */

/** 提交、轮询、取文件三次请求各自的超时。轮询那次最短：它本来就要反复发 */
const SUBMIT_TIMEOUT_MS = 120_000
const POLL_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 120_000

/** 整个任务从提交到出文件的上限。超了就是厂商那边卡住了，报错好过无限等 */
const JOB_TIMEOUT_MS = 600_000

/** 两次轮询之间的间隔。各家都按秒计费排队，5 秒足够快又不会把自己打成限流 */
const POLL_INTERVAL_MS = 5_000

/** 单次请求最多连几次（含首次）。退避 1s / 2s，够扛住常见的瞬时抖动 */
const NETWORK_ATTEMPTS = 3

/**
 * 轮询阶段能容忍连续几次失败。
 *
 * 与 `NETWORK_ATTEMPTS` 是两层：那一层管一次请求内部的重连，这一层管
 * 「连着几轮都没查到」。分开是因为代价不对称 —— 提交前失败只是白等，
 * 提交后失败**钱已经扣了**，多熬几轮远比把任务判死划算。
 */
const POLL_FAILURE_TOLERANCE = 5

/**
 * 配置类错误共有的锚点短语。
 *
 * 与生图、语音共用同一个思路：错误经过 IPC 之后只剩字符串，instanceof 早就没了，
 * 靠一个固定短语让上层认出「这是配置问题，要原样透出」。
 */
export const MODEL3D_CONFIG_ERROR_MARKER = '设置 → 模型'

export class Model3dNotConfiguredError extends ModelNotConfiguredError {
  constructor() {
    super(
      `还没有配置「3D 生成」模型。请到 ${MODEL3D_CONFIG_ERROR_MARKER} 添加一个 Provider，` +
        '在它的模型清单里勾上「3D 生成」并选好接口形状，再把这个模型绑定给「3D 生成」角色。',
      'model3d'
    )
    this.name = 'Model3dNotConfiguredError'
  }
}

export class Model3dUnavailableError extends Error {
  constructor() {
    super(
      `这次指定的 3D 模型已经不可用。请到 ${MODEL3D_CONFIG_ERROR_MARKER} ` +
        '检查 Provider、密钥和模型的「3D 生成」能力，再重新选择。'
    )
    this.name = 'Model3dUnavailableError'
  }
}

/**
 * 模型没写 `model3dApi` 时抛这个。
 *
 * 这一类**不猜缺省值**（与生图相反）：3D 还没有事实标准，猜错的表现是一串 404，
 * 那看上去像「Base URL 填错了」，用户会去反复改地址，而真正缺的是接口形状。
 */
export class Model3dApiUnknownError extends Error {
  constructor(readonly providerId: string) {
    super(
      `Provider「${providerId}」没有指定 3D 接口形状。请到 ${MODEL3D_CONFIG_ERROR_MARKER} ` +
        `打开这个模型的详情，选一个接口形状（目前支持：${Object.keys(ADAPTERS).join(' / ')}）。`
    )
    this.name = 'Model3dApiUnknownError'
  }
}

/**
 * 这家收不了本地图片，只收公网直链。
 *
 * 目前只有 Tripo：它的图片入参要么是公网 URL、要么是 File Upload 换来的
 * file_token，**没有内联 base64 这条路**（Rodin 走 multipart、Meshy 收 data URI，
 * 两家都不需要）。
 *
 * 本地图片已经由 `adapter.upload` 那条路自动传成 file_token 了，所以正常流程
 * 走不到这里。留着是当**兜底断言**：万一上传拿回了空 token 而没抛错，
 * 在这里挡住，好过把 undefined 当图片发出去换一次收费的 400。
 */
export class Model3dLocalImageUnsupportedError extends Error {
  constructor(readonly api: string) {
    super(
      `«${api}» 只接受公网可访问的图片地址，收不了本地图片。` +
        '请先把参考图传到一个能公开访问的地方，或者换用 Rodin / Meshy。'
    )
    this.name = 'Model3dLocalImageUnsupportedError'
  }
}

/**
 * 这家没有对应这个参数的入参。
 *
 * **必须报错，不能静默丢掉。** 各家的能力不是同一套，而调用方给
 * `boundingBox` 是为了让整批资产比例一致、给 `format` 是为了下游导入器认得。
 * 悄悄不发这两个参数，任务会正常跑完、正常扣费、正常出模型 —— 只是尺寸和格式
 * 不是要的那个。那种错在下游才暴露，而且看不出是这里丢的。
 */
export class Model3dParamUnsupportedError extends Error {
  constructor(
    readonly api: string,
    readonly param: string,
    hint: string
  ) {
    super(`«${api}» 不支持 ${param}。${hint}`)
    this.name = 'Model3dParamUnsupportedError'
  }
}

/** 既没有提示词也没有参考图。**先在本地拦掉**，不然是一次白花钱的 400 */
export class Model3dEmptyInputError extends Error {
  constructor() {
    super('生成 3D 至少要给一句提示词或一张参考图。')
    this.name = 'Model3dEmptyInputError'
  }
}

/** 厂商把请求打回来了。消息保持短，只留状态码、端点、厂商那句话 */
export class Model3dRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
    /** 完整地址。不进 message，需要它的调用方自己取 */
    readonly url = ''
  ) {
    super(
      `3D 接口报错 HTTP ${status}（POST ${path}）：${detail.slice(0, 200) || '厂商没有给出说明'}`
    )
    this.name = 'Model3dRequestError'
  }
}

/** 厂商说这个任务失败了。额度多半已经扣了，所以要把厂商那句话原样带出来 */
export class Model3dJobFailedError extends Error {
  constructor(detail: string) {
    super(`3D 生成任务失败：${detail || '厂商没有给出原因'}`)
    this.name = 'Model3dJobFailedError'
  }
}

/**
 * 提交成功之后，查询这一端断了。
 *
 * 与「任务失败」是两回事，而这个区别值钱：任务**大概率还在厂商那边跑**，
 * 钱也已经扣了。所以这里把任务号带出来，并且措辞上必须挡住「再试一次」——
 * 重新提交是再付一次全款。
 */
export class Model3dInterruptedError extends Error {
  constructor(
    readonly job: Model3dJob,
    readonly cause: unknown
  ) {
    super(
      `任务已经提交成功（任务号 ${encodeModel3dJob(job)}），但连着查不到它的状态：` +
        `${cause instanceof Error ? cause.message : String(cause)}。` +
        '**任务多半还在厂商那边跑，额度也已经扣了** —— 不要重新提交，' +
        '那是再付一次全款。稍后拿这个任务号去厂商控制台看结果。'
    )
    this.name = 'Model3dInterruptedError'
  }
}

/**
 * 用户在**提交之后**按了停止。
 *
 * 取消掉的是「我们这边的等待」，不是厂商那边的任务 —— 那个还在跑，钱也已经扣了。
 * 直接把原始的 AbortError 抛出去，任务号就跟着丢了，用户为一次点击付了全款
 * 却拿不到东西。这一档存在就是为了把任务号救出来。
 */
export class Model3dCancelledError extends Error {
  constructor(readonly job: Model3dJob) {
    super(
      `已停止等待（任务号 ${encodeModel3dJob(job)}）。` +
        '**厂商那边的任务还在跑，额度已经扣了** —— 想要结果的话用这个任务号取回，' +
        '不用重新生成。'
    )
    this.name = 'Model3dCancelledError'
  }
}

/** 超过 `JOB_TIMEOUT_MS` 还没跑完。job 带出来，调用方可以稍后接着轮询 */
export class Model3dTimeoutError extends Error {
  constructor(readonly job: Model3dJob) {
    super(
      `3D 生成超过 ${Math.round(JOB_TIMEOUT_MS / 1000)} 秒仍未完成（任务号 ${encodeModel3dJob(job)}）。` +
        '任务可能还在厂商那边排队 —— 用这个任务号可以接着查，不用重新提交。'
    )
    this.name = 'Model3dTimeoutError'
  }
}

/**
 * 请求通了，但没解析出可下载的文件。
 *
 * 单独成一档而不是当成空结果：这多半意味着厂商改了响应结构，而不是用户配错了。
 * 把原始 body 带出来，是为了让下一次出问题时能直接看到新形状，不用再复现一遍。
 */
export class Model3dNoFilesError extends Error {
  constructor(readonly raw: string) {
    super('3D 任务已完成，但响应里没有可下载的文件地址（厂商可能改了响应结构）。')
    this.name = 'Model3dNoFilesError'
  }
}

// ── 对外的形状 ─────────────────────────────────────────────────────────────

/**
 * 输出的网格格式。
 *
 * 只收各家普遍都给的这几种。`glb` 排第一并作为缺省：它自带材质与贴图，是单文件，
 * 而虚幻侧的导入器已经认这个扩展名。
 */
export type Model3dFormat = 'glb' | 'gltf' | 'fbx' | 'obj' | 'usdz' | 'stl'

/**
 * 网格精度档。
 *
 * 用「档」而不是直接收面数：同一个档在不同拓扑下对应的面数差一个数量级
 * （Rodin 的 high 在三角面下是 50 万、四边面下是 5 万），把换算留在适配器里，
 * 调用方只需要表达「这是主角道具还是背景件」。
 */
export type Model3dQuality = 'high' | 'medium' | 'low' | 'extra-low'

/** 拓扑。`quad` 便于后续在 DCC 里改，`raw` 三角面直接进引擎 */
export type Model3dTopology = 'raw' | 'quad'

/** 材质产出。`pbr` 给基础色/金属度/法线/粗糙度，`shaded` 只给烘死光照的基础色 */
export type Model3dMaterial = 'pbr' | 'shaded' | 'all'

export interface GenerateModel3dRequest {
  /** 提示词。与 `images` 至少要有一个 */
  prompt?: string
  /**
   * 参考图。`data:` URI 或 http(s) 直链都收，内部统一取成字节再上传。
   *
   * 图生 3D 比文生 3D 稳得多，有图就尽量给图。
   *
   * **给多张时整组都会发出去**，按 `正面 → 左 → 背 → 右` 解释朝向：三家分别走
   * Rodin 的多图 `images`、Tripo 的 `multiview-to-model`、Meshy 的
   * `multi-image-to-3d`。后两家各只有四个视位，超了**报错**而不是丢掉多的那几张。
   */
  images?: string[]
  /** 可选的已配置 Provider；与 modelId 同时传入时覆盖全局「3D 生成」角色绑定 */
  providerId?: string
  /** 可选的已配置 3D 模型；与 providerId 同时传入时覆盖全局「3D 生成」角色绑定 */
  modelId?: string
  /** 输出格式，缺省 glb */
  format?: Model3dFormat
  /** 精度档。不给就用厂商自己的缺省 */
  quality?: Model3dQuality
  /** 拓扑。不给就用厂商自己的缺省 */
  topology?: Model3dTopology
  /** 材质产出。不给就用厂商自己的缺省 */
  material?: Model3dMaterial
  /**
   * 限制成品的最大尺寸，`[宽, 高, 长]`。
   *
   * 这是整套参数里对下游最值钱的一个：给了它，同一批资产的比例才是一致的，
   * 导进引擎之后不用一个个手调缩放。单位由厂商自己解释，不做换算。
   */
  boundingBox?: [number, number, number]
  /** 随机种子。同样的输入 + 同样的种子应当得到同样的结果，用于「换一个」时避开重复 */
  seed?: number
  /** 人形生成 T/A 摆姿。**只是摆姿势，不给骨骼** —— 出来的仍是静态网格 */
  restPose?: boolean
  /** 厂商特供开关。发给不支持的厂商会明确报错，不会被静默丢掉 */
  vendor?: Model3dVendorOptions
  /** 调用方的取消信号。与内部超时并联 */
  signal?: AbortSignal
}

/**
 * 只有一部分厂商有的开关。
 *
 * 单独一个类型而不是摊进 `GenerateModel3dRequest`，是为了让「这一批是厂商特供」
 * 这件事在类型上就看得见 —— 上层按厂商决定要不要把它们暴露给模型
 * （见 `generate3dModel.ts`），底下这一层则负责在发错家的时候明确报错。
 *
 * 目前全部来自 Tripo。名字取的是通用叫法而不是它的字段名：另外两家将来有对应
 * 能力时应该复用这些名字，而不是各自再长一套。
 */
export interface Model3dVendorOptions {
  /** 反向描述：不想要的东西（底座、支架、背景板这类）。Tripo 上限 255 字符 */
  negativePrompt?: string
  /** 贴图精细档。`extreme` 只有 Tripo P 系列有 */
  textureQuality?: 'standard' | 'detailed' | 'extreme'
  /** 几何精细档 */
  geometryQuality?: 'standard' | 'detailed'
  /** 出「像手工做的」低模拓扑。**会把面数压进厂商给的低模区间** */
  smartLowPoly?: boolean
  /** 按真实世界米制缩放。整批资产要尺寸一致时用它 */
  autoSize?: boolean
  /** 让成品朝向对齐参考图，而不是厂商的默认朝向。只对图生有意义 */
  alignOrientationToImage?: boolean
  /** 贴图对齐原图还是对齐几何。只对图生有意义 */
  textureAlignment?: 'original_image' | 'geometry'
  /** 先让厂商自动修一遍输入图（会更慢）。只对图生有意义 */
  imageAutofix?: boolean
  /** 分件输出。**与贴图、PBR、四边面互斥** */
  generateParts?: boolean
}

/** 厂商特供开关的字段名清单。发错家时要一条条点名，不能囫囵说「有不支持的参数」 */
const VENDOR_OPTION_KEYS = [
  'negativePrompt',
  'textureQuality',
  'geometryQuality',
  'smartLowPoly',
  'autoSize',
  'alignOrientationToImage',
  'textureAlignment',
  'imageAutofix',
  'generateParts'
] as const satisfies readonly (keyof Model3dVendorOptions)[]

/**
 * 一次已经提交出去的任务。
 *
 * 做成**两位**而不是一个 id，是被 Rodin 逼的：它的 status 只认
 * `subscription_key`、download 只认顶层 `uuid`，互换的结果是一句看不出来路的
 * 报错。另外两家用不着第二个 id，但那一位对它们同样有用（见下）。
 */
export interface Model3dJob {
  /** 轮询状态用的 id */
  poll: string
  /**
   * 第二个位，含义**由适配器自己定**，上层只负责原样存取。
   *
   * Rodin 放的是取文件用的另一个 id；Meshy 放的是任务类型（它的轮询端点按类型
   * 分叉）；Tripo 两段共用一个 id，这里就是同一个值。做成不透明的一位，是因为
   * 它唯一的作用是「断点续传时能把任务接回来」—— 上层不需要看懂它。
   */
  download: string
  /** 厂商声明本次扣掉的额度。拿不到就是 null */
  cost: number | null
  /**
   * 这个任务是哪个 Provider 下的。
   *
   * 存它是为了续跑不认错家：用户在生成和续跑之间改过「3D 生成」的绑定
   * （从 Tripo 换到 Rodin 很常见），拿 Tripo 的任务号去问 Rodin 得到的是
   * 一句「任务不存在」—— 而真正的任务好好地在 Tripo 那边。
   */
  providerId?: string
}

/**
 * 把任务打包成**一个能带走的字符串**。
 *
 * `Model3dJob` 有两位（Rodin 的 status 与 download 用的是不同的 id），
 * 但报给用户和模型的必须是一个词 —— 让人抄两个 id、还得记住哪个配哪个端点，
 * 是把厂商的实现细节甩给用户。
 *
 * 分隔符用 `~`：三家的 id 都是 uuid / `task_xxx` / 纯数字，都不含它。
 */
export function encodeModel3dJob(job: Model3dJob): string {
  const core = `${job.poll}~${job.download}`
  return job.providerId ? `${job.providerId}:${core}` : core
}

/** 反过来。缺第二位时两位都用同一个值 —— Tripo / Meshy 本来就只有一个 id */
export function decodeModel3dJob(token: string): Model3dJob {
  const raw = String(token || '').trim()
  // 厂商前缀可有可无：用户从厂商控制台复制回来的是裸任务号
  const at = raw.indexOf(':')
  const providerId = at > 0 ? raw.slice(0, at) : undefined
  const [poll, download] = (at > 0 ? raw.slice(at + 1) : raw).split('~')
  if (!poll) throw new Model3dJobTokenInvalidError(token)
  return { poll, download: download || poll, cost: null, ...(providerId ? { providerId } : {}) }
}

/** 任务号不成形。与其拿着空串去查一个不存在的任务，不如直说 */
export class Model3dJobTokenInvalidError extends Error {
  constructor(readonly token: string) {
    super(
      `任务号「${token}」不成形。它应该长得像 \`abc123~abc123\`，从上一次失败的报错里原样复制。`
    )
    this.name = 'Model3dJobTokenInvalidError'
  }
}

export interface Model3dFile {
  /** 有时效的下载地址，拿到就该立刻落盘 */
  url: string
  /** 厂商给的文件名，含扩展名。用来分辨网格与贴图 */
  name: string
}

export interface GeneratedModel3d {
  files: Model3dFile[]
  job: Model3dJob
}

// ── 适配器 ─────────────────────────────────────────────────────────────────

/** 已经归一化过的一次请求。适配器只管把它翻成自家文档里的那个形状 */
interface AdapterInput {
  /** 厂商侧的模型标识。Rodin 管它叫 tier（`Gen-2` / `Gen-2.5-Low`） */
  modelId: string
  prompt: string
  /**
   * 已经取成字节的参考图，附带原始媒体类型。
   *
   * `url` 只在**调用方本来给的就是公网直链**时才有。Tripo 只收直链或
   * file_token，收不了内联字节，所以它需要这一位来判断这张图能不能用。
   */
  images: { bytes: Uint8Array; mediaType: string; url?: string }[]
  format: Model3dFormat
  quality?: Model3dQuality
  topology?: Model3dTopology
  material?: Model3dMaterial
  boundingBox?: [number, number, number]
  seed?: number
  restPose?: boolean
  /** 厂商特供开关。到这一层时已经确认过发的是支持它们的那一家 */
  vendor: Model3dVendorOptions
}

/** 适配器拼出来的 HTTP 请求。路径相对 Provider 的 Base URL */
interface HttpRequest {
  /**
   * 缺省 POST。
   *
   * 这一位是**第二、三个适配器逼出来的**：只看 Rodin 的话三段都是 POST，
   * 很容易把方法写死。而 Tripo 与 Meshy 的轮询都是 `GET /task/{id}` ——
   * 把 GET 发成 POST 得到的是 405，看上去像路径拼错了。
   */
  method?: 'GET' | 'POST'
  path: string
  /** FormData 交给 fetch 自己带 boundary；字符串则由上层补 JSON 头。GET 没有体 */
  body?: FormData | string
}

/** 一次轮询读出来的进度 */
interface JobProgress {
  done: boolean
  failed: boolean
  /** 给用户看的一句话，如「3 个子任务里 2 个已完成」「67%」。没有就留空 */
  note: string
  /**
   * 文件地址就在轮询响应里。
   *
   * 同样是后两个适配器逼出来的：Rodin 要单独打一次 `/download`，而 Tripo 的
   * `data.output` 和 Meshy 的 `model_urls` **在轮询响应里就给全了**。为它们
   * 硬造一次下载调用，就是硬造一个厂商根本没有的端点。
   */
  files?: Model3dFile[]
}

interface Model3dAdapter {
  /** 这家的官方文档。要改下面的字段，先去看它 */
  doc: string
  /**
   * 密钥的前缀。缺省 `Bearer`。
   *
   * 单独一位是因为它**不是所有家都一样**（fal.ai 用的是 `Key`），
   * 而写错的表现是 401 —— 那看上去像密钥填错了。
   */
  authScheme?: string
  /**
   * 这家收不了内联图片，要**先传一次文件换 token**，再把 token 当图片入参提交。
   *
   * 写成数据而不是让适配器自己发请求：上传这一步三家的形状是一样的
   * （multipart 一个字段、回一个 token），不一样的只有端点、字段名、
   * token 在响应里的位置。让 `submit` 保持纯函数（进 input、出一个请求），
   * 上传由通用层统一做 —— 否则每个适配器都要自带一份重试与错误处理。
   */
  upload?: {
    path: string
    /** multipart 里那个文件字段叫什么 */
    field: string
    /** 从上传响应里取出 token */
    tokenAt(payload: unknown): string | null
  }
  submit(input: AdapterInput): HttpRequest
  /**
   * 从提交响应里取出后续各段要用的 id。取不到返回 null。
   *
   * 也收 `input`：有些家的轮询路径取决于**提交时选了哪种任务**（Meshy 的
   * text-to-3d / image-to-3d 是两条端点），那个信息只在输入里，响应里没有。
   */
  job(payload: unknown, input: AdapterInput): Model3dJob | null
  poll(job: Model3dJob): HttpRequest
  progress(payload: unknown): JobProgress
  /**
   * 单独一次「取文件」调用。**只有真有这个端点的家才写**（目前只有 Rodin）；
   * 不写就表示文件从 `progress().files` 来。
   */
  files?(job: Model3dJob): HttpRequest
  /** 从取文件的响应里挖出地址。挖不到返回空数组。与 `files` 成对出现 */
  parseFiles?(payload: unknown): Model3dFile[]
}

/** Rodin 的精度档名。与我们的档一一对应，只是大小写不同 */
const RODIN_QUALITY: Readonly<Record<Model3dQuality, string>> = Object.freeze({
  high: 'high',
  medium: 'medium',
  low: 'low',
  'extra-low': 'extra-low'
})

/** Box Plan（`uebox-tasks`）不走这张表，走共用的任务客户端，见文件末尾 */
const ADAPTERS: Record<Exclude<Model3dApi, 'uebox-tasks'>, Model3dAdapter> = {
  /**
   * Hyper3D Rodin。
   *
   * 三段都是 POST：`/rodin`（multipart）→ `/status` → `/download`。
   *
   * 最容易踩的一脚在提交响应上：里面有 `uuid`、`jobs.uuids`、
   * `jobs.subscription_key` 三个 id，而**只有两个是能用的** ——
   * `subscription_key` 给 status，顶层 `uuid` 给 download，`jobs.uuids` 两处都不是。
   * 官方文档专门为此加了一条警告。
   *
   * @see https://docs.hyper3d.ai/en/get-started/quick-start
   * @see https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5
   */
  rodin: {
    doc: 'https://docs.hyper3d.ai/en/get-started/quick-start',

    submit(input) {
      const form = new FormData()
      // tier 就是「用哪一代模型」，与其它模态里的 model 是同一个位置的东西
      form.append('tier', input.modelId)
      if (input.prompt) form.append('prompt', input.prompt)
      input.images.forEach((image, index) => {
        const extension = image.mediaType.split('/')[1] || 'png'
        form.append(
          'images',
          new Blob([image.bytes as BlobPart], { type: image.mediaType }),
          `reference-${index}.${extension}`
        )
      })
      form.append('geometry_file_format', input.format)
      if (input.quality) form.append('quality', RODIN_QUALITY[input.quality])
      // Rodin 管三角面叫 Raw、四边面叫 Quad，首字母大写
      if (input.topology) form.append('mesh_mode', input.topology === 'quad' ? 'Quad' : 'Raw')
      if (input.material)
        form.append(
          'material',
          input.material === 'pbr' ? 'PBR' : input.material === 'shaded' ? 'Shaded' : 'All'
        )
      // 三个整数的 JSON 数组，顺序是宽(X) / 高(Y) / 长(Z)
      if (input.boundingBox) form.append('bbox_condition', JSON.stringify(input.boundingBox))
      if (typeof input.seed === 'number') form.append('seed', String(input.seed))
      if (input.restPose) form.append('TAPose', 'true')
      return { path: '/rodin', body: form }
    },

    job(payload) {
      const body = payload as {
        uuid?: unknown
        jobs?: { subscription_key?: unknown }
        consumed?: unknown
      }
      const download = typeof body?.uuid === 'string' ? body.uuid : ''
      const poll =
        typeof body?.jobs?.subscription_key === 'string' ? body.jobs.subscription_key : ''
      if (!download || !poll) return null
      return { poll, download, cost: typeof body.consumed === 'number' ? body.consumed : null }
    },

    poll(job) {
      return { path: '/status', body: JSON.stringify({ subscription_key: job.poll }) }
    },

    progress(payload) {
      const jobs = (payload as { jobs?: unknown })?.jobs
      // 一次提交可能拆成多个子任务，全部 Done 才算完
      const statuses = Array.isArray(jobs)
        ? jobs.map((item) => String((item as { status?: unknown })?.status ?? ''))
        : []
      if (statuses.length === 0) return { done: false, failed: false, note: '' }
      const failed = statuses.some((status) => status === 'Failed')
      const finished = statuses.filter((status) => status === 'Done').length
      return {
        failed,
        done: !failed && finished === statuses.length,
        note: statuses.length > 1 ? `${finished}/${statuses.length} 个子任务已完成` : ''
      }
    },

    files(job) {
      return { path: '/download', body: JSON.stringify({ task_uuid: job.download }) }
    },

    parseFiles(payload) {
      return collectFiles(payload)
    }
  },

  /**
   * Tripo（VAST AI）—— **V3**。
   *
   * 两段：`POST /generation/{text-to-model|image-to-model|multiview-to-model}` 拿
   * `data.task_id`，然后 `GET /tasks/{id}` 轮到 `data.status === 'success'`，
   * **文件就在同一份响应的 `data.output` 里**，没有第三段。
   *
   * ## 为什么直接写 V3 而不是文档更全的 V2
   *
   * V2 的维护在 2026-10-01 结束，端点在 2026-11-01 全部关停。照 V2 写的适配器
   * 从落地那天算只有两个月寿命 —— 这正是「不想一直追」要避免的那种活。
   *
   * V3 不是 V2 换个前缀，三处都变了：端点从一个 `/task` 按能力拆开、
   * `model_version` 改叫 `model`、输出字段从 `pbr_model`/`model`/`base_model`
   * 换成 `model_url`/`rendered_image_url`/`generated_image_url`。
   *
   * ⚠️ **Tripo 的下载地址 5 分钟就过期**，是三家里最短的。
   *
   * @see https://developers.tripo3d.ai/en/docs/quick-start
   * @see https://docs.tripo3d.ai/model-generation/text-to-model-v3-0-v3-1.html
   * @see https://developers.tripo3d.ai/en/docs/generation-multiview-to-model
   */
  tripo: {
    doc: 'https://developers.tripo3d.ai/zh/docs/quick-start',

    /** `POST /files`，multipart 一个 `file` 字段，回 `data.file_token`（如 `file_abc123`） */
    upload: {
      path: '/files',
      field: 'file',
      tokenAt(payload) {
        const token = (payload as { data?: { file_token?: unknown } })?.data?.file_token
        return typeof token === 'string' && token ? token : null
      }
    },

    submit(input) {
      // Tripo **没有输出格式这个入参** —— 格式是被其它参数隐含决定的：
      // 缺省出 glb，`quad: true` 会强制出 fbx。所以这里只能核对，不能设置。
      const pSeries = isTripoPSeries(input.modelId)

      /*
       * 四边面只有 H 系列有。P 系列的参数表里根本没有 `quad` ——
       * 发过去要么被忽略、要么 400，两种都不该让用户到那一步才发现。
       */
      if (pSeries && input.topology === 'quad') {
        throw new Model3dParamUnsupportedError(
          'tripo',
          `四边面拓扑（${input.modelId} 属于 P 系列）`,
          'P 系列本来就是为低面数、干净拓扑优化的，没有 quad 这个开关。' +
            '要四边面请换 H 系列（v3.1 / v3.0 / v2.5）。'
        )
      }

      // 不核对的话，用户要 glb 却设了 quad，拿到的是一个正常完成的 fbx 任务。
      const implied: Model3dFormat = input.topology === 'quad' ? 'fbx' : 'glb'
      if (input.format !== implied) {
        throw new Model3dParamUnsupportedError(
          'tripo',
          `${input.format} 格式`,
          input.topology === 'quad'
            ? '它的四边面网格只能导出 fbx。要 glb 就别用 quad 拓扑。'
            : '这个端点只出 glb（四边面时出 fbx）。其它格式要再走一次它的 /models/convert。'
        )
      }
      if (input.boundingBox) {
        throw new Model3dParamUnsupportedError(
          'tripo',
          '指定包围盒尺寸',
          '它只有 auto_size（按真实世界米制自动缩放），没有「限制到这个尺寸」。' +
            '需要整批资产比例一致的话，用 Rodin 的 bbox_condition，或者导入后在引擎里统一缩放。'
        )
      }

      const body: Record<string, unknown> = { model: input.modelId }
      if (input.prompt) body.prompt = input.prompt
      if (input.images.length > 0) {
        // 通用层已经把本地图片传成 file_token 放进 url 那一位了
        const refs = input.images.map((image) => {
          if (!image.url) throw new Model3dLocalImageUnsupportedError('tripo')
          return image.url
        })

        if (refs.length === 1) {
          // 单图端点的入参是**单数**的 `input`，收公网直链、file_token、
          // 或此前生图任务的 task_id
          body.input = refs[0]
        } else {
          if (refs.length > TRIPO_VIEWS.length) {
            throw new Model3dParamUnsupportedError(
              'tripo',
              `${refs.length} 张参考图`,
              `它的 multiview 只有 ${TRIPO_VIEWS.join(' / ')} 四个视位，第 5 张往后没有位置可放。` +
                '挑出这四个朝向再来一次，或者换 Rodin —— 它是整组图一起发过去的，不卡四张。'
            )
          }
          /*
           * 用**视位形式**而不是那个四元定长数组。官方把前者标为 recommended，
           * 但真正的理由是定长数组要拿空串占位来跳过视位 —— 少一个空串，
           * 整组朝向就整体错位一格，而错位**不报错**：任务正常完成、正常扣费，
           * 出来的是一个左右颠倒的模型。视位形式把「哪张是哪个朝向」写进了请求本身。
           */
          body.inputs = refs.map((url, index) => ({ [TRIPO_VIEWS[index]]: url }))
        }
      }

      // Tripo 收面数上限而不是档位。**两个系列的量级差 75 倍**，别用错表
      if (input.quality) {
        body.face_limit = (pSeries ? TRIPO_P_FACE_LIMIT : TRIPO_H_FACE_LIMIT)[input.quality]
      }
      // quad 只有 H 系列有，上面已经把 P 系列的情况拦掉了
      if (input.topology && !pSeries) body.quad = input.topology === 'quad'
      if (input.material) {
        // pbr 为 true 时 Tripo 会强制 texture 也为 true，两个都发是照文档写的
        body.texture = true
        body.pbr = input.material !== 'shaded'
      }
      if (input.seed !== undefined) body.model_seed = input.seed
      applyTripoVendorOptions(body, input, pSeries)
      return {
        path: `/generation/${tripoKind(input)}`,
        body: JSON.stringify(body)
      }
    },

    job(payload, input) {
      const id = (payload as { data?: { task_id?: unknown } })?.data?.task_id
      if (typeof id !== 'string' || !id) return null
      // V3 轮询是统一的 /tasks/{id}，不按类型分叉，所以第二位存什么都行；
      // 存任务类型只是为了排错时一眼看得出这条 job 是怎么提交的
      return { poll: id, download: tripoKind(input), cost: null }
    },

    poll(job) {
      return { method: 'GET', path: `/tasks/${encodeURIComponent(job.poll)}` }
    },

    progress(payload) {
      const data = (payload as { data?: Record<string, unknown> })?.data ?? {}
      const status = String(data.status ?? '').toLowerCase()
      const percent = typeof data.progress === 'number' ? data.progress : null
      // SDK 的 TaskStatus 里终态有好几个，只有 success 是成功
      const failed = ['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(status)
      const done = status === 'success'
      return {
        done,
        failed,
        note: failed ? status : percent !== null && !done ? `${percent}%` : '',
        files: done ? collectTripoOutput(data.output) : undefined
      }
    }
  },

  /**
   * Meshy。
   *
   * 与 Tripo 同构的两段式，但**端点按任务类型分叉**：单图打
   * `/openapi/v1/image-to-3d`，多图打 `/openapi/v1/multi-image-to-3d`，
   * 文生打 `/openapi/v1/text-to-3d`，轮询也要打回各自那一条。用错那一条拿到的是
   * 404，看上去像 task id 过期了。
   *
   * 所以这一家的 `job.download` 存的不是另一个 id，而是**任务类型** ——
   * 轮询时要靠它拼回正确的路径。
   *
   * @see https://docs.meshy.ai/en/api/image-to-3d
   * @see https://docs.meshy.ai/en/api/multi-image-to-3d
   * @see https://docs.meshy.ai/en/api/text-to-3d
   */
  meshy: {
    doc: 'https://docs.meshy.ai/en/api/image-to-3d',

    submit(input) {
      /*
       * **Meshy 的文生 3D 是两步**，而且与图生不在同一个 API 版本上：
       *   图生：POST /openapi/v1/image-to-3d          一步出带贴图的模型
       *   文生：POST /openapi/v2/text-to-3d           mode=preview 出**无贴图**网格
       *         POST /openapi/v2/text-to-3d           mode=refine  拿上一步的 id 再上贴图
       *
       * 只发 preview 就收工的话，用户要一个带材质的模型，拿回来一个灰模 ——
       * 任务状态是 success，账也扣了，没有任何地方报错。这正是这套适配器
       * 一直在消灭的那类失败，所以这里**明确拒绝**，而不是给半成品。
       *
       * 不实现 refine 是因为它要在轮询循环里插入第二次提交（第一段完成后才能拿到
       * 它的 task_id），是为一家厂商改整个三段式的结构。而 Meshy 的图生一步到位，
       * 想文生也有 Tripo / Rodin 顶着 —— 真有人非要 Meshy 文生再说。
       */
      if (input.images.length === 0) {
        throw new Model3dParamUnsupportedError(
          'meshy',
          '纯文字生成（不给参考图）',
          'Meshy 的文生 3D 是「先出灰模、再单独上贴图」两步流程，这里只做一步的那种。' +
            '请给一张参考图走图生 3D，或者换 Tripo / Rodin 做文生。'
        )
      }

      const body: Record<string, unknown> = { ai_model: input.modelId }
      const kind = meshyKind(input)
      if (kind === 'multi-image-to-3d' && input.images.length > MESHY_MAX_IMAGES) {
        throw new Model3dParamUnsupportedError(
          'meshy',
          `${input.images.length} 张参考图`,
          `它的 multi-image-to-3d 收 1–${MESHY_MAX_IMAGES} 张，多出来的会被打回（400）。` +
            '挑出最有信息量的四张（正面 / 左 / 背 / 右）再来一次，' +
            '或者换 Rodin —— 它是整组图一起发过去的，不卡四张。'
        )
      }
      // Meshy 的图片入参（单数 image_url 与复数 image_urls）都同时收 data URI，
      // 所以本地图片不用像 Tripo 那样先传一次换 token
      const dataUri = (image: AdapterInput['images'][number]): string =>
        `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`
      if (kind === 'multi-image-to-3d') body.image_urls = input.images.map(dataUri)
      else body.image_url = dataUri(input.images[0])
      if (input.prompt) body.texture_prompt = input.prompt

      /*
       * `target_polycount` 与 `topology` **只在 `should_remesh: true` 时生效**，
       * 而 meshy-6 / meshy-7 的 should_remesh 默认是 false。
       *
       * 不显式打开这一位，那两个参数会被**静默忽略** —— 用户点了「背景件精度」，
       * 拿回来一个几十万面的东西，账照扣，要到进引擎才发现。
       */
      if (input.quality || input.topology) body.should_remesh = true
      if (input.quality) body.target_polycount = MESHY_POLYCOUNT[input.quality]
      if (input.topology) body.topology = input.topology === 'quad' ? 'quad' : 'triangle'
      if (input.material) {
        body.should_texture = input.material !== 'shaded'
        body.enable_pbr = input.material !== 'shaded'
      }
      if (input.restPose) body.pose_mode = 't-pose'
      return { path: `/openapi/v1/${kind}`, body: JSON.stringify(body) }
    },

    job(payload, input) {
      // 创建任务的响应把 id 放在 `result`，与轮询响应的 `id` 不是同一个字段名
      const id = (payload as { result?: unknown })?.result
      if (typeof id !== 'string' || !id) return null
      // download 位存的是任务类型而不是另一个 id —— 轮询要靠它拼回正确的端点
      return { poll: id, download: meshyKind(input), cost: null }
    },

    poll(job) {
      const kind = job.download || 'image-to-3d'
      return { method: 'GET', path: `/openapi/v1/${kind}/${encodeURIComponent(job.poll)}` }
    },

    progress(payload) {
      const data = (payload as Record<string, unknown>) ?? {}
      const status = String(data.status ?? '').toUpperCase()
      const percent = typeof data.progress === 'number' ? data.progress : null
      const done = status === 'SUCCEEDED'
      const failed = status === 'FAILED' || status === 'CANCELED'
      return {
        done,
        failed,
        note: failed
          ? String(data.task_error ?? status)
          : percent !== null && !done
            ? `${percent}%`
            : '',
        files: done ? collectMeshyUrls(data.model_urls) : undefined
      }
    }
  }
}

/**
 * Tripo 分 **H 系列**和 **P 系列**，两套的面数量级差 75 倍。
 *
 * 这一位不是可以糊弄过去的换算：P1 的合法区间是 **50–20,000**，把 H 系列的
 * 150,000 发过去是越界。而越界的表现极可能是**静默夹到上限**而不是报错 ——
 * 用户点了「主角道具精度」，拿回来一个 2 万面的东西，账照扣，问题要到进引擎
 * 才发现。
 *
 * 两个系列**共用同一条端点**（`/generation/text-to-model`），只靠 `model`
 * 字段区分，所以这里只能按型号名认。
 *
 * @see https://developers.tripo3d.ai/zh/docs/generation-text-to-model/p
 */
function isTripoPSeries(modelId: string): boolean {
  return /^p\d/i.test(modelId.trim())
}

/**
 * H 系列（v2.5 / v3.0 / v3.1）的面数上限。
 *
 * 官方给的天花板是三角面 150 万、四边面 15 万，但预置值取的是**引擎里的常见
 * 用途**而不是天花板 —— 文档自己也写着「游戏资产推荐 50,000–100,000」。
 */
const TRIPO_H_FACE_LIMIT: Readonly<Record<Model3dQuality, number>> = Object.freeze({
  high: 150_000,
  medium: 40_000,
  low: 10_000,
  'extra-low': 3_000
})

/**
 * P 系列（P1）的面数上限。**整体压在 20,000 以内**，这是它的硬上限。
 *
 * 下限也有讲究：文档说低于 150（复杂模型 250）面质量会明显下降，
 * 所以最低那一档取 800 而不是贴着 50 走。
 */
const TRIPO_P_FACE_LIMIT: Readonly<Record<Model3dQuality, number>> = Object.freeze({
  high: 20_000,
  medium: 8_000,
  low: 3_000,
  'extra-low': 800
})

/** 反向描述的长度上限。超了是 400，本地先拦 */
const TRIPO_NEGATIVE_PROMPT_MAX = 255

/**
 * 开了 `smart_low_poly` 之后的面数上限（官方给的区间是 1000–20000，
 * 配四边面时 500–10000）。
 *
 * 上限和 `quality` 那张表**会打架**：`high` 档给的 150,000 在区间外面。
 * 打架时以这里为准并压下去 —— 这个开关的意义就是「出低模」，两个都听等于
 * 一个都没听。压这件事写在工具的参数说明里，不是悄悄改。
 *
 * 下限那一头不用管：`quality` 最低那一档换算出来是 3,000，本来就在区间里。
 */
const TRIPO_LOW_POLY_MAX = 20_000
/** 同上，配四边面时更窄 */
const TRIPO_LOW_POLY_QUAD_MAX = 10_000

/**
 * 把厂商特供开关拼进 Tripo 的请求体。
 *
 * 分成独立一段而不是塞回 `submit`：这些开关**几乎每一个都有前置条件**
 * （分系列、分文生图生、互相排斥），而每一条不满足的后果都是一次收费的 400，
 * 或者更糟 —— 参数被忽略、任务照跑、账照扣。集中在一处才看得出它们之间的关系。
 *
 * @see https://docs.tripo3d.ai/model-generation/text-to-model-v3-0-v3-1.html
 * @see https://docs.tripo3d.ai/model-generation/image-to-model-v3-0-v3-1.html
 * @see https://developers.tripo3d.ai/en/docs/generation-text-to-model/p
 */
function applyTripoVendorOptions(
  body: Record<string, unknown>,
  input: AdapterInput,
  pSeries: boolean
): void {
  const vendor = input.vendor
  const hasImages = input.images.length > 0
  /** H 系列专属的那几个：P 系列的参数表里根本没有，发过去要么 400 要么被忽略 */
  const requireHSeries = (param: string): void => {
    if (!pSeries) return
    throw new Model3dParamUnsupportedError(
      'tripo',
      `${param}（${input.modelId} 属于 P 系列）`,
      'P 系列的参数表里没有这一项。要用它请换 H 系列（v3.1 / v3.0 / v2.5）。'
    )
  }
  /** 只对图生有意义的那几个。文生没有「原图」可对齐，发过去是无意义的一位 */
  const requireImages = (param: string): void => {
    if (hasImages) return
    throw new Model3dParamUnsupportedError(
      'tripo',
      `文生 3D 时的 ${param}`,
      '这一项是拿参考图当基准的，纯文字生成时没有基准可用。给一张参考图，或者去掉这个参数。'
    )
  }

  const negative = String(vendor.negativePrompt ?? '').trim()
  if (negative) {
    if (negative.length > TRIPO_NEGATIVE_PROMPT_MAX) {
      throw new Model3dParamUnsupportedError(
        'tripo',
        `${negative.length} 字的反向描述`,
        `上限是 ${TRIPO_NEGATIVE_PROMPT_MAX} 字。反向描述本来就该是几个词` +
          '（「底座、支架、背景板」），写长了也不会更管用。'
      )
    }
    body.negative_prompt = negative
  }

  if (vendor.textureQuality) {
    // extreme 只有 P 系列有。发给 H 系列是 400，而它和 detailed 只差一个词，
    // 模型很容易顺手写上去
    if (vendor.textureQuality === 'extreme' && !pSeries) {
      throw new Model3dParamUnsupportedError(
        'tripo',
        'extreme 贴图精度（H 系列）',
        'H 系列最高只到 detailed。要 extreme 请换 P 系列（P1）。'
      )
    }
    body.texture_quality = vendor.textureQuality
  }

  if (vendor.geometryQuality) {
    requireHSeries('几何精细档')
    body.geometry_quality = vendor.geometryQuality
  }

  if (vendor.smartLowPoly) {
    requireHSeries('智能低模')
    body.smart_low_poly = true
    const cap = input.topology === 'quad' ? TRIPO_LOW_POLY_QUAD_MAX : TRIPO_LOW_POLY_MAX
    // 没给 quality 时厂商本来是自适应的，而自适应可能落在区间外，所以也按上限发
    const current = typeof body.face_limit === 'number' ? body.face_limit : cap
    body.face_limit = Math.min(current, cap)
  }

  if (vendor.alignOrientationToImage) {
    requireHSeries('朝向对齐参考图')
    requireImages('朝向对齐参考图')
    body.orientation = 'align_image'
  }

  if (vendor.textureAlignment) {
    requireHSeries('贴图对齐方式')
    requireImages('贴图对齐方式')
    body.texture_alignment = vendor.textureAlignment
  }

  if (vendor.imageAutofix) {
    requireHSeries('输入图自动修复')
    requireImages('输入图自动修复')
    body.enable_image_autofix = true
  }

  if (vendor.generateParts) {
    requireHSeries('分件输出')
    if (input.topology === 'quad' || input.material) {
      throw new Model3dParamUnsupportedError(
        'tripo',
        '分件输出 + 贴图/四边面',
        '官方把它和贴图、PBR、四边面标为互斥 —— 分件出来的是**没有贴图的**多个网格。' +
          '要贴图就别开分件，要分件就别设 material、别用 quad。'
      )
    }
    if (vendor.autoSize) {
      throw new Model3dParamUnsupportedError(
        'tripo',
        '分件输出 + 真实尺寸缩放',
        '真实尺寸缩放要求成品带贴图，而分件输出恰好不带。两个只能选一个。'
      )
    }
    body.generate_parts = true
    // 它的默认值是带贴图的，不显式关掉的话这次请求自己和自己冲突
    body.texture = false
    body.pbr = false
  }

  if (vendor.autoSize) body.auto_size = true
}

/**
 * 厂商特供开关发错家时，在**提交之前**点名拦住。
 *
 * 正常路径上走不到这里：工具那一层按用户绑定的厂商决定暴露哪些参数，绑的不是
 * Tripo 时模型根本看不见这些字段。留着是因为「静默忽略」在这条链路上最贵 ——
 * 参数没生效、任务照跑、钱照扣，要到进引擎才发现拿到的东西不对。
 */
function assertVendorOptionsSupported(api: string | undefined, vendor: Model3dVendorOptions): void {
  if (api === 'tripo') return

  const given = VENDOR_OPTION_KEYS.filter((key) => vendor[key] !== undefined && vendor[key] !== '')
  if (given.length === 0) return

  throw new Model3dParamUnsupportedError(
    api || '这个厂商',
    given.join(' / '),
    '这几个参数目前只有 Tripo 有。去掉它们，或者把「3D 生成」换绑到 Tripo。'
  )
}

/** 同上，Meshy 的 `target_polycount` 也是个整数 */
const MESHY_POLYCOUNT: Readonly<Record<Model3dQuality, number>> = Object.freeze({
  // 官方的 remesh 区间是 100–300,000（默认 30,000）。这里取的是引擎里的常见
  // 用途而不是天花板 —— 300k 的背景件没有意义
  high: 100_000,
  medium: 30_000,
  low: 10_000,
  'extra-low': 3_000
})

/**
 * Meshy 的 `image_urls` 能收几张。
 *
 * 超了是 400（官方把它列在 invalid image count 那一条里），所以这一位要在本地卡住，
 * 不能靠厂商打回来 —— 打回来的那次往返是白花的时间。
 */
const MESHY_MAX_IMAGES = 4

/**
 * Meshy 的端点按任务类型分叉，提交与轮询都要用同一个。
 *
 * **两张以上必须走 multi-image-to-3d。** 单图端点只有一个 `image_url`，
 * 把第 2–4 张交给它就只能丢掉，而丢掉是静默的：任务正常完成、正常扣费，
 * 只是背面仍旧是模型猜的 —— 那正好是补四视图想要消灭的那件事。
 */
function meshyKind(input: {
  images: unknown[]
}): 'image-to-3d' | 'multi-image-to-3d' | 'text-to-3d' {
  if (input.images.length >= 2) return 'multi-image-to-3d'
  return input.images.length > 0 ? 'image-to-3d' : 'text-to-3d'
}

/** Tripo V3 的提交端点同样按任务类型分叉（轮询则是统一的 /tasks/{id}），理由同上 */
function tripoKind(input: {
  images: unknown[]
}): 'image-to-model' | 'multiview-to-model' | 'text-to-model' {
  if (input.images.length >= 2) return 'multiview-to-model'
  return input.images.length > 0 ? 'image-to-model' : 'text-to-model'
}

/**
 * Tripo multiview 的四个视位，**顺序即朝向**。
 *
 * 这个顺序不是随便定的：它要和 `ai-3d-asset-production` skill 里教给模型的出图
 * 顺序（正面 → 左 → 背 → 右）对齐。两边对不上不会报错，只是出一个左右颠倒的模型。
 *
 * 两个系列（H / P）共用同一条端点、同一组视位，只靠 `model` 字段区分。
 *
 * @see https://developers.tripo3d.ai/en/docs/generation-multiview-to-model
 */
const TRIPO_VIEWS = ['front', 'left', 'back', 'right'] as const

/**
 * Tripo V3 的 `data.output`。
 *
 * 字段名与 V2 **完全不同**：V2 的 `pbr_model` / `model` / `base_model` 已经退役，
 * V3 换成了这三个。两套都认是为了万一用户把 Base URL 指回 V2 —— 多几个键名的
 * 代价是一行数组，认错的代价是「任务成功了却说没有文件」。
 */
function collectTripoOutput(output: unknown): Model3dFile[] {
  const fields = [
    // V3
    'model_url',
    'rendered_image_url',
    'generated_image_url',
    // V2（2026-11-01 关停，在那之前用户可能还指着旧地址）
    'pbr_model',
    'model',
    'base_model'
  ] as const
  const source = (output ?? {}) as Record<string, unknown>
  const files: Model3dFile[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    const url = source[field]
    if (typeof url !== 'string' || !url || seen.has(url)) continue
    seen.add(url)
    files.push({ url, name: fileNameOf(url) })
  }
  return files
}

/**
 * Meshy 的 `model_urls`：一个「格式 → 地址」的字典。
 *
 * 没生成的格式**整个键都不在**（不是空串），所以只能遍历实际存在的键。
 */
function collectMeshyUrls(urls: unknown): Model3dFile[] {
  const source = (urls ?? {}) as Record<string, unknown>
  return Object.entries(source)
    .filter(([, url]) => typeof url === 'string' && url)
    .map(([format, url]) => ({ url: url as string, name: `model.${format}` }))
}

/**
 * 从「取文件」的响应里挖出地址。
 *
 * 刻意写得比某一家的文档更宽：数组可能挂在 `list` / `files` / `result` 下，也可能
 * 就是根；每一项的地址字段各家叫法不一。这不是过度设计，是因为**这一段的响应结构
 * 是三段里唯一没能从官方文档确认到字段名的**（文档只说「返回文件信息」）。
 *
 * 宽松解析的代价是几行代码，写死一个猜的字段名的代价是：任务跑完了、额度扣掉了，
 * 最后一步拿不到文件。真实形状确认之后应当收窄回去。
 *
 * ponytail: 宽松解析，等第一次真实调用确认了字段名再收窄成一家一个 parseFiles
 */
function collectFiles(payload: unknown): Model3dFile[] {
  const root = payload as Record<string, unknown> | unknown[] | null
  const candidates = Array.isArray(root)
    ? root
    : [
        (root as Record<string, unknown>)?.list,
        (root as Record<string, unknown>)?.files,
        (root as Record<string, unknown>)?.result
      ].find(Array.isArray)

  if (!Array.isArray(candidates)) return []

  const files: Model3dFile[] = []
  for (const item of candidates) {
    if (typeof item === 'string') {
      files.push({ url: item, name: fileNameOf(item) })
      continue
    }
    const entry = item as Record<string, unknown>
    const url = [entry?.url, entry?.file_url, entry?.download_url].find(
      (value): value is string => typeof value === 'string' && value.length > 0
    )
    if (!url) continue
    const name = [entry?.name, entry?.file_name].find(
      (value): value is string => typeof value === 'string' && value.length > 0
    )
    files.push({ url, name: name || fileNameOf(url) })
  }
  return files
}

/** 地址末段当文件名。取不出就给个占位，调用方至少还能按顺序落盘 */
function fileNameOf(url: string): string {
  const path = url.split(/[?#]/)[0]
  return decodeURIComponent(path.split('/').filter(Boolean).pop() || 'model')
}

/**
 * 接口形状现在挂在 **Provider** 上，不在模型上。
 *
 * 3D 的形状由厂商唯一决定（三家是三个域名），所以它是 Provider 级的信息 ——
 * 放在模型上只会让用户在每个模型下重选一遍，而选错（在 Tripo 下选 Meshy）
 * 得到的是一串谁也看不懂的 404。
 */
function adapterOf(provider: ProviderConfig): Model3dAdapter {
  const api = provider.model3dApi
  if (!api || api === 'uebox-tasks' || !(api in ADAPTERS)) {
    throw new Model3dApiUnknownError(provider.id)
  }
  return ADAPTERS[api]
}

// ── 发请求 ─────────────────────────────────────────────────────────────────

/** 参考图的大小上限。这些字节要进 multipart 请求体，不能没有头 */
const MAX_REFERENCE_IMAGE_BYTES = 32 * 1024 * 1024

/** 响应体像不像一个网页。网关的错误页、登录页、404 页都是这个形状 */
function looksLikeHtml(body: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html|<\?xml|<head|<body)/i.test(body)
}

/** 从厂商的错误响应里挖出那句人话。挖不到就用原文（上层会截断） */
function describeError(body: string): string {
  if (looksLikeHtml(body)) return '返回的是 HTML 网页而不是 JSON'
  try {
    const payload = JSON.parse(body) as {
      error?: { message?: unknown; code?: unknown } | string
      message?: unknown
    }
    const error = payload.error
    const message =
      typeof error === 'string' ? error : (error?.message ?? payload.message ?? error?.code)
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    // 不是 JSON 也不是 HTML：空 body、纯文本错误都会走到这
  }
  return body.trim().slice(0, 200)
}

/** 值得再试一次的：限流和厂商侧的临时故障。其余（4xx）再试也是同一个结果 */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/** 调用方的取消信号与内部超时并联；没人给信号时就只有超时 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * 这个串像不像一个文件路径。
 *
 * 只用来**换一句说得清的报错**：真正把路径挡在外面的是下面那道 base64 字符集
 * 检查（路径里的 `:` `.` `\` 一个都不在字母表里）。分成两步是因为
 * 「既不是地址也不是可解析的 base64」对一个刚传了截图路径的人毫无帮助 ——
 * 他需要知道的是「路径要先读成图片内容」。
 *
 * 三种写法都认：盘符（`H:/…`、`C:\…`）、绝对路径与 UNC（`/tmp/…`、`\\srv\…`）、
 * 以及带图片扩展名的相对路径（`shots/front.png`）。
 */
function looksLikeFilePath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    /^[\\/]/.test(value) ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?|tga)$/i.test(value)
  )
}

/** 把 `data:` URI 或 http(s) 直链统一取成字节 */
async function toBytes(
  source: string,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; mediaType: string; url?: string }> {
  const trimmed = String(source || '').trim()

  const dataUri = trimmed.match(/^data:([^;,]+);base64,(.*)$/is)
  if (dataUri) {
    const bytes = Buffer.from(dataUri[2], 'base64')
    if (bytes.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`参考图超过 ${MAX_REFERENCE_IMAGE_BYTES} 字节上限`)
    }
    return { bytes: new Uint8Array(bytes), mediaType: dataUri[1] }
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    /*
     * 裸 base64（没有 data: 前缀）也收，按 png 处理 —— 上游各处传法不统一。
     *
     * 但**必须先卡一道字符集**。`Buffer.from(x, 'base64')` 会把字母表以外的
     * 字符直接丢掉、再去解剩下的，所以它对**任何**字符串都「成功」，
     * 只有全是废字符时才回空。这不是理论风险：真机上被喂进来的是文件路径 ——
     * `H:/shots/front.png` 里的字母正好都在 base64 字母表里，于是解出几个
     * 垃圾字节、一句报错都没有、照常提交，用户付全款换回一个凭空捏造的模型。
     *
     * 路径要在**调用方**读成 data URI（见 aigc/references.ts）。这里只负责
     * 不把它当成图片糊弄过去。
     */
    if (looksLikeFilePath(trimmed)) {
      throw new Error(
        `参考图 "${trimmed.slice(0, 120)}" 看着是一个文件路径，不是图片内容。` +
          '本地文件要先读成 data URI 再传进来（工具层的参考图加载器会做这件事）。'
      )
    }
    const compact = trimmed.replace(/\s+/g, '')
    const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
      ? Buffer.from(compact, 'base64')
      : Buffer.alloc(0)
    if (bytes.byteLength === 0) throw new Error('参考图既不是地址也不是可解析的 base64')
    return { bytes: new Uint8Array(bytes), mediaType: 'image/png' }
  }

  const response = await fetch(trimmed, signal ? { signal } : {})
  if (!response.ok) throw new Error(`取回参考图失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`参考图超过 ${MAX_REFERENCE_IMAGE_BYTES} 字节上限`)
  }
  return {
    bytes: new Uint8Array(buffer),
    mediaType: response.headers.get('content-type')?.split(';')[0] || 'image/png',
    // 原样留着：只收直链的那几家（Tripo）要靠它，而字节对它们没用
    url: trimmed
  }
}

/** 发一次请求并把 JSON 解出来。各段共用，因为它们的失败方式完全一样 */
async function send(
  provider: ProviderConfig,
  adapter: Model3dAdapter,
  request: HttpRequest,
  signal: AbortSignal
): Promise<unknown> {
  const apiKey = await resolveApiKey(provider.apiKey)
  const url = `${provider.baseUrl.replace(/\/+$/, '')}${request.path}`
  const scheme = adapter.authScheme ?? 'Bearer'

  /*
   * **网络异常也要重试**，不只是 429/5xx。
   *
   * `fetch` 在连接层出问题时是**抛异常**而不是返回一个带状态码的响应，
   * 所以只判 `response.status` 的重试逻辑对它完全无效 —— 一次 TLS 抖动、
   * 一次 DNS 超时，请求就直接失败。
   *
   * 这在轮询阶段是灾难性的：任务已经提交、钱已经扣了，十分钟的轮询里只要有
   * 一次抖动，整个任务就被判死，而它还在厂商那边继续跑。真机上就是这么炸的：
   * 连着三次「fetch failed」，每次重来都重新提交一遍。
   */
  let response: Response | null = null
  let networkError: unknown = null
  for (let attempt = 0; attempt < NETWORK_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(url, {
        method: request.method ?? 'POST',
        headers: {
          // FormData 的 Content-Type 必须由 fetch 自己带（里面有 boundary），
          // 手动补一个 multipart/form-data 会让厂商解不出任何字段
          ...(typeof request.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(apiKey ? { Authorization: `${scheme} ${apiKey}` } : {}),
          ...provider.headers
        },
        body: request.body,
        signal
      })
      networkError = null
    } catch (error) {
      // 调用方主动取消不该被当成抖动重试 —— 那是用户按了停止
      if (signal.aborted) throw error
      networkError = error
      response = null
    }
    if (response && (response.ok || !isRetryable(response.status))) break
    if (attempt === NETWORK_ATTEMPTS - 1) break
    // 退避：1s、2s、4s。厂商限流和网络抖动都吃这一套
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
  }

  if (networkError) {
    throw new Model3dRequestError(
      0,
      request.path,
      `连了 ${NETWORK_ATTEMPTS} 次都没连上：${networkError instanceof Error ? networkError.message : String(networkError)}`,
      url
    )
  }
  if (!response) throw new Model3dRequestError(0, request.path, '请求没有发出去', url)
  const raw = await response.text()
  if (!response.ok) {
    throw new Model3dRequestError(response.status, request.path, describeError(raw), url)
  }

  try {
    return JSON.parse(raw)
  } catch {
    throw new Model3dRequestError(
      response.status,
      request.path,
      '返回的不是 JSON，多半是 Base URL 指到了网页而不是 API',
      url
    )
  }
}

/**
 * 提交一次生成，拿到 job。**这一步就开始扣额度了。**
 *
 * 与 `requestEmbeddings` 同理，对**显式给定的** provider 发请求、不查角色绑定 ——
 * 「测试连接」传进来的是用户还没存盘的草稿配置。
 *
 * @throws {Model3dApiUnknownError} 模型没写 `model3dApi`
 * @throws {Model3dEmptyInputError} 既没有提示词也没有参考图
 * @throws {Model3dRequestError} 厂商把请求打回来了
 */
/**
 * 把一张本地图片传给厂商，换回一个可以当图片入参用的 token。
 *
 * @throws {Model3dRequestError} 上传被打回，或响应里没有 token
 */
async function uploadImage(
  provider: ProviderConfig,
  adapter: Model3dAdapter,
  image: { bytes: Uint8Array; mediaType: string },
  signal: AbortSignal
): Promise<string> {
  const upload = adapter.upload!
  const form = new FormData()
  const extension = image.mediaType.split('/')[1] || 'png'
  form.append(
    upload.field,
    new Blob([image.bytes as BlobPart], { type: image.mediaType }),
    `reference.${extension}`
  )

  const payload = await send(provider, adapter, { path: upload.path, body: form }, signal)
  const token = upload.tokenAt(payload)
  if (!token) {
    throw new Model3dRequestError(200, upload.path, '上传成功但响应里没有文件 token')
  }
  return token
}

export async function submitModel3d(
  provider: ProviderConfig,
  modelId: string,
  request: Omit<GenerateModel3dRequest, 'providerId' | 'modelId'>
): Promise<Model3dJob> {
  const adapter = adapterOf(provider)

  const prompt = String(request.prompt ?? '').trim()
  const sources = (request.images ?? []).filter((item) => String(item || '').trim())
  if (!prompt && sources.length === 0) throw new Model3dEmptyInputError()

  const signal = withTimeout(request.signal, SUBMIT_TIMEOUT_MS)
  const images = await Promise.all(sources.map((source) => toBytes(source, signal)))

  // 收不了内联图片的那几家，先把本地图片传上去换 token。
  // 已经是公网直链的不动：那种情况多传一次是白花时间，而且有的家直链本来就更快
  if (adapter.upload) {
    for (const image of images) {
      if (image.url) continue
      image.url = await uploadImage(provider, adapter, image, signal)
    }
  }

  const vendor = request.vendor ?? {}
  assertVendorOptionsSupported(provider.model3dApi, vendor)

  const input: AdapterInput = {
    modelId,
    prompt,
    images,
    format: request.format ?? 'glb',
    quality: request.quality,
    topology: request.topology,
    material: request.material,
    boundingBox: request.boundingBox,
    seed: request.seed,
    restPose: request.restPose,
    vendor
  }

  const httpRequest = adapter.submit(input)
  const payload = await send(provider, adapter, httpRequest, signal)

  const parsed = adapter.job(payload, input)
  const job = parsed ? { ...parsed, providerId: provider.id } : null
  if (!job) {
    throw new Model3dRequestError(
      200,
      httpRequest.path,
      '提交成功但响应里没有任务号（厂商可能改了响应结构）'
    )
  }
  return job
}

/** 查一次任务状态。不阻塞、不重试 —— 循环由调用方掌握 */
export async function pollModel3d(
  provider: ProviderConfig,
  job: Model3dJob,
  signal?: AbortSignal
): Promise<JobProgress> {
  const adapter = adapterOf(provider)
  const payload = await send(
    provider,
    adapter,
    adapter.poll(job),
    withTimeout(signal, POLL_TIMEOUT_MS)
  )
  return adapter.progress(payload)
}

/**
 * 取已完成任务的文件地址。
 *
 * 两条路：有单独下载端点的（Rodin）打那一次；没有的（Tripo / Meshy）再轮询一次
 * 从进度里取 —— 对它们来说轮询响应本来就带着文件，重来一次是幂等的，
 * 而且这样断点续传也走同一个入口。
 *
 * @throws {Model3dNoFilesError} 任务说完成了，但响应里挖不出地址
 */
export async function fetchModel3dFiles(
  provider: ProviderConfig,
  job: Model3dJob,
  signal?: AbortSignal
): Promise<Model3dFile[]> {
  const adapter = adapterOf(provider)

  if (!adapter.files || !adapter.parseFiles) {
    const progress = await pollModel3d(provider, job, signal)
    const files = progress.files ?? []
    if (files.length === 0) throw new Model3dNoFilesError(JSON.stringify(progress).slice(0, 500))
    return files
  }

  const request = adapter.files(job)
  const payload = await send(provider, adapter, request, withTimeout(signal, FETCH_TIMEOUT_MS))
  const files = adapter.parseFiles(payload)
  if (files.length === 0) throw new Model3dNoFilesError(JSON.stringify(payload).slice(0, 500))
  return files
}

/** 取本次指定的模型；未指定时沿用全局「3D 生成」角色绑定 */
async function resolveModel3dBinding(request: GenerateModel3dRequest): Promise<{
  provider: ProviderConfig
  modelId: string
  model?: ModelConfig
}> {
  const settings = await readSettings()
  const requestedProviderId = request.providerId?.trim()
  const requestedModelId = request.modelId?.trim()

  if (requestedProviderId || requestedModelId) {
    if (!requestedProviderId || !requestedModelId) throw new Model3dUnavailableError()
    const provider = settings.providers.find((item) => item.id === requestedProviderId)
    const model = provider?.models.find((item) => item.id === requestedModelId)
    // 能力不再看模型上的位，看 Provider 的用途
    if (!provider || provider.kind !== 'model3d') throw new Model3dUnavailableError()
    return { provider, modelId: requestedModelId, model }
  }

  // 与嵌入、生图、语音一样**不参与回落**：把对话模型顶上来只会拿到一句厂商报错
  const binding = settings.roles.model3d
  if (!binding) throw new Model3dNotConfiguredError()

  const provider = settings.providers.find((item) => item.id === binding.providerId)
  if (!provider) throw new Model3dNotConfiguredError()

  return {
    provider,
    modelId: binding.modelId,
    model: provider.models.find((item) => item.id === binding.modelId)
  }
}

/**
 * 提交 → 轮询到完成 → 取文件，一路走完。
 *
 * 给不需要断点续传的调用方用。**要断点续传就别用这个**，用上面那三段：
 * 这个函数一旦被取消或超时，已经付掉的额度就只能靠 `Model3dTimeoutError.job`
 * 里的任务号去捞。
 *
 * @throws {Model3dNotConfiguredError} 没有绑定 3D 模型
 * @throws {Model3dJobFailedError} 厂商说这个任务失败了
 * @throws {Model3dTimeoutError} 超过 10 分钟仍未完成
 */
export async function generateModel3d(
  request: GenerateModel3dRequest & {
    onProgress?: (note: string) => void
    /** 套餐任务提交之后回一次任务令牌：调用方据此在「用户按停止」时报出任务号 */
    onSubmitted?: (jobToken: string) => void
  }
): Promise<GeneratedModel3d> {
  const { provider, modelId } = await resolveModel3dBinding(request)
  if (provider.model3dApi === 'uebox-tasks') return runPlanModel3d(provider, modelId, request)
  const job = await submitModel3d(provider, modelId, request)

  const deadline = Date.now() + JOB_TIMEOUT_MS
  let ready: Model3dFile[] = []
  /*
   * 提交之后**钱已经扣了**，任务也已经在厂商那边跑着。
   *
   * 这之后的每一次查询失败都只是「这一次没查到」，不代表任务死了 ——
   * 直接抛出去的话，用户为一次网络抖动付了全款还什么都没拿到，而模型多半会
   * 「再试一次」重新提交，于是同一个东西付两次。所以这里熬着，熬不住才认输，
   * 且**认输时把任务号带出来**。
   */
  let consecutiveFailures = 0
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

    let progress: JobProgress
    try {
      progress = await pollModel3d(provider, job, request.signal)
      consecutiveFailures = 0
    } catch (error) {
      // 用户按了停止：任务还在跑、钱已经扣了，任务号必须活着出来
      if (request.signal?.aborted) throw new Model3dCancelledError(job)
      consecutiveFailures += 1
      if (consecutiveFailures >= POLL_FAILURE_TOLERANCE)
        throw new Model3dInterruptedError(job, error)
      request.onProgress?.(`查询任务状态失败（第 ${consecutiveFailures} 次），任务还在跑，继续等…`)
      if (Date.now() > deadline) throw new Model3dTimeoutError(job)
      continue
    }

    if (progress.failed) throw new Model3dJobFailedError(progress.note)
    if (progress.note) request.onProgress?.(progress.note)
    if (progress.done) {
      // Tripo / Meshy 的文件就在这份响应里，别为了走个形式再打一次
      ready = progress.files ?? []
      break
    }
    if (Date.now() > deadline) throw new Model3dTimeoutError(job)
  }

  const files = ready.length > 0 ? ready : await fetchModel3dFiles(provider, job, request.signal)
  return { files, job }
}

/**
 * 接着查一个**已经提交出去**的任务，拿它的文件。
 *
 * 存在的理由很直接：提交那一刻钱就扣了。任务在厂商那边跑完了，我们这边却因为
 * 一次网络抖动把它丢了 —— 真机上就这么丢过三次，三次都成功、三次都扣了费。
 * 有了这条路，那种情况下把任务号交回来就能取货，而不是重新付一次全款。
 *
 * @throws {Model3dJobTokenInvalidError} 任务号不成形
 */
export async function resumeModel3d(
  request: { jobToken: string; providerId?: string; modelId?: string; signal?: AbortSignal } & {
    onProgress?: (note: string) => void
  }
): Promise<GeneratedModel3d> {
  const job = decodeModel3dJob(request.jobToken)
  /*
   * 任务号里带的厂商优先 —— 绑定可能在生成之后被改过。
   * 找不到那个 Provider 要**明说是哪一个**：任务还在那边、钱也扣了，
   * 用户至少得知道该去哪个控制台找。
   */
  const provider = job.providerId
    ? (await readSettings()).providers.find((item) => item.id === job.providerId)
    : (await resolveModel3dBinding(request)).provider
  if (!provider) {
    throw new Model3dRequestError(
      0,
      'resume',
      `任务号里写的 Provider「${job.providerId}」已经不在配置里了。` +
        '任务本身还在那家厂商那边 —— 把它加回来，或者直接去它的控制台取结果。'
    )
  }
  if (provider.model3dApi === 'uebox-tasks') {
    const planJob = { ...job, providerId: provider.id }
    const task = await resumePlanTask(provider, 'model3d', job.poll, {
      signal: request.signal,
      onProgress: request.onProgress,
      label: () => `任务号 ${encodeModel3dJob(planJob)}`
    })
    return { files: planModel3dFiles(task), job: planJob }
  }

  const deadline = Date.now() + JOB_TIMEOUT_MS
  let consecutiveFailures = 0
  let ready: Model3dFile[] = []
  for (;;) {
    let progress: JobProgress
    try {
      progress = await pollModel3d(provider, job, request.signal)
      consecutiveFailures = 0
    } catch (error) {
      // 用户按了停止：任务还在跑、钱已经扣了，任务号必须活着出来
      if (request.signal?.aborted) throw new Model3dCancelledError(job)
      consecutiveFailures += 1
      if (consecutiveFailures >= POLL_FAILURE_TOLERANCE)
        throw new Model3dInterruptedError(job, error)
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      continue
    }

    if (progress.failed) throw new Model3dJobFailedError(progress.note)
    if (progress.done) {
      ready = progress.files ?? []
      break
    }
    if (progress.note) request.onProgress?.(progress.note)
    if (Date.now() > deadline) throw new Model3dTimeoutError(job)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  const files = ready.length > 0 ? ready : await fetchModel3dFiles(provider, job, request.signal)
  return { files, job }
}

export interface Model3dModelStatus {
  /** 有没有可用的 3D 绑定 */
  configured: boolean
  /** 形如 `Hyper3D:Gen-2`。界面拿它回答「这个模型是谁生成的」 */
  model: string | null
}

/**
 * 当前的 3D 配置。界面据此决定显示生成入口还是显示引导。
 *
 * 与 getImageModelStatus 一样只看绑定、**不发请求**。
 */
export async function getModel3dStatus(): Promise<Model3dModelStatus> {
  try {
    const settings = await readSettings()
    const binding = settings.roles.model3d
    if (!binding) return { configured: false, model: null }

    const provider = settings.providers.find((item) => item.id === binding.providerId)
    if (!provider) return { configured: false, model: null }

    // 绑定在、但没写接口形状 = 发出去必然 404，对界面来说等于没配
    if (!provider.model3dApi) return { configured: false, model: null }

    return { configured: true, model: `${provider.displayName}:${binding.modelId}` }
  } catch {
    return { configured: false, model: null }
  }
}

// ── Box Plan（model3dApi: 'uebox-tasks'）────────────────────────────

/** 多图时每张带的视位，顺序与 Tripo 那支一致（正面 → 左 → 背 → 右） */
const PLAN_VIEWS = ['front', 'left', 'back', 'right'] as const

/**
 * 我们的厂商开关 → 协议 `options` 的键。协议里没有对应键的几个（几何精细档、朝向对齐、
 * 贴图对齐、自动修图）不在表里 —— 给了就明确报错，不静默丢掉。
 */
const PLAN_OPTION_KEYS: Partial<Record<keyof Model3dVendorOptions, string>> = {
  negativePrompt: 'negative_prompt',
  textureQuality: 'texture_quality',
  smartLowPoly: 'smart_low_poly',
  autoSize: 'auto_size',
  generateParts: 'generate_parts'
}

/**
 * 我们的 3D 请求 → 协议 05-tasks 的 `uebox-3d` 输入。
 *
 * - 多张参考图各带 `view`（front / left / back / right），最多 4 张
 * - 厂商开关、`bounding_box`、`rest_pose` 都进 `options`，**只发清单 `options` 里列了的键**：
 *   清单没列的给了就在本地报错（服务端也会回 400 unsupported_option，但那要多一次往返）。
 *   没有缓存的清单时照发，由服务端判。
 */
export function planModel3dBody(
  modelId: string,
  request: Omit<GenerateModel3dRequest, 'providerId' | 'modelId'>,
  allowedOptions: readonly string[] | null
): PlanTaskBody {
  const prompt = String(request.prompt ?? '').trim()
  const images = (request.images ?? []).map((item) => String(item || '').trim()).filter(Boolean)
  if (!prompt && images.length === 0) throw new Model3dEmptyInputError()
  if (images.length > PLAN_VIEWS.length) {
    throw new Model3dParamUnsupportedError(
      'uebox-tasks',
      `${images.length} 张参考图`,
      `最多 ${PLAN_VIEWS.length} 张，按正面 → 左 → 背 → 右给。`
    )
  }
  for (const image of images) {
    if (!/^https:\/\//i.test(image) && !/^data:image\//i.test(image)) {
      throw new Model3dParamUnsupportedError(
        'uebox-tasks',
        `参考图「${image.slice(0, 60)}」`,
        '只收 https 链接或 data URI。本地文件要先读成 data URI（工具层的参考图加载器会做这件事）。'
      )
    }
  }

  const vendor = request.vendor ?? {}
  const options: Record<string, unknown> = {}
  const unsupported: string[] = []
  for (const [name, value] of Object.entries(vendor) as [keyof Model3dVendorOptions, unknown][]) {
    if (value === undefined || value === '') continue
    const key = PLAN_OPTION_KEYS[name]
    if (key) options[key] = value
    else unsupported.push(name)
  }
  if (request.boundingBox) options.bounding_box = request.boundingBox
  if (request.restPose !== undefined) options.rest_pose = request.restPose
  if (allowedOptions) {
    unsupported.push(...Object.keys(options).filter((key) => !allowedOptions.includes(key)))
  }
  if (unsupported.length > 0) {
    throw new Model3dParamUnsupportedError(
      'uebox-tasks',
      unsupported.join(' / '),
      allowedOptions
        ? `当前套餐支持的扩展选项：${allowedOptions.join(' / ') || '无'}。去掉其余的再生成。`
        : 'Box Plan 没有这几个选项，去掉它们再生成。'
    )
  }

  return {
    model: modelId,
    input: {
      ...(prompt ? { prompt } : {}),
      ...(images.length > 0
        ? {
            images: images.map((url, index) => ({
              url,
              ...(images.length > 1 ? { view: PLAN_VIEWS[index] } : {})
            }))
          }
        : {}),
      format: request.format ?? 'glb',
      ...(request.quality ? { quality: request.quality } : {}),
      ...(request.topology ? { topology: request.topology } : {}),
      ...(request.material ? { material: request.material } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {})
    }
  }
}

/** 任务文件 → 我们的文件列表：网格在前，贴图、预览图在后（工具层按扩展名分网格与附属文件） */
function planModel3dFiles(task: PlanTask): Model3dFile[] {
  const files = [
    ...filesOfRole(task, 'model'),
    ...filesOfRole(task, 'texture'),
    ...filesOfRole(task, 'preview')
  ].map((file) => ({ url: file.url, name: fileNameOfUrl(file.url, `${file.role}.bin`) }))
  if (files.length === 0) throw new Model3dNoFilesError(JSON.stringify(task.files).slice(0, 500))
  return files
}

/**
 * 套餐那一支：提交（带幂等键、崩溃后按账本续上）→ 按 5 秒轮询 → 拿文件链接（7 天有效）。
 * 失败、超时退回额度；用户按停止时服务端取消，但**已提交的 3D 取消不退**。见 creatorPlan/tasks.ts。
 */
async function runPlanModel3d(
  provider: ProviderConfig,
  modelId: string,
  request: GenerateModel3dRequest & {
    onProgress?: (note: string) => void
    /** 套餐任务提交之后回一次任务令牌：调用方据此在「用户按停止」时报出任务号 */
    onSubmitted?: (jobToken: string) => void
  }
): Promise<GeneratedModel3d> {
  const spec = await cachedPlanSpec('model3d')
  const allowed = Array.isArray(spec?.options)
    ? (spec.options as unknown[]).filter((key): key is string => typeof key === 'string')
    : null
  const body = planModel3dBody(modelId, request, allowed)
  const tokenOf = (id: string): string =>
    encodeModel3dJob({ poll: id, download: id, cost: null, providerId: provider.id })
  const task = await runPlanTask(provider, 'model3d', body, {
    signal: request.signal,
    onProgress: request.onProgress,
    onSubmitted: (task) => request.onSubmitted?.(tokenOf(task.id)),
    label: (id) => `任务号 ${tokenOf(id)}`
  })
  const files = planModel3dFiles(task)
  await settlePlanTask(body)
  return { files, job: { poll: task.id, download: task.id, cost: null, providerId: provider.id } }
}
