import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { classifyAsset, summarize, triangleShares } from './levelFindings'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/**
 * 查询条件。
 *
 * **只列插件真的会拿去筛的。** 这里曾经还有 `min_texture_size` / `max_texture_size` /
 * `shader_complexity_index` / `min_radius` —— 四个都被插件读进了变量，然后一条都
 * 没参与过筛选。后果比不支持更糟：模型传了门槛、拿回一堆没筛过的东西，
 * 然后照着「已经筛过了」的前提往下推。
 */
const QueryAssetsConditionsSchema = z.object({
  min_triangles: z.number().optional().describe('最小三角形数量（单份，不是总量）'),
  min_instances: z.number().optional().describe('最少摆了多少份。找「铺得到处都是」的东西用它'),
  missing_collision: z.boolean().optional().describe('只要缺碰撞体的'),
  nanite_enabled: z.boolean().optional().describe('传 false 只要没开 Nanite 的'),
  shadow_casting: z.boolean().optional().describe('只要开了阴影投射的'),
  class_filter: z.string().optional().describe('Actor 类型筛选（如 StaticMeshActor）')
})

/**
 * 查询范围。
 *
 * **只列插件真正实现了的值。** 原来这里还有 `ContentBrowser`，但插件侧
 * （`UAL_LevelCommands.cpp` 的 `level.query_assets`）只处理 `Level` 和 `Selection`，
 * 其余一律回 400「Scope type not supported yet」。
 *
 * 后果在会话记录里很清楚：这个工具叫「找重资产」，查整个项目才是最自然的用法，
 * 于是模型每次都选 `ContentBrowser`，**7 次调用 7 次失败、一次都没恢复过** ——
 * 错误信息也不说支持哪些值，所以它永远学不会。
 *
 * 现在整个工程的排行有专门的工具（`ue_project_asset_ranking`），
 * 描述里直接把人指过去，比在这里加一个假的枚举值有用。
 */
const QueryAssetsScopeSchema = z.object({
  type: z
    .enum(['Level', 'Selection'])
    .describe('查询范围。Level=当前关卡全部 Actor，Selection=选中的'),
  path: z.string().optional().describe('可选，限制文件夹路径 (例如 /Game/Props)')
})

export const QueryAssetsParamsSchema = z.object({
  scope: QueryAssetsScopeSchema.optional().describe('查询范围设置'),
  conditions: QueryAssetsConditionsSchema.optional().describe('查询条件组合'),
  sort_by: z
    .enum(['TotalTriangles', 'TriangleCount', 'InstanceCount', 'ResourceSize'])
    .optional()
    .describe('排序方式。默认 TotalTriangles（单份面数 × 实例数）'),
  limit: z.number().optional().default(20).describe('返回结果数量限制')
})

/** 开了 Nanite 的那几个单列多少条：只是让模型知道它们在，不是要它去排 */
const NANITE_SIDE_LIMIT = 5

/**
 * 按面数排时把 Nanite 拆出去。
 *
 * Nanite 按屏幕像素挑簇画，原始面数和帧开销基本脱钩。混在一张面数榜里，
 * 开了 Nanite 的大网格会占满前几名、把真正按面数付钱的非 Nanite 网格挤出 limit，
 * 报告头一句就叫用户去优化一个其实不贵的网格。
 *
 * 不拆的情况只有两种：按实例数 / 资源大小排；或者条件在**找问题网格**、拆了会把开 Nanite 的
 * 那几个连同它们的发现一起踢出主榜。条件按插件（UAL_LevelCommands.cpp 的 Handle_QueryAssets）
 * 实际怎么读来分：
 * - nanite_enabled：给了就是它明确要的 Nanite 口径，不管真假都不拆
 * - missing_collision / shadow_casting：插件默认 false，只有 true 才筛 —— true 不拆，false 等于没给
 * - min_triangles / min_instances / class_filter：门槛或范围，不是在找毛病，照拆。
 *   描述里自己的例子就是 { min_triangles: 100000 }，这时更该把 Nanite 拿出去
 */
export function shouldSplitByNanite(input: z.infer<typeof QueryAssetsParamsSchema>): boolean {
  const triangleSort =
    input.sort_by === undefined ||
    input.sort_by === 'TotalTriangles' ||
    input.sort_by === 'TriangleCount'
  const c = input.conditions ?? {}
  const huntingProblems =
    c.nanite_enabled !== undefined || c.missing_collision === true || c.shadow_casting === true
  return triangleSort && !huntingProblems
}

interface AssetStat {
  triangles?: number
  total_triangles?: number
  instance_count?: number
  nanite?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

interface AssetResult {
  name: string
  path: string
  type: string
  stats: AssetStat
  sample_actors?: string[]
  suggestion?: string
}

interface QueryAssetsResponse {
  count: number
  matched_assets?: number
  actors_visited?: number
  truncated?: boolean
  assets: AssetResult[]
  not_ranked_by_class?: Record<string, number>
}

export function createQueryAssetsTool(): V2Tool {
  return defineV2Tool({
    description: `按开销特征找出**当前关卡里哪几个网格最贵** —— 总面数、实例数、缺碰撞、没开 Nanite、贴图大小。

【回答的问题】"这张关卡里什么最费"、"哪个模型摆得到处都是"、"谁没有碰撞体"。
**按资产聚合**，不是一个 Actor 一行：同一个网格摆 500 份是一条记录，
写着「摆了 500 份、总共 198 万面」，而不是 500 行重复的「3968 面」。

【和另外三个性能工具的分工】
- 想知道**整个工程**哪些资产占地方（任意类型，含贴图）→ ue_project_asset_ranking
- 想知道**当前跑得快不快**（帧率、各线程耗时）→ ue_get_performance_stats
- 想知道**整个项目配置得好不好**（Nanite/Lumen 启用率概览）→ ue_content_audit_optimization
- 想知道**这张关卡该改哪几个网格** → 就是本工具

【参数】
- scope: { type: 'Level' | 'Selection', path? } 查哪一批（只看**当前关卡里的** Actor）
- conditions: 门槛组合，如 { min_triangles: 100000, missing_collision: true }
- sort_by: TotalTriangles（默认）| TriangleCount | InstanceCount | ResourceSize
- limit: 默认 20

按面数排时主榜只排没开 Nanite 的，开了的另列 nanite_assets（见 ranking_note）。
给了 nanite_enabled，或 missing_collision / shadow_casting 为 true 时不拆，按原样一张榜。

【读结果时注意三件事】
1. \`not_ranked_by_class\` 是**没进排行**的 Actor 类型计数（灯光、骨骼网格、贴花）。
   它们有开销，但没有和三角形可比的指标，所以只报数量不排名 ——
   要逐个看它们，用 ue_project_asset_ranking 按类型查。
2. \`resource_bytes\` 是引擎估算的常驻资源大小，**不是磁盘文件大小**。
3. 贴图数据（max_texture_edge / texture_bytes）只对返回的这几个算 ——
   算贴图要走材质，全关卡算一遍太慢。所以没有按贴图内存排序这个选项，
   要那个用 ue_project_asset_ranking。`,
    inputSchema: QueryAssetsParamsSchema,
    execute: async (input) => {
      console.log('[QueryAssetsTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const split = shouldSplitByNanite(input)
        const response = await wsService.callRequest<QueryAssetsResponse>(
          'level.query_assets',
          split ? { ...input, conditions: { ...input.conditions, nanite_enabled: false } } : input,
          getTargetConnectionId(),
          60000
        )

        console.log('[QueryAssetsTool] 收到响应:', response)

        if (response) {
          // RPC 错误响应透传
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '查询失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details
            return {
              success: false,
              error: `查询关卡资产失败：${msg}`,
              code,
              details,
              raw: response
            }
          }

          // 统计量本身判不了轻重。在这里翻成稳定的 code + 严重度，
          // 调用方才有「先看哪几个」的依据。
          const minTriangles = input.conditions?.min_triangles
          const raw = response.assets ?? []
          const shares = triangleShares(raw)
          const assets = raw.map((a, index) => ({
            ...a,
            findings: classifyAsset(a.stats, a.suggestion, minTriangles, shares[index])
          }))

          // 开了 Nanite 的单独查一次、单独列。查不到就不列，不影响主榜。
          // 只要 Nanite 得用 nanite_only（nanite_enabled: true 只是「不排除」）。旧插件不认它、
          // 会回整体前 N 名 —— 下面按 stats.nanite 再滤一遍兜底，结果对、只是可能偏少
          let naniteAssets: AssetResult[] | undefined
          if (split) {
            const side = await wsService
              .callRequest<QueryAssetsResponse>(
                'level.query_assets',
                {
                  ...input,
                  conditions: { ...input.conditions, nanite_only: true },
                  limit: Math.min(NANITE_SIDE_LIMIT, input.limit ?? NANITE_SIDE_LIMIT)
                },
                getTargetConnectionId(),
                60000
              )
              .catch(() => undefined)
            naniteAssets = (side?.assets ?? []).filter((a) => a.stats?.nanite === true)
          }

          return {
            success: true,
            data: {
              ...response,
              assets,
              finding_counts: summarize(assets.flatMap((a) => a.findings)),
              ...(split
                ? {
                    ranking_note:
                      '面数榜只排没开 Nanite 的网格：Nanite 的帧开销不跟面数走。' +
                      '开了 Nanite 的面数最高几个列在 nanite_assets，要查它们看材质有没有遮罩、半透明或 WPO。',
                    nanite_assets: naniteAssets
                  }
                : {})
            }
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[QueryAssetsTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
