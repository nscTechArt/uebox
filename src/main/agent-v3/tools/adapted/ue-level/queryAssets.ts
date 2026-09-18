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

        const response = await wsService.callRequest<QueryAssetsResponse>(
          'level.query_assets',
          input,
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

          return {
            success: true,
            data: {
              ...response,
              assets,
              finding_counts: summarize(assets.flatMap((a) => a.findings))
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
