/**
 * Read high-level Blueprint structure through the Unreal websocket bridge.
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { extractBlueprintGraphRefs, pickPreferredGraphName } from './graphDiscovery'
import { resolveBlueprintPathInput } from './resolveBlueprintPath'

const DescribeBlueprintSchema = z.object({
  blueprint_path: z
    .string()
    .describe(
      'Required Blueprint asset path, for example "/Game/Blueprints/BP_Hero" or the short name "BP_Hero".'
    )
})

interface ComponentInfo {
  name: string
  class: string
  class_path: string
  source: 'added' | 'inherited'
  editable: boolean
  /** 父组件名。空字符串 = 它就是根组件，和「不知道」是两回事 */
  attach_to?: string
  /** 层级深度，0 是根 */
  depth?: number
  /** 父组件是不是 C++ 里声明的原生组件 */
  attach_parent_is_native?: boolean
  /** 挂在骨骼 socket 上时才有 */
  attach_socket?: string
}

interface VariableInfo {
  name: string
  type: string
  editable: boolean
  default_value?: string
}

interface DescribeBlueprintResponse {
  ok: boolean
  name: string
  path: string
  parent_class: string
  parent_class_path: string
  generated_class?: string
  components: ComponentInfo[]
  variables: VariableInfo[]
  compile_status: 'UpToDate' | 'Dirty' | 'Error' | 'Unknown' | 'Other'
  [key: string]: unknown
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createDescribeBlueprintTool() {
  return defineV2Tool({
    description: `Read the overall Blueprint structure for validation and context building.

Returns name, path, parent class, components, variables, compile status, and the list of
inspectable graphs (graph_names / preferred_graph).
Use this before editing an existing Blueprint, when the user asks what the current Blueprint
contains, or when you need to know which graphs exist before calling blueprint_get_graph.

Each component carries its real attachment: "attach_to" is the parent component's name
(empty string means it IS the root) and "depth" is how deep it sits. That hierarchy decides
behaviour — a door swinging on its hinge versus around its centre is exactly this. It is
reported here, so do not fall back to running Python to read the SCS tree.`,
    inputSchema: DescribeBlueprintSchema,
    execute: async (input) => {
      console.log('[DescribeBlueprintTool] Received request:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error:
              'No Unreal Editor connection is available. Start Unreal Editor and ensure the UnrealAgentLink plugin is connected.'
          }
        }

        const resolvedBlueprint = await resolveBlueprintPathInput(input.blueprint_path)
        const blueprintPath = resolvedBlueprint.blueprintPath

        if (!blueprintPath) {
          return {
            success: false,
            error: resolvedBlueprint.wasPlaceholder
              ? 'Could not resolve the current Blueprint from context. Open the target Blueprint in Unreal Editor and retry.'
              : 'Missing required field: blueprint_path'
          }
        }

        const params = { blueprint_path: blueprintPath }
        console.log('[DescribeBlueprintTool] Sending blueprint.describe request:', params)

        let response = await wsService.callRequest<DescribeBlueprintResponse>(
          'blueprint.describe',
          params,
          getTargetConnectionId(),
          30000
        )

        if (
          !response?.ok &&
          !resolvedBlueprint.wasPlaceholder &&
          resolvedBlueprint.originalInput &&
          resolvedBlueprint.originalInput !== blueprintPath
        ) {
          console.log(
            '[DescribeBlueprintTool] Resolved path failed, retrying original input:',
            resolvedBlueprint.originalInput
          )
          response = await wsService.callRequest<DescribeBlueprintResponse>(
            'blueprint.describe',
            { blueprint_path: resolvedBlueprint.originalInput },
            getTargetConnectionId(),
            30000
          )
        }

        console.log('[DescribeBlueprintTool] Response received:', response ? 'ok' : 'empty')

        if (response?.ok) {
          const rawResponse = response as Record<string, unknown>
          let graphRefs = extractBlueprintGraphRefs(rawResponse)

          // describe 没带出图表时，再问一次专门的 list_graphs。
          //
          // 这两件事原来是两个工具（blueprint_describe / blueprint_list_graphs），
          // 而后者的降级路径**就是 blueprint.describe** —— 也就是说它多数时候
          // 只是 describe 的一层壳。反过来把 list_graphs 作为 describe 的补充，
          // 一个工具就覆盖了两者，模型也不用再判断"该问结构还是该问图表"。
          if (graphRefs.length === 0) {
            try {
              const listed = await wsService.callRequest<unknown>(
                'blueprint.list_graphs',
                { blueprint_path: blueprintPath },
                getTargetConnectionId(),
                20000
              )
              if (
                listed &&
                typeof listed === 'object' &&
                (listed as { ok?: boolean }).ok === true
              ) {
                graphRefs = extractBlueprintGraphRefs(listed)
              }
            } catch (error) {
              // 老版本插件没有这个 RPC。describe 的结果本身是完整的，
              // 少一份图表清单不该让整次查询失败
              console.warn('[DescribeBlueprintTool] blueprint.list_graphs unavailable:', error)
            }
          }

          const graphNames = graphRefs.map((graph) => graph.name)
          /**
           * 摘要里要能看出层级，不能只是一串平铺的名字。
           *
           * 「组件挂在谁下面」决定行为（门绕门轴转还是绕中心转）。摘要是模型
           * 最先读的那一行，只给平铺列表的话它得自己去翻 components 数组，
           * 而实测里它选择的是不翻 —— 转头去写 Python 读 SCS。
           *
           * 缩进用 depth 表示；depth 缺席（继承来的组件）就不缩进。
           */
          const componentSummary = response.components
            .map((component) => {
              const indent = '  '.repeat(component.depth ?? 0)
              // 老插件把空 FName 序列化成字面量 "None"，那读起来像「有个叫 None
              // 的父组件」。插件端已经改回空串，这里再挡一道 ——
              // 用户装的插件版本可能比 app 旧。
              const parentName =
                component.attach_to && component.attach_to !== 'None' ? component.attach_to : ''
              const parent = parentName ? ` ⊂ ${parentName}` : ' 根'
              return `${indent}${component.name} (${component.class}, ${component.source}${parent})`
            })
            .join('; ')
          const variableSummary = response.variables
            .map((variable) => `${variable.name}: ${variable.type}`)
            .join(', ')
          const graphSummary =
            graphNames.length > 0 ? `, ${graphNames.length} graphs [${graphNames.join(', ')}]` : ''

          return {
            success: true,
            ...rawResponse,
            name: response.name,
            blueprint_path: response.path,
            path: response.path,
            parent_class: response.parent_class,
            parent_class_path: response.parent_class_path,
            generated_class: response.generated_class,
            compile_status: response.compile_status,
            component_count: response.components.length,
            components: response.components,
            variable_count: response.variables.length,
            variables: response.variables,
            graph_count: graphRefs.length,
            graph_names: graphNames,
            // 下一步多半是 blueprint_get_graph，直接把该开哪张图告诉它
            preferred_graph: pickPreferredGraphName(graphRefs),
            graphs: graphRefs,
            summary: `Blueprint "${response.name}" (${response.parent_class}): ${response.components.length} components [${componentSummary || 'none'}], ${response.variables.length} variables [${variableSummary || 'none'}]${graphSummary}`
          }
        }

        const msg =
          (response as Record<string, unknown> | null)?.error ||
          (response as Record<string, unknown> | null)?.message ||
          'No response or ok=false'
        const code =
          (response as { __rpc?: { code?: number }; code?: number } | null)?.__rpc?.code ??
          (response as { code?: number } | null)?.code
        const details = (response as { details?: unknown } | null)?.details

        return {
          success: false,
          error: `Failed to describe Blueprint: ${String(msg)}`,
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[DescribeBlueprintTool] Execution failed:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
