/**
 * `ue_input_map` —— 这个游戏现在能按什么。
 *
 * ## 为什么不是「读一下 DefaultInput.ini」
 *
 * UE5 默认的 Enhanced Input，绑定不在 ini 里，在 IMC 资产里；而**挂着哪些 IMC
 * 是游戏逻辑随时改的**：主菜单一套、跑图一套、开车一套、打开背包再压一套。
 * 所以「W 是前进」这句话只在某个时刻成立。
 *
 * 读资产只能得到*可能的*绑定，读运行时才知道*此刻*能按什么。
 * 两者用 `source` 分开，且都会附一句人话 —— 混为一谈就会出现
 * 「工具说 E 是交互，注入了没反应」，因为那个 IMC 在这个关卡压根没被加进来。
 *
 * ## 为什么必须回报值类型和触发器
 *
 * 往 Boolean 动作注入一个 2D 向量**不报错，静默无效**；
 * 一个挂着 `Hold 1.0s` 的交互键，按一帧也什么都不会发生。
 * 这两件事模型不可能猜到，工具不给就等于让它去查别的地方。
 *
 * 设计 与 §7.1。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { worldFields, describeWorld } from '../../worldScope'
import { summarizeInputMap, type InputMapResponse } from './summary'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const InputMapSchema = z.object({
  player_index: z
    .number()
    .optional()
    .describe('多人 PIE 时看第几个客户端的输入，默认 0。单机不用传')
})

export function createInputMapTool(): V2Tool {
  return defineV2Tool({
    description: `查这个游戏现在能按什么键、有哪些输入动作。

**要模拟玩家操作之前，先调它。** 不调就去按键，等于闭着眼睛敲键盘。

## 最要紧的一个字段：source

- \`source: "runtime"\` —— 游戏正在跑，这是**此刻真实生效**的映射。可以据此操作。
- \`source: "asset"\` —— 游戏没在跑，这只是**工程里定义**了这些绑定，
  **不代表游戏里那一刻挂着**。想知道此刻能按什么，先把游戏跑起来（ue_playtest）再查。

Enhanced Input 的绑定由「当前挂着哪些输入上下文（IMC）」决定，而那是游戏逻辑
随时增删的：主菜单一套、跑图一套、开车一套。所以同一个工程，不同时刻答案不一样。

## 每个动作要看三样

- **value_type**：Boolean / Axis1D / Axis2D / Axis3D。移动一般是 Axis2D，跳跃是 Boolean。
  类型对不上时注入会**静默无效**。
- **triggers**：挂了 \`Hold\` 的动作，按一帧什么都不会发生 —— 要按住够 \`HoldTimeThreshold\` 秒。
  \`Chorded\` 表示要和另一个动作同时按。
- **modifiers**：\`Negate\`（反向）、\`Swizzle\`（换轴）、\`DeadZone\`（死区）会改变你给的值。
  所以「向前」到底是 (0,1) 还是 (1,0)，取决于这个工程怎么配的，**不要猜**。

## input_system 决定你能怎么操作

- \`enhanced\`：有动作层，可以按动作名操作
- \`legacy\`：**只有旧的 Action/Axis Mapping，没有动作层**（5.0–5.3 起步的工程常见），
  只能按键位。这时候 actions 是空的，看 legacy_actions / legacy_axes
- \`both\`：迁移中的工程，两套并存
- \`none\`：这个工程没有可查的输入配置，可能是漫游/展示类项目

## 它答不了什么

- **触摸屏和 VR 的输入**：会在 legacy 里看到痕迹，但本工具不覆盖那两条路
- **UI 按钮**：这里只有 gameplay 输入，界面上的按钮不在其中`,

    inputSchema: InputMapSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const params: Record<string, unknown> = {}
        if (input.player_index !== undefined) params.player_index = input.player_index

        const response = await wsService.callRequest<InputMapResponse>(
          'input.map',
          params,
          getTargetConnectionId()
        )

        if (!response) {
          return { success: false, error: '插件没有响应（input.map）' }
        }
        if (response.ok === false) {
          const message = (response as unknown as { error?: string })?.error || '读取输入映射失败'
          return { success: false, error: message }
        }

        return {
          success: true,
          source: response.source,
          input_system: response.input_system,
          contexts: response.contexts,
          actions: response.actions,
          action_count: response.action_count,
          ...(response.legacy_actions?.length ? { legacy_actions: response.legacy_actions } : {}),
          ...(response.legacy_axes?.length ? { legacy_axes: response.legacy_axes } : {}),
          ...(response.contexts_truncated ? { contexts_truncated: true } : {}),
          ...worldFields(response),
          message:
            summarizeInputMap(response) + '\n\n' + response.source_note + describeWorld(response)
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
