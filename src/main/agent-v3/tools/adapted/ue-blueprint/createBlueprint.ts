/**
 * Create Blueprint tool
 * Sends blueprint.create command to UE plugin over WebSocket.
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/** UE 侧失败响应的字段。历史原因不统一，四种都可能出现 */
type RpcFailureShape =
  | {
      ok?: boolean
      success?: boolean
      __rpc?: { code?: string | number }
      code?: string | number
      error?: string
      message?: string
      details?: unknown
    }
  | null
  | undefined

const ComponentSchema = z.object({
  component_type: z.string().describe('Component class name, e.g. StaticMeshComponent'),
  component_name: z.string().optional().describe('Component name'),
  attach_to: z.string().optional().describe('Parent component name, default root'),
  location: z
    .object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional()
    })
    .optional()
    .describe('Relative location'),
  rotation: z
    .object({
      pitch: z.number().optional(),
      yaw: z.number().optional(),
      roll: z.number().optional()
    })
    .optional()
    .describe('Relative rotation'),
  scale: z
    .object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional()
    })
    .optional()
    .describe('Relative scale'),
  properties: z.unknown().optional().describe('Component property map')
})

const CreateBlueprintSchema = z.object({
  name: z.string().describe('Blueprint name (required)'),
  parent_class: z
    .string()
    .optional()
    .default('Actor')
    .describe('Parent class, e.g. Actor/Pawn/Character, default Actor'),
  folder: z.string().optional().describe('Target folder, e.g. /Game/Blueprints'),
  components: z.array(ComponentSchema).optional().describe('Optional components to add')
})

interface CreateBlueprintResponse {
  ok: boolean
  name: string
  path: string
  parent_class: string
  generated_class: string
  saved: boolean
  components: Array<{
    name: string
    class: string
    attach_to: string
  }>
  warnings: string[]
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createBlueprintTool() {
  return defineV2Tool({
    description: `在虚幻引擎中创建一个新的蓝图资产。
- 支持指定父类（Actor/Pawn/Character）
- 支持创建时附带组件列表
- 返回蓝图路径、生成类、组件列表等信息`,

    inputSchema: CreateBlueprintSchema,

    execute: async (input) => {
      console.log('[CreateBlueprintTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const params: Record<string, unknown> = { name: input.name }
        if (input.parent_class) params.parent_class = input.parent_class
        if (input.folder) params.folder = input.folder
        if (input.components) params.components = input.components

        console.log('[CreateBlueprintTool] 发送 blueprint.create 请求:', params)

        const response = await wsService.callRequest<CreateBlueprintResponse>(
          'blueprint.create',
          params,
          getTargetConnectionId(),
          30000
        )

        console.log('[CreateBlueprintTool] 收到响应:', {
          hasResponse: !!response,
          ok: response?.ok,
          code: (response as RpcFailureShape)?.__rpc?.code ?? (response as RpcFailureShape)?.code
        })

        if (response && response.ok) {
          const componentNames = response.components?.map((c) => c.name) || []
          return {
            success: true,
            name: response.name,
            blueprint_path: response.path,
            path: response.path,
            parent_class: response.parent_class,
            generated_class: response.generated_class,
            saved: response.saved,
            components: response.components,
            component_count: response.components?.length || 0,
            warnings: response.warnings,
            blueprintState: {
              components: componentNames,
              componentCount: componentNames.length,
              hasDefaultSceneRoot: componentNames.includes('DefaultSceneRoot')
            },
            note:
              componentNames.length <= 1
                ? '蓝图当前仅有默认组件。如需添加其它组件，请继续调用 blueprint.add_component。'
                : undefined,
            message: `蓝图 "${response.name}" 创建成功，路径: ${response.path}`
          }
        }

        const msg =
          (response as RpcFailureShape)?.error ||
          (response as RpcFailureShape)?.message ||
          '无响应或 ok=false'

        const code =
          (response as RpcFailureShape)?.__rpc?.code ?? (response as RpcFailureShape)?.code

        const details = (response as RpcFailureShape)?.details

        const duplicatePattern = /(already\s+exists|已存在|同名|重名|duplicate)/i
        if (typeof msg === 'string' && duplicatePattern.test(msg)) {
          const detailObj =
            details && typeof details === 'object'
              ? (details as Record<string, unknown>)
              : undefined
          const detailPath =
            (typeof detailObj?.path === 'string' && detailObj.path) ||
            (typeof detailObj?.asset_path === 'string' && detailObj.asset_path) ||
            (typeof detailObj?.blueprint_path === 'string' && detailObj.blueprint_path)
          const fallbackPath =
            input.folder && input.folder.trim()
              ? `${input.folder.replace(/\/+$/, '')}/${input.name}`
              : undefined
          const existingPath = detailPath || fallbackPath

          return {
            // Treat duplicate-create as reusable success so downstream can continue with add_component.
            success: true,
            nonFatal: true,
            duplicate: true,
            reusable: true,
            reused: true,
            created: false,
            code: code ?? 409,
            error: undefined,
            name: input.name,
            blueprint_path: existingPath,
            path: existingPath,
            parent_class: input.parent_class || 'Actor',
            message: `蓝图 "${input.name}" 已存在${existingPath ? `（路径: ${existingPath}）` : ''}，已复用现有资产并继续后续步骤。`,
            suggestion:
              '不要再次调用 blueprint.create；请改为调用 blueprint.add_component / blueprint.set_property / blueprint.compile。'
          }
        }

        return {
          success: false,
          error: `创建蓝图失败: ${msg}`,
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[CreateBlueprintTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
