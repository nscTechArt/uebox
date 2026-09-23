/**
 * 用户带进对话的多媒体（图片、视频、音频），怎么进到模型的请求里。
 *
 * ## 规则：先走对象存储，走不通再退
 *
 * 这是全项目的规矩（AGENTS.md 第 5 节）：多媒体进模型，**先传用户配的对象存储、
 * 给模型一个链接**；对象存储没配、模型收不了链接、或者这次传失败了，才退回各自的旧路：
 *
 * | 种类 | 走得通 | 走不通时退回 |
 * |---|---|---|
 * | 图片 | `image_url` 链接 | base64 内联（`admitPromptImages` 压过的那份） |
 * | 视频 / 音频 | `video_url` / `input_audio` 链接 | 只给本地路径，agent 用 `analyze_video` 去看 |
 *
 * 为什么链接优先：base64 跟着对话每轮重发，一大就撞请求预算（`requestBudget.ts`
 * 从最大的开始丢），而且厂商对 base64 有硬上限；链接只有几百字节。
 *
 * 「走得通」要同时满足：对象存储开着且配完整、当前模型走 OpenAI 兼容协议、
 * 模型有这一类的能力（图片看「视觉」，音视频看「视频」）。
 *
 * 链接发出去之后还有两道：音视频只随附带它的那条消息发（见 `ONE_TURN_KINDS`）；
 * 厂商说拉不下来的，`streamFn.ts` 换成说明重发一次，之后这个对象不再给它发链接。
 *
 * 只管**用户带进来的**。工具产出的截图不走这里：一轮工具循环里截图很多，
 * 每张都先上传会拖慢每一步，编辑器画面也不该默认进第三方存储（见 screenshot.ts）。
 *
 * ## 为什么是一段文本，而不是 pi 的图片块
 *
 * pi 的消息只有文字和图片两种。图片块要过好几道关（视觉能力过滤、图片压缩、
 * 请求预算里「最大的先丢」），每一道都会把它当成一张坏图处理掉。文本块哪道都不拦，
 * 原样落进 JSONL、原样到 `onPayload`，在那里换掉即可。
 *
 * ## 为什么引用里只有键、没有链接
 *
 * 链接怎么生成（公开域名 / 预签名）、对象还在不在，都是**发请求那一刻**的事。
 * 引用只记「是哪个对象」，JSONL 里那段文本就一字不改，前缀缓存不受影响。
 * 换了个看不了视频的模型、或者对象被清理了，同一段引用换成同一句说明 ——
 * 也是逐字稳定的。
 */

import path from 'node:path'

import type { Context, ImageContent } from '@earendil-works/pi-ai'

import { readSettings } from '../../ai/store'
import type { AiProviderSettings } from '../../ai/types'
import { classifyProviderError } from '../host/providerError'
import {
  isObjectStorageReady,
  uploadMediaFile
} from '../../services/objectStorage/objectStorageService'
import { savePromptAttachments } from './promptAttachments'

export interface PromptMediaFile {
  filePath: string
  fileName: string
  kind: 'video' | 'audio'
}

export type PromptMediaKind = 'image' | 'video' | 'audio'

export interface PromptMediaRef {
  kind: PromptMediaKind
  key: string
  fileName: string
  filePath: string
}

const MARKER_PREFIX = '[[uebox-media '
const MARKER_SUFFIX = ']]'

export function mediaRefText(ref: PromptMediaRef): string {
  return `${MARKER_PREFIX}${JSON.stringify(ref)}${MARKER_SUFFIX}`
}

export function parseMediaRef(text: string): PromptMediaRef | null {
  if (!text.startsWith(MARKER_PREFIX) || !text.endsWith(MARKER_SUFFIX)) return null
  try {
    const ref = JSON.parse(text.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length))
    if (
      (ref?.kind === 'image' || ref?.kind === 'video' || ref?.kind === 'audio') &&
      typeof ref.key === 'string'
    ) {
      return ref as PromptMediaRef
    }
  } catch {
    // 不是我们的引用，原样放过
  }
  return null
}

function noun(kind: PromptMediaKind): string {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
}

/** 引用发不出去时换成的那句话。逐字稳定，见文件头 */
function unavailableText(ref: PromptMediaRef, reason: string): string {
  const how =
    ref.kind === 'image'
      ? '需要看的话用读本地文件的工具打开这个路径。'
      : '需要知道内容时用 `analyze_video` 去看。'
  return `【${noun(ref.kind)} ${ref.fileName}：${reason}。本地路径：${ref.filePath}。${how}】`
}

/**
 * 写进用户消息的那段说明。
 * @param sentPaths 已经作为引用随消息发出去的文件路径，其余的只给路径
 * @param failures 想走链接但上传失败的，按路径记原因 —— 要如实告诉模型
 */
export function describePromptMedia(
  files: PromptMediaFile[],
  sentPaths: Set<string>,
  failures: Map<string, string> = new Map()
): string {
  if (files.length === 0) return ''
  const lines = files.map((file) => {
    if (sentPaths.has(file.filePath)) {
      return `- ${noun(file.kind)}：${file.fileName}（已随这条消息发给你，直接看；本地路径：${file.filePath}）`
    }
    const failure = failures.get(file.filePath)
    return failure
      ? `- ${noun(file.kind)}：${file.fileName}（传到对象存储失败：${failure}；本地路径：${file.filePath}）`
      : `- ${noun(file.kind)}：${file.fileName}（本地路径：${file.filePath}）`
  })
  const hasPathOnly = files.some((file) => !sentPaths.has(file.filePath))
  return [
    '【用户附带的音视频】',
    ...lines,
    ...(hasPathOnly
      ? [
          '只给了路径的没有预先分析。需要知道内容时，用 `analyze_video` 去看（`video_path` 填路径，`question` 填用户想知道的）。'
        ]
      : [])
  ].join('\n')
}

/** 这个模型能不能直接收这一类的链接，见 {@link modelTakesMediaUrl} */
export async function canSendMediaByUrl(
  providerId: string,
  modelId: string,
  kind: PromptMediaKind = 'video'
): Promise<boolean> {
  return modelTakesMediaUrl(await readSettings(), providerId, modelId, kind)
}

/**
 * 模型能不能直接收这一类的链接：OpenAI 兼容协议，而且有这一类的能力
 * （图片看「视觉」，音视频看「视频」）。
 *
 * 只认 OpenAI 兼容：Gemini 的 fileUri 只收 Files API 和 YouTube，桶里的链接会被 400；
 * Anthropic 的接口收链接，但 pi 的适配器只会发 base64，要另写改写，先不接。
 */
export function modelTakesMediaUrl(
  settings: AiProviderSettings,
  providerId: string,
  modelId: string,
  kind: PromptMediaKind = 'video'
): boolean {
  const provider = settings.providers.find((item) => item.id === providerId)
  const model = provider?.models.find((item) => item.id === modelId)
  if (provider?.protocol !== 'openai-completions' || !model) return false
  return kind === 'image' ? model.supportsVision === true : model.supportsVideo === true
}

/** 这个模型能直接收链接的那几类 */
export function mediaUrlKinds(
  settings: AiProviderSettings,
  providerId: string,
  modelId: string
): Set<PromptMediaKind> {
  const kinds = ['image', 'video', 'audio'] as const
  return new Set(kinds.filter((kind) => modelTakesMediaUrl(settings, providerId, modelId, kind)))
}

/** 上下文里有没有媒体引用。没有就不挂 `onPayload`，一切照旧 */
export function contextHasMediaRefs(context: Context): boolean {
  return context.messages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'text' && parseMediaRef(part.text) !== null)
  )
}

/**
 * 音视频只随附带它的那条用户消息发链接。
 *
 * 厂商每次请求都要把链接指的文件重新拉一遍 —— 十几 MB 的视频从桶里拉，
 * 一轮工具循环几十步就拉几十次，慢，而且只要有一次没拉下来整轮就 400。
 * 用户发了下一条消息，说明那段已经看过了，后面换成本地路径，要再看就走 `analyze_video`。
 * 图片小，拉一次不费事，跟着对话走。
 */
const ONE_TURN_KINDS: ReadonlySet<PromptMediaKind> = new Set(['video', 'audio'])

/** 这个引用这一次为什么不能作为链接发出去；能发返回 null */
function refBlocker(
  ref: PromptMediaRef,
  inEarlierTurn: boolean,
  allowed: ReadonlySet<PromptMediaKind>,
  unfetchable: ReadonlySet<string>
): string | null {
  if (!allowed.has(ref.kind)) return `当前模型收不了${noun(ref.kind)}链接`
  if (unfetchable.has(ref.key)) return '厂商拉不下这个链接'
  if (inEarlierTurn && ONE_TURN_KINDS.has(ref.kind)) {
    return '附带它的那一轮已经发给你看过，之后不再每轮重发'
  }
  return null
}

/**
 * 这次发不出去的引用换成说明。只换副本，不动 JSONL。
 *
 * 换的说明逐字稳定：同一个引用在之后每一轮都换成同一句话，前缀缓存只在换的那一刻断一次。
 * @param allowed 这个模型能直接收链接的种类。不在里面的一律换掉
 * @param unfetchable 厂商已经拉失败过的对象键，见 {@link noteUnfetchableMedia}
 */
export function replaceMediaRefs(
  context: Context,
  allowed: ReadonlySet<PromptMediaKind> = new Set(),
  unfetchable: ReadonlySet<string> = new Set()
): Context {
  if (!contextHasMediaRefs(context)) return context
  let lastUser = -1
  context.messages.forEach((message, index) => {
    if (message.role === 'user') lastUser = index
  })
  return {
    ...context,
    messages: context.messages.map((message, index) => {
      if (message.role !== 'user' || !Array.isArray(message.content)) return message
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== 'text') return part
          const ref = parseMediaRef(part.text)
          if (!ref) return part
          const blocker = refBlocker(ref, index < lastUser, allowed, unfetchable)
          return blocker ? { ...part, text: unavailableText(ref, blocker) } : part
        })
      }
    })
  }
}

/** 上下文里全部引用的对象键 */
export function mediaRefKeys(context: Context): string[] {
  const keys: string[] = []
  for (const message of context.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const ref = part.type === 'text' ? parseMediaRef(part.text) : null
      if (ref) keys.push(ref.key)
    }
  }
  return keys
}

/**
 * 厂商说它拉不下 / 处理不了链接里的多媒体。
 *
 * 各家措辞不一（MIMO：`failed to download or process media content`；
 * 百炼：`Download the media resource timed out`；OpenAI：`Failed to download image from url`），
 * 共同点是 4xx、提到下载或拉取、提到媒体或链接。
 */
export function isMediaFetchError(errorMessage: string): boolean {
  const { statusCode } = classifyProviderError(errorMessage)
  if (statusCode === undefined || statusCode < 400 || statusCode >= 500) return false
  return (
    /download|fetch/i.test(errorMessage) &&
    /media|image|video|audio|url|content|file/i.test(errorMessage)
  )
}

/**
 * 按厂商记下拉失败过的对象键。只在内存里，重启就忘 ——
 * 一次网络抖动不该让这个文件永远发不出去，但同一次运行里也不该每一步都再撞一次。
 */
const unfetchableByProvider = new Map<string, Set<string>>()

export function noteUnfetchableMedia(providerId: string, keys: readonly string[]): void {
  const known = unfetchableByProvider.get(providerId) ?? new Set<string>()
  keys.forEach((key) => known.add(key))
  unfetchableByProvider.set(providerId, known)
}

export function unfetchableMediaKeys(providerId: string): ReadonlySet<string> {
  return unfetchableByProvider.get(providerId) ?? new Set()
}

export const __testing = {
  resetUnfetchable: (): void => unfetchableByProvider.clear()
}

interface ResolveDeps {
  urlFor: (key: string) => Promise<string | null>
  isRemoved: (key: string) => Promise<boolean>
}

/**
 * 在 OpenAI 兼容的请求体里把引用换成厂商认的多媒体块。
 *
 * - 图片：`{ type: 'image_url', image_url: { url } }`
 * - 视频：`{ type: 'video_url', video_url: { url } }`
 * - 音频：`{ type: 'input_audio', input_audio: { data: url } }`（MIMO 文档的形状）
 *
 * 对象清理掉了或者存储没配了，换成说明 —— 发一个 404 的链接过去，
 * 整轮请求都会失败，比少看一段视频糟得多。
 */
export async function rewriteMediaInPayload(payload: unknown, deps: ResolveDeps): Promise<unknown> {
  const messages = (payload as { messages?: unknown })?.messages
  if (!Array.isArray(messages)) return undefined

  let changed = false
  const next = await Promise.all(
    messages.map(async (message) => {
      const content = (message as { role?: string; content?: unknown }).content
      if ((message as { role?: string }).role !== 'user' || !Array.isArray(content)) return message
      const parts = await Promise.all(
        content.map(async (part: { type?: string; text?: string }) => {
          if (part?.type !== 'text' || typeof part.text !== 'string') return part
          const ref = parseMediaRef(part.text)
          if (!ref) return part
          changed = true
          if (await deps.isRemoved(ref.key)) {
            return { type: 'text', text: unavailableText(ref, '已经从对象存储里清理掉了') }
          }
          const url = await deps.urlFor(ref.key)
          if (!url) {
            return { type: 'text', text: unavailableText(ref, '对象存储现在不可用') }
          }
          if (ref.kind === 'image') return { type: 'image_url', image_url: { url } }
          return ref.kind === 'video'
            ? { type: 'video_url', video_url: { url } }
            : { type: 'input_audio', input_audio: { data: url } }
        })
      )
      return { ...(message as object), content: parts }
    })
  )
  return changed ? { ...(payload as object), messages: next } : undefined
}

/**
 * 这一类能不能走对象存储。判断本身出错（设置读不出来之类）也算走不通 ——
 * 退回旧路这一轮照样能发，为了一个更好的传法把整轮打断不值得。
 * @param kind 不给就只问存储配没配好
 */
async function canUseUrl(
  deps: {
    isReady: () => Promise<boolean>
    canSend: (providerId: string, modelId: string, kind: PromptMediaKind) => Promise<boolean>
  },
  model: { providerId: string; modelId: string },
  kind?: PromptMediaKind
): Promise<boolean> {
  try {
    if (!kind) return await deps.isReady()
    return (await deps.canSend(model.providerId, model.modelId, kind)) && (await deps.isReady())
  } catch (error) {
    console.warn('[promptMedia] 判断能否走对象存储时出错，按走不通处理:', error)
    return false
  }
}

export interface PreparedPromptMedia {
  /** 要作为独立文本块放进用户消息的引用 */
  refs: PromptMediaRef[]
  /** 并进用户那段文字的说明 */
  note: string
}

interface PrepareDeps {
  isReady: () => Promise<boolean>
  canSend: (providerId: string, modelId: string, kind: PromptMediaKind) => Promise<boolean>
  upload: (filePath: string, onProgress?: (note: string) => void) => Promise<{ key: string }>
}

const DEFAULT_PREPARE_DEPS: PrepareDeps = {
  isReady: isObjectStorageReady,
  canSend: canSendMediaByUrl,
  upload: uploadMediaFile
}

/**
 * 发送这一轮之前，决定每个音视频走哪条路，该传的传上去。
 *
 * 上传失败不拦这一轮：退回只给路径，并把原因写进说明 —— 用户问的问题照样有人回答，
 * 只是 agent 要自己用工具去看。
 */
export async function preparePromptMedia(
  files: PromptMediaFile[],
  model: { providerId: string; modelId: string },
  onProgress?: (note: string) => void,
  deps: PrepareDeps = DEFAULT_PREPARE_DEPS
): Promise<PreparedPromptMedia> {
  if (files.length === 0) return { refs: [], note: '' }

  const refs: PromptMediaRef[] = []
  const failures = new Map<string, string>()
  if (await canUseUrl(deps, model)) {
    for (const file of files) {
      if (!(await canUseUrl(deps, model, file.kind))) continue
      try {
        const { key } = await deps.upload(file.filePath, onProgress)
        refs.push({ kind: file.kind, key, fileName: file.fileName, filePath: file.filePath })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.set(file.filePath, reason)
        onProgress?.(`${file.fileName} 传到对象存储失败，改为只给路径：${reason}`)
      }
    }
  }

  const sent = new Set(refs.map((ref) => ref.filePath))
  return { refs, note: describePromptMedia(files, sent, failures) }
}

export interface PreparedPromptImages {
  /** 走通了对象存储的，作为引用放进用户消息 */
  refs: PromptMediaRef[]
  /** 走不通的，交回 base64 那条路（`admitPromptImages`） */
  inline: ImageContent[]
}

interface PrepareImageDeps {
  isReady: () => Promise<boolean>
  canSend: (providerId: string, modelId: string, kind: PromptMediaKind) => Promise<boolean>
  /** 把图落成本地文件（上传要文件路径），返回路径；落不了返回 null */
  save: (image: ImageContent) => Promise<string | null>
  upload: (filePath: string) => Promise<{ key: string }>
}

async function saveImageFile(image: ImageContent): Promise<string | null> {
  const [saved] = await savePromptAttachments([image])
  return saved?.path ?? null
}

const DEFAULT_IMAGE_DEPS: PrepareImageDeps = {
  isReady: isObjectStorageReady,
  canSend: canSendMediaByUrl,
  save: saveImageFile,
  upload: uploadMediaFile
}

/**
 * 用户贴的图：先走对象存储，走不通的交回 base64。
 *
 * 一张一张地判：一轮里三张图传上去两张、第三张失败，那第三张照旧 base64，
 * 不连累另外两张。
 */
export async function preparePromptImages(
  images: readonly ImageContent[],
  model: { providerId: string; modelId: string },
  deps: PrepareImageDeps = DEFAULT_IMAGE_DEPS
): Promise<PreparedPromptImages> {
  if (images.length === 0) return { refs: [], inline: [] }
  if (!(await canUseUrl(deps, model, 'image'))) return { refs: [], inline: [...images] }

  const refs: PromptMediaRef[] = []
  const inline: ImageContent[] = []
  for (const image of images) {
    try {
      const filePath = await deps.save(image)
      if (!filePath) throw new Error('图片没能落盘')
      const { key } = await deps.upload(filePath)
      refs.push({ kind: 'image', key, fileName: path.basename(filePath), filePath })
    } catch (error) {
      console.warn('[promptMedia] 图片没走通对象存储，改用 base64:', error)
      inline.push(image)
    }
  }
  return { refs, inline }
}
