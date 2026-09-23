/**
 * AI 生成 3D 模型工具。
 *
 * ## 它与生图、生视频的位置
 *
 * 三个都是「用用户自己配的 Provider 直连厂商」，但下游差别很大：
 * 图和视频是**给人看的**，3D 是**要进引擎的**。所以这个工具比另外两个多做一步 ——
 * 把网格和贴图一起落盘，并把网格路径单独回出来，好让 `ue_content_import` 接得上。
 *
 * ## 三处刻意的设计
 *
 * 1. **不返回模型进上下文**。与视频同理：没有能塞进上下文的形式。厂商多数会
 *    附一张预览渲染图，但那张图**不能代替看模型** —— 拓扑、面数、朝向、有没有
 *    穿模，图上一样都看不出来。所以这里不拿预览图冒充「我看过了」。
 * 2. **面数与用途一起报**。3D 资产进引擎之后最常见的返工是「面数超了」和
 *    「尺寸不对」，这两件事在生成时就该定下来，而不是导入后再返工。
 * 3. **说清「这是静态网格，没有骨骼」**。图生 3D 出的一律是静态网格，
 *    再好看也不能直接做动画 —— 模型很容易把 Rodin 的 T-pose 选项当成「带绑定」。
 *
 * ## 边界
 *
 * 出的是一个**新网格**，不是从工程里的资产改出来的。用户要减面、要 LOD、
 * 要重拓扑现有资产，那是引擎/DCC 的事，这个工具顶不上。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import {
  encodeModel3dJob,
  generateModel3d,
  resumeModel3d,
  type Model3dJob,
  type Model3dVendorOptions
} from '../../../ai/model3d'
import { readSettings, readSettingsSync } from '../../../ai/store'
import { readPlanStateSync } from '../../../ai/creatorPlan/planState'
import { isPlanProvider } from '../../../../shared/creatorPlan'
import { downloadAndSaveAIGCAsset } from '../../../services/aigc/assetSaver'
import { compressForContext } from '../contextImage'
import { loadReferenceImages, MODEL3D_REFERENCE_BUDGET } from './references'
import { promises as fs } from 'fs'
import { describeMissingModel3d, listModel3dModels, pickModel3d } from './model3dModels'
import type { AiProviderSettings } from '../../../ai/types'

/** 素材库文件名的长度上限。再长的提示词截断即可，资产备注里存着全文 */
const NAME_MAX_LENGTH = 40

/**
 * 哪些扩展名算「网格本体」。
 *
 * 一次生成回来的是一组文件：网格 + 若干贴图 + 一张预览渲染图。
 * 下游（ue_content_import、对话窗口的预览器）要的是网格那一个，
 * 分不出来的话会把一张 png 当模型导进引擎。
 */
const MESH_EXTENSION = /\.(glb|gltf|fbx|obj|usdz|stl)$/i

/**
 * 厂商附的那张预览渲染图。
 *
 * 三家都会额外渲一张图回来（Tripo 叫 `rendered_image_url`）。以前它只是被
 * 当成附属文件存下来，**模型看不到** —— 于是模型对自己刚生成的东西一无所知，
 * 连「是不是我要的那个物体」都答不上来。
 *
 * 现在把它塞进模型上下文。但要说清它**能判断什么**：主体对不对、风格对不对、
 * 大致形状对不对。**不能判断的**：拓扑、面数、朝向、有没有穿模、尺寸 ——
 * 那些在一张渲染图上一样都看不出来，所以它不能代替用户在预览器里转一圈。
 */
const PREVIEW_EXTENSION = /\.(png|jpe?g|webp)$/i

const Generate3dModelInput = z.object({
  prompt: z
    .string()
    .optional()
    .describe(
      '文字描述。与 reference_images 至少给一个。' +
        '写物体本身：是什么、什么材质、什么风格。**别写镜头和光线** —— 那是生图的写法，3D 用不上。'
    ),
  reference_images: z
    .array(z.string())
    .optional()
    .describe(
      '参考图（图生 3D，比纯文字稳得多）。收**本地绝对路径**（ue_screenshot 的 path 直接可用）、' +
        'http(s) 直链、data URI 三种 —— 本地图会自动先传给厂商换成引用。' +
        '**给多张时整组都会用上**，按 `正面 → 左 → 背 → 右` 的顺序放 —— 顺序错了' +
        '不会报错，只是出一个左右颠倒的模型。**只给两张时它们就是「正面 + 左」**，' +
        '所以手上只有正面和背面时，要么补齐四视图、要么只传正面那一张。' +
        'Tripo 和 Meshy 各只有四个视位，给第 5 张会明确报错（Rodin 不卡张数）。'
    ),
  quality: z
    .enum(['high', 'medium', 'low', 'extra-low'])
    .optional()
    .describe(
      '精度档，直接对应面数。**按用途选，不要一律选 high**：' +
        '背景道具 low / extra-low、可交互道具 medium、主角或特写 high。' +
        '面数超标进引擎之后就是返工。'
    ),
  topology: z
    .enum(['raw', 'quad'])
    .optional()
    .describe(
      'raw = 三角面（直接进引擎），quad = 四边面（便于在 DCC 里继续改）。' +
        '不确定就别填。注意 Tripo 的四边面**只能导出 fbx**'
    ),
  format: z
    .enum(['glb', 'gltf', 'fbx', 'obj', 'usdz', 'stl'])
    .optional()
    .describe(
      '输出格式，默认 glb（单文件自带材质，虚幻侧导入器认它）。' +
        '选了厂商给不了的组合会明确报错，不会静默给你另一种'
    ),
  bounding_box: z
    .array(z.number())
    .length(3)
    .optional()
    .describe(
      '限制成品最大尺寸 [宽, 高, 长]。**整批资产比例要一致时必填** —— ' +
        '不给的话每个模型都是各自归一化的大小，导进引擎要一个个手调缩放。' +
        '只有 Rodin 支持，其它家给了会明确报错'
    ),
  material: z
    .enum(['pbr', 'shaded', 'all'])
    .optional()
    .describe('pbr = 基础色/金属度/粗糙度/法线（进引擎用这个）；shaded = 只有烘死光照的基础色'),
  rest_pose: z
    .boolean()
    .optional()
    .describe(
      '人形生成 T/A 摆姿。**只是摆姿势，不给骨骼** —— 出来仍是静态网格，' +
        '要动画还得另外绑定。只有 Rodin 支持'
    ),
  seed: z.number().int().optional().describe('随机种子。想保持同一个造型换贴图时带上同一个种子'),
  model: z
    .string()
    .optional()
    .describe('指定模型。不填就用用户绑定的那个（推荐）。填错会把可选清单报回来'),
  name: z.string().optional().describe('存进素材库时的文件名。不填从提示词里取'),
  resume_job_id: z
    .string()
    .optional()
    .describe(
      '**接着取一个已经提交过的任务**（形如 `abc123~abc123`），而不是重新生成。' +
        '上一次失败的报错里带着这个号就用它 —— 提交那一刻钱就扣了，' +
        '重新提交是再付一次全款。给了这个参数时，其余生成参数全部忽略。'
    ),

  /*
   * ── 以下是 Tripo 专属的开关 ──────────────────────────────────────────
   *
   * 用户绑的**不是** Tripo 时，这一段会从入参表里整体摘掉（见
   * `createGenerate3dModelTool`），模型根本看不见它们。
   *
   * 为什么不是「都暴露出来，发错家再报错」：这些参数没有一个是通用的，
   * 而模型看见了就会想用。绑着 Rodin 却看到一个 `smart_low_poly`，
   * 最好的结果是白花一次往返，最坏的结果是它把参数名写进 prompt。
   */
  negative_prompt: z
    .string()
    .optional()
    .describe(
      '【Tripo】不想要的东西，几个词就够（上限 255 字）。' +
        '**最值钱的用法是去掉底座、支架、背景板** —— 那是生成 3D 最常见的多余物。' +
        '别在这里写画质词，它不认。'
    ),
  texture_quality: z
    .enum(['standard', 'detailed', 'extreme'])
    .optional()
    .describe(
      '【Tripo】贴图精细档，默认 standard。detailed 额外扣约 10 额度；' +
        'extreme **只有 P 系列有**。主角和特写才值得往上调，背景件不值。'
    ),
  geometry_quality: z
    .enum(['standard', 'detailed'])
    .optional()
    .describe(
      '【Tripo · 仅 H 系列】几何精细档，默认 standard。' +
        'detailed 额外扣约 20 额度，是这批开关里最贵的一个 —— 只给主角开。'
    ),
  smart_low_poly: z
    .boolean()
    .optional()
    .describe(
      '【Tripo · 仅 H 系列】出「像手工做的」低模拓扑，额外扣约 10 额度。' +
        '**这是游戏资产最想要的那一档**，但复杂造型上厂商明说可能失败。' +
        '打开之后 `quality` 会被压进 1000–20000 面（配四边面 500–10000）—— ' +
        '这是厂商给的区间，不是这里挑的。'
    ),
  auto_size: z
    .boolean()
    .optional()
    .describe(
      '【Tripo】按真实世界米制缩放成品。' +
        '**整批资产要尺寸一致时打开它** —— Tripo 没有 `bounding_box`，这是它这边的替代。'
    ),
  align_orientation: z
    .boolean()
    .optional()
    .describe(
      '【Tripo · 仅 H 系列 · 要有参考图】让成品的朝向对齐参考图，而不是厂商的默认朝向。' +
        '省掉进引擎之后一个个转的活。'
    ),
  texture_alignment: z
    .enum(['original_image', 'geometry'])
    .optional()
    .describe(
      '【Tripo · 仅 H 系列 · 要有参考图】贴图对齐原图（默认，更像参考图）还是对齐几何' +
        '（接缝更规整）。拿不准就别填。'
    ),
  image_autofix: z
    .boolean()
    .optional()
    .describe(
      '【Tripo · 仅 H 系列 · 要有参考图】先让厂商自动修一遍输入图（会更慢）。' +
        '用户给的是手机随手拍、背景杂、光线不匀时才打开。'
    ),
  generate_parts: z
    .boolean()
    .optional()
    .describe(
      '【Tripo · 仅 H 系列】分件输出而不是一整块，额外扣约 20 额度。' +
        '**出来的没有贴图**，而且与 `material`、四边面互斥 —— 同时给会明确报错。'
    )
})

/** Tripo 专属参数的键。绑的不是 Tripo 时按这份清单从入参表里摘掉 */
const TRIPO_ONLY_KEYS = {
  negative_prompt: true,
  texture_quality: true,
  geometry_quality: true,
  smart_low_poly: true,
  auto_size: true,
  align_orientation: true,
  texture_alignment: true,
  image_autofix: true,
  generate_parts: true
} as const

export interface Generated3dModelDetails extends Record<string, unknown> {
  success: boolean
  model: string
  /** 网格本体的绝对路径。对话窗口的预览器和 ue_content_import 都用它 */
  model_path?: string
  /** 一起下载下来的贴图等附属文件 */
  extra_paths: string[]
  asset_keys: string[]
  /** 厂商那边的任务号。失败时靠它对账 */
  job_id: string
  cost?: number | null
  save_error?: string
}

/**
 * 工具入参里的厂商开关 → 传输层的形状。
 *
 * 一个个列而不是整包透传：工具这一层用的是模型好读的下划线名，传输层用的是
 * 通用叫法（将来另外两家有对应能力时复用同一批名字）。中间少一层映射，
 * 两边的命名迟早会被改成一样，然后就再也分不清谁该跟着厂商改了。
 */
function vendorOptionsOf(args: {
  negative_prompt?: string
  texture_quality?: 'standard' | 'detailed' | 'extreme'
  geometry_quality?: 'standard' | 'detailed'
  smart_low_poly?: boolean
  auto_size?: boolean
  align_orientation?: boolean
  texture_alignment?: 'original_image' | 'geometry'
  image_autofix?: boolean
  generate_parts?: boolean
}): Model3dVendorOptions {
  const negative = String(args.negative_prompt ?? '').trim()
  return {
    ...(negative ? { negativePrompt: negative } : {}),
    ...(args.texture_quality ? { textureQuality: args.texture_quality } : {}),
    ...(args.geometry_quality ? { geometryQuality: args.geometry_quality } : {}),
    ...(args.smart_low_poly !== undefined ? { smartLowPoly: args.smart_low_poly } : {}),
    ...(args.auto_size !== undefined ? { autoSize: args.auto_size } : {}),
    ...(args.align_orientation !== undefined
      ? { alignOrientationToImage: args.align_orientation }
      : {}),
    ...(args.texture_alignment ? { textureAlignment: args.texture_alignment } : {}),
    ...(args.image_autofix !== undefined ? { imageAutofix: args.image_autofix } : {}),
    ...(args.generate_parts !== undefined ? { generateParts: args.generate_parts } : {})
  }
}

/**
 * 用户给「3D 生成」绑的是不是 Tripo。
 *
 * 同步读配置，理由见 `readSettingsSync` 的注释：工具注册这一步是同步的，
 * 而且结果会被全局缓存住 —— 换绑之后由 `registry.ts` 订阅配置变更清缓存。
 *
 * 读不出来（没配、配坏了）时按「不是 Tripo」处理：少给几个参数只是少一点能力，
 * 给错了则是让模型对着一家不存在的厂商写参数。
 */
function tripoIsBound(): boolean {
  try {
    const settings = readSettingsSync()
    const binding = settings.roles.model3d
    if (!binding) return false
    return (
      settings.providers.find((provider) => provider.id === binding.providerId)?.model3dApi ===
      'tripo'
    )
  } catch {
    return false
  }
}

/**
 * 绑了 Tripo 才追加的这一段说明。
 *
 * 与那组参数同进同退：参数摘掉了还留着说明，等于告诉模型去用一批它看不见的字段。
 */
const TRIPO_DESCRIPTION_NOTE = `
【这次绑的是 Tripo，多出一组开关】它们都要额外花钱，按用途开，不要一次全打开：

- 想去掉底座、支架、背景板 → \`negative_prompt\`（几个词，这是最划算的一个）
- 要做游戏资产、在意拓扑 → \`smart_low_poly\`（面数会被压进低模区间）
- 整批资产要尺寸一致 → \`auto_size\`（Tripo 这边没有 \`bounding_box\`，用它替代）
- 有参考图且在意朝向 → \`align_orientation\`
- 只有主角和特写才值得开 \`geometry_quality: detailed\` / \`texture_quality: detailed\`
`

/**
 * 创作者 Token Plan 的扩展开关（协议 05-tasks 的 `options`）。键名和协议一致，
 * 说明不带厂商名；只暴露清单 `model3d.options` 里列了的那几个。
 * `bounding_box` / `rest_pose` 是通用参数，但在套餐那边也走 options，没列就一并摘掉。
 */
const PLAN_OPTION_FIELDS = {
  negative_prompt: z
    .string()
    .max(255)
    .optional()
    .describe('不想要的东西，几个词就够（上限 255 字）。最值钱的用法是去掉底座、支架、背景板。'),
  texture_quality: z
    .enum(['standard', 'detailed'])
    .optional()
    .describe('贴图精细档，默认 standard。主角和特写才值得调到 detailed。'),
  smart_low_poly: z
    .boolean()
    .optional()
    .describe('出面向实时渲染的低面数干净拓扑。游戏资产最想要的一档，复杂造型上可能失败。'),
  auto_size: z.boolean().optional().describe('按真实世界尺寸缩放成品。整批资产要尺寸一致时打开。'),
  generate_parts: z.boolean().optional().describe('按部件拆分输出，而不是一整块。')
} as const

/** 套餐那边走 options、但在工具入参里是通用参数的两个 */
const PLAN_GENERAL_OPTION_KEYS = ['bounding_box', 'rest_pose'] as const

/**
 * 「3D 生成」绑的是不是创作者 Token Plan；是的话带上缓存清单里的 `options`。
 * 同步读，理由同 tripoIsBound。清单没缓存时按「没有扩展开关」处理。
 */
function planModel3dOptions(): string[] | null {
  try {
    const binding = readSettingsSync().roles.model3d
    if (!binding || !isPlanProvider(binding.providerId)) return null
    const options = (readPlanStateSync().manifest?.roles?.model3d as { options?: unknown } | null)
      ?.options
    return Array.isArray(options)
      ? options.filter((key): key is string => typeof key === 'string')
      : []
  } catch {
    return null
  }
}

/** 套餐那一段说明：什么时候退额度，以及这次能用哪几个扩展开关 */
function planDescriptionNote(options: string[]): string {
  const extra = Object.keys(PLAN_OPTION_FIELDS).filter((key) => options.includes(key))
  return `
【这次绑的是创作者 Token Plan】失败、超时退回额度；**已提交的 3D 取消后不退额度**（上游会跑完、照常计费），参数确认好再提交。
四边面、智能低模、要转格式的输出（obj、usdz、三角面 fbx）各多占 0.5 次。${
    extra.length > 0
      ? `当前套餐多出这几个开关：${extra.map((key) => `\`${key}\``).join('、')}。按用途开，不要一次全打开。`
      : ''
  }
`
}

export function createGenerate3dModelTool(): UnrealAgentTool<Generated3dModelDetails> {
  const tripo = tripoIsBound()
  const planOptions = tripo ? null : planModel3dOptions()

  /*
   * 绑的不是 Tripo 就把那一段参数摘掉。
   *
   * 这里要一次 `as`：摘完之后运行时的 schema 少几个键，而类型上仍按全量算。
   * 这不是把类型糊过去 —— 那几个键本来就是可选的，摘掉之后 `args` 上取到的是
   * `undefined`，与类型说的完全一致。反过来按运行时的形状去写类型，
   * 会让 `execute` 的签名跟着分叉成两份。
   */
  const input = tripo
    ? Generate3dModelInput
    : planOptions
      ? planInput(planOptions)
      : (Generate3dModelInput.omit(TRIPO_ONLY_KEYS) as unknown as typeof Generate3dModelInput)

  return defineTool<typeof Generate3dModelInput, Generated3dModelDetails>({
    name: 'generate_3d_model',
    namespace: 'aigc',
    risk: 'mutating',
    description: `用 AI 生成一个 3D 网格，存进素材库并在对话窗口里可以转着看。

【要花钱，而且不快】一次几十秒到几分钟，${
      planOptions
        ? '每次调用占用创作者 Token Plan 的 3D 次数，**失败、超时退回；提交之后取消不退**'
        : '每次调用扣用户的额度，**失败也扣**'
    }。
一次只出一个，看过再决定要不要重来。

【出来的是静态网格，没有骨骼】图生 3D 全都如此，再好看也不能直接做动画。
\`rest_pose\` 只是让人形摆成 T/A 姿势方便**之后**绑定，不等于带绑定。
用户要能动的角色，绑定是另一步，如实说。

【它不改现有资产】出的是一个新网格。用户要给工程里已有的资产减面、做 LOD、
重拓扑，那是引擎/DCC 的事，这个工具顶不上。

【最容易返工的两件事，生成时就定】：
- \`quality\` **按用途选**：背景道具 low/extra-low，可交互道具 medium，主角/特写 high。
  一律选 high 的结果是几十万面的背景石头，进引擎必返工。
- \`bounding_box\` **整批资产要比例一致时必填**。不给的话每个模型各自归一化，
  导进去要一个个手调缩放。（只有 Rodin 支持）

【图生 3D 比文生 3D 稳得多】有参考图就给。本地截图可以直接给路径。

【用哪个模型】不填 \`model\` 就用用户绑定的那个。目录里预置了 Hyper3D Rodin、
Tripo、Meshy 三家，各家支持的参数不同，选了对方没有的会明确报错。

【你能看到什么】厂商会附一张预览渲染图，附在这个工具的返回里。
你可以据此判断**主体、风格、大致形状**对不对。但**拓扑、面数、朝向、有没有穿模、
尺寸在那张图上一样都看不出来**，那些只能由用户在预览器里转着看，别替他下结论。

【好不好看不是你说了算 —— 也不是你能花钱去改的】
你能看到那张预览图，所以你会有判断。但**「像不像」「好不好」是主观的**，
而重做一次要用户再付一次钱。所以：

- 觉得不对劲 → **调 \`ask_user\`**，把你看到的问题说清楚、给出选项
  （照原样再来一次 / 改提示词重来 / 换精度或换厂商 / 就这样，够用了），
  第一个放你的推荐并标「（推荐）」。
- **不要自己决定重做。** 没有用户明确点头，一次生成只调一次这个工具。
- 用户说「不行，再来一个」那才是点头 —— 那时直接做，别再问一遍。

判断得对不对都不是重点，重点是**花的是用户的钱，选择权归他**。

【出完之后】网格存在素材库的 AIGC/模型 下，返回值 \`model_path\` 是绝对路径，
交给 \`ue_content_import\` 就能进工程。
${tripo ? TRIPO_DESCRIPTION_NOTE : ''}${planOptions ? planDescriptionNote(planOptions) : ''}
`,
    input,
    execute: async (args, ctx) => {
      // 续跑：跳过提交，直接去取那个已经付过钱的任务
      const resumeToken = String(args.resume_job_id ?? '').trim()
      if (resumeToken) {
        ctx.report({ text: `正在取回任务 ${resumeToken} 的结果（不重新提交、不再扣费）…` })
        const resumed = await resumeModel3d({
          jobToken: resumeToken,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: (note) => ctx.report({ text: `任务状态：${note}` })
        }).catch((error: unknown) => {
          throw new Error(describeModel3dFailure(error, '续跑'))
        })
        return await saveAndReport(resumed, '续跑（本次未重新扣费）', args, ctx)
      }

      const prompt = String(args.prompt ?? '').trim()
      const sources = (args.reference_images ?? []).map((item) => item.trim()).filter(Boolean)
      if (!prompt && sources.length === 0) {
        return {
          isError: true,
          text: '生成 3D 至少要给一句描述（prompt）或一张参考图（reference_images）。'
        }
      }

      /*
       * 参考图先读 —— 与生图、生视频共用同一个加载器：本地绝对路径读盘转 data URI、
       * 太大的先缩一遍、直链和 data URI 原样递过去。
       *
       * **这一步以前是漏的**，而漏掉的表现是静默的：路径被原样递给厂商层，那边的
       * `toBytes` 认不出路径，只能当裸 base64 解 —— 而路径里的字母正好都在 base64
       * 字母表里，于是解出几个垃圾字节、一句报错都没有、照常提交。用户付了全款，
       * 换回一个凭空捏造的模型。而这条路是**主路**：skill 教的四视图流程、
       * 用户在对话里贴的附件、`ue_screenshot` 拍的白盒，给的全是本地路径。
       */
      const references = await loadReferenceImages(sources, MODEL3D_REFERENCE_BUDGET)

      const settings = await readSettings()
      const available = listModel3dModels(settings)
      const chosen = args.model ? pickModel3d(available, args.model) : undefined
      if (args.model && !chosen) {
        return { isError: true, text: describeMissingModel3d(available, args.model) }
      }

      const modelLabel = describeBoundModel3d(settings, chosen)
      ctx.report({ text: `正在用 ${modelLabel} 生成 3D 模型，通常要一到几分钟…` })

      const generated = await generateModel3d({
        ...(prompt ? { prompt } : {}),
        ...(references.length > 0 ? { images: references } : {}),
        ...(chosen ? { providerId: chosen.providerId, modelId: chosen.modelId } : {}),
        format: args.format ?? 'glb',
        ...(args.quality ? { quality: args.quality } : {}),
        ...(args.topology ? { topology: args.topology } : {}),
        ...(args.material ? { material: args.material } : {}),
        ...(args.bounding_box
          ? { boundingBox: args.bounding_box as [number, number, number] }
          : {}),
        ...(args.rest_pose !== undefined ? { restPose: args.rest_pose } : {}),
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
        vendor: vendorOptionsOf(args),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (note) => ctx.report({ text: `3D 生成中：${note}` })
      }).catch((error: unknown) => {
        throw new Error(describeModel3dFailure(error, modelLabel))
      })

      return await saveAndReport(generated, modelLabel, args, ctx)
    }
  })
}

/**
 * 把一次生成的产物落盘并汇报。**正常生成和续跑共用这一段** ——
 * 两条路唯一的区别是钱扣没扣，其余（下载、分网格、写素材库、措辞）完全一样。
 *
 * 地址有时效，而且各家差得离谱：**Tripo 只有 5 分钟**，Rodin / Meshy 是小时级。
 * 所以拿到就顺序下完，不能「先存地址、回头再下」。
 *
 * 存盘失败**不算整次失败** —— 钱已经花了，至少要把还没过期的地址交出去。
 */
async function saveAndReport(
  generated: { files: { url: string; name: string }[]; job: Model3dJob },
  modelLabel: string,
  args: { name?: string; prompt?: string },
  ctx: { report: (payload: { text: string }) => void }
): Promise<{
  text: string
  images?: { data: string; mimeType: string }[]
  details: Generated3dModelDetails
}> {
  const prompt = String(args.prompt ?? '').trim()
  const token = encodeModel3dJob(generated.job)
  const baseName = baseNameOf(args.name, prompt, token)
  const meshPaths: string[] = []
  const extraPaths: string[] = []
  /** 塞进模型上下文的那张预览图。只取第一张 —— 多塞几张纯烧 token */
  let previewForContext: { data: string; mimeType: string } | undefined
  const assetKeys: string[] = []
  const saveErrors: string[] = []

  for (const file of generated.files) {
    const isMesh = MESH_EXTENSION.test(file.name)
    const saved = await downloadAndSaveAIGCAsset(file.url, 'model', {
      suggestedName: isMesh ? baseName : `${baseName}_${file.name}`,
      defaultExt: extensionOf(file.name) || '.glb',
      // 网格 + 4K 贴图几十兆很常见
      timeout: 300_000,
      prompt
    })
    if (saved.success && saved.localPath) {
      ;(isMesh ? meshPaths : extraPaths).push(saved.localPath)
      if (saved.assetKey) assetKeys.push(saved.assetKey)
      // 读回来压一压进上下文，好让模型至少看得见「生成的是个什么东西」
      if (!previewForContext && !isMesh && PREVIEW_EXTENSION.test(file.name)) {
        previewForContext = await fs
          .readFile(saved.localPath)
          .then((bytes) => compressForContext(bytes))
          .then((image) => image ?? undefined)
          .catch(() => undefined)
      }
    } else if (saved.error) {
      saveErrors.push(saved.error)
    }
  }

  const lines = [`用 ${modelLabel} 完成（任务号 ${token}）。`]
  if (meshPaths[0]) {
    lines.push(`网格已存进素材库 AIGC/模型：${meshPaths[0]}`)
    lines.push('用户可以在对话窗口里转着看。要进工程就把这个路径交给 ue_content_import。')
  } else {
    lines.push(
      '没有拿到网格文件。厂商返回的地址是：' +
        generated.files.map((file) => `${file.name} → ${file.url}`).join('；') +
        ' —— **很快就会失效**（Tripo 只有 5 分钟），请用户立刻另存。'
    )
  }
  if (extraPaths.length > 0) lines.push(`另存了 ${extraPaths.length} 个附属文件（贴图等）。`)
  if (saveErrors.length > 0) lines.push(`有 ${saveErrors.length} 个文件没存下来：${saveErrors[0]}`)
  if (generated.job.cost !== null) lines.push(`本次扣了 ${generated.job.cost} 额度。`)
  // 任务号也说给用户听：万一后面存盘/网络又出问题，他手上得有这个号
  lines.push(`任务号 ${token} —— 万一后续出问题，用它可以直接取回结果，不用重新生成。`)
  lines.push(
    previewForContext
      ? '下面附了厂商渲的一张预览图 —— 只能看出**主体、风格、大致形状**对不对。' +
          '拓扑、面数、朝向、有没有穿模、尺寸，这张图上一样都看不出来，' +
          '那些仍然要用户自己在预览器里转一圈。'
      : '这个模型你看不到 —— 拓扑、朝向、有没有穿模要用户自己在预览里看。'
  )
  ctx.report({ text: `已取回 ${generated.files.length} 个文件` })

  return {
    text: lines.join('\n'),
    // 网格进不了上下文，但厂商附的那张预览渲染图可以
    ...(previewForContext ? { images: [previewForContext] } : {}),
    details: {
      success: true,
      model: modelLabel,
      job_id: token,
      ...(meshPaths[0] ? { model_path: meshPaths[0] } : {}),
      extra_paths: extraPaths,
      asset_keys: assetKeys,
      cost: generated.job.cost,
      ...(saveErrors[0] ? { save_error: saveErrors[0] } : {})
    }
  }
}

/** 这次到底用的是哪个模型。各家出的东西差别极大，用户要靠它判断值不值 */
function describeBoundModel3d(settings: AiProviderSettings, chosen?: { label: string }): string {
  if (chosen) return chosen.label
  const binding = settings.roles.model3d
  if (!binding) return '绑定的 3D 模型'
  const provider = settings.providers.find((item) => item.id === binding.providerId)
  return provider ? `${provider.displayName}:${binding.modelId}` : binding.modelId
}

/**
 * 失败时补上「够不够排查」。
 *
 * 与视频同一条理由：提交之后的失败额度已经扣了，而模型默认会建议重试。
 * 另外 3D 这边多一类特有的失败 —— **参数组合这家不支持**（要 glb 却设了
 * Tripo 的四边面、给了 Tripo 包围盒）。那种错重试一百次都是同一个结果，
 * 要改的是参数，不是运气。
 */
function describeModel3dFailure(error: unknown, modelLabel: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const parts = [raw]

  if (/不支持/.test(raw)) {
    parts.push(
      '这是**参数组合**的问题，不是运气问题 —— 原样重试是同一个结果。' +
        '按上面那句提示改参数，或者换一家（各家支持的参数不同）。'
    )
  } else if (/任务已经提交成功/.test(raw)) {
    /*
     * 真机上踩过的一次：连着三次「fetch failed」，模型自己判断成「网络抖动，
     * 没真正开始计费」，然后重试了三遍 —— 而每一次都是一次真实提交。
     * 这一支存在就是为了不让它再那么猜。
     */
    parts.push(
      '**不要重新提交**。这不是「没跑成功」，是「跑了但查不到」—— 重新提交等于' +
        '再付一次全款。把上面那个任务号告诉用户，让他去厂商控制台看结果。'
    )
  } else if (/连了 \d+ 次都没连上|fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(raw)) {
    parts.push(
      '这是**网络层**的问题（连不上厂商），不是提示词或参数的问题 —— 改参数没有用。' +
        '如果是在提交那一步断的，钱没扣；如果已经提交出去了，上面会带任务号。' +
        '**先问用户网络/代理是否正常，不要连着重试** —— 每次重试都可能是一次真实提交。'
    )
  } else if (/任务失败|超过 \d+ 秒/.test(raw)) {
    parts.push(
      '注意：任务已经提交出去了，**额度多半已经扣掉**。' +
        '不要直接重试 —— 先把原因告诉用户，由他决定要不要再花一次钱。'
    )
  }
  if (/没有指定 3D 接口形状|还没有配置/.test(raw)) {
    parts.push(`当前用的是 ${modelLabel}。这是配置问题，重试没有意义。`)
  }
  return parts.join('\n')
}

/** 从厂商给的文件名里取扩展名，带上点 */
function extensionOf(fileName: string): string {
  const match = fileName.match(/(\.[a-z0-9]+)$/i)
  return match ? match[1].toLowerCase() : ''
}

/** 文件名：用户给了就用，否则从提示词头部截一段 */
function baseNameOf(name: string | undefined, prompt: string, jobToken?: string): string {
  const explicit = String(name ?? '').trim()
  if (explicit) return explicit.slice(0, NAME_MAX_LENGTH)

  const fromPrompt = prompt.trim().slice(0, NAME_MAX_LENGTH)
  if (fromPrompt) return fromPrompt

  /*
   * 续跑没有提示词，落到这里。
   *
   * 原来这一支直接返回 'model' —— 真机上一次取回 5 个任务，结果全叫
   * `model.glb` / `model_1.fbx` / `model_2.fbx`，**名字和内容对不上号**，
   * 用户拿到一堆分不清谁是谁的文件。用任务号当名字至少是唯一的、而且
   * 能对回厂商控制台那一条。
   */
  const fromJob = String(jobToken ?? '')
    .trim()
    // 冒号和波浪号进不了文件名
    .replace(/[:~]/g, '_')
    .slice(0, NAME_MAX_LENGTH)
  return fromJob || 'model'
}

/**
 * 绑的是套餐时的入参表：摘掉 Tripo 那一组，换上清单 `options` 列了的套餐开关；
 * `bounding_box` / `rest_pose` 没列也摘掉。类型上仍按全量算，理由同 createGenerate3dModelTool 里那次 `as`。
 */
function planInput(options: string[]): typeof Generate3dModelInput {
  const drop: Record<string, true> = { ...TRIPO_ONLY_KEYS }
  for (const key of PLAN_GENERAL_OPTION_KEYS) if (!options.includes(key)) drop[key] = true
  const add = Object.fromEntries(
    Object.entries(PLAN_OPTION_FIELDS).filter(([key]) => options.includes(key))
  )
  return Generate3dModelInput.omit(drop as never).extend(
    add
  ) as unknown as typeof Generate3dModelInput
}
