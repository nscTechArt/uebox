/**
 * Create Blueprint tool
 * Sends blueprint.create command to UE plugin over WebSocket.
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { withPartialHeadline, type PartialFailure } from '../../partialResult'

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
  /** saved 为 false 时插件给的说明 */
  save_warning?: string
  components: Array<{
    name: string
    class: string
    attach_to: string
  }>
  /** 没写进去的组件属性、没挂到要求位置的组件。旧版插件可能不带 */
  warnings?: string[]
}

/** 同名蓝图已存在时读回来的实际状态（blueprint.describe 的子集） */
interface ExistingBlueprintInfo {
  ok?: boolean
  name?: string
  path?: string
  parent_class?: string
}

/** 父类名比较时去掉路径、包名和 A/U 前缀：/Script/Engine.Actor、AActor、Actor 是同一个 */
function normalizeClassName(name: string): string {
  const last = name.split(/[./]/).pop() ?? name
  return last.replace(/_C$/, '').toLowerCase()
}

function sameClass(a: string, b: string): boolean {
  const x = normalizeClassName(a)
  const y = normalizeClassName(b)
  return x === y || x === `a${y}` || y === `a${x}` || x === `u${y}` || y === `u${x}`
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

          /*
           * AGENTS.md §5 第 14 条：蓝图建出来了、组件属性没写进去 / 没存上盘，
           * 第一句就得说。原来 warnings 只躺在 JSON 里，save_warning 直接丢掉，
           * 文案一律「创建成功」—— 模型读到这句就往下做了。
           */
          const failures: PartialFailure[] = (response.warnings ?? []).map((warning) => ({
            item: '组件',
            reason: warning
          }))
          // 组件类名认不出来时插件只打日志、直接跳过，回执里就少一个。按名字对一遍
          const present = new Set(componentNames.map((name) => name.toLowerCase()))
          for (const comp of input.components ?? []) {
            if (comp.component_name && !present.has(comp.component_name.toLowerCase())) {
              failures.push({
                item: comp.component_name,
                reason: `引擎的组件列表里没有它（${comp.component_type} 可能不是有效的组件类名，插件跳过了）`
              })
            }
          }
          if (response.saved === false) {
            failures.push({
              item: '保存',
              reason: response.save_warning ?? '蓝图只在内存里，没写到磁盘，关编辑器就没了'
            })
          }
          const body =
            `蓝图 "${response.name}" 已创建（父类 ${response.parent_class}），路径: ${response.path}` +
            (response.saved === false ? '，**未能保存**' : '')

          return {
            message: withPartialHeadline(
              body,
              { succeeded: 1 + componentNames.length, failed: failures.length, unit: '项' },
              failures
            ),
            success: true,
            name: response.name,
            blueprint_path: response.path,
            path: response.path,
            parent_class: response.parent_class,
            generated_class: response.generated_class,
            saved: response.saved,
            components: response.components,
            component_count: response.components?.length || 0,
            ...(response.save_warning ? { save_warning: response.save_warning } : {}),
            warnings: response.warnings ?? [],
            blueprintState: {
              components: componentNames,
              componentCount: componentNames.length,
              hasDefaultSceneRoot: componentNames.includes('DefaultSceneRoot')
            },
            note:
              componentNames.length <= 1
                ? '蓝图当前仅有默认组件。如需添加其它组件，请继续调用 blueprint.add_component。'
                : undefined
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
          // 插件的 409 原话里带着包路径：「 '/Game/X' 下已经存在同名蓝图 'BP_X'」
          const pathInMessage = /'([^']+)'\s*下已经存在同名蓝图/.exec(msg)?.[1]
          const fallbackPath =
            input.folder && input.folder.trim()
              ? `${input.folder.replace(/\/+$/, '')}/${input.name}`
              : undefined
          const guessedPath = detailPath || pathInMessage || fallbackPath

          /*
           * 已存在的那个蓝图是什么样，要从引擎读，不能拿请求补。
           * 原来 parent_class 填的是输入值、path 是 folder + name 拼的 —— 已有的
           * BP_Door 是 Pawn，回执却说它是 Actor，模型就按 Actor 往下接了。
           * 读不到就明说没核实，不报 parent_class。
           */
          let existing: ExistingBlueprintInfo | null = null
          try {
            existing = await wsService.callRequest<ExistingBlueprintInfo>(
              'blueprint.describe',
              { blueprint_path: guessedPath ?? input.name },
              getTargetConnectionId(),
              30000
            )
          } catch {
            existing = null
          }
          const verified = Boolean(existing?.ok && existing.path)
          const existingPath = verified ? existing?.path : guessedPath
          const existingParent = verified ? existing?.parent_class : undefined
          const parentMismatch =
            existingParent && input.parent_class && !sameClass(existingParent, input.parent_class)

          const where = existingPath ? `（路径: ${existingPath}）` : ''
          const message = !verified
            ? `⚠️ 蓝图 "${input.name}" 已存在${where}，没有新建。没能读回它的父类和组件，` +
              '路径和父类都未核实 —— 先用 blueprint_describe 看一眼再往下做。'
            : parentMismatch
              ? `⚠️ 蓝图 "${input.name}" 已存在${where}，没有新建，而且它的父类是 ${existingParent}，` +
                `不是你要的 ${input.parent_class}。要 ${input.parent_class} 的话换个名字重建。`
              : `蓝图 "${input.name}" 已存在${where}，父类 ${existingParent}，没有新建，已复用现有资产。`

          return {
            message,
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
            verified,
            ...(existingParent ? { parent_class: existingParent } : {}),
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
