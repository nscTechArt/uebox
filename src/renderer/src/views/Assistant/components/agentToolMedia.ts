/**
 * 工具结果里带的图和视频怎么读。
 *
 * 单独成文件是因为两处要读：小窗的过程日志（`AgentProcessLog`）和主对话页的
 * 步骤组（`AgentStepGroup`）。各抄一份的话，哪天工具多一个字段就会只认一边。
 *
 * 显示的是**磁盘上那张原图**，不是进模型上下文的那张压缩版：后者为了省 token
 * 压到了 768px 宽的 JPEG，而且根本不发到渲染层（base64 会随对话记录写进
 * localStorage，把配额撑满 —— 见 adaptV2Tool 的说明）。读盘显示既清楚又不占
 * 存储，重开应用之后也还在。
 */
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { isPreviewableImageRef } from './markdownMediaPreview'
import { normalizeToolName, parseStructuredValue } from './agentToolCallData'

/**
 * 工具返回值里存图片路径的字段。
 *
 * `screenshot_path` 是视口截图 / Widget 预览 / PIE 试玩，`path` 是老一些的截图工具。
 * 只认这两个字段还不够 —— `path` 这个名字太泛（一堆工具用它指资产路径），
 * 所以还要过一遍 `isPreviewableImageRef`：必须是绝对路径且以图片扩展名结尾。
 */
const RESULT_IMAGE_FIELDS = ['screenshot_path', 'path'] as const

/**
 * 一次产出多张图的字段。生图、以及 PIE 试玩的时间轴拼图走它。
 *
 * 单独一个字段而不是把 `path` 改成数组：`path` 那条路上有一堆存量工具，
 * 而它们一次只出一张。
 *
 * 试玩那条路必须用它：模型收到的是几张拼图加收尾截图，界面只认单张
 * `screenshot_path` 的话，用户看到的是「跑了一下出了一张图」，而模型
 * 正照着四张拼图讲整段过程 —— 两边看的不是同一批画面，用户没法复核。
 */
const RESULT_IMAGE_LIST_FIELD = 'image_paths'

/**
 * 产出视频的字段。目前只有 generate_video。
 *
 * 视频一次只出一条 —— 各家的接口都是一次一个任务，而且贵，没有「一次出四条」
 * 这回事，所以这里是单值不是数组。
 */
const RESULT_VIDEO_FIELD = 'video_path'

/** 能在 <video> 里直接播的扩展名。本机资源服务对这几种都带 Range 响应 */
const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v)$/i

/**
 * agent **看过**的那张图（`read_local_file` 读到图片时挂在 details 上）。
 *
 * 单独一个字段而不是并进 `RESULT_IMAGE_FIELDS`：那些是工具产出的图，这张是
 * agent 的输入，默认收起、点一下才加载。
 */
const RESULT_PEEK_IMAGE_FIELD = 'viewed_image_path'

/**
 * 出的图本身就是交付物的工具。
 *
 * 按**工具**分，不按图长什么样猜：同样是一张图，生图出来的是用户要的东西，
 * 截图 / 控件预览 / 试玩拼图是 agent 给自己看的检查画面。前者默认就铺在
 * 段落下面，后者收进过程里 —— 一轮自检能截十几张，全铺开会把对话淹掉。
 *
 * 新增一个「出图给用户」的工具时要加到这里，漏了的表现是它的图收在过程里
 * 要点开才看得到，不会丢。
 */
const DELIVERABLE_IMAGE_TOOLS = new Set(['generate_image'])

export function isDeliverableImageTool(toolName: string): boolean {
  return DELIVERABLE_IMAGE_TOOLS.has(normalizeToolName(toolName))
}

/**
 * 找出这一步产出的、能直接播放的视频。
 *
 * 与图同理走本机资源服务读磁盘上那份，而不是厂商那个临时地址 ——
 * 后者几小时后失效，对话记录翻回来就是一个点不开的黑框。
 */
export function findResultVideoUrls(result: unknown): string[] {
  const structured = parseStructuredValue(result)
  const value = structured?.[RESULT_VIDEO_FIELD]
  if (typeof value !== 'string' || !VIDEO_EXTENSION.test(value.split(/[?#]/)[0])) return []
  const url = toLocalResourceUrl(value)
  return url ? [url] : []
}

export function findResultPeekImageUrls(result: unknown): string[] {
  const structured = parseStructuredValue(result)
  const value = structured?.[RESULT_PEEK_IMAGE_FIELD]
  const paths = Array.isArray(value) ? value : [value]
  return paths
    .filter((item): item is string => typeof item === 'string' && isPreviewableImageRef(item))
    .map((item) => toLocalResourceUrl(item))
    .filter((url): url is string => Boolean(url))
}

/** 找出这一步产出的、能直接显示的图 */
export function findResultImageUrls(result: unknown): string[] {
  const structured = parseStructuredValue(result)
  if (!structured) return []

  const list = structured[RESULT_IMAGE_LIST_FIELD]
  if (Array.isArray(list)) {
    const urls = list
      .filter((value): value is string => typeof value === 'string' && isPreviewableImageRef(value))
      .map((value) => toLocalResourceUrl(value))
      .filter((url): url is string => Boolean(url))
    if (urls.length > 0) return urls
  }

  for (const field of RESULT_IMAGE_FIELDS) {
    const value = structured[field]
    if (typeof value === 'string' && isPreviewableImageRef(value)) {
      const url = toLocalResourceUrl(value)
      if (url) return [url]
    }
  }
  return []
}
