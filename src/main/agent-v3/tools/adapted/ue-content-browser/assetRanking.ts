/**
 * 全工程资源占用排行。
 *
 * ## 它和 ue_content_audit_optimization 不是一回事
 *
 * 那个回「整体什么状况」：Nanite 启用率多少、有几张大贴图、总共估算多少内存。
 * 都是**汇总数**，用户拿着一句「有 4 张 4K 贴图」没法干活 ——
 * 他还得自己去几千个资产里找是哪四张。
 *
 * 这个回「具体是哪几个」，逐条列，可按磁盘占用 / 面数 / 贴图内存排序。
 *
 * ## 为什么它快
 *
 * 数据来自资产注册表的标签（保存资产时写进 uasset 头里的）和包文件的磁盘字节数，
 * **一个资产都不加载**。audit_optimization 是逐个 `GetAsset()` 加载的，
 * 一万个资产的工程要跑几分钟、还会把整个工程拽进内存。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { humanBytes } from './formatBytes'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const AssetRankingSchema = z.object({
  path: z
    .string()
    .optional()
    .default('/Game')
    .describe('限定目录，默认 /Game（整个工程的用户资产）。传 /Game/Characters 就只看那一块'),
  class_filter: z
    .string()
    .optional()
    .describe(
      '只看某一类资产，如 StaticMesh、SkeletalMesh、Texture2D、Material、SoundWave。' +
        '不传就是全部类型混排'
    ),
  sort_by: z
    .enum(['DiskSize', 'Triangles', 'Vertices', 'TextureMemory'])
    .optional()
    .default('DiskSize')
    .describe('排序依据，默认 DiskSize（磁盘占用）'),
  limit: z.number().optional().default(30).describe('返回多少条，默认 30，最多 200')
})

interface RankedAsset {
  name: string
  path: string
  class: string
  disk_size: number
  stats?: {
    triangles?: number
    vertices?: number
    lod_count?: number
    nanite?: boolean
    width?: number
    height?: number
    format?: string
    texture_bytes?: number
  }
}

interface AssetRankingResponse {
  ok?: boolean
  scanned?: number
  returned?: number
  total_disk_size?: number
  truncated?: boolean
  scope_path?: string
  assets?: RankedAsset[]
  by_class?: Record<string, { count: number; disk_size: number }>
  notes?: string[]
}

/**
 * 哪几类资产占了大头。
 *
 * 逐个资产的排行前面要先有这一句 —— 「贴图占了工程的 68%」比
 * 「最大的那张贴图是 12MB」更早决定该往哪看。
 */
function topClasses(byClass: Record<string, { count: number; disk_size: number }>): string {
  const entries = Object.entries(byClass)
    .sort((a, b) => b[1].disk_size - a[1].disk_size)
    .slice(0, 5)
  if (entries.length === 0) return ''
  return entries.map(([name, v]) => `${name} ${v.count} 个 / ${humanBytes(v.disk_size)}`).join('，')
}

export function createAssetRankingTool(): V2Tool {
  return defineV2Tool({
    description: `**整个工程**里哪些资产最占地方 —— 逐条列出来，可按磁盘占用、面数、贴图内存排序。

【回答的问题】"这个工程什么最占空间"、"最大的十张贴图是哪些"、"面数最高的模型"、
"哪个文件夹最沉"（配合 path 参数）。

【和另外三个性能工具的分工】
- 想知道**当前关卡**里哪几个网格最贵（含实例数）→ ue_find_heavy_assets
- 想知道整体配置好不好（Nanite/Lumen 启用率）→ ue_content_audit_optimization
- 想知道某一个资产**连同依赖**一共多大 → ue_asset_size_map
- 想要一份**全工程资产占用排行** → 就是本工具

【为什么它快】不加载任何资产，只读资产注册表里的标签和包文件大小。
可以放心对整个 /Game 跑。

【参数】
- path: 限定目录，默认 /Game
- class_filter: StaticMesh / SkeletalMesh / Texture2D / Material / SoundWave …
- sort_by: DiskSize（默认）| Triangles | Vertices | TextureMemory
- limit: 默认 30

【读结果时注意】
- \`disk_size\` 是**磁盘上压缩过的编辑器包体**，不是运行时内存。
  Nanite 网格和 BC7 贴图加载后都会膨胀得多，两个数不能互相代替。
- 标签是**保存资产时**写进去的。用老引擎存过、之后没再存的资产可能没有
  triangles / nanite 这些字段 —— 字段**不出现**表示没这个标签，
  不表示这个值是 0。别把缺失当成零去下结论。
- \`by_class\` 是按类型的汇总，先看它再看逐条排行。`,
    inputSchema: AssetRankingSchema,
    // 每个例子都写满：schema 里带默认值的字段在输出类型里是必填的，
    // 省一个就类型不过 —— 而且模型照着不完整的例子学，也容易漏参数
    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const response = await wsService.callRequest<AssetRankingResponse>(
          'content.asset_ranking',
          input,
          getTargetConnectionId(),
          120000
        )

        if (!response) {
          return { success: false, error: '服务未返回有效数据' }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failed = (response as any)?.ok === false || (response as any)?.success === false
        if (failed) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = (response as any)?.error || (response as any)?.message || '排行查询失败'
          return {
            success: false,
            error: `资产排行失败：${msg}`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            code: (response as any)?.__rpc?.code ?? (response as any)?.code
          }
        }

        const assets = response.assets ?? []
        const classSummary = topClasses(response.by_class ?? {})

        return {
          success: true,
          scanned: response.scanned,
          returned: assets.length,
          truncated: response.truncated,
          scope_path: response.scope_path,
          total_disk_size: response.total_disk_size,
          total_disk_size_human: humanBytes(response.total_disk_size ?? 0),
          by_class: response.by_class,
          assets: assets.map((a) => ({ ...a, disk_size_human: humanBytes(a.disk_size) })),
          notes: response.notes,
          summary:
            `扫了 ${response.scanned ?? 0} 个资产（${response.scope_path ?? input.path}），` +
            `共 ${humanBytes(response.total_disk_size ?? 0)}` +
            (classSummary ? `。占大头的：${classSummary}` : '') +
            (response.truncated ? `。只返回了前 ${assets.length} 条` : '')
        }
      } catch (error) {
        console.error('[AssetRankingTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
