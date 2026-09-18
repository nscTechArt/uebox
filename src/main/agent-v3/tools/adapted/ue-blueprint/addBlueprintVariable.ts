/**
 * 添加蓝图成员变量工具
 * 通过 WebSocket 向虚幻引擎插件发送 blueprint.add_variable 命令
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
const AddBlueprintVariableSchema = z.object({
  blueprint_path: z.string().describe('蓝图路径（必填），如 /Game/Blueprints/BP_Hero'),
  name: z.string().describe('变量名（必填），如 Health'),
  type: z
    .string()
    .describe(
      '变量类型（必填）。标量：bool/int/int64/float/double/string/name/text。' +
        '结构体或枚举：直接写名字，如 Vector / Rotator / Transform / LinearColor / ' +
        'DataTableRowHandle / 你自己定义的 MyStruct / EMyEnum（带不带 F、E 前缀都认）。' +
        '对象引用：object/class/soft_object/soft_class，再用 object_class 指定类。'
    ),
  object_class: z
    .string()
    .optional()
    .describe('当 type=object/class/soft_object/soft_class 时指定类，如 /Script/Engine.Actor'),
  container: z
    .enum(['array', 'set', 'map'])
    .optional()
    .describe('容器类型（可选）。不给就是单值。给了就覆盖 is_array'),
  is_array: z
    .boolean()
    .optional()
    .default(false)
    .describe('是否数组（默认 false）。等价于 container=array'),
  default_value: z
    .string()
    .optional()
    .describe(
      '默认值（可选）。用 UE 自己的字面量写法："600.0"、"true"、"(X=0,Y=0,Z=0)"、' +
        '资产写完整路径 "/Game/M_Gold.M_Gold"。写不进去会报错，不会静默留 0；' +
        '返回里的 default_value 是**引擎读回来的值**，不是这里填的回声'
    )
})

export interface AddBlueprintVariableResponse {
  ok: boolean
  blueprint_path: string
  variable: {
    name: string
    type: string
    is_array: boolean
    sub_category_object?: string
    default_value?: string
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createAddBlueprintVariableTool() {
  return defineV2Tool({
    description: `为蓝图添加成员变量（Blueprint Member Variable）。

【使用建议】
- 添加变量后，如需在图表中使用，用 blueprint_apply_graph 往图里放节点，
  节点类型写 VariableGet / VariableSet。逐节点建图的工具已经下线，写图只有它一个。
- 建出来的变量**默认不暴露给实例**。要让策划在场景里逐个实例调，接着用
  blueprint_set_variable_meta 打开 instance_editable。

【返回数据】
- variable: 包含变量的类型与（可选）默认值信息`,

    inputSchema: AddBlueprintVariableSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const params: Record<string, unknown> = {
          blueprint_path: input.blueprint_path,
          name: input.name,
          type: input.type,
          is_array: input.is_array
        }
        if (input.object_class) params.object_class = input.object_class
        if (input.container) params.container = input.container
        if (input.default_value !== undefined) params.default_value = input.default_value

        const response = await wsService.callRequest<AddBlueprintVariableResponse>(
          'blueprint.add_variable',
          params,
          getTargetConnectionId(),
          30000
        )

        if (!response || !response.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = (response as any)?.error || (response as any)?.message || '无响应或 ok=false'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const code = (response as any)?.__rpc?.code ?? (response as any)?.code
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details = (response as any)?.details
          return { success: false, error: `添加变量失败：${msg}`, code, details, raw: response }
        }

        return {
          success: true,
          blueprint_path: response.blueprint_path,
          variable: response.variable,
          message: `已添加变量 ${response.variable.name}（${response.variable.type}${response.variable.is_array ? '[]' : ''}）到 ${response.blueprint_path}`
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
