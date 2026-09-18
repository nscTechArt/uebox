/**
 * 导入资产工具
 * 通过 WebSocket 向虚幻引擎插件发送 content.import 命令
 * 将外部文件导入到 UE 项目中
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 导入资产请求参数
 */
const ImportAssetsSchema = z.object({
  files: z
    .array(z.string())
    .describe('外部文件的绝对路径列表，如 ["C:/Downloads/Texture.png", "C:/Downloads/Hero.fbx"]'),
  destination_path: z
    .string()
    .optional()
    .default('/Game/Imported')
    .describe('UE 内部目标文件夹，不存在则自动创建，如 /Game/Imported/Textures'),
  overwrite: z.boolean().optional().default(false).describe('是否覆盖同名文件'),
  /**
   * 插件一直支持，工具这边一直没暴露 —— 于是「这模型导进来小了 100 倍」
   * 只能靠用户自己去引擎里改 Build Scale，或者重新导一次。
   */
  scale: z
    .number()
    .positive()
    .optional()
    .describe(
      '网格导入缩放。不给就按格式默认（OBJ 按 100 放大；glTF/GLB 和 FBX 按 1，' +
        '因为引擎自己已经做过米→厘米）。导进来大小明显不对时给一个明确值，' +
        '如 100 或 0.01。只影响网格，贴图/音频忽略它'
    ),
  /**
   * 内嵌同名贴图互相覆盖 —— FBX/GLB 里的贴图叫 Color/Normal/Roughness 是常态，
   * 两个模型进同一个文件夹，网格会被改名成 _1，贴图不会，第二份被静默跳过，
   * 于是两个模型共用第一份贴图。UV 不同就是一片碎块。
   */
  isolate: z
    .enum(['auto', 'always', 'never'])
    .optional()
    .describe(
      '每个网格文件是否单独放进子文件夹，避免内嵌同名贴图互相覆盖。' +
        'auto（默认，不填就是它）在有风险时才隔离：这批有两个以上网格文件，' +
        '或目标文件夹里已经有东西。always 一律隔离，never 全部平铺（老行为）'
    ),
  /**
   * 落地就叫对名字，不要「先导进来再改名」。
   *
   * 插件一直收这个映射（`normalized_names`），盒子自己的导入管线也一直在用，
   * 只有 agent 这条路没暴露 —— 于是「导进来顺手按规范命名」只能走
   * 导入 → naming_audit → batch_move 三步，还要收拾一遍重定向器。
   * 而这里改名发生在**资产刚建出来、还没有任何引用者**的时候，干净得多。
   */
  asset_names: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      '导入后资产叫什么名字，按源文件指定：{ "Hero.fbx": "SK_Hero", "wood.png": "T_Wood_D" }。' +
        '键写文件名或完整路径都行（扩展名会被忽略），值是**资产名**，不是路径。' +
        '按 Epic 前缀规范起名（SM_/SK_/T_/M_/MI_/BP_…）就不用导完再改名 —— ' +
        '这时候资产还没有引用者，改名不留重定向器。' +
        '目标名已被占用时插件会跳过改名（保留原名），返回里会点出来'
    )
})

// ============================================================================
// 类型定义
// ============================================================================

/**
 * UE 资产名里不能出现的字符。
 *
 * 带这些字符的名字发下去，引擎的 `RenameAssets` 会失败，而插件那边只写一行
 * 日志、照样回 `ok:true` 和原来的名字 —— 调用方以为改好了。本地先拦掉，
 * 报一句能照着改的话，比让它在真机上查一轮日志便宜得多。
 *
 * 点号也在里面：`T_Wood.png` 这种把扩展名一起填进来的写法，引擎会当成
 * `包名.对象名` 的分隔符。
 */
const INVALID_ASSET_NAME = /[/\\:*?"<>|.\s]/

/** 导入结果项 */
interface ImportedItem {
  name: string
  path: string
  class: string
  auto_generated?: boolean // 标记是否为自动生成的资产（如PBR材质）
  reused?: boolean // 这份是工程里本来就有的，不是这次新建的
}

/** 被复用而非新建的资产 —— 主要是同名贴图 */
interface ReusedItem {
  name: string
  path: string
  class: string
  source_file: string
}

/** 隔离到子文件夹的网格文件，及其实际落点 */
interface IsolatedItem {
  file: string
  destination: string
}

/** 导入资产响应数据 (UE 插件返回) */
interface ImportAssetsResponse {
  ok: boolean
  imported_count: number
  requested_count: number
  imported: ImportedItem[]
  isolated?: IsolatedItem[]
  isolate_note?: string
  reused?: ReusedItem[]
  reused_count?: number
  reuse_warning?: string
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建导入资产工具
 * @returns 导入资产工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createImportAssetsTool() {
  return defineV2Tool({
    description: `将外部文件导入到虚幻引擎项目中。

【重要】：此工具仅支持外部格式文件（FBX、PNG、WAV 等）。
不支持 .uasset/.umap 文件！如需导入 .uasset 文件，请使用 project_manage 工具的 import_assets action。

【和 project_manage(import_assets) 的分工：看东西在哪，不是看格式】
- 文件在**磁盘上**、你有路径（用户给的目录、你刚下载的、AI 刚生成的）→ 用本工具
- 资产在**素材库里**、你手上是 search_assets 给的 assetKey → 用 project_manage，
  它两种格式都收（.uasset 直接拷贝并解析依赖，外部格式照样过引擎的导入 API），
  而且只有它会按素材库记录的 softPath 落位
拿着 assetKey 是没法调本工具的（它要的是真实路径），反过来也一样。

【功能说明】：
- 支持导入 FBX、PNG、WAV 等常见格式
- UE 会自动识别文件类型
- 目标目录不存在时自动创建

【参数说明】：
- files: 外部文件绝对路径列表（必填，不可包含 .uasset/.umap）
- destination_path: UE 内部目标目录，默认 /Game/Imported
- overwrite: 是否覆盖同名文件
- scale: 网格导入缩放。不给按格式默认（OBJ ×100，glTF/GLB 和 FBX ×1 —— 后两者
  引擎自己就做了米→厘米，不能再乘一遍）；模型进来大小差一两个数量级时用它，
  别让用户自己去引擎里改
- asset_names: 导入后各叫什么名字，{ "Hero.fbx": "SK_Hero" }
- isolate: 网格是否各进各的子文件夹，默认 auto，正常不用填

【名字在导入时就起对，别导完再改】
用 asset_names 一次到位：{ "hero.fbx": "SK_Hero", "wood_color.png": "T_Wood_D" }。
这时候资产刚建出来、还没有任何引用者，改名**不留重定向器**；等导完再用
ue_content_move 改，引擎要重写引用者、还要再清一轮重定向器。
Epic 前缀：SM_ 静态网格 / SK_ 骨骼网格 / T_ 贴图 / M_ 材质 / MI_ 材质实例 /
BP_ 蓝图（完整表在 ue_content_naming_audit）。
用户没要求规范命名就别自作主张改名 —— 他可能就是按原名找东西。
目标名被占用时插件保留原名，返回里会给 rename_failed 并在 message 里点出来。

【同名贴图这个坑】：
FBX/GLB 里内嵌的贴图常叫 Color / Normal / Roughness / Metallic，AI 生成的模型几乎都这样。
多个这种模型进同一个文件夹时，网格会被引擎改名成 _1 / _2，**贴图不会** —— 后来的同名贴图
被静默跳过，所有模型的材质都连到第一份贴图上。UV 不同的话渲染出来就是碎块和重影。
默认 isolate=auto 已经在有风险时自动分文件夹了。要是返回里出现 reuse_warning，
说明还是复用了旧贴图，**不要当成成功**，按提示重导。

【返回数据】：
- ok: 是否成功
- imported_count: 实际导入数量（包含被复用的那些，别只看这个数）
- imported: 导入的资产信息列表，reused=true 的是复用的旧资产
- isolated / isolate_note: 哪些文件被放进了子文件夹，以及实际落点
- reused / reused_count / reuse_warning: 哪些资产是复用的旧的，不是这次新建的
- rename_failed: asset_names 里没改成的那些（只在有的时候出现）`,

    inputSchema: ImportAssetsSchema,

    execute: async (input) => {
      console.log('[ImportAssetsTool] 收到请求:', input)
      console.log('[ImportAssetsTool] files 类型:', typeof input.files, Array.isArray(input.files))
      console.log('[ImportAssetsTool] files 内容:', JSON.stringify(input.files))

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 确保 files 是数组类型（防止 AI SDK 传入字符串）
        let filesArray: string[]
        if (Array.isArray(input.files)) {
          filesArray = input.files
        } else if (typeof input.files === 'string') {
          // 如果是 JSON 字符串，尝试解析
          try {
            filesArray = JSON.parse(input.files)
            console.log('[ImportAssetsTool] files 是字符串，已解析为数组:', filesArray)
          } catch {
            // 如果不是 JSON 格式，当作单个路径处理
            filesArray = [input.files]
            console.log('[ImportAssetsTool] files 是普通字符串，转为单元素数组')
          }
        } else {
          return {
            success: false,
            error: 'files 参数格式错误，应该是字符串数组'
          }
        }

        // 过滤掉 .uasset/.umap 文件 — 这些不能通过 content.import 导入
        // 应使用 project_manage 工具的 import_assets action（直接复制到 Content 目录）
        const uassetFiles = filesArray.filter((f) => {
          const ext = f.toLowerCase()
          return ext.endsWith('.uasset') || ext.endsWith('.umap')
        })
        if (uassetFiles.length > 0) {
          return {
            success: false,
            error: `.uasset/.umap 文件不能通过此工具导入。请使用 project_manage 工具的 import_assets action，它会自动将 .uasset 文件复制到项目 Content 目录并解析依赖。涉及的文件: ${uassetFiles.join(', ')}`
          }
        }

        // 改名映射：本地先把明显不合法的名字拦掉（理由见 INVALID_ASSET_NAME）
        const nameEntries = Object.entries(input.asset_names ?? {})
        const badNames = nameEntries.filter(([, to]) => !to || INVALID_ASSET_NAME.test(to))
        if (badNames.length > 0) {
          return {
            success: false,
            error:
              `asset_names 里这些是资产名不合法：${badNames.map(([from, to]) => `${from} → "${to}"`).join('、')}。` +
              '资产名不能含 / \\ : * ? " < > | 、点号和空格 —— 只写名字，不要带扩展名和路径' +
              '（要换目录用 destination_path）。'
          }
        }

        // 构建请求参数
        const params: Record<string, unknown> = {
          files: filesArray,
          destination_path: input.destination_path,
          overwrite: input.overwrite,
          ...(typeof input.scale === 'number' ? { scale: input.scale } : {}),
          // 不填就不提 —— 让插件用它的 auto，别在这儿复制一份默认值出来
          ...(input.isolate ? { isolate: input.isolate } : {}),
          ...(nameEntries.length > 0
            ? {
                normalized_names: nameEntries.map(([original, normalized]) => ({
                  original,
                  normalized
                }))
              }
            : {})
        }

        console.log('[ImportAssetsTool] 发送 content.import 请求:', JSON.stringify(params))

        const response = await wsService.callRequest<ImportAssetsResponse>(
          'content.import',
          params,
          getTargetConnectionId(),
          60000 // 导入可能需要较长时间
        )

        console.log('[ImportAssetsTool] 收到响应:', response ? '成功' : '无数据')

        if (response && response.ok) {
          // 「导入成功」这句话不能盖住「贴图是旧的」和「东西不在你以为的目录里」。
          // 模型只读 message 的时候也得看得见这两件事，所以拼进正文，不只挂字段
          const notes: string[] = [
            `成功导入 ${response.imported_count}/${response.requested_count} 个文件`
          ]
          if (response.isolated?.length) {
            const where = response.isolated
              .map((item) => `${item.file} → ${item.destination}`)
              .join('；')
            notes.push(
              `${response.isolated.length} 个网格各自进了子文件夹（避免同名贴图打架）：${where}`
            )
          }
          if (response.reuse_warning) {
            notes.push(`⚠️ ${response.reuse_warning}`)
          }

          // 要的名字到底改上没有，回读一次再说。
          //
          // 插件在目标名已被占用时**跳过改名**（保留原名）、RenameAssets 失败时
          // 只写一行日志，两种情况的响应长得和成功一模一样：imported[] 里是
          // 资产的最终名字，没有「本来想叫什么」。不核对的话，模型接着按
          // 它要的那个名字去引用资产，下一步才发现找不到。
          const renamedAway = nameEntries.filter(
            ([, wanted]) => !response.imported.some((item) => item.name === wanted)
          )
          if (renamedAway.length > 0) {
            notes.push(
              `⚠️ 这些名字没改成：${renamedAway.map(([from, to]) => `${from} → ${to}`).join('、')}。` +
                '多半是目标名已经被占用（插件这时会保留原名）。' +
                `实际落地的名字看 imported[]；要改成别的名字用 ue_content_move。`
            )
          }

          return {
            success: true,
            ...(renamedAway.length > 0
              ? { rename_failed: renamedAway.map(([from, to]) => ({ file: from, wanted: to })) }
              : {}),
            imported_count: response.imported_count,
            requested_count: response.requested_count,
            imported: response.imported,
            ...(response.isolated?.length
              ? { isolated: response.isolated, isolate_note: response.isolate_note }
              : {}),
            ...(response.reused?.length
              ? {
                  reused: response.reused,
                  reused_count: response.reused_count ?? response.reused.length,
                  reuse_warning: response.reuse_warning
                }
              : {}),
            message: notes.join('\n')
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (response as any)?.error || (response as any)?.message || '无响应或 ok=false'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const details = (response as any)?.details
        return {
          success: false,
          error: `导入资产失败：${msg}`,
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[ImportAssetsTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
