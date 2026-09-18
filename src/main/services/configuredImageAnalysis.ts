/**
 * 用**用户自己配的模型**识图。
 *
 * ## 为什么重写这一条
 *
 * 上一版把三个图片入口（截图分析、文档内嵌图、扫描版 PDF）全都绑死在**某一家厂商的
 * Key** 上。用户在设置里认认真真绑了看得懂图的模型，只要没顺手申请那一家的 Key，
 * 这三个功能一律报「请配置 Key」。这跟社区版「不绑任何一家」的立场是直接冲突的。
 *
 * 现在只说一句「我要一个看得懂图的」，具体是谁由用户的配置决定：
 * 主模型看得懂图就用主模型，看不懂才轮到他绑的「视觉」角色
 * （挑选逻辑见 `resolveRoleForRequest`）。这个文件里不出现任何厂商名字、
 * 任何写死的模型 id。
 */

import { complete, resolveBinding } from '../ai/piCompletion'
import { findVisionCapableRole } from '../../shared/aiProvider'
import { readSettings } from '../ai/store'

/**
 * 图片编码后的大小上限。
 *
 * 各家对单次图片输入都有限制，具体数值不一。这里取一个各家都吃得下的保守值，
 * 超了就别发出去 —— 发出去也是一次 400，还白等一轮网络往返。
 */
export const IMAGE_BASE64_LIMIT = 10 * 1024 * 1024

/** 没有任何看得懂图的模型时给用户的提示。不点名任何厂商 */
export const NO_VISION_MODEL_HINT =
  '没有可用的图片理解模型。请在 设置 → 模型 里绑定一个看得懂图片的模型（主模型支持图片的话直接用它就行）。'

export interface ImageAnalysisResult {
  success: boolean
  markdown?: string
  content?: string
  description?: string
  error?: string
}

export interface ImageAnalysisInput {
  /** base64 编码的图片数据（不含 data: 前缀） */
  imageData: unknown
  mimeType: unknown
  /** 想让模型干什么。不给就按「描述这张图」走 */
  prompt?: unknown
  /** `prompt` 的别名，文档图片那条路用的是这个字段名 */
  context?: unknown
}

const DEFAULT_PROMPT = `请用中文描述这张图片的内容，输出 Markdown。

- 图里有文字就**原样抄下来**，保持原有的顺序和分组
- 图表要说清楚横纵轴、关键数值和趋势
- 只描述图里真实存在的内容，不要猜测、不要脑补`

/** 现在有没有一个看得懂图的模型可用 */
export async function hasConfiguredVisionModel(): Promise<boolean> {
  try {
    const settings = await readSettings()
    return findVisionCapableRole(settings) !== null
  } catch {
    return false
  }
}

/**
 * 把一张图交给用户配的模型。
 *
 * 返回 null = 「这条路走不通」：给的不是图片、超了大小限制、或者一个看得懂图的
 * 模型都没绑。调用方据此给出提示，而不是把 null 当成识别失败。
 */
export async function analyzeImageWithConfiguredModel(
  body: ImageAnalysisInput
): Promise<ImageAnalysisResult | null> {
  const { imageData, mimeType } = body
  if (typeof imageData !== 'string' || typeof mimeType !== 'string') return null
  if (imageData.length > IMAGE_BASE64_LIMIT) return null

  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
  const context = typeof body.context === 'string' ? body.context : undefined

  try {
    // hasImages 让 resolveRoleForRequest 挑一个看得懂图的绑定
    const binding = await resolveBinding({ role: 'vision', hasImages: true })

    const message = await complete(binding.provider, binding.modelId, {
      system: prompt || context || DEFAULT_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: imageData, mimeType }] as never,
          timestamp: 0
        }
      ],
      temperature: 0.2,
      maxTokens: 2000
    })

    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim()

    if (!text) return { success: false, error: '模型没有返回内容' }

    // 三个调用方各读一个字段（markdown / description / content），都给上
    return { success: true, markdown: text, content: text, description: text }
  } catch (error) {
    /*
      「没绑模型」和「识别失败」要分开。

      前者返回 null，调用方会给出「去设置里绑一个」的提示；后者是真的调用出错
      （余额、网络、厂商拒了），要把原因如实带出去。混在一起的话，用户配好了模型
      却一直看到「请去配置模型」，无从下手。
    */
    const reason = error instanceof Error ? error.message : String(error)
    if (!(await hasConfiguredVisionModel())) return null
    return { success: false, error: reason }
  }
}
