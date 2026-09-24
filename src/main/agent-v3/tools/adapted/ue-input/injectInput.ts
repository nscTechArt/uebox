/**
 * `ue_inject_input` —— 在运行中的游戏里模拟一次操作。
 *
 * ## 两层，各自能证明什么
 *
 * - **动作层**（`action`）：直接把值塞进 Enhanced Input 的注入队列，绕开键位映射。
 *   稳、不依赖窗口焦点，但**证明不了键位绑对没有** —— 一个根本没绑跳跃键的工程，
 *   这条路照样能让角色跳起来。
 * - **按键层**（`key`）：从游戏视口发一次真实按键，走完整条链路。
 *   这是唯一能验出键位的路径，也是唯一会**像真人一样被 UI 挡住**的路径。
 *
 * 2026-09-03 在 5.8 与 5.3 上各自实测：游戏切到菜单（UIOnly）后，
 * **动作注入照常把角色推走，而真实按键归零**。所以「注入成功」和「玩家按得动」
 * 是两件事，工具必须把用了哪一层如实说出来。
 *
 * 设计 与 §12.8。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { worldFields, type WorldScopedResponse } from '../../worldScope'
import { checkInjectLayer } from './summary'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const InjectSchema = z.object({
  action: z
    .string()
    .optional()
    .describe('动作名（如 IA_Move）。和 key 二选一。名字用 ue_input_map 查'),
  key: z
    .string()
    .optional()
    .describe('按键名（如 W、SpaceBar、E）。和 action 二选一。走真人路径，能验键位'),
  x: z.number().optional().describe('动作的值：Axis2D 的左右、Axis1D 的大小'),
  y: z.number().optional().describe('动作的值：Axis2D 的前后'),
  z: z.number().optional().describe('动作的值：只有 Axis3D 用得到'),
  value: z.boolean().optional().describe('Boolean 动作用这个，比记住「x=1 是按下」清楚'),
  event: z
    .enum(['tap', 'press', 'release'])
    .optional()
    .describe('按键模式：tap（按下再抬起，默认）/ press（只按下）/ release（只抬起）'),
  frames: z.number().optional().describe('持续多少帧，默认 1，上限 600。按住走路要给足帧数'),
  player_index: z.number().optional().describe('多人 PIE 时第几个客户端，默认 0')
})

interface InjectResponse extends WorldScopedResponse {
  ok: boolean
  injected_at: 'action' | 'key'
  action?: string
  key?: string
  event?: string
  value_type?: string
  frames?: number
  accepted?: boolean
  interrupted?: boolean
  layer_note: string
  held_note?: string
  warnings?: string[]
  viewport_ignores_input?: boolean
  move_input_ignored?: boolean
}

export function createInjectInputTool(): V2Tool {
  return defineV2Tool({
    description: `在**正在运行的游戏**里模拟一次操作。游戏没跑的时候用不了。

调它之前先用 ue_input_map 查清楚有哪些动作、什么值类型、挂了哪些触发器。

## 两种用法，选哪种取决于你要验什么

**验逻辑对不对 → 用 action**

    { action: "IA_Move", y: 1, frames: 60 }   // 往前走 60 帧
    { action: "IA_Jump", value: true }        // 跳一下

直接触发动作，稳、不受窗口焦点影响。**但它绕开了键位映射** ——
就算这个工程根本没把跳跃绑到任何键上，这条路照样能让角色跳。
所以**不能拿它的成功去说「按键正常」**。

**验键位绑对没有 → 用 key**

    { key: "W", frames: 60 }        // 按住 W 60 帧再松开
    { key: "SpaceBar" }             // 点一下空格

走真人那条路：视口 → 键位映射 → 动作。键没绑上就不会有反应，这才验得出键位。

## 一定要看返回里的 warnings

如果游戏当前打开着菜单一类的 UI（UIOnly 模式），**动作注入照样生效，而真人按键完全无效**。
这时候返回里会有 \`viewport_ignores_input: true\` 和一条警告 ——
**看到它就不要下「操作正常」的结论**，先让游戏回到能正常操作的状态。

同理 \`move_input_ignored: true\` 表示游戏正忽略移动输入（过场/剧情常见），
这时动作会触发但角色不动，**那是正确行为，不是失败**。

## 值怎么给

- Boolean 动作：\`value: true\`
- Axis1D：\`x\`
- Axis2D：\`x\` 和 \`y\`。**但「向前」到底是 y=1 还是 x=1，取决于这个工程的 modifier 配置**，
  先用 ue_input_map 看 modifiers，不要猜
- 类型给错会当场报错，不会静默无效

## 帧数

一帧非常短（60fps 下约 16 毫秒）。想让角色真的走出一段距离，\`frames\` 要给到几十。
挂着 \`Hold\` 触发器的动作，帧数不够就什么也不会发生。`,

    inputSchema: InjectSchema,

    execute: async (input) => {
      const layerError = checkInjectLayer(input.action, input.key)
      if (layerError) {
        return { success: false, error: layerError }
      }
      const hasAction = typeof input.action === 'string' && input.action.length > 0

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const params: Record<string, unknown> = {}
        for (const field of [
          'action',
          'key',
          'x',
          'y',
          'z',
          'value',
          'event',
          'frames',
          'player_index'
        ] as const) {
          if (input[field] !== undefined) params[field] = input[field]
        }

        // 插件那边按帧收尾（frames 上限 600），60fps 下最长 10 秒；
        // 留足余量，别让传输超时盖掉插件那句具体的诊断
        const frames = typeof input.frames === 'number' ? input.frames : 1
        const timeoutMs = Math.max(15000, frames * 60 + 15000)

        const response = await wsService.callRequest<InjectResponse>(
          hasAction ? 'input.inject_action' : 'input.inject_key',
          params,
          getTargetConnectionId(),
          timeoutMs
        )

        if (!response) {
          return { success: false, error: '插件没有响应' }
        }
        if (response.ok === false) {
          const message = (response as unknown as { error?: string })?.error || '注入失败'
          return { success: false, error: message }
        }

        const warnings = response.warnings ?? []
        // accepted:false = 游戏视口没处理这个键（被 UI 吃掉、焦点不在游戏视口……）。
        // 这时说「已发送」，模型会接着去查游戏逻辑为什么没反应，而键根本没进去。
        // 老插件不回 accepted，按原话说
        const notAccepted = !hasAction && response.accepted === false
        const summary = [
          hasAction
            ? `已对动作 ${response.action} 注入（${response.value_type}）`
            : notAccepted
              ? `⚠️ 按键 ${response.key}（${response.event}）没被游戏视口接受，角色不会有反应。` +
                '多半是 UI 挡住了输入或焦点不在游戏视口'
              : `已发送按键 ${response.key}（${response.event}）`,
          response.frames && response.frames > 1 ? `持续 ${response.frames} 帧` : '',
          response.interrupted ? '⚠️ 中途 PIE 停了，没跑满' : ''
        ]
          .filter(Boolean)
          .join('；')

        return {
          // message 放第一个键：适配层把整个对象 JSON 化，键序就是模型读到的顺序。
          // 警告放在最前面：模型读 message 是从头读的，把「这次结论不可信」
          // 压在末尾等于没说。键没被接受时那句本身就是结论，排在警告之前
          message:
            (notAccepted ? summary + '\n\n' : '') +
            (warnings.length > 0 ? warnings.join('\n') + '\n\n' : '') +
            (notAccepted ? '' : summary + '\n\n') +
            response.layer_note +
            (response.held_note ? '\n\n' + response.held_note : ''),
          success: true,
          injected_at: response.injected_at,
          ...(response.action ? { action: response.action } : {}),
          ...(response.key ? { key: response.key } : {}),
          ...(response.value_type ? { value_type: response.value_type } : {}),
          ...(response.frames !== undefined ? { frames: response.frames } : {}),
          ...(response.accepted !== undefined ? { accepted: response.accepted } : {}),
          ...(response.interrupted ? { interrupted: true } : {}),
          ...(response.viewport_ignores_input ? { viewport_ignores_input: true } : {}),
          ...(response.move_input_ignored ? { move_input_ignored: true } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          ...worldFields(response)
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
