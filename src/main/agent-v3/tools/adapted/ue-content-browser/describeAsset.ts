/**
 * Describe Asset Tool - 获取资产详情
 * 返回资产的完整信息，包括依赖项和被引用项
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
 * 获取资产详情请求参数
 */
const DescribeAssetSchema = z.object({
  path: z.string().describe('资产路径（UE 路径格式，如 /Game/Meshes/SM_Cube）'),
  include_dependencies: z
    .boolean()
    .optional()
    .default(true)
    .describe('是否包含依赖项列表（该资产引用了哪些资产）'),
  include_referencers: z
    .boolean()
    .optional()
    .default(true)
    .describe('是否包含被引用项列表（哪些资产引用了该资产）')
})

// ============================================================================
// 类型定义
// ============================================================================

/** 依赖/引用资产信息 */
interface AssetReference {
  path: string
  name?: string
  class?: string
}

/** 资产详情响应数据 (UE 插件返回) */
interface DescribeAssetResponse {
  ok: boolean
  name?: string
  path?: string
  class?: string
  package?: string
  package_size_bytes?: number
  dependencies?: AssetReference[]
  dependencies_count?: number
  referencers?: AssetReference[]
  referencers_count?: number
  migration_hint?: string
  message?: string
  /**
   * 按资产类型给的细节：贴图是 width/height/pixel_format/compression/srgb，
   * 静态网格是 triangles_lod0/vertices_lod0/lod_count/material_slots/nanite_enabled。
   * 用户问得最多的正是这些，而依赖/被引用计数答不了。
   */
  details?: Record<string, unknown>
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建获取资产详情工具
 * @returns 获取资产详情工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createDescribeAssetTool() {
  return defineV2Tool({
    description: `获取 UE 资产的详细信息，包括依赖项和被引用项。

【使用场景】：
1. 资产迁移：了解需要一起迁移的所有依赖项
2. 清理分析：找出哪些资产被引用，哪些可以安全删除
3. 依赖检查：检查资产的材质、纹理、网格等依赖关系

【返回信息】：
- name: 资产名称
- path: 资产完整路径
- assetClass: 资产类型（如 StaticMesh, Material, Texture2D）
- packageSizeBytes: 资产包大小
- dependencies: 依赖列表（该资产使用的其他资产）
- dependenciesCount: 依赖数量
- referencers: 被引用列表（使用该资产的其他资产）
- referencersCount: 被引用数量
- migrationHint: 迁移建议

【示例】：
- 查看 SM_Chair 的依赖：path="/Game/Meshes/SM_Chair"
- 检查材质被哪些网格使用：path="/Game/Materials/M_Wood"`,

    inputSchema: DescribeAssetSchema,

    execute: async (input) => {
      console.log('[DescribeAssetTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 构建请求参数
        const params: Record<string, unknown> = {
          path: input.path
        }
        if (input.include_dependencies !== undefined) {
          params.include_dependencies = input.include_dependencies
        }
        if (input.include_referencers !== undefined) {
          params.include_referencers = input.include_referencers
        }

        console.log('[DescribeAssetTool] 发送 content.describe 请求:', params)

        const response = await wsService.callRequest<DescribeAssetResponse>(
          'content.describe',
          params,
          getTargetConnectionId(),
          15000
        )

        console.log(
          '[DescribeAssetTool] 收到响应:',
          response ? JSON.stringify(response).slice(0, 300) : '无数据'
        )

        if (response && response.ok) {
          const depsCount = response.dependencies_count ?? response.dependencies?.length ?? 0
          const refsCount = response.referencers_count ?? response.referencers?.length ?? 0

          return {
            success: true,
            message: `资产 ${response.name} 详情获取成功。依赖: ${depsCount} 个, 被引用: ${refsCount} 个`,
            name: response.name,
            path: response.path,
            assetClass: response.class,
            packagePath: response.package,
            packageSizeBytes: response.package_size_bytes,
            dependencies: response.dependencies,
            dependenciesCount: depsCount,
            referencers: response.referencers,
            referencersCount: refsCount,
            migrationHint: response.migration_hint,
            // 按类型补的细节（贴图的分辨率/格式、静态网格的面数/LOD）。
            // 这一层是白名单式映射，不透传的话引擎侧新加的字段全会被丢掉 ——
            // 「这张贴图多大」这种最常见的问题就答不了。
            ...(response.details ? { details: response.details } : {})
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
          error: `获取资产详情失败：${msg}`,
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[DescribeAssetTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
