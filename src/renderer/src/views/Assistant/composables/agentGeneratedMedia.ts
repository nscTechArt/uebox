/**
 * 把 `generate_image` 出的图、`generate_video` 出的视频、`generate_3d_model` 出的
 * 网格捞出来，附在最终回答后面。
 *
 * ## 为什么不能只靠模型自己写路径
 *
 * 工具返回值里有绝对路径，模型**通常**会在回答里提一句，那时
 * `markdownMediaPreview` 会把它渲染成预览图 / 播放器。但那是「通常」——
 * 花了钱出的东西要不要显示，不该取决于模型这一轮的措辞。这里从工具产出里直接取，
 * 保证一定看得见。
 *
 * 视频这一路是补上来的：它此前只在过程日志里能播，而过程日志是可以收起来的 ——
 * 一段按秒计费、跑了几分钟的片子，收起来之后正文里一点痕迹都没有。
 *
 * 网格是第三个补上来的，原因更直接：它此前**一次都没显示出来过**。气泡里的
 * 预览器只认会话结束事件还原出来的 `toolResults`，而那是 V2 的形状 —— V3 的
 * 完成事件只带一个 sessionId，那条路上 `toolResults` 恒为空。真正有值的是
 * 过程日志，与图和视频走的是同一个来源。
 *
 * ## 为什么给的是路径不是 base64
 *
 * 这段结果会随聊天记录一起持久化。base64 图片存进去几轮就把配额撑满，
 * 之后聊天记录静默地再也存不进去（同一个坑见 `adaptV2Tool` 的 `stripImages`）。
 * 存路径既便宜又清楚 —— 显示的是磁盘上那张原图，不是进模型上下文的 768px 压缩版。
 */

import { toLocalResourceUrl } from '@renderer/utils/localResource'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'

interface ToolResultArtifact {
  toolName: string
  result: unknown
}

function parseStructuredValue(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : null
}

/** 一次生图产出的全部图片路径 */
function collectImagesFromResult(result: unknown, urls: string[]): void {
  const record = parseStructuredValue(result)
  if (!record || record.success !== true) return

  const paths = Array.isArray(record.image_paths) ? record.image_paths : []
  for (const path of paths) {
    const url = typeof path === 'string' ? toLocalResourceUrl(path) : undefined
    if (url) urls.push(url)
  }
}

/**
 * 一次生视频产出的路径。
 *
 * 单值不是数组：各家的视频接口都是一次一个任务，没有「一次出四条」这回事
 * （与过程日志里的 `RESULT_VIDEO_FIELD` 是同一个字段）。
 */
function collectVideoFromResult(result: unknown, urls: string[]): void {
  const record = parseStructuredValue(result)
  if (!record || record.success !== true) return

  const path = record.video_path
  const url = typeof path === 'string' ? toLocalResourceUrl(path) : undefined
  if (url) urls.push(url)
}

/**
 * 能塞进预览器的网格扩展名，与 `generate_3d_model` 的输出格式一一对应。
 *
 * `model_path` 是工具自己从一堆产物里挑出来的网格，正常不会是别的东西；
 * 这道守卫是为了老会话记录里形状不明的 `model_preview` 结果 —— 把一张贴图
 * 递进预览器不会报错，只会在气泡里挂一个空的黑框。
 */
const MESH_EXTENSION = /\.(glb|gltf|fbx|obj|usdz|stl)$/i

/**
 * 一次 3D 生成产出的网格路径。
 *
 * 与图、视频不同，这里**不要求** `success === true`：V2 时代的 `model_preview`
 * 结果里没有这一位，而历史消息里的预览不该因为这次改动凭空消失。有一个合法的
 * 网格路径就够了 —— 存盘失败的那次本来就没有路径可给。
 */
function collectModelFromResult(result: unknown, field: string, urls: string[]): void {
  const record = parseStructuredValue(result)
  const path = record?.[field]
  if (typeof path !== 'string' || !MESH_EXTENSION.test(path.split(/[?#]/)[0])) return

  const url = toLocalResourceUrl(path)
  if (url) urls.push(url)
}

export interface GeneratedMedia {
  /** 本轮生成图的显示地址，按出图顺序，去重 */
  images: string[]
  /** 本轮生成视频的显示地址，同样去重 */
  videos: string[]
  /** 本轮生成网格的显示地址，按生成顺序，去重 */
  models: string[]
}

/**
 * 本轮所有生成产物的显示地址。
 *
 * 两个来源都要看：`toolResults` 是会话结束时从消息里还原的，
 * `agentProcess` 是过程日志。同一份产出在两边都出现时靠去重收敛。
 */
export function collectGeneratedMediaFromAgentArtifacts(args: {
  toolResults?: ToolResultArtifact[]
  agentProcess?: AgentProcessItem[]
}): GeneratedMedia {
  const images: string[] = []
  const videos: string[] = []
  const models: string[] = []

  const collect = (toolName: string | undefined, result: unknown): void => {
    if (toolName === 'generate_image') collectImagesFromResult(result, images)
    if (toolName === 'generate_video' || toolName === 'render_task_video')
      collectVideoFromResult(result, videos)
    if (toolName === 'generate_3d_model') collectModelFromResult(result, 'model_path', models)
    // V2 的生成工具，早就不存在了。老会话记录里还有这种结果
    if (toolName === 'model_preview') collectModelFromResult(result, 'filePath', models)
  }

  for (const toolResult of args.toolResults || []) collect(toolResult.toolName, toolResult.result)

  for (const item of args.agentProcess || []) {
    if (item.type !== 'tool-result') continue
    const data = item.data as { toolName?: string; result?: unknown } | undefined
    collect(data?.toolName, data?.result)
  }

  return {
    images: [...new Set(images)],
    videos: [...new Set(videos)],
    models: [...new Set(models)]
  }
}

export interface GeneratedMusicTrack {
  path: string
  title?: string
}

/** Keep paid audio visible even when the assistant abbreviates or omits its links. */
export function collectGeneratedMusic(args: {
  toolResults?: ToolResultArtifact[]
  agentProcess?: AgentProcessItem[]
}): GeneratedMusicTrack[] {
  const tracks = new Map<string, GeneratedMusicTrack>()
  const collect = (toolName: string | undefined, result: unknown): void => {
    if (toolName !== 'generate_task_music') return
    const record = parseStructuredValue(result)
    if (!record || record.success === false) return
    const candidates =
      Array.isArray(record.tracks) && record.tracks.length ? record.tracks : [record]
    for (const candidate of candidates) {
      const track = parseStructuredValue(candidate)
      if (
        typeof track?.path !== 'string' ||
        !/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(track.path)
      )
        continue
      if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(track.path)) continue
      const key = toLocalResourceUrl(track.path)!
      tracks.set(key, {
        path: track.path,
        title: typeof track.title === 'string' ? track.title : undefined
      })
    }
  }
  for (const item of args.toolResults ?? []) collect(item.toolName, item.result)
  for (const item of args.agentProcess ?? []) {
    if (item.type !== 'tool-result') continue
    const data = item.data as { toolName?: string; result?: unknown; isError?: boolean } | undefined
    if (!data?.isError) collect(data?.toolName, data?.result)
  }
  return [...tracks.values()]
}
