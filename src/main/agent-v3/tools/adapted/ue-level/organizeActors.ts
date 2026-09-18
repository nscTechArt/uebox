import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import {
  describeUnmatchedTargets,
  unmatchedTargetFields,
  type UnmatchedTargetsResponse
} from '../../unmatchedTargets'
/**
 * Property Match Rule Schema - 属性匹配规则
 */
const PropertyMatchRuleSchema = z.object({
  name: z.string().describe('属性名（如 StaticMesh, Material）'),
  value: z.string().describe('期望值（模糊包含匹配，忽略大小写）')
})

/**
 * Filter Schema - Actor过滤条件（与actor.get的filter格式相同）
 */
const FilterSchema = z.object({
  class: z.string().optional().describe('类名包含匹配（模糊，忽略大小写）'),
  name_pattern: z.string().optional().describe('名称通配符匹配（Wildcard，如 *_Debug_*）'),
  exclude_classes: z
    .array(z.string())
    .optional()
    .describe('排除的类名数组（全等匹配，忽略大小写）'),
  property_match: z
    .array(PropertyMatchRuleSchema)
    .optional()
    .describe('属性匹配规则数组。用于按资产/属性值过滤（如 StaticMesh=Cube）')
})

/**
 * Organize Actors 请求参数
 */
export const OrganizeActorsParamsSchema = z.object({
  folder_path: z.string().describe('目标文件夹路径（如 "Lighting/Indoor"）'),
  filter: FilterSchema.optional().describe('Actor过滤条件（与actor.get的filter格式相同）'),
  class: z.string().optional().describe('简化用法：直接传类名（如 "PointLight"）')
})

interface ActorResult {
  name: string
  class: string
  path: string
  folder_path: string
}

interface OrganizeActorsResponse extends UnmatchedTargetsResponse {
  count: number
  total_found: number
  actors: ActorResult[]
}

export function createOrganizeActorsTool(): V2Tool {
  return defineV2Tool({
    description:
      '批量将场景中的Actor移动到指定的世界大纲文件夹（Outliner文件夹）。支持按类名过滤（如PointLight、SpotLight、StaticMeshActor等）。用于场景整理和组织Actor到文件夹。操作支持撤销（Ctrl+Z）。' +
      '【和 ue_set_property 的分工】那个也能设 FolderPath（targets.filter + properties: { FolderPath }），两个都是一次调用一个撤销组。' +
      '差别只有一条：本工具在 PIE 跑着的时候会**拒绝**——大纲文件夹是编辑器世界的东西，PIE 世界里根本没有，' +
      '那时候设了也只是改一份跑完就没的副本。整理大纲用本工具；顺手改别的属性时一起把 FolderPath 也改了，用 ue_set_property。' +
      '关键词：移动Actor到文件夹、归类Actor、组织Actor、设置文件夹路径、FolderPath。',
    inputSchema: OrganizeActorsParamsSchema,
    execute: async (input) => {
      console.log('[OrganizeActorsTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 构建请求参数
        const params: {
          folder_path: string
          filter?: {
            class?: string
            name_pattern?: string
            exclude_classes?: string[]
            property_match?: Array<{ name: string; value: string }>
          }
          class?: string
        } = {
          folder_path: input.folder_path
        }

        // 如果提供了filter，使用filter；否则如果提供了class，转换为filter
        if (input.filter) {
          params.filter = input.filter
        } else if (input.class) {
          // 简化用法：将class转换为filter格式
          params.filter = {
            class: input.class
          }
        }

        const response = await wsService.callRequest<OrganizeActorsResponse>(
          'level.organize_actors',
          params,
          getTargetConnectionId(),
          60000
        )

        console.log('[OrganizeActorsTool] 收到响应:', response)

        if (response) {
          // RPC 错误响应透传
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '组织Actor失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details
            return {
              success: false,
              error: `组织Actor到文件夹失败：${msg}`,
              code,
              details,
              raw: response
            }
          }

          const count = response.count ?? 0
          const totalFound = response.total_found ?? count

          return {
            success: true,
            count,
            total_found: totalFound,
            actors: response.actors || [],
            ...unmatchedTargetFields(response),
            message:
              `成功将 ${count} 个Actor归类到文件夹 "${input.folder_path}"。` +
              describeUnmatchedTargets(response)
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[OrganizeActorsTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
