/**
 * AI 生图工具。
 *
 * ## 为什么现在能注册了
 *
 * V2 时代的 `generate_image` 要 `{ baseUrl, token }` —— 那是**官方网关**的地址
 * 和令牌，社区版没有（AGENTS.md §1：社区版完全离线，不得在社区版代码路径引入
 * 远程调用）。所以 V3 注册表里长期空着一段「暂不注册的：AIGC」。
 *
 * 那个前提已经不成立了：生图早就改成 `ai/imageGeneration.ts` 那套「用用户自己
 * 配的 Provider 直连厂商」，AI 创作面板走的就是它。同一个函数接给 agent，
 * 社区版不多一个官方调用点。
 *
 * ## 它是为哪条工作流存在的
 *
 * 在关卡里搭白盒 → `ue_focus_viewport` 对准 → `ue_screenshot` 拍一张 →
 * 把那张图当参考图丢给这个工具 → 出渲染成品图。所以 `reference_images`
 * **收本地绝对路径**（截图工具返回值里的 `path` 可以直接用），而不是逼模型
 * 先把图读成 base64 再贴进参数里。
 *
 * 出的图存进素材库的 AIGC/图片，返回绝对路径 —— 下一步 `ue_content_import`
 * 就能把它导进工程当贴图/参考板。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { compressForContext } from '../contextImage'
import { generateImages } from '../../../ai/imageGeneration'
import { readSettings } from '../../../ai/store'
import { saveAIGCAssetFromBuffer } from '../../../services/aigc/assetSaver'
import { describeMissingModel, listImageModels, pickImageModel } from './imageModels'
import { loadReferenceImages } from './references'
import type { AiProviderSettings } from '../../../ai/types'

/**
 * 最多几张图进模型上下文。
 *
 * 一张压完约 60–180KB，折算下来一张就是两三万 token（见 `contextImage.ts`）。
 * 出 8 张全塞回去要烧掉几十万 token，而模型看四张已经足够回答「这一版行不行、
 * 要不要重出」。剩下的照常存盘、照常在返回值里给路径，用户在界面上看得到。
 */
const MAX_CONTEXT_IMAGES = 4

/** 素材库文件名的长度上限。再长的提示词截断即可，资产备注里存着全文 */
const NAME_MAX_LENGTH = 40

const GenerateImageInput = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      '出图提示词：用途、主体与数量、场景、构图、风格、光线、准确文字、保留项和禁止项。' +
        '只写相关项，用户要求具体时只整理、不擅自扩写；中文或英文均可，画面中的文字必须保留原文。' +
        '编辑时写清只改什么、什么保持不变；多图按输入顺序说明每张图的用途。'
    ),
  reference_images: z
    .array(z.string())
    .optional()
    .describe(
      '参考图（图生图 / 照着改）。收**本地绝对路径**（ue_screenshot 返回值里的 path 直接可用）、' +
        'http(s) 直链、data URI 三种。在 prompt 中按图一、图二标明编辑目标、风格参考或待加入的物件。' +
        '本地图片没看过时先用看图工具检查，不要仅凭文件名猜内容；不要静默丢掉参考图。' +
        '搭完白盒出渲染图就靠这个：先截一张，再把截图路径放这里。'
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe('出几张，默认 1。张数直接乘在用户的账单上，没有明确要求就别多出'),
  aspect_ratio: z
    .string()
    .optional()
    .describe('画面比例，形如 "16:9" / "1:1" / "9:16"。不填由模型自己决定'),
  size: z
    .string()
    .optional()
    .describe(
      '目标像素尺寸，填写 "宽x高"（单位：像素，使用小写英文字母 x），例如 "1024x1024"。' +
        '不要填写 "1K" / "2K" / "4K" 等档位：部分接口会忽略它们，按默认低分辨率出图。' +
        '用户要求 4K 时，结合画面比例填写具体像素，例如 16:9 横图 "3840x2160"、' +
        '1:1 方图 "4096x4096"、2:1 全景图 "3840x1920"；同时填写 aspect_ratio 时应与宽高一致。' +
        '不填使用模型默认尺寸。部分厂商会调整到支持的尺寸或档位，实际分辨率以生成文件为准'
    ),
  seed: z
    .number()
    .int()
    .optional()
    .describe(
      '可选随机种子。当前仅 siliconflow-images / ark-images 适配器传递，其他适配器不发送。' +
        '不能保证构图或身份不变；迭代应带上用户认可的图，并重申保留项'
    ),
  model: z
    .string()
    .optional()
    .describe(
      '指定生图模型 id（可以只写片段）。不填就用用户在偏好设置里绑定给「生图」的那个 —— ' +
        '默认不填，除非用户点名要某个模型'
    ),
  name: z.string().optional().describe('存进素材库时的文件名（不含扩展名）。不填按提示词截一段')
})

export interface GeneratedImageDetails {
  success: true
  /** 形如 `火山方舟:doubao-seedream-4-0` */
  model: string
  prompt: string
  count: number
  /**
   * 第一张图的绝对路径。
   *
   * 名字叫 `path` 是为了对上过程日志的 `RESULT_IMAGE_FIELDS` —— 界面靠它
   * 显示缩略图，改名就等于让这条产出在界面上消失。
   */
  path?: string
  image_paths: string[]
  asset_keys: string[]
  /** 出图成了、但存素材库失败时的原因。图仍然在上下文里 */
  save_error?: string
}

/** `image/png` → `png`。认不出来按 png 存，扩展名错了界面就不当它是图 */
function extensionOf(mediaType: string): string {
  const subtype = /^image\/([a-z0-9.+-]+)/i.exec(mediaType)?.[1]?.toLowerCase()
  if (!subtype) return 'png'
  if (subtype === 'jpeg') return 'jpg'
  if (subtype === 'svg+xml') return 'svg'
  return subtype
}

/** 文件名：用户给了就用，否则拿提示词开头凑一个能在素材库里认出来的名字 */
function baseNameOf(name: string | undefined, prompt: string): string {
  const candidate = (name || prompt).replace(/\s+/g, ' ').trim()
  return candidate.slice(0, NAME_MAX_LENGTH) || `generated_${Date.now()}`
}

export function createGenerateImageTool(): UnrealAgentTool<GeneratedImageDetails> {
  return defineTool<typeof GenerateImageInput, GeneratedImageDetails>({
    name: 'generate_image',
    namespace: 'aigc',
    risk: 'mutating',
    description: `用 AI 生成图片（文生图 / 图生图），出的图直接返回给你看，同时存进素材库。

【它出的不是引擎渲染结果】这一点先说清楚：出来的是模型**重新画的一张图**，
构图和大致布局照着参考图，但画面里没有一样东西对应工程里的资产 ——
不能合成、不能换分辨率重出、不能拆通道，下一张也不会和这张完全一致。

用户说「渲染」时**先分清他要哪一种**：说概念图、效果图、氛围图、给客户看的图，
是这个工具；说出片、出序列、Movie Render Queue、MRQ、出视频、带 Alpha、EXR，
要的是引擎渲染 —— 那个**没有工具**，如实说，不要拿 AI 图顶上。
话说得两边都通（「把这个场景渲染成成品」）就先问一句再动手。

【什么时候用】：
- 用户要概念图、参考图、贴图素材、氛围图、UI 草图
- **场景里搭好白盒，要出概念成品图** —— 这是最常见的用法，做法见下
- 通用生成和改图按 \`image-generation\` 技能执行；白盒取景按 \`ue-ai-render-from-blockout\` 技能执行。

【白盒出图的固定流程】：
1. \`ue_focus_viewport\` 把镜头对准要出图的部分
2. \`ue_screenshot\` 拍一张，记住返回值里的 \`path\`
3. 调本工具：\`reference_images\` 填那个 path，\`prompt\` 写你要的成品效果
   （材质、光照、时间、天气、风格），同时写清要保留的镜头与布局
4. 看返回的图，核对布局与要求。获准修改时带上认可的图并重申保留项，不靠 seed 保证构图。

【提示词怎么写】：按用途 → 场景与主体 → 构图与细节 → 约束整理，保持简短。
用户要求具体时只整理，不擅自增加人物、物件、配色、品牌或故事；要求笼统时才补充必要的构图和光线。
明确主体数量；画面文字逐字引用并说明位置，不翻译或改写用户指定的文字。
借鉴图片的风格或构图生成新图，与修改原图是两回事。多图按输入顺序写明每张的角色。
编辑时写「只改 X；保持 Y 不变」，列出身份、姿态、布局等相关保留项，每轮重申。
白盒转成品时描述目标材质与光照，避免把灰色白盒外观写成目标，但仍要写清应保留的镜头与布局。
同一提示词的多个版本才用 count；不同素材分别写提示词、分别调用，不能把 count 当成素材清单。

【用哪个模型】：不填 \`model\` 就用用户绑定的那个，这是默认做法。
用户点名某个模型时才填，填错会把可选清单报回来。

【要花钱】：每次调用都在用用户自己的 API 额度，\`count\` 直接乘在账单上。
没明确要求就出 1 张，看过之后再决定要不要多出。

【重出与否由用户定】：你能看到出的图，所以你会有判断 —— 但「好不好看」是主观的，
而每重出一次都在花用户的额度。觉得不对劲就**调 \`ask_user\`** 把问题说清楚、给出选项
（改提示词重来 / 换比例或尺寸 / 换模型 / 够用了），别自己决定再来一轮。
用户明确说了「重来」就直接做，不用再问。
用户已明确授权迭代次数或预算时，在该范围内执行；超出范围再问。

【出完之后】：图存在素材库的 AIGC/图片 下，返回值里有绝对路径。
逐项检查主体、数量、构图、文字、保留项和禁止项，区分审美偏好与客观不符合要求。
只评价实际看到的图；其余图片先看再评价。成功返回只代表出图成功，不代表符合要求。
指出偏差并遵守上面的重出授权规则；获准迭代时每次只做针对性修改。
交付时给出图片路径、实际模型和最终提示词；需要项目素材时按用户指定位置交付，保留原图。
要放进虚幻工程就把那个路径交给 \`ue_content_import\`。`,
    input: GenerateImageInput,
    execute: async (args, ctx) => {
      // 参考图先读 —— 路径写错、文件不在，早一步报出来比等厂商那边超时强
      const references = await loadReferenceImages(args.reference_images ?? [])

      const settings = await readSettings()
      const available = listImageModels(settings)
      const chosen = args.model ? pickImageModel(available, args.model) : undefined
      if (args.model && !chosen) {
        return { isError: true, text: describeMissingModel(available, args.model) }
      }

      const count = args.count ?? 1
      ctx.report({
        text: `正在出图（${count} 张${references.length > 0 ? `，参考图 ${references.length} 张` : ''}）…`
      })

      const generated = await generateImages({
        prompt: args.prompt,
        count,
        ...(chosen ? { providerId: chosen.providerId, modelId: chosen.modelId } : {}),
        ...(args.size ? { size: args.size } : {}),
        ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}),
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
        ...(references.length > 0 ? { referenceImages: references } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {})
      }).catch((error: unknown) => {
        throw new Error(describeFailure(error, describeBoundModel(settings, chosen), references))
      })

      const baseName = baseNameOf(args.name, args.prompt)
      const paths: string[] = []
      const assetKeys: string[] = []
      const saveErrors: string[] = []
      const images: { data: string; mimeType: string }[] = []

      for (const [index, image] of generated.entries()) {
        const bytes = Buffer.from(image.base64, 'base64')

        // 存盘失败**不算整次失败**：钱已经花了，图还在手里，
        // 把它扔掉换一句报错是最差的处理。如实说存哪失败了，图照常给出去。
        const saved = await saveAIGCAssetFromBuffer(bytes, 'image', {
          suggestedName: generated.length > 1 ? `${baseName}_${index + 1}` : baseName,
          extension: extensionOf(image.mediaType),
          prompt: args.prompt
        })
        if (saved.success) {
          paths.push(saved.filePath)
          assetKeys.push(saved.assetKey)
        } else if (saved.error) {
          saveErrors.push(saved.error)
        }

        if (images.length < MAX_CONTEXT_IMAGES) {
          const compressed = await compressForContext(bytes)
          if (compressed) images.push(compressed)
        }
      }

      const modelLabel = describeBoundModel(settings, chosen)
      const lines = [
        `用 ${modelLabel} 出了 ${generated.length} 张图` +
          `${references.length > 0 ? `（参考图 ${references.length} 张）` : ''}。`
      ]

      if (paths.length > 0) {
        lines.push('已存进素材库 AIGC/图片：')
        lines.push(...paths.map((path, index) => `${index + 1}. ${path}`))
      }
      if (saveErrors.length > 0) {
        lines.push(`有 ${saveErrors.length} 张没能存进素材库：${saveErrors[0]}`)
      }
      if (images.length > 0) {
        lines.push(
          images.length < generated.length
            ? `下面附了前 ${images.length} 张，其余的只有路径。看过再决定要不要重出。`
            : '图已附在下面，自己看一眼再决定要不要重出。'
        )
      }
      if (paths.length > 0) {
        lines.push('要放进虚幻工程：把上面的路径交给 ue_content_import。')
      }

      return {
        text: lines.join('\n'),
        images,
        details: {
          success: true,
          model: modelLabel,
          prompt: args.prompt,
          count: generated.length,
          ...(paths[0] ? { path: paths[0] } : {}),
          image_paths: paths,
          asset_keys: assetKeys,
          ...(saveErrors[0] ? { save_error: saveErrors[0] } : {})
        }
      }
    }
  })
}

/**
 * 这次到底用的是哪个模型。
 *
 * 不能只说「默认模型」—— 用户绑的是哪个只有他自己知道，而出图效果差别极大，
 * 「这张图是谁画的」是他判断要不要换模型的唯一依据。出错时更是如此。
 */
function describeBoundModel(settings: AiProviderSettings, chosen?: { label: string }): string {
  if (chosen) return chosen.label
  const binding = settings.roles.image
  if (!binding) return '绑定的生图模型'
  const provider = settings.providers.find((item) => item.id === binding.providerId)
  return provider ? `${provider.displayName}:${binding.modelId}` : binding.modelId
}

/**
 * 出图失败时，把「够不够排查」补齐。
 *
 * ## 为什么要这一层
 *
 * 真机上出现过这样一次：三次调用全部失败，模型拿到的只有一句
 * 「生图接口报错 HTTP 4xx（POST /images/edits）：返回的是 HTML 网页而不是 JSON」。
 * 它据此做了两次重试和一次纯文本诊断，最后告诉用户「生图服务不可用，去检查
 * Provider 和 key」—— 而用户的 key 是好的，AI 创作面板里同一个模型出图正常。
 *
 * 缺的两条信息恰恰是决定性的：
 *
 * 1. **带参考图和不带参考图打的不是同一个端点。** OpenAI 那一系里，图生图走
 *    `/images/edits`（multipart），文生图走 `/images/generations`。很多第三方
 *    网关只代理了后者，于是「AI 创作能用、agent 不能用」—— 因为 AI 创作那条
 *    链路上多数时候没有参考图。不说这一点，模型只会得出「整个服务挂了」。
 * 2. **打的是哪个地址。** Base URL 是用户自己填的，指错地方（填成网页、少了
 *    `/v1`）时厂商回的正是一个 HTML 页面。
 */
function describeFailure(error: unknown, modelLabel: string, references: string[]): string {
  const base = error instanceof Error ? error.message : String(error)
  const url = (error as { url?: unknown } | null)?.url
  const lines = [`${base}（用的是 ${modelLabel}）`]

  if (typeof url === 'string' && url) lines.push(`请求地址：${url}`)

  if (references.length > 0) {
    lines.push(
      '本次带了参考图。部分接入的图生图与文生图使用不同端点（例如 /images/edits 与 ' +
        '/images/generations），具体以本次请求地址为准。' +
        '「AI 创作面板里同一个模型能出图」不能单独证明这里也能。' +
        '请按上面的实际错误排查，不要自动去掉 reference_images 再调一次；那会改变任务并可能再次扣费。' +
        '需要纯文生图诊断或换模型时先取得用户授权；文生图成功也不能单独证明图生图失败的原因。'
    )
  } else {
    lines.push(
      '这次没有带参考图，走的是文生图端点。' +
        '排查顺序：API 地址是不是指到了网页而不是接口（少了 /v1 之类）、' +
        '密钥是否有效、这个模型在这家服务商上是否真的存在。'
    )
  }

  return lines.join('\n')
}
