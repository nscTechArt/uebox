/**
 * 把网页正文里的图片交给视觉模型读一遍。
 *
 * ## 为什么需要
 *
 * 中文平台（尤其是微信公众号）习惯把关键信息**做进图里**：时间表、报名要求、
 * 参数清单、流程图。抓回来的 markdown 里只剩一行 `![](https://...)`，检索检索不到、
 * 问 AI 它也答不上来 —— 而用户明明看见页面上写着。
 *
 * ## 边界（这一节就是这个功能的全部设计）
 *
 * 读图是**按张收费**的动作，而一篇公众号动辄十几张图，其中大半是分割线、logo、
 * 二维码和引流卡片。所以这里的每一条限制都不是保守，是必需的：
 *
 * | 边界 | 值 | 为什么 |
 * |---|---|---|
 * | 默认关 | `enabled: false` | 花钱的事必须用户明确同意，不能替他决定 |
 * | 每篇张数 | 用户自己配，默认 6 | 一篇要读几张只有用户知道；超出的不读，但如实报出来剩几张没读 |
 * | 单图下限 | 20KB | 再小的是图标、表情、分割线，读回来是「一条灰色的线」 |
 * | 单图上限 | 8MB | 厂商对单次图片输入有上限，也防一张巨图吃掉一天额度 |
 * | 单图下载超时 | 30 秒 | 卡住一张不能拖住整篇 |
 * | 单图识别超时 | 90 秒 | 和下载**分开**计时：图都下完了才因为共用预算放弃，是最亏的一种失败 |
 * | 装饰图 | 模型回 SKIP 就丢 | 二维码、logo、纯装饰图读出来是噪音，进了库还会污染检索 |
 * | 同一张图 | 只读一次 | 公众号页眉页脚的引流图会在一篇里重复出现好几次 |
 *
 * 还有两条不在表里但同样是硬约束：
 *
 * - **不覆盖原文。** 识别结果插在那张图后面，并明确标注是 AI 读的 —— 用户要能
 *   一眼看出哪些字是原文、哪些是模型认出来的，后者会认错。
 * - **不绑任何一家模型。** 走的是用户自己在设置里配的模型：主模型看得懂图就直接
 *   用主模型，看不懂才轮到他绑的「视觉」角色（见 `resolveRoleForRequest`）。
 *   这里不出现任何厂商名字、任何写死的模型 id。
 */

import { complete, resolveBinding } from '../ai/piCompletion'
import { DEFAULT_IMAGE_READ_MAX } from '../../shared/notebookImagePolicy'

/** 读图策略。全部可调，但默认值就是上面表里那一套 */
export interface NotebookImageReadPolicy {
  /** 总开关。默认关 —— 这是花钱的动作 */
  enabled: boolean
  /** 一篇最多读几张。用户在设置里配，见 {@link normalizeMaxImages} */
  maxImages: number
  /** 小于这个字节数当装饰图跳过 */
  minBytes: number
  /** 大于这个字节数不读 */
  maxBytes: number
  /** 单张图**下载**的超时（毫秒） */
  timeoutMs: number
  /**
   * 单张图**识别**的超时（毫秒）。
   *
   * 和下载分开计时，不能共用一个 30 秒：下载一张 8MB 的图本身就可能花掉十几秒，
   * 共用的话剩给模型的时间不确定，一台正常但偏慢的服务器会被判成卡死 ——
   * 而那时候图已经下完、钱已经要花了，中途放弃是最亏的。
   * 识别比下载慢是常态（大图 + 长表格），所以给得比下载宽。
   */
  recognizeTimeoutMs: number
}

export const DEFAULT_IMAGE_READ_POLICY: NotebookImageReadPolicy = Object.freeze({
  enabled: false,
  /** 出厂默认，不是上限 —— 用户在设置里改这个数 */
  maxImages: DEFAULT_IMAGE_READ_MAX,
  minBytes: 20 * 1024,
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 30_000,
  recognizeTimeoutMs: 90_000
})

/** 模型判定「这张图没有可读内容」时回的暗号 */
const SKIP_TOKEN = 'SKIP'

/** 识别结果短于这个长度就当没读出东西 */
const MIN_USEFUL_CHARS = 10

const READ_PROMPT = `把这张图里的文字**原样抄下来**。

## 要求
1. 只抄图里真实存在的字，一个字都不要自己补
2. 保持原有的顺序和分组（表格就抄成表格，列表就抄成列表）
3. **不要描述画面**、不要总结、不要评论

## 什么时候不抄
这张图没有可读的实质文字时，只回四个字母 ${SKIP_TOKEN}，别的什么都不要写。包括：
- 二维码、条形码
- logo、纯装饰图、分割线、表情
- 只有一两个词的按钮或角标`

/** markdown 里的一处图片引用 */
interface ImageRef {
  /** 整行 `![alt](url)` 原文，用来定位插入点 */
  raw: string
  url: string
}

/** 一次读图的账目。调用方要能如实告诉用户读了几张、为什么没读 */
export interface ImageReadStats {
  /** markdown 里一共有几张图（去重后） */
  total: number
  /** 真的读出文字的张数 */
  read: number
  /** 模型判定是装饰图 */
  decorative: number
  /** 太小 / 太大 / 下载失败 / 识别失败 */
  skipped: number
  /** 超过每篇张数上限没轮到的 */
  overLimit: number
}

const IMAGE_PATTERN = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g

/** 找出正文里的图片，按出现顺序去重 */
export function extractImageRefs(markdown: string): ImageRef[] {
  const refs: ImageRef[] = []
  const seen = new Set<string>()

  for (const match of markdown.matchAll(IMAGE_PATTERN)) {
    const url = match[1]
    // 公众号的页眉页脚引流图会在一篇里重复出现，读一次就够
    if (seen.has(url)) continue
    seen.add(url)
    refs.push({ raw: match[0], url })
  }

  return refs
}

/** 下载成 base64。太小太大都不读，返回 null */
async function downloadImage(
  url: string,
  policy: NotebookImageReadPolicy,
  signal: AbortSignal
): Promise<{ data: string; mimeType: string } | null> {
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) return null

  const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim()
  // 只认真正的图片：有些站点对热链返回一个 HTML 错误页，那玩意儿喂给模型是纯浪费
  if (!mimeType.startsWith('image/')) return null

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength < policy.minBytes || buffer.byteLength > policy.maxBytes) return null

  return { data: buffer.toString('base64'), mimeType }
}

/** 把一张图交给视觉模型。读不出东西返回 null */
async function readOneImage(url: string, policy: NotebookImageReadPolicy): Promise<string | null> {
  // 下载和识别各自计时：共用一个预算的话，下载慢一点就会把识别挤没了，
  // 而那时候图已经下完、这一张的钱已经要花了，中途放弃最亏
  const downloadController = new AbortController()
  const downloadTimer = setTimeout(() => downloadController.abort(), policy.timeoutMs)
  let image: { data: string; mimeType: string } | null = null
  try {
    image = await downloadImage(url, policy, downloadController.signal)
  } finally {
    clearTimeout(downloadTimer)
  }
  if (!image) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), policy.recognizeTimeoutMs)

  try {
    // hasImages 让 resolveRoleForRequest 挑一个看得懂图的绑定：
    // 主模型能读图就用主模型，不能才轮到「视觉」角色
    const binding = await resolveBinding({ role: 'vision', hasImages: true })

    const message = await complete(binding.provider, binding.modelId, {
      system: READ_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] as never,
          timestamp: 0
        }
      ],
      // 超时要真的管到识别这一步：厂商端卡住不返回时，只掐下载等于没掐。
      // 用识别自己的预算，不和下载共用 —— 见 recognizeTimeoutMs
      signal: controller.signal,
      temperature: 0,
      maxTokens: 1500
    })

    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim()

    if (!text || text.toUpperCase().startsWith(SKIP_TOKEN)) return null
    if (text.length < MIN_USEFUL_CHARS) return null

    return text
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读完正文里的图，把识别到的文字插回去。
 *
 * 一张图失败不影响其他图，整体失败不影响正文 —— 调用方拿到的永远是一份能用的
 * markdown，最坏情况是和传进来的一模一样。
 */
export async function readImagesInMarkdown(
  markdown: string,
  policy: NotebookImageReadPolicy = DEFAULT_IMAGE_READ_POLICY
): Promise<{ markdown: string; stats: ImageReadStats }> {
  const refs = extractImageRefs(markdown)
  const stats: ImageReadStats = {
    total: refs.length,
    read: 0,
    decorative: 0,
    skipped: 0,
    overLimit: Math.max(0, refs.length - policy.maxImages)
  }

  if (!policy.enabled || refs.length === 0) return { markdown, stats }

  let result = markdown

  for (const ref of refs.slice(0, policy.maxImages)) {
    let text: string | null = null
    try {
      text = await readOneImage(ref.url, policy)
    } catch (error) {
      console.warn('[NotebookImageReader] 读图失败，跳过这张:', ref.url, error)
      stats.skipped += 1
      continue
    }

    if (!text) {
      // 模型说没内容，和下载被门槛挡掉，对用户是同一件事：这张没读出东西
      stats.decorative += 1
      continue
    }

    /*
      插在图片后面，**不覆盖原文**，并标注是 AI 读的。

      用引用块包起来是为了让用户一眼分得清：上面那行图是原文，下面这段是模型
      认出来的字 —— 它会认错，用户必须知道该不该信。
    */
    const block = `${ref.raw}\n\n> 🔍 图中文字（AI 识别）：\n>\n${text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`

    /*
      替换必须用函数形式：`block` 里是模型抄回来的字，可能带 `$'`、`$&`、`$$`。
      直接当替换字符串传进去，`$'` 会被展开成「匹配处之后的全文」，等于把后面
      整篇文章复制一份塞进注释块里，然后写回用户的原始正文。
    */
    result = result.replace(ref.raw, () => block)
    stats.read += 1
  }

  return { markdown: result, stats }
}
