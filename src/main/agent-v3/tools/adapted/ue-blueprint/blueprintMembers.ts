/**
 * 蓝图成员的「调」与「删」—— 变量元数据、删变量、事件分发器。
 *
 * ## 补的是同一个洞
 *
 * 在这三个工具之前，蓝图成员**只能加，不能调、不能删**：
 *
 *   - 变量建出来就定死了，改不了它在细节面板里的表现。而「暴露给策划在
 *     实例上调」恰恰是蓝图变量最常见的用途 —— 做不到这个，建出来的变量
 *     只能在图里用，等于少了一半价值。
 *   - 加错一个变量只能留着，或者让用户自己去编辑器里删。
 *   - 事件分发器一个都建不出来。凡是「A 发事件 B 收」的需求全都做不了，
 *     只能退化成 B 每帧轮询 A —— 那是错的写法，而模型会照着写。
 *
 * 对应引擎侧 `blueprint.set_variable_meta` / `blueprint.remove_variable` /
 * `blueprint.event_dispatcher`（UnrealAgentLink，5.0–5.8 全版本可用）。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'

import { serviceManager } from '../../../../services'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const TIMEOUT_MS = 30_000

interface RpcFailure {
  success: false
  error: string
  code?: unknown
  details?: unknown
  raw?: unknown
}

/**
 * 统一的 RPC 外壳。
 *
 * 三个工具的失败处理逐字相同，各写一遍只会让其中一份先漂移 ——
 * 而漂移的那份通常是「错误信息少带了 details」，恰恰是模型自我纠正
 * 唯一能用的东西（引擎侧会在 details 里列出可用的变量名、参数类型）。
 */
async function callBlueprint<T extends { ok?: boolean }>(
  method: string,
  params: Record<string, unknown>,
  failurePrefix: string
): Promise<T | RpcFailure> {
  const wsService = serviceManager.getWebSocketService()
  if (wsService.getConnectionCount() === 0) {
    return {
      success: false,
      error: UE_NOT_CONNECTED_MESSAGE
    }
  }

  const response = await wsService.callRequest<T>(
    method,
    params,
    getTargetConnectionId(),
    TIMEOUT_MS
  )

  if (!response || response.ok !== true) {
    const anyResponse = response as Record<string, unknown> | undefined
    const msg =
      (anyResponse?.error as string) || (anyResponse?.message as string) || '无响应或 ok=false'
    return {
      success: false,
      error: `${failurePrefix}：${msg}`,
      code: (anyResponse?.__rpc as { code?: unknown })?.code ?? anyResponse?.code,
      details: anyResponse?.details,
      raw: response
    }
  }

  return response
}

function isFailure(value: unknown): value is RpcFailure {
  return (value as RpcFailure)?.success === false
}

// ── 变量元数据 ────────────────────────────────────────────────────────────

const SetVariableMetaSchema = z.object({
  blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Hero'),
  name: z.string().describe('变量名，如 Health'),
  instance_editable: z
    .boolean()
    .optional()
    .describe('是否让放到场景里的实例能在细节面板改这个值。策划要调的参数都该打开'),
  blueprint_read_only: z
    .boolean()
    .optional()
    .describe('图表里只读（只能 Get 不能 Set）。用于常量式配置，防止被逻辑意外改掉'),
  category: z
    .string()
    .optional()
    .describe('细节面板里的分组名，如 "移动"。变量多了不分组，面板会长得没法用'),
  tooltip: z.string().optional().describe('鼠标悬停提示。写给用这个蓝图的人看'),
  expose_on_spawn: z
    .boolean()
    .optional()
    .describe('在 SpawnActor 节点上暴露成输入引脚，生成时直接传值。会连带打开 instance_editable'),
  replication: z
    .enum(['None', 'Replicated', 'RepNotify'])
    .optional()
    .describe(
      '联机复制。Replicated 服务器改了同步给客户端；' +
        'RepNotify 再加一个变化回调（函数名固定 OnRep_<变量名>，要自己建这个函数）。' +
        '单机项目不用碰'
    )
})

interface SetVariableMetaResponse {
  ok: boolean
  blueprint_path: string
  name: string
  applied: string[]
  compiled?: boolean
  compile_error_count?: number
  /** 编译没把变量带进生成类时才有：实例还用不上新设置 */
  warning?: string
  variable?: {
    name: string
    type: string
    /** 以编译后生成类上的属性为准，实例赋值查的就是它 */
    instance_editable: boolean
    blueprint_read_only: boolean
    category: string
    tooltip?: string
    expose_on_spawn?: boolean
    replication?: string
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSetBlueprintVariableMetaTool() {
  return defineV2Tool({
    description: `改蓝图变量在细节面板里的表现：是否暴露给实例、是否只读、分组、提示、是否在 SpawnActor 上暴露。

**建完变量通常还要调一次这个。** blueprint_add_variable 建出来的变量默认不暴露给实例，
只能在图表里用 —— 而大多数变量的意义就是让策划在场景里逐个实例调。

只改你传的字段，没传的原样不动。想只改分组就只传 category。

改完会自动编译一次，实例马上就能按新设置赋值；落盘仍要 ue_save。`,

    inputSchema: SetVariableMetaSchema,

    execute: async (input) => {
      try {
        const params: Record<string, unknown> = {
          blueprint_path: input.blueprint_path,
          name: input.name
        }
        // 只透传真的传了的字段。全量透传会把 undefined 变成 JSON 里的 null，
        // 引擎侧 TryGetBoolField 读到就当成 false，等于用户没传也被改了
        for (const key of [
          'instance_editable',
          'blueprint_read_only',
          'category',
          'tooltip',
          'expose_on_spawn',
          'replication'
        ] as const) {
          if (input[key] !== undefined) params[key] = input[key]
        }

        const response = await callBlueprint<SetVariableMetaResponse>(
          'blueprint.set_variable_meta',
          params,
          '修改变量元数据失败'
        )
        if (isFailure(response)) return response

        const v = response.variable
        const compileErrors = response.compile_error_count ?? 0
        return {
          success: true,
          blueprint_path: response.blueprint_path,
          applied: response.applied,
          variable: v,
          ...(compileErrors > 0 ? { compile_error_count: compileErrors } : {}),
          ...(response.warning ? { warning: response.warning } : {}),
          message:
            `已更新 ${response.name}：${response.applied.join('、')}` +
            (v ? `（现在：实例可编辑=${v.instance_editable}，分组="${v.category}"）` : '') +
            (compileErrors > 0
              ? `。蓝图编译有 ${compileErrors} 个错误，先 blueprint_compile 看清再给实例赋值`
              : '')
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// ── 删变量 ────────────────────────────────────────────────────────────────

const RemoveVariableSchema = z.object({
  blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Hero'),
  name: z.string().describe('要删除的变量名')
})

interface RemoveVariableResponse {
  ok: boolean
  blueprint_path: string
  name: string
  removed: boolean
  note?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createRemoveBlueprintVariableTool() {
  return defineV2Tool({
    description: `删除蓝图成员变量。

**不可逆，而且会波及图表**：引用这个变量的 Get / Set 节点会变成孤儿节点，
删完要 blueprint_compile 一次才能看到哪些图断了。

建错变量时用它收拾，别留着不管 —— 留着的话它会出现在后续每一次
blueprint_describe 里，模型会以为那是有意义的状态。`,

    inputSchema: RemoveVariableSchema,

    execute: async (input) => {
      try {
        const response = await callBlueprint<RemoveVariableResponse>(
          'blueprint.remove_variable',
          { blueprint_path: input.blueprint_path, name: input.name },
          '删除变量失败'
        )
        if (isFailure(response)) return response

        return {
          success: true,
          blueprint_path: response.blueprint_path,
          name: response.name,
          message:
            `已删除变量 ${response.name}。` +
            '引用它的节点现在是孤儿节点，跑一次 blueprint_compile 看看哪些图断了。'
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// ── 组件事件 ──────────────────────────────────────────────────────────────

const ComponentEventSchema = z.object({
  blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
  component_name: z
    .string()
    .describe('组件名，就是组件面板里显示的那个名字。用 blueprint_describe 可以查到'),
  action: z
    .enum(['list', 'add'])
    .describe('list 列出这个组件能绑哪些事件（连参数签名）；add 在事件图里放一个绑定节点'),
  event_name: z
    .string()
    .optional()
    .describe('要绑的事件名，action=add 时必填。如 OnComponentBeginOverlap'),
  graph_name: z.string().optional().describe('放到哪张图，默认 EventGraph')
})

interface ComponentEventResponse {
  ok: boolean
  blueprint_path: string
  component_name?: string
  component_class?: string
  events?: Array<{ name: string; params: Array<{ name: string; type: string }> }>
  node_id?: string
  event_name?: string
  reused?: boolean
  pins?: Array<{ name: string; dir: string }>
  note?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createBlueprintComponentEventTool() {
  return defineV2Tool({
    description: `列出或绑定组件上的事件（OnComponentBeginOverlap、OnClicked、OnComponentHit 等）。

**所有触发式交互的入口都在这里**：走进触发区就开门、点一下就捡起来、撞到就扣血。

先 action="list" 看这个组件到底能绑什么 —— 事件名很容易记混
（OnComponentBeginOverlap 不是 OnBeginOverlap），而且不同组件类型能绑的不一样。

action="add" 之后返回 node_id 和全部引脚。拿着这个 node_id 直接在
blueprint_apply_graph 的 connections 里当源节点用，把 then 接到你的逻辑上，
不用再读一次图。

**不要用 Tick 每帧算距离来代替它。** 那在性能和正确性上都是错的，
而且组件事件本来就能直接绑。

绑完要 blueprint_compile。`,

    inputSchema: ComponentEventSchema,

    execute: async (input) => {
      try {
        if (input.action === 'add' && !input.event_name) {
          return { success: false, error: 'action=add 时必须提供 event_name' }
        }

        const params: Record<string, unknown> = {
          blueprint_path: input.blueprint_path,
          component_name: input.component_name,
          action: input.action
        }
        if (input.event_name) params.event_name = input.event_name
        if (input.graph_name) params.graph_name = input.graph_name

        const response = await callBlueprint<ComponentEventResponse>(
          'blueprint.component_event',
          params,
          input.action === 'add' ? '绑定组件事件失败' : '列出组件事件失败'
        )
        if (isFailure(response)) return response

        if (input.action === 'list') {
          const events = response.events ?? []
          return {
            success: true,
            component_class: response.component_class,
            events,
            message: events.length
              ? `${input.component_name}（${response.component_class}）可绑 ${events.length} 个事件：` +
                events.map((e) => e.name).join('、')
              : `${input.component_name}（${response.component_class}）没有可绑定的事件。`
          }
        }

        // 引脚原样带回：下一步就是把 then 接到逻辑上、读 OtherActor 之类的数据引脚，
        // 让模型再查一次图是白花一个来回
        return {
          success: true,
          node_id: response.node_id,
          pins: response.pins,
          reused: response.reused,
          message:
            (response.reused
              ? `${input.event_name} 之前已经绑过，复用原节点 `
              : `已绑定 ${input.event_name}，`) +
            `node_id=${response.node_id}。` +
            '在 blueprint_apply_graph 的 connections 里用这个 id 接后续逻辑。'
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// ── 事件分发器 ────────────────────────────────────────────────────────────

const DispatcherParamSchema = z.object({
  name: z.string().describe('参数名，如 Opener'),
  type: z
    .string()
    .describe(
      '参数类型。标量：bool / int / int64 / float / double / string / name / text。' +
        '结构体或枚举直接写名字：Vector / Rotator / Transform / LinearColor / ' +
        '自定义的 MyStruct / EMyEnum（带不带 F、E 前缀都认）。' +
        '对象引用：object / class / soft_object / soft_class，再用 class 指定具体类。'
    ),
  class: z
    .string()
    .optional()
    .describe('type 是 object 或 class 时的具体类，如 Actor、PlayerController。省略默认 Actor')
})

const EventDispatcherSchema = z.object({
  blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
  action: z
    .enum(['add', 'list'])
    .describe('add 建一个新的；list 列出这个蓝图已有的（连参数签名一起回）'),
  name: z
    .string()
    .optional()
    .describe('分发器名，action=add 时必填。习惯以 On 开头，如 OnDoorOpened'),
  params: z
    .array(DispatcherParamSchema)
    .optional()
    .describe('分发器参数。省略就是无参分发器，只通知「发生了」不带数据')
})

interface EventDispatcherResponse {
  ok: boolean
  blueprint_path: string
  name?: string
  created?: boolean
  params?: string[]
  dispatchers?: Array<{
    name: string
    params: Array<{ name: string; type: string; class?: string }>
  }>
  note?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createBlueprintEventDispatcherTool() {
  return defineV2Tool({
    description: `建 / 列蓝图的事件分发器（Event Dispatcher）。

事件分发器是蓝图里做解耦的标准手段：门开了就广播一下，谁关心谁自己订阅，
门不需要知道有谁在听。

**没有它就只能写成轮询** —— 让监听方每帧去问「门开了吗」。那在性能和正确性上
都是错的，但没有分发器时模型只能这么写。所以凡是「A 发生了，B 要响应」的需求，
先建一个分发器。

建完怎么用（apply_graph 里放节点）：
- 广播：class="CallDispatcher"、member_name="<名字>"
- 订阅：class="BindEvent"、member_name="<名字>"，它那根红色委托线（引脚真名
  **Delegate**）要接一个**签名一致的自定义事件** —— class="CustomEvent"，
  把这里的 params 照抄进它的 params（名字随意，类型和顺序必须一致）。
  分发器无参时事件也不要参数。
- 退订：class="UnbindEvent"；全部退订：class="UnbindAllEvents"。
- 别人身上的分发器写 member_name="BP_Chest.OnChestOpened"，Target 引脚接那个 Actor。

编辑器标题那种写法也认（class="Function" + member_name="Call <名字>" /
"Bind Event to <名字>"），但上面的 class 写法更短、报错也更准。

改完要 blueprint_compile。`,

    inputSchema: EventDispatcherSchema,

    execute: async (input) => {
      try {
        if (input.action === 'add' && !input.name) {
          // 在本地拦下来而不是发出去。引擎侧也会拒，但多一次往返，
          // 而这个错误本地完全判得出来
          return { success: false, error: 'action=add 时必须提供 name' }
        }

        const params: Record<string, unknown> = {
          blueprint_path: input.blueprint_path,
          action: input.action
        }
        if (input.name) params.name = input.name
        if (input.params?.length) params.params = input.params

        const response = await callBlueprint<EventDispatcherResponse>(
          'blueprint.event_dispatcher',
          params,
          input.action === 'add' ? '创建事件分发器失败' : '列出事件分发器失败'
        )
        if (isFailure(response)) return response

        if (input.action === 'list') {
          const list = response.dispatchers ?? []
          return {
            success: true,
            dispatchers: list,
            message: list.length
              ? `${input.blueprint_path} 有 ${list.length} 个事件分发器：${list
                  .map((d) => `${d.name}(${d.params.map((p) => p.name).join(', ')})`)
                  .join('、')}`
              : `${input.blueprint_path} 还没有任何事件分发器。`
          }
        }

        return {
          success: true,
          name: response.name,
          params: response.params ?? [],
          message:
            `已创建事件分发器 ${response.name}` +
            (response.params?.length ? `（参数：${response.params.join('、')}）` : '（无参数）') +
            `。广播放一个 class="CallDispatcher"、member_name="${response.name}" 的节点，` +
            `订阅用 class="BindEvent"、member_name="${response.name}"（它的 Delegate 引脚接一个签名一致的 CustomEvent）。`
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// ── 函数签名 ──────────────────────────────────────────────────────────────

const FunctionSignatureSchema = z.object({
  blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
  graph_name: z.string().describe('函数名（就是函数图的名字），如 OpenDoor'),
  action: z
    .enum(['add_param', 'remove_param', 'remove_function'])
    .describe('加参数 / 删参数 / 整个删掉这个函数'),
  param: z
    .object({
      name: z.string().describe('参数名'),
      type: z
        .string()
        .optional()
        .describe(
          'add_param 必填：bool / int / float / double / string / name / text / ' +
            'vector / rotator / transform / object / class'
        ),
      class: z.string().optional().describe('type 是 object 或 class 时的具体类，省略默认 Actor'),
      direction: z
        .enum(['in', 'out'])
        .optional()
        .describe('in（默认）是输入参数，out 是返回值。out 要求这个函数已经有返回值节点')
    })
    .optional()
    .describe('action 是 add_param / remove_param 时必填')
})

interface FunctionSignatureResponse {
  ok: boolean
  blueprint_path: string
  graph_name: string
  action: string
  inputs?: Array<{ name: string; type: string; class?: string }>
  outputs?: Array<{ name: string; type: string; class?: string }>
  note?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createBlueprintFunctionSignatureTool() {
  return defineV2Tool({
    description: `改蓝图函数的参数表，或者整个删掉一个函数。

**建函数时就能带参数**：blueprint_create_function 的 inputs / outputs 是能用的。
这个工具管的是**建完之后再改**：加一个参数、删一个参数、或者整个删掉这个函数。

三个动作：
- add_param：加一个参数。direction="out" 加的是返回值
- remove_param：删一个参数
- remove_function：删掉整个函数（不可逆，调用它的地方会变成孤儿节点）

改完签名之后，**已有的调用点需要重新连线** —— 跑一次 blueprint_compile
看哪些图断了。

事件图（EventGraph）不是函数，删不了，传它会被拒。`,

    inputSchema: FunctionSignatureSchema,

    execute: async (input) => {
      try {
        // 本地判得出来的错就别浪费一次往返
        if (input.action !== 'remove_function' && !input.param) {
          return { success: false, error: `action=${input.action} 时必须提供 param` }
        }
        if (input.action === 'add_param' && !input.param?.type) {
          return { success: false, error: 'add_param 时 param.type 必填' }
        }

        const params: Record<string, unknown> = {
          blueprint_path: input.blueprint_path,
          graph_name: input.graph_name,
          action: input.action
        }
        if (input.param) params.param = input.param

        const response = await callBlueprint<FunctionSignatureResponse>(
          'blueprint.function_signature',
          params,
          '修改函数签名失败'
        )
        if (isFailure(response)) return response

        if (input.action === 'remove_function') {
          return {
            success: true,
            message:
              `已删除函数 ${input.graph_name}。` +
              '调用它的节点现在是孤儿节点，跑一次 blueprint_compile 看看哪些图断了。'
          }
        }

        const inputs = response.inputs ?? []
        const outputs = response.outputs ?? []
        return {
          success: true,
          inputs,
          outputs,
          message:
            `${input.graph_name} 现在的签名：` +
            `输入 ${inputs.map((p) => `${p.name}:${p.type}`).join('、') || '（无）'}，` +
            `输出 ${outputs.map((p) => `${p.name}:${p.type}`).join('、') || '（无）'}。` +
            '已有的调用点需要重新连线，跑一次 blueprint_compile 确认。'
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// ── 改父类 ────────────────────────────────────────────────────────────────

const SetParentClassSchema = z.object({
  blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Hero'),
  parent_class: z
    .string()
    .describe('新的父类名，如 Character、Pawn、ActorComponent，或蓝图类的完整路径')
})

interface SetParentClassResponse {
  ok: boolean
  blueprint_path: string
  old_parent: string
  new_parent: string
  compile_errors?: number
  compile_warnings?: number
  messages?: string[]
  note?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSetBlueprintParentClassTool() {
  return defineV2Tool({
    description: `改蓝图的父类（Reparent）。

「这个 BP 应该继承 Character 而不是 Actor」原来建完就改不了，只能重建一个再把图抄过去，
而抄图这件事本身就容易出错。

**改父类大概率会打断一批节点** —— 引用旧父类成员的节点会失效。所以这个工具
改完会自动编译一次，把错误和警告一起回给你。返回里 compile_errors > 0 时
不要当成功往下做，先看 messages 里断了什么。

循环继承（改成自己的子类）会被拒绝。`,

    inputSchema: SetParentClassSchema,

    execute: async (input) => {
      try {
        const response = await callBlueprint<SetParentClassResponse>(
          'blueprint.set_parent_class',
          { blueprint_path: input.blueprint_path, parent_class: input.parent_class },
          '改父类失败'
        )
        if (isFailure(response)) return response

        const errors = response.compile_errors ?? 0
        const warnings = response.compile_warnings ?? 0
        const messages = response.messages ?? []

        // 编译错误顶到最前面。埋在 JSON 里的话模型会略过去，
        // 然后拿着一个编不过的蓝图继续往下做
        const lines = [`父类：${response.old_parent} → ${response.new_parent}。`]
        if (errors > 0) {
          lines.unshift(`⚠️ 改完编译有 ${errors} 个错误，这个蓝图现在是坏的：`)
          lines.push(...messages.slice(0, 10))
        } else if (warnings > 0) {
          lines.push(`编译通过，有 ${warnings} 个警告。`)
        } else {
          lines.push('编译通过，没有错误。')
        }

        return {
          success: true,
          old_parent: response.old_parent,
          new_parent: response.new_parent,
          compile_errors: errors,
          compile_warnings: warnings,
          messages,
          message: lines.join('\n')
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
