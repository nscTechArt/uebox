/**
 * `blueprint_apply_graph` —— 一次调用写完一整片蓝图逻辑。
 *
 * ## 它取代了什么
 *
 * 五个节点级写图工具：`add_node` / `connect_pins` / `set_pin_value` /
 * `add_timeline` / `build_logic`。
 *
 * （`delete_node` 后来回来了，另外还加了 `disconnect_pins` —— 它们是**减法**，
 * 不和这里抢「怎么写一片逻辑」，所以不构成当初要避免的那种选择负担。）
 *
 * 那套接口是**命令式**的：加一个节点、连一根线、设一个值。命令式的每一步都
 * 依赖当前图的状态，而状态只能查回来 —— 于是调用方被迫「查一个、写一个、
 * 再查一个」地往返。真机评测里，写十个节点花了三十分钟、三十多个来回。
 *
 * 更糟的是它还有六个功能重叠的写工具可选，选错一个就得回退重来。
 *
 * ## 它是什么形状
 *
 * **声明式整图**：你描述这张图应该长成什么样，插件负责让它变成那样。
 * 和 `blueprint_get_graph` 的返回结构对称 —— 读回来改一改就能写回去，
 * 就是 Read/Edit/Write 那个循环。
 *
 * 三条保证：
 *
 *   1. **全有或全无**。插件端包在一个 UE 事务里，任何一条失败就整体回滚，
 *      不编译、不落盘。失败后图和调用前一模一样，改完重发整份即可 ——
 *      不需要先搞清楚上次留下了什么残骸。
 *   2. **编译错误按你给的 id 回传**，不是引擎 GUID。改哪个节点一目了然。
 *   3. **布局在这里算**。分层布局（`blueprint-layout/blueprintLayout.ts`）把坐标
 *      算好再发下去，图是顺着执行流读的。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import {
  autoLayoutBlueprintNodes,
  BlueprintLayoutConnection,
  BlueprintLayoutNode
} from '../../../../blueprint-layout/blueprintLayout'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/**
 * 节点类型。
 *
 * ## 为什么是开放字符串而不是 enum
 *
 * 这里原来是个九项的 `z.enum`，里面有四项（CallFunction / VariableGet /
 * VariableSet / K2Node）插件端根本不认 —— 而 `CallFunction` 恰恰写在工具
 * 自己的示例里。模型照着示例填，被插件顶回来，然后放弃批量。
 *
 * 枚举给了「这些都能用」的承诺，而承诺兑现与否在另一个仓库的 C++ 里，
 * 两边迟早再次漂移。所以不再用 enum 锁死：类型名在描述里列清楚，
 * 插件端认不认由插件端说了算，认不出来会连**它支持哪些**一起回。
 *
 * 真正的兜底是 `raw_class`：具名类型没覆盖到的节点，直接点名 UK2Node 子类。
 */
const NodeDefinitionSchema = z.object({
  id: z.string().describe('本次调用内的节点标识，连线和编译诊断都用它引用。随便起，只要不重复'),
  class: z
    .string()
    .describe(
      '节点类型。常用：Event、EnhancedInputAction、Function、VariableGet、VariableSet、Branch、Sequence、' +
        'Cast、SpawnActor、CustomEvent、Select、MakeArray、MakeStruct、BreakStruct、Self、Timeline、' +
        'CallDispatcher、BindEvent、UnbindEvent、UnbindAllEvents、' +
        'ForLoop、WhileLoop、DoOnce、Gate、FlipFlop、IsValid、ForEachLoop'
    ),
  member_name: z
    .string()
    .optional()
    .describe(
      '成员名。CallDispatcher / BindEvent / UnbindEvent / UnbindAllEvents 写事件分发器名' +
        '（别人身上的写 BP_Chest.OnChestOpened）；' +
        'Function 必须是 ClassName.FunctionName（如 KismetSystemLibrary.PrintString，' +
        '用 blueprint_search_nodes 查到的 member_name 可直接填）；' +
        'Event 用 ReceiveBeginPlay / ReceiveTick；EnhancedInputAction 写 Input Action 资产名或路径（IA_Jump）；' +
        'VariableGet 写变量名、组件名（如 Light）或父类变量名；' +
        'Timeline 写 Timeline 自己的名字；控制节点可省略'
    ),
  timeline: z
    .object({
      length: z.number().optional().describe('总时长（秒）。省略则跟着最后一个关键帧走'),
      length_mode: z
        .enum(['length', 'last_keyframe'])
        .optional()
        .describe(
          '时长取自 length 还是最后一个关键帧。省略就不动现有设置 —— ' +
            'last_keyframe 模式下 length 是被引擎忽略的'
        ),
      loop: z.boolean().optional().describe('循环播放'),
      autoplay: z.boolean().optional().describe('BeginPlay 自动播放'),
      tracks: z
        .array(
          z.object({
            name: z.string().describe('轨道名，同时是节点上的输出引脚名，如 Alpha'),
            keys: z
              .array(
                z.object({
                  time: z.number(),
                  value: z.number(),
                  interp: z
                    .enum(['linear', 'constant', 'auto', 'user', 'break'])
                    .optional()
                    .describe(
                      '这一帧之后怎么插值，省略＝linear（直线）。' +
                        'auto 是缓入缓出的 S 形，constant 是阶梯。' +
                        'user / break 是用户手拉过切线的，必须同时给 arrive_tangent 和 leave_tangent'
                    ),
                  arrive_tangent: z
                    .number()
                    .optional()
                    .describe('入切线斜率，只在 interp 是 user/break 时有意义，要和 leave 一起给'),
                  leave_tangent: z.number().optional().describe('出切线斜率，和 arrive 一起给')
                })
              )
              .optional()
              .describe(
                '关键帧。如 [{time:0,value:0},{time:1,value:1,interp:"auto"}]。' +
                  '给了就整条替换现有关键帧；省略则不动这条轨道现有的帧（新轨道就是空的）'
              )
          })
        )
        .optional()
        .describe(
          'float 轨道。开门、渐变这类插值都靠它，没有轨道的 Timeline 只有 Update/Finished 可用'
        )
    })
    .optional()
    .describe('Timeline 专用：轨道和播放参数'),
  /**
   * 自定义事件的参数表。
   *
   * 没有它，自定义事件只能是无参的 —— 而「绑定到事件分发器」这条最常见的用法
   * 恰恰要求事件签名和分发器一致。2026-09-16 的用户反馈就卡在这里：
   * 模型试了 params、inputs 两种写法，两种都被静默丢掉（schema 里没有这个字段，
   * zod 会把它剥掉），于是建出来的事件永远没有引脚可连。
   */
  params: z
    .array(
      z.object({
        name: z.string().describe('参数名，也就是事件节点上那个输出引脚的名字'),
        type: z
          .string()
          .describe(
            'bool / int / int64 / float / double / string / name / text / byte，' +
              '或结构体、枚举名（Vector、Transform、EMyEnum），' +
              '或 object / class / soft_object / soft_class（配 object_class 用）'
          ),
        object_class: z
          .string()
          .optional()
          .describe(
            'type 是 object/class/soft_object/soft_class 时的类名，如 Actor、PlayerController'
          ),
        container: z.enum(['array', 'set', 'map']).optional().describe('容器类型，省略表示单个值')
      })
    )
    .optional()
    .describe(
      'CustomEvent 专用：事件参数。要绑事件分发器就先用 blueprint_event_dispatcher（action=list）' +
        '查到分发器的 params，逐个照抄过来 —— 名字可以不同，类型和顺序必须一致'
    ),
  target_class: z.string().optional().describe('Cast / SpawnActor 的目标类'),
  struct_type: z.string().optional().describe('MakeStruct / BreakStruct 的结构体'),
  raw_class: z
    .string()
    .optional()
    .describe(
      '兜底：直接点名一个 UK2Node 子类（如 K2Node_MakeMap）。' +
        '只适用于不需要额外配置就能自己长出引脚的节点'
    ),
  first_index: z.number().int().optional().describe('ForLoop 起始索引'),
  last_index: z.number().int().optional().describe('ForLoop 结束索引（9 表示循环 10 次）'),
  pin_defaults: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      '引脚字面量，如 { "InString": "Hello", "bPrintToScreen": "true" }。' +
        '别为了一个常量单独建变量节点。已连线的引脚不能再设默认值'
    ),
  position: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('节点坐标。省略则自动布局，通常不用填')
})

const ConnectionSchema = z.object({
  from: z.string().describe('源：「节点id.引脚名」，如 "begin.then"'),
  to: z.string().describe('目标：「节点id.引脚名」，如 "print.execute"')
})

const ApplyGraphSchema = z
  .object({
    blueprint_path: z.string().describe('蓝图路径，如 /Game/Blueprints/BP_Door'),
    /**
     * 允许为空，但那只是**补线**这一种用法。
     *
     * 正常写图一次把整片逻辑发完 —— 空 nodes 是给「两个已有节点之间少了一根线」
     * 准备的，不是让调用方一个节点一个节点地攒图。
     */
    nodes: z.array(NodeDefinitionSchema).describe('这一批要建的节点。只补连线时可以是空数组'),
    connections: z.array(ConnectionSchema).optional().describe('节点之间的连线'),
    graph_name: z
      .string()
      .optional()
      .describe(
        '图表名，默认 EventGraph。必须是已存在的图；新函数图先用 blueprint_create_function 建'
      ),
    clear_existing: z
      .boolean()
      .optional()
      .describe('先清空图里的现有节点再写（函数入口/出口保留）。重写整片逻辑时用'),
    compile: z.boolean().optional().describe('写完是否编译，默认 true')
  })
  // 空 nodes + clear_existing 就是「把整张图清空，什么都不建」。
  // 那多半不是调用方想要的，而代价是一整张图 —— 在发出去之前就拦掉
  .refine((input) => !(input.clear_existing === true && input.nodes.length === 0), {
    message:
      'clear_existing: true 配上空的 nodes 会把整张图清空、什么都不建。' +
      '真要清空就把想保留的节点一起发过来；只补连线时不要传 clear_existing。',
    path: ['nodes']
  })

type ApplyGraphInput = z.infer<typeof ApplyGraphSchema>

interface ApplyGraphResponse {
  ok: boolean
  rolled_back?: boolean
  blueprint_path: string
  graph_name: string
  created_count: number
  connection_count: number
  removed_count?: number
  compiled: boolean
  compile_error_count?: number
  compile_warning_count?: number
  /**
   * 这次改动能不能被用户 Ctrl+Z 撤销。
   *
   * UE 的事务在 `GEditor` 缺席或正忙时会**静默降级成空操作**，那种情况下
   * 用户撤不回来。如实回给调用方，让它知道要不要提醒用户先存一份。
   */
  undoable?: boolean
  /**
   * 引擎替我们做了、但调用方没要求的事：顶掉了别的连线、插了转换节点、
   * 提升了引脚类型。不往上带的话，调用方回头读图会发现和自己写的不一样，
   * 却不知道是谁改的。
   */
  warnings?: string[]
  nodes?: Array<{
    id: string
    node_id: string
    class: string
    reused?: boolean
    pins: Array<Record<string, unknown>>
  }>
  diagnostics?: Array<{ severity: string; message: string; node?: string; node_id?: string }>
  errors?: string[]
  message?: string
}

/**
 * 图里已有内容的下边界。
 *
 * 布局只认得**这一次要建的节点**，对图里已经有什么一无所知。分多次往同一张图
 * 里写时，每一批都从原点重新铺一遍，于是后一批盖在前一批身上 —— 真机上
 * `Event ActorBeginOverlap` 就这么压在了 `Set Actor Rotation` 上。
 *
 * 而「往已有逻辑中间插一段」现在是常规用法（连线可以直接引用图里已有节点的
 * GUID），所以这条必须处理。
 *
 * 拿不到就返回 undefined —— 读图失败不该让写图整个失败，大不了退回旧行为。
 */
async function existingContentBottom(
  blueprintPath: string,
  graphName: string | undefined
): Promise<number | undefined> {
  try {
    const params: Record<string, unknown> = { blueprint_path: blueprintPath }
    if (graphName) params.graph_name = graphName

    const graph = await serviceManager.getWebSocketService().callRequest<{
      ok?: boolean
      nodes?: Array<{ pos_y?: number }>
    }>('blueprint.get_graph', params, getTargetConnectionId(), 20000)

    const nodes = graph?.nodes ?? []
    if (nodes.length === 0) return undefined

    const bottom = Math.max(...nodes.map((node) => node.pos_y ?? 0))
    return Number.isFinite(bottom) ? bottom : undefined
  } catch {
    return undefined
  }
}

/** 新一批和已有内容之间留的空档，够看出是两段逻辑 */
const LAYOUT_BLOCK_GAP = 400

/**
 * 在 app 侧用 ELK 算好坐标再发下去。
 *
 * 插件端也有一套兜底排布（按行铺开），但它不看连线方向 —— 一张顺着执行流
 * 读的图和一张按创建顺序铺开的图，可读性差得远。坐标算在这边，插件端那套
 * 只在完全没有布局信息时兜底。
 */
async function withLayout(input: ApplyGraphInput): Promise<ApplyGraphInput> {
  const needsLayout = input.nodes.some((node) => node.position === undefined)
  if (!needsLayout) return input

  const layoutNodes: BlueprintLayoutNode[] = input.nodes.map((node, index) => ({
    id: node.id,
    name: node.member_name || node.class,
    type: node.class,
    x: node.position?.x ?? index * 320,
    y: node.position?.y ?? 120
  }))
  const layoutConnections: BlueprintLayoutConnection[] = (input.connections || []).map((conn) => ({
    from: conn.from,
    to: conn.to
  }))

  const layouted = await autoLayoutBlueprintNodes(layoutNodes, layoutConnections)
  const positions = new Map(layouted.map((node) => [node.id, node]))

  // clear_existing 会先清空，那就没有「已有内容」可让；否则整批往下挪开
  const bottom = input.clear_existing
    ? undefined
    : await existingContentBottom(input.blueprint_path, input.graph_name)
  const offsetY = bottom === undefined ? 0 : bottom + LAYOUT_BLOCK_GAP

  return {
    ...input,
    nodes: input.nodes.map((node) => {
      const position = positions.get(node.id)
      return position ? { ...node, position: { x: position.x, y: position.y + offsetY } } : node
    })
  }
}

/**
 * 失败时把「下一步该怎么办」写进返回。
 *
 * 回滚是这里最反直觉的一点：调用方很容易以为「至少建了几个」，然后去查图、
 * 试图在残骸上接着干。说清楚图没动过、重发整份即可，能省掉一整轮试探。
 */
/**
 * 两根 wildcard 引脚连不上时，指的路必须是**能走通的那条**。
 *
 * 插件这条命令是「先把所有连线验一遍，再一次性连」（`UAL_BlueprintCommands.cpp`
 * 里 `CanCreateConnection` 那一段，注释写了为什么：一条都没连的时候才能整批放弃）。
 * 代价是同一批里的类型传播看不见 —— ForEach 的 Array 引脚在第 13 条连上
 * `TArray<AActor>` 之后才定型，而它的 Array Element 是在引擎的
 * `NotifyPinConnectionListChanged` 里跟着定型的，那时第 15 条早就验过了。
 * 于是 Array Element 还是 wildcard，接 Cast 的 Object 引脚当场被拒。
 *
 * 模型看到「wildcard -> wildcard 不允许」会以为自己写错了图，去改节点类型 ——
 * 图其实是对的，只是要分两次发。这句话把那一轮试探省掉。
 */
function describeWildcardRetry(errors: string[]): string {
  const hasWildcardPair = errors.some(
    (line) => (line.match(/wildcard/gi) ?? []).length >= 2 && line.includes('cannot connect')
  )
  if (!hasWildcardPair) return ''
  return (
    '\n\n提示：报错里两端都是 wildcard 的连线，多半不是你写错了。' +
    'ForEach 的 Array Element、数组函数的 TargetArray 这类引脚要等**上游连线真的连上**' +
    '才定型，而这条命令是整批先验后连，同一批里看不到定型结果。' +
    '这种图要**分两批发**：把那几根线摘掉、其余的先发一次，' +
    '再用 nodes=[] 只带这几根线发第二次 —— 那时上游已经定型，就能连上。'
  )
}

function describeFailure(response: ApplyGraphResponse): string {
  const errors = response.errors ?? []
  const head =
    response.rolled_back === true
      ? '整批已回滚，蓝图没有任何改动。修正后重新提交完整的 nodes + connections（不要只补失败的那几个）。'
      : '写入失败。'
  return (
    `${head}\n\n${errors.map((line, i) => `${i + 1}. ${line}`).join('\n')}` +
    describeWildcardRetry(errors)
  )
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createApplyBlueprintGraphTool() {
  return defineV2Tool({
    description: `一次性写完一整片蓝图逻辑：节点、连线、引脚默认值、布局、编译。

这是**唯一**的蓝图写图工具。不要试图一个节点一个节点地建 —— 把整片逻辑
一次描述完，比分多次写更准，也更省时间。

## 上一轮没写完，接着写也是整批

图写到一半断了（超时、编译报错、你自己判断该停），**不要逐个补节点**。
先 blueprint_get_graph 读回图里现在真实有什么，然后把**剩下的那一批**
一次性发过来 —— 一百个节点写了五十个，这一次就发另外五十个，
连线里用 node_id（GUID）接到已有的那五十个上。

一次调用建五十个节点和建一个节点，代价几乎一样；分五十次补则是五十倍。

nodes 传空数组表示「只补连线」—— 那是给「两个已有节点之间少了一根线」用的，
不是让你一个节点一个节点地攒图。

## 用之前先查

引脚名和函数名**不能猜**。用 blueprint_search_nodes 查到确切的 member_name
和引脚签名，再一次性写下来。查一次能拿到十几个函数的完整签名，
比建一个节点看一眼引脚快得多。

改已有的图就先 blueprint_get_graph 读回来 —— 它的返回结构和这里的入参
是对称的，读回来改一改就能写回去。

## 全有或全无

任何一条失败（节点类型不认、引脚名不对、类型连不上），整批回滚，
蓝图一点不动。所以失败之后**重发完整的一份**，不要只补失败的那几个。

## 变量要先建，组件直接引用

VariableGet / VariableSet 引用的变量必须已经存在，先用
blueprint_add_variable 建。常量不要建变量 —— 直接写 pin_defaults。

**组件也是变量**：VariableGet 的 member_name 写组件名（blueprint_describe 里
components 的 name，如 Light、Mesh）就能拿到组件引用，接着连 SetMaterial /
SetVisibility 之类的 Target。父类声明的变量同样直接写名字。

## 增强输入事件

按键、摇杆这类玩家输入用 class=EnhancedInputAction，member_name 写 Input Action
资产（IA_Jump，或完整路径 /Game/Input/IA_Jump）。不要用 Event 去建它，也不要
raw_class 点名 K2Node_EnhancedInputAction —— 那样建出来的节点没绑资产。
出口引脚：Triggered / Started / Ongoing / Canceled / Completed，值在 ActionValue。
资产名用 ue_input_map 查。

## Timeline

class=Timeline，member_name 是 Timeline 的名字，轨道写在 timeline.tracks 里：

{ "id": "tl", "class": "Timeline", "member_name": "DoorTimeline",
  "timeline": { "length": 1, "tracks": [{ "name": "Alpha",
    "keys": [{ "time": 0, "value": 0 }, { "time": 1, "value": 1, "interp": "auto" }] }] } }

引脚：Play / PlayFromStart / Stop / Reverse / ReverseFromEnd / SetNewTime 是执行入口，
Update 每帧出、Finished 播完出，每条轨道一个同名 float 输出（上例就是 Alpha）。

**曲线形状看 interp**：省略是直线，"auto" 是缓入缓出的 S 形，"constant" 是阶梯。
开门、渐隐这类想要「起步慢、中间快、收尾慢」的，第一帧和最后一帧都写 "auto"。

**已有的 Timeline 可以直接改**：blueprint_get_graph 会把它现在的 length / loop /
autoplay / 每条轨道的关键帧一起回出来，改完连整张图写回来即可。整批失败时
Timeline 会和图一起回滚。轨道是**按名字合并**的：没提到的轨道原样留着，
提到了就整条替换关键帧。想删一条轨道只能去编辑器里删。
interp 是 "user" / "break" 的关键帧是用户手拉过切线的 —— 原样带回去，
别改成 auto，那会把他调好的形状抹平。
它的节点在别的图上时会报错，去那张图写。

## 自定义事件带参数

class=CustomEvent，参数写在 params 里：

{ "id": "ev", "class": "CustomEvent", "member_name": "OnDoorOpened",
  "params": [{ "name": "Opener", "type": "object", "object_class": "Actor" },
             { "name": "Delay", "type": "float" }] }

参数是事件节点的**输出**引脚，名字就是引脚名（上例是 Opener / Delay）。

**绑事件分发器要靠它**：BindEvent 那根红色委托线，接的就是一个签名和分发器
一致的自定义事件。先用 blueprint_event_dispatcher（action=list）查到分发器的
params，把类型和顺序照抄进这里 —— 对不上编译会报签名不匹配。

params 只有 CustomEvent 收。函数图的参数用 blueprint_create_function 的
inputs/outputs，或者 blueprint_function_signature；引擎自带事件（class=Event）
的签名是固定的，改不了。

## 事件分发器：广播和订阅

四个 class，member_name 一律写分发器名本身（**不要**写编辑器标题里的 "Call ..."）：

| class | 干什么 |
|---|---|
| CallDispatcher | 广播一次 |
| BindEvent | 订阅 |
| UnbindEvent | 退订一个 |
| UnbindAllEvents | 退订全部 |

{ "id": "bind", "class": "BindEvent", "member_name": "OnChestOpened" },
{ "id": "ev", "class": "CustomEvent", "member_name": "OnChestOpened_Handler",
  "params": [{ "name": "Opener", "type": "object", "object_class": "Actor" }] }

连线：把 CustomEvent 的 **OutputDelegate** 引脚接到 BindEvent 的 **Delegate** 引脚
（那根红线）。事件的 params 要和分发器的 params 类型、顺序一致。

**别人身上的分发器**写 member_name="BP_Chest.OnChestOpened"，再把那个 Actor 接到
节点的 Target 引脚上。组件自带的事件（OnComponentBeginOverlap 之类）不走这里，
用 blueprint_component_event。

## 连线写法

{ "from": "节点id.引脚名", "to": "节点id.引脚名" }

执行流是 then（出）→ execute（入）。

**一个执行输出只能接一个节点**（引擎的规矩，不是本工具的限制）。要让一件事
之后依次做两件，加一个 Sequence 节点，用它的 Then_0 / Then_1。给同一个输出
写第二条线不会报错，而是**顶掉第一条**，返回的 warnings 里会说。
输入侧相反：多个输出接同一个执行输入是允许的。

**引脚名要用真名，不是编辑器里显示的那个。** 最容易踩的是 Branch：
它的两个出口在界面上写着 true / false，真名却是 **then / else**
（界面显示的是 PinFriendlyName，API 一律不认）。
拿不准就先 blueprint_search_nodes 或 blueprint_get_graph 查一眼。

**可以连到图里已有的节点**：把 blueprint_get_graph 返回的 node_id（GUID）
当成节点 id 写进 from/to 即可。往已有逻辑中间插一段就靠这个，
不必把整张图重写一遍。

## 引擎可能自作主张

连线时引擎有时会替你做事：顶掉目标引脚上已有的连线（同一个输入引脚只能
接一根）、插一个类型转换节点、或提升引脚类型。这些都会记在返回的
warnings 里 —— **读一下**，否则你以为写成了 A，图里其实是 B。

## 图表必须已存在

graph_name 默认 EventGraph。要写进新的函数图，先用
blueprint_create_function 建出来。本工具不创建图表。`,

    inputSchema: ApplyGraphSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const laidOut = await withLayout(input)

        const params: Record<string, unknown> = {
          blueprint_path: laidOut.blueprint_path,
          nodes: laidOut.nodes,
          connections: laidOut.connections ?? []
        }
        if (laidOut.graph_name) params.graph_name = laidOut.graph_name
        if (laidOut.clear_existing !== undefined) params.clear_existing = laidOut.clear_existing
        if (laidOut.compile !== undefined) params.compile = laidOut.compile

        const response = await wsService.callRequest<ApplyGraphResponse>(
          'blueprint.create_graph',
          params,
          getTargetConnectionId(),
          60000
        )

        if (!response) {
          return { success: false, error: '插件没有响应（blueprint.create_graph）' }
        }

        if (!response.ok) {
          return {
            success: false,
            error: describeFailure(response),
            rolled_back: response.rolled_back === true,
            errors: response.errors
          }
        }

        // 编译错误不算调用失败 —— 图确实写进去了，只是不能编译通过。
        // 报成失败会让调用方以为要重写整张图，实际上多半只需要改一两个节点。
        const compileErrors = response.compile_error_count ?? 0
        const diagnostics = response.diagnostics ?? []
        const warnings = response.warnings ?? []

        // 引擎自作主张做的事要写进 summary，不能只塞在字段里 ——
        // 「顶掉了一条已有连线」这种副作用，看不见就等于没发生过
        const sideEffects =
          warnings.length > 0 ? `，另有 ${warnings.length} 处引擎自动调整（见 warnings）` : ''

        return {
          success: true,
          blueprint_path: response.blueprint_path,
          graph_name: response.graph_name,
          created_count: response.created_count,
          connection_count: response.connection_count,
          ...(response.removed_count ? { removed_count: response.removed_count } : {}),
          compiled: response.compiled,
          nodes: response.nodes,
          ...(diagnostics.length > 0 ? { diagnostics } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          // 事务不可用时这次改动撤不回来，如实说
          ...(response.undoable === false ? { undoable: false } : {}),
          summary:
            `已写入 ${response.created_count} 个节点、${response.connection_count} 条连线` +
            (response.compiled
              ? compileErrors > 0
                ? `，编译有 ${compileErrors} 个错误 —— 看 diagnostics，里面的 node 就是你给的 id`
                : '，编译通过'
              : '，未编译') +
            sideEffects +
            (response.undoable === false ? '。注意：本次改动无法用 Ctrl+Z 撤销' : '')
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
