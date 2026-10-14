/**
 * `ue_input_add_mapping` —— 往工程里加一条按键映射。
 *
 * 此前输入这一块只能读（`ue_input_map`）。蓝图里放了 InputAction 节点、编译报
 * 「这个动作不在输入设置里」时，只能让用户去项目设置 / IMC 里自己加 —— 用户点名
 * 让 Agent 做一个「按空格跳」，Agent 做到一半交回给用户。
 *
 * 两套输入系统都写：
 *
 *   - Enhanced Input（5.1 起默认）：往点名的 IMC 里加「动作 + 键」，动作资产不在就新建，
 *     可带触发器 / 修饰器（WASD 走 Axis2D 要靠 Negate / SwizzleAxis）；
 *   - 旧输入系统（`system: "legacy"`）：加 Action / Axis Mapping，写回 Config/DefaultInput.ini。
 *
 * 它**不**负责把 IMC 挂到玩家身上（那是蓝图里 AddMappingContext 的事），也不建 IMC 本身。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const AddMappingSchema = z.object({
  system: z
    .enum(['enhanced', 'legacy'])
    .default('enhanced')
    .describe(
      '写哪套输入系统。先用 ue_input_map 看 input_system：enhanced 就写 IMC；' +
        'legacy（只有旧 Action/Axis Mapping 的工程，或蓝图里用的是旧 InputAction 节点）写 legacy'
    ),
  key: z
    .string()
    .trim()
    .min(1)
    .describe(
      '引擎键名，如 SpaceBar、W、E、LeftMouseButton、Gamepad_FaceButton_Bottom、Gamepad_Left2D'
    ),
  context_path: z
    .string()
    .optional()
    .describe('enhanced：加到哪个输入映射上下文（IMC），如 /Game/Input/IMC_Default。必须已存在'),
  action_path: z
    .string()
    .optional()
    .describe('enhanced：输入动作资产路径，如 /Game/Input/Actions/IA_Interact。不存在会新建'),
  value_type: z
    .enum(['Boolean', 'Axis1D', 'Axis2D', 'Axis3D'])
    .optional()
    .describe('enhanced：新建动作时的值类型，默认 Boolean。按键类用 Boolean，移动用 Axis2D'),
  triggers: z
    .array(z.string())
    .optional()
    .describe('enhanced：这条映射的触发器，如 ["Hold"]、["Pressed"]。不填就是按下即触发'),
  modifiers: z
    .array(z.string())
    .optional()
    .describe(
      'enhanced：这条映射的修饰器。WASD 绑 Axis2D 的常见配法：W=["SwizzleAxis"]，' +
        'S=["SwizzleAxis","Negate"]，A=["Negate"]，D 不加'
    ),
  name: z
    .string()
    .optional()
    .describe('legacy：Action 或 Axis 的名字，要和蓝图里 InputAction / InputAxis 节点的名字一致'),
  axis_scale: z
    .number()
    .optional()
    .describe('legacy：给了就是轴映射（如 W=1、S=-1），不给就是动作映射')
})

interface AddMappingResponse {
  ok?: boolean
  system: 'enhanced' | 'legacy'
  key: string
  already_mapped: boolean
  // enhanced
  context_path?: string
  action_path?: string
  value_type?: string
  action_created?: boolean
  saved?: boolean
  // legacy
  kind?: 'action' | 'axis'
  name?: string
  config_saved?: boolean
  keys: Array<string | { key: string; scale?: number; triggers?: unknown[]; modifiers?: unknown[] }>
}

function keyLabel(k: AddMappingResponse['keys'][number]): string {
  if (typeof k === 'string') return k
  return k.scale !== undefined ? `${k.key}(${k.scale})` : k.key
}

export function createInputAddMappingTool(): V2Tool {
  return defineV2Tool({
    description: `往工程里加一条按键映射：把某个键绑到一个输入动作上。

什么时候用：
- 要做「按 E 交互」「按空格跳」，工程里还没有这个动作或这个键
- 蓝图编译警告 InputAction 节点的动作「不在输入设置里」

先调 ue_input_map 看 input_system，决定写哪套：

**enhanced（默认）**：给 context_path（已有的 IMC）、action_path、key。
动作资产不存在会按 value_type 新建（默认 Boolean）。需要长按、反向、换轴时给 triggers / modifiers。
同一个动作同一个键已经有了就不重复加。

**legacy**：给 name（和蓝图里旧 InputAction / InputAxis 节点同名）和 key；轴映射再给 axis_scale。
写回 Config/DefaultInput.ini。

它不做的：不新建 IMC，也不把 IMC 挂到玩家身上 —— 新建的 IMC 要在蓝图里 AddMappingContext
才生效。加完想在游戏里验证，ue_playtest 跑起来再 ue_input_map 看 source=runtime。`,

    inputSchema: AddMappingSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return { success: false, error: UE_NOT_CONNECTED_MESSAGE }
        }

        // 没传的字段不发：引擎侧按「有没有这个字段」区分动作映射和轴映射
        const params: Record<string, unknown> = {
          system: input.system ?? 'enhanced',
          key: input.key
        }
        for (const field of [
          'context_path',
          'action_path',
          'value_type',
          'triggers',
          'modifiers',
          'name',
          'axis_scale'
        ] as const) {
          if (input[field] !== undefined) params[field] = input[field]
        }

        const response = await wsService.callRequest<AddMappingResponse>(
          'input.add_mapping',
          params,
          getTargetConnectionId(),
          30_000
        )

        if (!response || response.ok !== true) {
          const raw = response as unknown as Record<string, unknown> | undefined
          const msg = (raw?.error as string) || (raw?.message as string) || '插件没有响应'
          return {
            success: false,
            error: `加按键映射失败：${msg}`,
            code: (raw?.__rpc as { code?: unknown })?.code ?? raw?.code,
            details: raw?.details
          }
        }

        const keys = (response.keys ?? []).map(keyLabel)
        const lines: string[] = []

        if (response.system === 'legacy') {
          const kind = response.kind === 'axis' ? '轴映射' : '动作映射'
          lines.push(
            response.already_mapped
              ? `旧输入系统的${kind}「${response.name}」本来就绑着 ${response.key}，没有改动。`
              : `已在旧输入系统加${kind}「${response.name}」← ${response.key}。`
          )
          if (response.config_saved === false) {
            lines.push(
              '⚠️ 没写进 Config/DefaultInput.ini（文件可能是只读的，或被版本控制锁着）。' +
                '现在编辑器里生效，但不跟着工程走，重开编辑器可能就没了。'
            )
          }
          lines.push(`「${response.name}」现在绑着：${keys.join('、') || '（无）'}。`)
        } else {
          lines.push(
            response.already_mapped
              ? `${response.context_path} 里 ${response.action_path} 本来就绑着 ${response.key}，没有改动。`
              : `已在 ${response.context_path} 里把 ${response.key} 绑到 ${response.action_path}` +
                  `（${response.value_type}${response.action_created ? '，动作是这次新建的' : ''}）。`
          )
          if (response.saved === false) {
            lines.push('⚠️ 资产没存盘成功，改动只在编辑器内存里，关掉编辑器前要手动保存。')
          }
          lines.push(`这个动作在该 IMC 里现在绑着：${keys.join('、') || '（无）'}。`)
          if (response.action_created) {
            lines.push(
              '蓝图里响应它用 EnhancedInputAction 节点（member_name 填动作名）。' +
                '这个 IMC 要在玩家身上 AddMappingContext 过才会生效。'
            )
          }
        }

        return { success: true, ...response, message: lines.join('\n') }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
