/**
 * 参考图的读取与整理（图生图那一半）。
 *
 * 「在场景里搭白盒 → 截一张 → 让它照着白盒出渲染成品图」是这个工具最主要的
 * 用法，而那条路上参考图就是 `ue_screenshot` 落在磁盘上的那个文件。所以这里
 * **收本地绝对路径**，而不是只收 base64 —— 否则模型得先把一张图读成 base64
 * 再原样贴进参数里，几十万个字符白白过一遍上下文。
 *
 * 三种来源都收：本地绝对路径、http(s) 直链、data URI。前者读盘转成 data URI，
 * 后两者原样递给厂商适配器（它自己认得）。
 */

import { promises as fs } from 'fs'
import { extname, isAbsolute } from 'path'

import { assertPathAllowed } from '../builtin/pathBoundary'
import { getSharp } from '../../../utils/sharpLoader'

/**
 * 超过这个大小的参考图先缩一遍再发。
 *
 * base64 会把体积撑到 4/3，而多数厂商的请求体上限在 10MB 附近 —— 一张 4K 的
 * PNG 截图（十几 MB）直接发过去是一次 413，而 413 在界面上表现为「生成失败」，
 * 没人猜得到问题出在参考图上。缩到 2048 宽的 JPEG 对图生图完全够用：
 * 厂商自己也会把输入重采样到模型的隐空间分辨率。
 */
const REFERENCE_MAX_BYTES = 4 * 1024 * 1024
const REFERENCE_MAX_WIDTH = 2048
const REFERENCE_JPEG_QUALITY = 90

/**
 * 参考图的处理预算。
 *
 * 生图和生视频的账**完全不是一个量级**，所以不能共用一套阈值：
 *
 * - **生图**通常带 1–2 张，请求体宽松。所以只在超过 4MB 时才动它 ——
 *   一张 1080p 的 PNG 截图（2–4MB）原样发过去，画质一点不损。
 * - **生视频**一次最多带 30 张（Seedance 2.5 全模态参考），而请求体上限是
 *   64MB、base64 还要撑到 4/3。30 张原样 PNG 就是 150MB，必然 413。
 *   所以视频这条路**不管多大都归一化**：统一转 JPEG 限宽，每张压到几百 KB。
 *
 * 归一化损失的画质对参考图无所谓 —— 厂商自己也会把输入重采样到模型的隐空间
 * 分辨率，两家的文档都要求宽高落在 [300, 6000] 之间，1536 远在区间内。
 */
export interface ReferenceBudget {
  /** 超过这个字节数才重新编码。给 0 表示「一律重新编码」 */
  maxBytes: number
  maxWidth: number
  quality: number
}

/** 生图：只在过大时才动，尽量保原图 */
export const IMAGE_REFERENCE_BUDGET: ReferenceBudget = {
  maxBytes: REFERENCE_MAX_BYTES,
  maxWidth: REFERENCE_MAX_WIDTH,
  quality: REFERENCE_JPEG_QUALITY
}

/** 生视频：一律归一化，因为可能有 30 张挤在同一个 64MB 的请求体里 */
export const VIDEO_REFERENCE_BUDGET: ReferenceBudget = {
  maxBytes: 0,
  maxWidth: 1536,
  quality: 82
}

/**
 * 图生 3D：比生图早一档动手，但不像视频那样一律重编码。
 *
 * 门槛压到 2MB 的理由不是画质，是**四张图挤在同一个请求体里**：Meshy 的多图
 * 端点把 1–4 张全部内联成 data URI 发在一个 JSON body 里，base64 还要撑到
 * 4/3。按生图那档（4MB 才动手）放行，四张原图就是二十多 MB 的 body ——
 * 一次 413 在界面上表现为「生成失败」，没人猜得到是参考图撑爆的。
 * 单张那条路同样受益：Tripo 的单文件上限是 20MB。
 *
 * 限宽仍取 2048：厂商侧只要求至少 256×256、自己也会重采样，而多视图重建吃的
 * 是**四张互相一致**，不是单张的分辨率。
 */
export const MODEL3D_REFERENCE_BUDGET: ReferenceBudget = {
  maxBytes: 2 * 1024 * 1024,
  maxWidth: REFERENCE_MAX_WIDTH,
  quality: REFERENCE_JPEG_QUALITY
}

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

/** 参考图读不进来时抛这个。消息直接给模型看，所以要说清楚下一步怎么办 */
export class ReferenceImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferenceImageError'
  }
}

function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'image/png'
}

/**
 * 一个参考图 → 厂商适配器认识的形式。
 *
 * 读不到就**抛**，不静默跳过：少一张参考图出来的是一张「看起来也挺好、
 * 但和白盒没关系」的图，那比报错难查得多。
 */
export async function loadReferenceImage(
  reference: string,
  budget: ReferenceBudget = IMAGE_REFERENCE_BUDGET
): Promise<string> {
  const value = String(reference || '').trim()
  if (!value) throw new ReferenceImageError('参考图是空字符串')

  // 直链和 data URI 原样递过去：适配器自己会按厂商的要求处理
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value

  if (!isAbsolute(value)) {
    throw new ReferenceImageError(
      `参考图 "${value}" 不是绝对路径。` +
        '给完整路径（比如 ue_screenshot 返回值里的 path），不要给相对路径。'
    )
  }

  // 只过敏感位置那道黑名单，**不过**用户设的「文件访问范围」。
  // 两个原因：参考图的路径要么是用户自己在对话里给的（他指名要用这张图，
  // 不算 agent 在盘里乱翻），要么是 ue_screenshot 刚写到临时目录的那一张 ——
  // 而临时目录不在「仅虚幻相关」的白名单里，一并管住的话，截图当参考图
  // 这条最常用的路会在收窄档下整条断掉。
  const denied = assertPathAllowed(value)
  if (denied) throw new ReferenceImageError(denied)

  let bytes: Buffer
  try {
    bytes = await fs.readFile(value)
  } catch {
    throw new ReferenceImageError(
      `参考图读不到：${value}。确认这个文件存在，或者先用 ue_screenshot 拍一张。`
    )
  }

  if (budget.maxBytes > 0 && bytes.byteLength <= budget.maxBytes) {
    return `data:${mediaTypeOf(value)};base64,${bytes.toString('base64')}`
  }

  const sharp = await getSharp()
  const shrunk = await sharp(bytes)
    .resize({ width: budget.maxWidth, withoutEnlargement: true })
    .jpeg({ quality: budget.quality })
    .toBuffer()
  return `data:image/jpeg;base64,${shrunk.toString('base64')}`
}

/** 按顺序读一批参考图。顺序有意义 —— 多数厂商把第一张当主图 */
export async function loadReferenceImages(
  references: string[],
  budget: ReferenceBudget = IMAGE_REFERENCE_BUDGET
): Promise<string[]> {
  const loaded: string[] = []
  for (const reference of references) {
    loaded.push(await loadReferenceImage(reference, budget))
  }
  return loaded
}

/**
 * 参考音频的单个上限。方舟文档：单个音频不超过 15MB。
 * 超了在本地拦，免得白等一次 400。
 */
const AUDIO_REFERENCE_MAX_BYTES = 15 * 1024 * 1024

const AUDIO_MEDIA_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mp3'
}

/**
 * 一个参考音频 → 方舟认识的形式（生视频的全模态参考用）。
 *
 * 与参考图同一套路：本地绝对路径读盘转 `data:audio/...;base64,...`，直链、
 * `asset://` 素材 ID、data URI 原样递过去。格式只收 wav / mp3 —— 方舟只认这两种，
 * 别的格式发过去是一次白等。
 */
export async function loadReferenceAudio(reference: string): Promise<string> {
  const value = String(reference || '').trim()
  if (!value) throw new ReferenceImageError('参考音频是空字符串')

  if (/^https?:\/\//i.test(value) || /^asset:\/\//i.test(value) || /^data:audio\//i.test(value)) {
    return value
  }

  if (!isAbsolute(value)) {
    throw new ReferenceImageError(`参考音频 "${value}" 不是绝对路径。给完整路径，不要给相对路径。`)
  }
  const mediaType = AUDIO_MEDIA_TYPES[extname(value).toLowerCase()]
  if (!mediaType) {
    throw new ReferenceImageError(
      `参考音频只收 wav / mp3，这个是 ${extname(value) || '无扩展名'}：${value}。先转成 wav 或 mp3。`
    )
  }

  const denied = assertPathAllowed(value)
  if (denied) throw new ReferenceImageError(denied)

  // 先看大小再读：模型给错路径指到一个几 GB 的录音上时，整个读进内存再拒绝，
  // 主进程会先卡上好一阵
  let size: number
  try {
    size = (await fs.stat(value)).size
  } catch {
    throw new ReferenceImageError(`参考音频读不到：${value}。确认这个文件存在。`)
  }
  if (size > AUDIO_REFERENCE_MAX_BYTES) {
    throw new ReferenceImageError(
      `参考音频 ${Math.round(size / 1024 / 1024)}MB，超过方舟单个 15MB 的上限：${value}。` +
        '截短一些，或者放到公网直链上。'
    )
  }
  let bytes: Buffer
  try {
    bytes = await fs.readFile(value)
  } catch {
    throw new ReferenceImageError(`参考音频读不到：${value}。确认这个文件存在。`)
  }
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}
