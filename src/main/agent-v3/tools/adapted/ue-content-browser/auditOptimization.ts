/**
 * 资产优化审计工具
 * 通过 WebSocket 向虚幻引擎插件发送资产审计命令
 * 检测 Nanite、Lumen 等功能的使用情况，提供优化建议
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
 * 资产审计请求参数
 */
const AuditOptimizationSchema = z.object({
  check_type: z
    .enum(['NaniteUsage', 'LumenMaterials', 'TextureSize', 'All'])
    .optional()
    .default('All')
    .describe(
      '检查类型：NaniteUsage（Nanite使用情况）、LumenMaterials（Lumen材质）、TextureSize（纹理大小）、All（全部）'
    )
})

// ============================================================================
// 类型定义
// ============================================================================

/** 资产审计响应数据 */
interface AuditOptimizationResponse {
  nanite_usage?: {
    enabled_in_config: boolean
    mesh_count: number
    meshes_with_nanite: number
    suggestion?: string
  }
  lumen_usage?: {
    enabled_in_config: boolean
    using_lumen_gi: boolean
    materials_with_emissive: number
    suggestion?: string
  }
  texture_analysis?: {
    total_textures: number
    large_textures_4k: number
    estimated_memory_bytes: number
    estimated_memory_mb: number
    suggestion?: string
  }
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建资产优化审计工具
 * @returns 资产优化审计工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createAuditOptimizationTool() {
  return defineV2Tool({
    description: `盘点**整个项目的配置和资产规模** —— Nanite / Lumen 启用率、纹理尺寸分布。

【Nanite / Lumen 这两项和 ue_get_project_info 问的不是一件事】
那边的 naniteEnabled 是工程设置里的开关（读 ini），本工具数的是**真的带 Nanite 数据的网格有几个**。
"开了开关但一个模型都没用"是常见状态，两个数字不一致不是矛盾。

【和另外三个性能工具的分工】
- 想知道**整个工程**哪几个资产占地方（逐条列出、可排序）→ ue_project_asset_ranking
- 想知道**当前关卡**里哪几个网格最贵（含实例数）→ ue_find_heavy_assets
- 想知道此刻跑得快不快（帧率、线程耗时）→ ue_get_performance_stats
- 想要一份项目级的配置体检 → 就是本工具

【注意它比上面几个慢】本工具会逐个加载资产来读设置，大工程要跑上几分钟。
只是想知道「哪些资产大」的话，用 ue_project_asset_ranking —— 那个读注册表标签，不加载。

【功能说明】：
- 检测 Nanite 使用情况：检查配置是否启用，扫描所有 StaticMesh 资产统计启用 Nanite 的网格数量
- 检测 Lumen 使用情况：检查配置是否启用，扫描材质资产统计使用自发光的材质数量
- 分析纹理大小：统计所有纹理的数量和大小，识别 4K 或更大的纹理

【参数说明】：
- check_type: 检查类型（可选，默认 All）
  - NaniteUsage: 仅检测 Nanite 使用情况
  - LumenMaterials: 仅检测 Lumen 材质使用情况
  - TextureSize: 仅分析纹理大小
  - All: 执行所有检查（默认）

【返回数据】：
- nanite_usage: Nanite 使用情况（如果检查）
- lumen_usage: Lumen 使用情况（如果检查）
- texture_analysis: 纹理分析（如果检查）

【优化建议示例】：
- Nanite 未使用：建议关闭以减小包体和提升构建速度
- Lumen 已启用但材质较少使用自发光：可以考虑禁用 Lumen
- 大纹理过多：建议压缩或降低分辨率

【注意事项】：
- 资产扫描操作可能需要较长时间，建议在项目资产加载完成后执行
- 仅在 UE 5.0+ 支持 Nanite 和 Lumen 检测`,

    inputSchema: AuditOptimizationSchema,

    execute: async ({ check_type = 'All' }) => {
      console.log('[AuditOptimizationTool] 收到请求:', { check_type })

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const response = await wsService.callRequest<AuditOptimizationResponse>(
          'content.audit_optimization',
          { check_type },
          getTargetConnectionId(),
          30000 // 资产扫描可能需要较长时间，设置30秒超时
        )

        console.log('[AuditOptimizationTool] 收到响应:', response ? '成功' : '无数据')

        if (response) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '资产审计失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            return {
              success: false,
              error: `资产审计失败：${msg}`,
              code
            }
          }

          const suggestions: string[] = []
          if (response.nanite_usage?.suggestion) {
            suggestions.push(`[Nanite] ${response.nanite_usage.suggestion}`)
          }
          if (response.lumen_usage?.suggestion) {
            suggestions.push(`[Lumen] ${response.lumen_usage.suggestion}`)
          }
          if (response.texture_analysis?.suggestion) {
            suggestions.push(`[纹理] ${response.texture_analysis.suggestion}`)
          }

          return {
            success: true,
            nanite_usage: response.nanite_usage,
            lumen_usage: response.lumen_usage,
            texture_analysis: response.texture_analysis,
            suggestions: suggestions.length > 0 ? suggestions : undefined,
            message: `资产审计完成。${suggestions.length > 0 ? suggestions.join(' ') : '未发现明显优化点。'}`
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[AuditOptimizationTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
