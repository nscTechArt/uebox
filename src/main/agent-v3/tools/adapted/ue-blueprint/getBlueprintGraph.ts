/**
 * Read one Blueprint graph and return its nodes, pins and connections.
 *
 * 返回的是**能直接照着改图的那份数据**：完整 node_id、每个引脚的名字方向和
 * 具体类型、节点坐标。以前这里为了省 token 删过引脚也删过类型，而系统提示词
 * 又要求「改图前必须来这里拿真实的 node id 和引脚名」—— 让它来拿，
 * 拿回去的却是删过一遍的，猜错了还查不出原因。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import {
  describeGraphNameMiss,
  explainGraphNameMiss,
  extractBlueprintGraphRefs,
  pickPreferredGraphName,
  type GraphNameMiss
} from './graphDiscovery'
import { resolveBlueprintPathInput } from './resolveBlueprintPath'
import { PLUGIN_UPDATE_HINT } from '../project/pluginUpdateHint'
import type { ArchiveSpec } from '../../defineTool'

const GetBlueprintGraphSchema = z.object({
  blueprint_path: z
    .string()
    .describe(
      'Required Blueprint path, for example "/Game/Blueprints/BP_Logic" or the short name "BP_Logic".'
    ),
  graph_name: z
    .string()
    .optional()
    .describe(
      'Optional graph name. Defaults to EventGraph or the best available graph. ' +
        'Graphs inside other graphs are addressed by path: "AnimGraph/Locomotion" (a state machine), ' +
        '"AnimGraph/Locomotion/Idle" (inside a state), "AnimGraph/Locomotion/Idle->Walk" (a transition rule).'
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Paging: index of the first node to return. Pass the next_offset of the previous page.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Paging: nodes per page. Omit to read the whole graph; a graph too large to send in one ' +
        'response is paged automatically and the result says how to continue.'
    )
})

export interface BlueprintGraphPinInfo {
  name: string
  dir: 'Input' | 'Output'
  category: string
  sub_category: string
  sub_category_object?: string
  is_array: boolean
  is_reference: boolean
  is_const: boolean
  friendly_name?: string
  /** 引脚上的字面量。三个槽位对应 UE 的三种落值方式，都可能缺席 */
  default_value?: string
  default_object?: string
  default_text?: string
  /** 这个引脚连到了哪些引脚 —— 图里的连线只在这里，没有顶层的 connections */
  linked_to?: Array<{ node_id?: string; pin_name?: string; dir?: string }>
}

export interface BlueprintGraphNodeInfo {
  node_id: string
  class: string
  title: string
  pos_x: number
  pos_y: number
  pins: BlueprintGraphPinInfo[]
  /**
   * 把这个节点重建出来要填的参数 —— 直接对应 blueprint_apply_graph 的入参。
   *
   * `class` 和 `title` 都不够：前者是引擎类名（K2Node_CallFunction），
   * 后者是**本地化**的显示名（"打印字符串"），两个都说不出它调的是哪个函数。
   * 没有这两个字段，「读回来改一改写回去」只能读、写不回去。
   */
  write_as?: string
  member_name?: string
  target_class?: string
  struct_type?: string
  /**
   * 自定义事件的参数表。带上它，读回来的自定义事件才写得回去 ——
   * 只回 member_name 的话，重写那一轮参数会全部消失，连在那些引脚上的线跟着断。
   */
  params?: Array<Record<string, unknown>>
  /** 自定义事件的复制模式（RPC）。只在事件确实复制时出现 */
  replication?: string
  reliable?: boolean
  /**
   * Timeline 的曲线本体：时长、循环、每条轨道的关键帧和插值方式。
   *
   * 引脚说得出「有一条 Alpha 输出」，说不出它是怎么插值的。少了这一段，
   * 「读回来改一改写回去」在 Timeline 上只能靠猜重打一条曲线，
   * 把用户在编辑器里拉过的切线整条盖掉。
   */
  timeline?: Record<string, unknown>
  /**
   * 注释框专有：文字、框体大小、框住了哪些节点。
   *
   * `nodes_under_comment` 来自引擎的 `NodesUnderComment`，**只在用户拖动或
   * 缩放过这个框之后才有**，所以可能是空的。空的时候按 x/y/width/height
   * 算几何包含关系 —— 那几个字段一定有。
   */
  comment_text?: string
  node_width?: number
  node_height?: number
  font_size?: number
  nodes_under_comment?: string[]
  /** 动画节点、状态、转换的设置项（只回改过的），原样填回 apply_graph 的 settings */
  settings?: Record<string, unknown>
  /** 状态机 / 状态 / 混合空间图这类节点里面那张图的路径，拿去当 graph_name */
  sub_graph?: string
  /** StateAlias 专有 */
  aliased_states?: string[]
  global_alias?: boolean
}

/** 状态机那一页的一条转换 */
export interface StateMachineTransitionInfo {
  from: string
  to: string
  node_id: string
  rule_graph?: string
  custom_blend_graph?: string
  settings?: Record<string, unknown>
}

export interface GetBlueprintGraphResponse {
  ok: boolean
  blueprint_path: string
  graph_name: string
  /** 动画图才有：anim_graph / state_machine / state / conduit / transition / custom_blend */
  graph_kind?: string
  /** 函数图里声明了局部变量才有；VariableGet / VariableSet 直接写这些名字 */
  local_variables?: Array<Record<string, unknown>>
  nodes: BlueprintGraphNodeInfo[]
  /** 状态机那一页才有 */
  transitions?: StateMachineTransitionInfo[]
  entry_state?: string
  links?: Array<Record<string, unknown>>
  connections?: Array<Record<string, unknown>>
  /** 分页读时才有；旧插件不认 offset / limit，整张回 */
  total_node_count?: number
  offset?: number
  next_offset?: number
  [key: string]: unknown
}

/**
 * 整张图超过收包上限时，第一页先给这么多节点；还超就退到小页再试一次。
 * 只试两次：旧插件不认 limit，每试一次编辑器都要把整张大图再序列化、再发一遍
 */
const AUTO_PAGE_NODES = 150
const FALLBACK_PAGE_NODES = 25

function isResponseTooLarge(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'E_MESSAGE_TOO_LARGE'
}

/**
 * 读一页图。没点名 limit 就先整张读，整张超过收包上限（512KB）再自动改成分页。
 *
 * 以前大图只回一句「响应过大」，而这个工具没有任何分页参数 —— 真机上一张 UI 背包的
 * EventGraph 707KB，agent 整个任务都没读到它，也不知道自己少读了东西（2026-10-13 反馈）。
 */
async function fetchGraphPage(
  blueprintPath: string,
  graphName: string,
  page: { offset?: number; limit?: number }
): Promise<{ response: GetBlueprintGraphResponse | null; autoPaged: boolean }> {
  const wsService = serviceManager.getWebSocketService()
  const call = (limit?: number): Promise<GetBlueprintGraphResponse | null> =>
    wsService.callRequest<GetBlueprintGraphResponse>(
      'blueprint.get_graph',
      {
        blueprint_path: blueprintPath,
        graph_name: graphName,
        ...(limit ? { offset: page.offset ?? 0, limit } : {})
      },
      getTargetConnectionId(),
      30000
    )

  const explicitLimit = page.limit ?? (page.offset ? AUTO_PAGE_NODES : undefined)
  if (explicitLimit) {
    try {
      return { response: await call(explicitLimit), autoPaged: false }
    } catch (error) {
      // 接着读的那页也可能太大（上一页就是退到小页才读出来的）
      if (!isResponseTooLarge(error)) throw error
    }
    if (explicitLimit > FALLBACK_PAGE_NODES) {
      try {
        return { response: await call(FALLBACK_PAGE_NODES), autoPaged: true }
      } catch (error) {
        if (!isResponseTooLarge(error)) throw error
      }
    }
    throw tooLargeEvenPaged(graphName)
  }

  try {
    return { response: await call(), autoPaged: false }
  } catch (error) {
    if (!isResponseTooLarge(error)) throw error
  }
  for (const limit of [AUTO_PAGE_NODES, FALLBACK_PAGE_NODES]) {
    try {
      return { response: await call(limit), autoPaged: true }
    } catch (error) {
      if (!isResponseTooLarge(error)) throw error
    }
  }
  throw tooLargeEvenPaged(graphName)
}

function tooLargeEvenPaged(graphName: string): Error {
  return new Error(
    `Graph ${graphName} is too large to send even ${FALLBACK_PAGE_NODES} nodes at a time. ` +
      'The UnrealAgentLink plugin in this project probably predates graph paging. ' +
      PLUGIN_UPDATE_HINT
  )
}

/** 分页读到的那一页，告诉模型这是第几到第几个、怎么接着读 */
export function describeGraphPage(
  response: GetBlueprintGraphResponse,
  autoPaged: boolean,
  pagingRequested: boolean
): Record<string, unknown> {
  if (response.total_node_count === undefined) {
    // 旧插件不认 offset / limit，回的是整张图；不说的话模型会拿 offset 再读一遍同样的东西。
    // 状态机那一页插件本来就不分页，不算
    if (!pagingRequested || response.graph_kind === 'state_machine') return {}
    return {
      page_note:
        'The plugin ignored offset/limit (it predates graph paging), so this is the whole graph — ' +
        'do not request further pages. ' +
        PLUGIN_UPDATE_HINT
    }
  }
  const first = response.offset ?? 0
  const count = response.nodes?.length ?? 0
  if (response.total_node_count === 0) {
    return { total_node_count: 0, offset: first, page_note: 'This graph is empty (0 nodes).' }
  }
  if (count === 0 && first >= response.total_node_count) {
    return {
      total_node_count: response.total_node_count,
      offset: first,
      page_note: `offset ${first} is past the end: this graph has ${response.total_node_count} nodes. Start again from offset=0.`
    }
  }
  const last = first + count
  const more = response.next_offset !== undefined
  const head = autoPaged
    ? `This graph is too large to read in one response, so it was paged automatically: `
    : ''
  const note =
    head +
    `nodes ${first}–${last - 1} of ${response.total_node_count}. ` +
    (more
      ? `Call again with offset=${response.next_offset}, limit=${count} for the next page. `
      : 'This is the last page. ') +
    'linked_to / connections may point at node_ids on other pages.'
  return {
    total_node_count: response.total_node_count,
    offset: first,
    ...(more ? { next_offset: response.next_offset } : {}),
    page_note: note
  }
}

/**
 * 一个引脚交给模型的样子。
 *
 * ## 为什么不再删引脚、不再只留 category
 *
 * 原来这里做两件省 token 的事，两件现在都在拆台：
 *
 * 1. **过滤掉 `self` / `WorldContextObject` / `OutputDelegate`**。它们确实少用，
 *    但少用不等于不用 —— 函数调用节点的 Target 就是 `self`。看不见的引脚，
 *    模型只能猜名字，而系统提示词第一条恰恰是「引脚名不能猜」。
 * 2. **类型只回 `category`**。于是 `Object` 就是 `Object`，分不出是 Actor 还是
 *    Component，两个接不上的引脚在模型眼里长得一模一样，连完了才在编译时报错。
 *
 * 现在把具体类型拼进 `type`（`object(Actor)`、`struct(Vector)`），
 * 数组和引用只在为真时才出现 —— 比原来准，字数也没多多少。
 */
export function describePin(pin: BlueprintGraphPinInfo): Record<string, unknown> {
  return {
    name: pin.name,
    dir: pin.dir,
    type: pin.category === 'exec' ? 'exec' : formatPinType(pin),
    // 界面上显示的名字和 API 认的名字不是一回事，且**只在不一致时**才带上。
    //
    // Branch 是典型：两个出口界面写着 true / false，真名是 then / else
    // （见 K2Node_IfThenElse::AllocateDefaultPins，那两个是 PinFriendlyName）。
    // 只写真名的话，模型照着自己在编辑器里见过的样子填 "True"，
    // 拿到一句「pin not found」却不知道自己错在哪 —— 真机验证里就是这么踩的。
    //
    // 一致的时候不带，省 token 也少噪音。
    ...(pin.friendly_name && pin.friendly_name.toLowerCase() !== pin.name.toLowerCase()
      ? { displayed_as: pin.friendly_name }
      : {}),
    ...(pin.is_array ? { is_array: true } : {}),
    ...(pin.is_reference ? { is_reference: true } : {}),
    // 引脚上的字面量。不回的话，「读回来改一改写回去」会把图里所有常量
    // 静默清空 —— 调用方根本不知道它们存在过。字段名和 apply_graph 的
    // pin_defaults 对得上，抄过去就能原样写回。
    ...(pin.default_value ? { default_value: pin.default_value } : {}),
    ...(pin.default_object ? { default_value: pin.default_object } : {}),
    ...(pin.default_text ? { default_value: pin.default_text } : {})
  }
}

/** `object(Actor)` / `struct(Vector)` / `float`：有具体类型就带上，没有就只回大类 */
function formatPinType(pin: BlueprintGraphPinInfo): string {
  const specific = pin.sub_category_object || pin.sub_category
  return specific ? `${pin.category}(${specific})` : pin.category
}

/**
 * 从每个引脚的 `linked_to` 推出图里的连线。
 *
 * **只从输出引脚这一侧发出**：一根线在两端的 `linked_to` 里各出现一次，
 * 两侧都收就会得到两条一模一样的连线。方向也靠这个定 ——
 * 输出 → 输入才是蓝图里连线的实际语义。
 */
export function deriveConnectionsFromPins(
  nodes: BlueprintGraphNodeInfo[] | undefined
): Array<Record<string, unknown>> {
  const connections: Array<Record<string, unknown>> = []
  for (const node of nodes ?? []) {
    for (const pin of node.pins ?? []) {
      if (pin.dir !== 'Output') continue
      for (const link of pin.linked_to ?? []) {
        if (!link?.node_id) continue
        connections.push({
          from_node_id: node.node_id,
          from_pin: pin.name,
          to_node_id: link.node_id,
          to_pin: link.pin_name
        })
      }
    }
  }
  return connections
}

/**
 * 一个节点交给模型的样子。
 *
 * 抽出来是因为「哪些字段算重建说明」这件事只该有一处 —— 少带一个字段，
 * 「读回来改一改写回去」就会在那类节点上**静默变形**：模型自以为只改了一处，
 * 写回去却把别的东西弄丢了，而返回里没有任何迹象。
 */
function describeNodeForModel(node: BlueprintGraphNodeInfo): Record<string, unknown> {
  return {
    id: node.node_id,
    class: node.class,
    title: node.title,
    // 重建这个节点要填的参数。缺席表示这类节点还翻译不回去 ——
    // 那就只能连它（用 id），不能重写它。
    ...(node.write_as ? { write_as: node.write_as } : {}),
    ...(node.member_name ? { member_name: node.member_name } : {}),
    ...(node.target_class ? { target_class: node.target_class } : {}),
    ...(node.struct_type ? { struct_type: node.struct_type } : {}),
    // 自定义事件的参数表。丢了它，写回去的事件就没有引脚，
    // 原本接在那些引脚上的线也跟着断
    ...(node.params?.length ? { params: node.params } : {}),
    // 复制模式同理：丢了它，写回去的 RPC 就变回了普通事件，联机时悄悄失效
    ...(node.replication ? { replication: node.replication } : {}),
    ...(node.reliable ? { reliable: true } : {}),
    // Timeline 的曲线。字段名和 apply_graph 的 timeline 块对得上，抄过去就能写回
    ...(node.timeline ? { timeline: node.timeline } : {}),
    // 坐标要留着：放新节点时得知道往哪儿放，不然新节点全叠在原点上
    pos_x: node.pos_x,
    pos_y: node.pos_y,
    // 注释框：带上文字和框体大小，否则它在模型眼里就是一个没有引脚的空节点，
    // 既看不出它说了什么，也看不出它框住了哪一段逻辑
    ...(node.comment_text !== undefined ? { comment_text: node.comment_text } : {}),
    ...(node.node_width ? { node_width: node.node_width } : {}),
    ...(node.node_height ? { node_height: node.node_height } : {}),
    ...(node.nodes_under_comment?.length ? { nodes_under_comment: node.nodes_under_comment } : {}),
    // 动画节点 / 状态的设置和子图。设置丢了，写回去就变回默认值（循环、播放速率、混合时长）；
    // 子图路径是下一步要写的地方（状态机里的状态、状态里的动画）
    ...(node.settings && Object.keys(node.settings).length > 0 ? { settings: node.settings } : {}),
    ...(node.sub_graph ? { sub_graph: node.sub_graph } : {}),
    ...(node.aliased_states ? { aliased_states: node.aliased_states } : {}),
    ...(node.global_alias ? { global_alias: true } : {}),
    // 状态机那一页的状态不带引脚（连线就是转换，见 connections）
    ...(node.pins ? { pins: node.pins.map(describePin) } : {})
  }
}

/**
 * 状态机那一页的连线 = 转换，形状和 apply_graph 的 connections 一致：
 * { from: 状态名, to: 状态名, settings }。入口那一根是 { from: "Entry", to: 入口状态 }。
 * 读回来改一改原样写回，同一对状态之间已有的转换会被就地修改而不是再叠一条。
 */
export function stateMachineConnections(
  response: GetBlueprintGraphResponse
): Array<Record<string, unknown>> {
  const connections: Array<Record<string, unknown>> = []
  if (response.entry_state) {
    connections.push({ from: 'Entry', to: response.entry_state })
  }
  for (const transition of response.transitions ?? []) {
    connections.push({
      from: transition.from,
      to: transition.to,
      ...(transition.settings && Object.keys(transition.settings).length > 0
        ? { settings: transition.settings }
        : {}),
      node_id: transition.node_id,
      ...(transition.rule_graph ? { rule_graph: transition.rule_graph } : {}),
      ...(transition.custom_blend_graph
        ? { custom_blend_graph: transition.custom_blend_graph }
        : {})
    })
  }
  return connections
}

/** 插件报的是「图找不到」，而不是蓝图找不到或别的错 */
export function isGraphNotFound(response: unknown): boolean {
  const error = (response as { error?: unknown } | null)?.error
  return typeof error === 'string' && /^Graph not found/i.test(error)
}

/**
 * 图名没找到时问一次图列表，查清是写了短名、有歧义、插件太旧，还是真没有。
 * 列表也拿不到就返回 null，调用方照用插件的原报错。
 */
export async function lookupMissedGraphName(
  blueprintPath: string,
  graphName: string
): Promise<GraphNameMiss | null> {
  try {
    const listed = await serviceManager
      .getWebSocketService()
      .callRequest<
        Record<string, unknown>
      >('blueprint.list_graphs', { blueprint_path: blueprintPath }, getTargetConnectionId(), 20000)
    if (!listed?.ok) return null
    return explainGraphNameMiss(graphName, extractBlueprintGraphRefs(listed))
  } catch {
    return null
  }
}

/** 换不成完整路径时接在原报错后面的那句 */
export function graphNameMissHint(graphName: string, miss: GraphNameMiss | null): string {
  if (!miss || miss.kind === 'resolved') return ''
  return describeGraphNameMiss(graphName, miss, PLUGIN_UPDATE_HINT)
}

/**
 * 图太大时的存档声明（见 `core/resultArchive.ts`），由注册表挂到工具上。
 *
 * 一个节点带全部引脚约 660 字符，真实会话里一张图到过 12.8 万字符、212 根连线就占 3.2 万。
 * 目录**不带引脚** —— 这正是文件头记的那次教训的反面：当年是悄悄删，这次是收起来，
 * 目录页明说没有引脚、连线前按 id 去 result_query 取完整节点。
 *
 * 节点排在连线前面：预算先花在「图里有什么」上，连线按节点 id 查得到。
 * 连线的目录列同时写了普通图（from_node / to_pin）和状态机页（from / to）两种形状，
 * 目录只取实际有的列。
 */
export const BLUEPRINT_GRAPH_ARCHIVE: ArchiveSpec = {
  lists: {
    nodes: ['id', 'class', 'title', 'write_as', 'member_name', 'sub_graph', 'pos_x', 'pos_y'],
    connections: ['from_node', 'from_pin', 'to_node', 'to_pin', 'from', 'to']
  }
}

export const __testing = {
  stateMachineConnections,
  describePin,
  formatPinType,
  deriveConnectionsFromPins,
  describeNodeForModel
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createGetBlueprintGraphTool() {
  return defineV2Tool({
    description: `Read one Blueprint graph — the first half of read-edit-write.

It auto-discovers a preferred graph when graph_name is omitted.

Each node comes back with its full node_id, class, title, position and every pin.
A pin's "type" is the concrete type, not just the category: "exec", "float",
"object(Actor)", "struct(Vector)". Two pins only connect when their types match,
so read the type before wiring rather than assuming from the pin name.

Always wire using "name". When a pin also has "displayed_as", that is the label the
Unreal editor shows and the API does NOT accept it — e.g. a Branch node's outputs are
displayed as true/false but are named then/else.

"default_value" is the literal currently sitting on that pin. When you rewrite this
graph with blueprint_apply_graph, carry those values across into pin_defaults —
anything you leave out is reset.

To change this graph, edit what you read here and write the whole thing back with
blueprint_apply_graph — that tool takes the same node/connection shape this one
returns. Do not try to mutate the graph one node at a time; there is no tool for it.

IMPORTANT — you write one vocabulary and read back another.
"class" is the engine class name (K2Node_IfThenElse) and "title" is localised to the
editor's language ("分支"), so neither is what you pass back to blueprint_apply_graph.
Use "write_as" and "member_name" for that — they are the exact values that recreate
the node. Match nodes by "class", never by title.

A node with no "write_as" cannot be recreated by this tool set. You can still wire to
it using its id, but do not try to rewrite it.

A Timeline node also comes back with "timeline": its length, loop/autoplay flags and
every float track's keyframes, including each key's interpolation. That is the curve
itself — pins cannot show it. Carry it back into blueprint_apply_graph unchanged
except for what you mean to change; a key whose interp is "user" or "break" was
hand-tuned in the editor and its arrive/leave tangents must survive the round trip.

Animation Blueprints: AnimGraph, a state machine, a state's inside and a transition rule
are each their own graph, addressed by path (graph_kind says which). Animation nodes and
states come back with "settings" (only what differs from the defaults) and, when they
contain a graph, "sub_graph" — the path to read or write next. A state machine page
returns states as nodes and its transitions as connections ({ from, to, settings,
rule_graph }), the same shape blueprint_apply_graph takes there.

Large graphs come back as a catalogue: "archived" gives a ref (e.g. "r3"), nodes carry only
id / class / title / write_as / member_name / position — NO pins — and connections may be
cut short. Before wiring or setting pin defaults, fetch the full nodes you touch with
result_query {"ref":"r3","list":"nodes","where":{"id":[...]}}; find a node's wires with
{"list":"connections","where":{"from_node":"<id>"}} (or to_node). Adding nodes and wiring
them to existing ids needs only those nodes. Rewriting the whole graph (clear_existing)
needs every node: page through result_query first.`,
    inputSchema: GetBlueprintGraphSchema,
    execute: async (input) => {
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

        const explicitGraphName = input.graph_name?.trim()
        const candidateGraphNames: string[] = []
        const triedGraphNames: string[] = []

        if (explicitGraphName) {
          candidateGraphNames.push(explicitGraphName)
        } else {
          try {
            const listResponse = await wsService.callRequest<Record<string, unknown>>(
              'blueprint.list_graphs',
              { blueprint_path: blueprintPath },
              getTargetConnectionId(),
              20000
            )
            if (listResponse?.ok) {
              const graphRefs = extractBlueprintGraphRefs(listResponse)
              const preferred = pickPreferredGraphName(graphRefs)
              if (preferred) candidateGraphNames.push(preferred)
              for (const ref of graphRefs) {
                if (!candidateGraphNames.includes(ref.name)) {
                  candidateGraphNames.push(ref.name)
                }
              }
            }
          } catch {
            // Ignore and fall back to describe/default names.
          }

          try {
            const describeResponse = await wsService.callRequest<Record<string, unknown>>(
              'blueprint.describe',
              { blueprint_path: blueprintPath },
              getTargetConnectionId(),
              20000
            )
            if (describeResponse?.ok) {
              const graphRefs = extractBlueprintGraphRefs(describeResponse)
              const preferred = pickPreferredGraphName(graphRefs)
              if (preferred && !candidateGraphNames.includes(preferred)) {
                candidateGraphNames.push(preferred)
              }
              for (const ref of graphRefs) {
                if (!candidateGraphNames.includes(ref.name)) {
                  candidateGraphNames.push(ref.name)
                }
              }
            }
          } catch {
            // Ignore and fall through to common defaults.
          }

          for (const fallbackGraph of ['EventGraph', 'ConstructionScript']) {
            if (!candidateGraphNames.includes(fallbackGraph)) {
              candidateGraphNames.push(fallbackGraph)
            }
          }
        }

        let response: GetBlueprintGraphResponse | null = null
        let lastFailure: { error?: string; code?: number; details?: unknown; raw?: unknown } = {}

        let autoPaged = false
        const page = { offset: input.offset, limit: input.limit }
        const pagingRequested = input.offset !== undefined || input.limit !== undefined

        for (const graphName of candidateGraphNames) {
          triedGraphNames.push(graphName)
          const fetched = await fetchGraphPage(blueprintPath, graphName, page)
          const graphResponse = fetched.response
          autoPaged = fetched.autoPaged
          if (graphResponse?.ok) {
            response = graphResponse
            break
          }

          const msg =
            (graphResponse as Record<string, unknown> | null)?.error ||
            (graphResponse as Record<string, unknown> | null)?.message ||
            'No response or ok=false'
          const code =
            (graphResponse as { __rpc?: { code?: number }; code?: number } | null)?.__rpc?.code ??
            (graphResponse as { code?: number } | null)?.code
          const details = (graphResponse as { details?: unknown } | null)?.details
          lastFailure = { error: String(msg), code, details, raw: graphResponse }

          if (explicitGraphName) {
            break
          }
        }

        // 点名的图找不到：多半是只写了状态 / 状态机的名字，查清楚后换成完整路径再读一次
        let missHint = ''
        if (!response && explicitGraphName && isGraphNotFound(lastFailure.raw)) {
          const miss = await lookupMissedGraphName(blueprintPath, explicitGraphName)
          if (miss?.kind === 'resolved') {
            triedGraphNames.push(miss.path)
            const fetched = await fetchGraphPage(blueprintPath, miss.path, page)
            const retried = fetched.response
            autoPaged = fetched.autoPaged
            if (retried?.ok) {
              response = retried
            } else {
              lastFailure = {
                error: String(
                  (retried as Record<string, unknown> | null)?.error ?? 'No response or ok=false'
                ),
                raw: retried
              }
            }
          }
          missHint = graphNameMissHint(explicitGraphName, miss)
        }

        if (!response) {
          return {
            success: false,
            error:
              `Failed to get Blueprint graph: ${lastFailure.error || 'No response or ok=false'}` +
              (missHint ? `\n${missHint}` : ''),
            code: lastFailure.code,
            details: lastFailure.details,
            raw: lastFailure.raw,
            tried_graph_names: triedGraphNames
          }
        }

        const graphNodes = response.nodes?.map(describeNodeForModel)

        if (response.graph_kind === 'state_machine') {
          const connections = stateMachineConnections(response)
          return {
            success: true,
            blueprint_path: response.blueprint_path,
            graph_name: response.graph_name,
            graph_kind: response.graph_kind,
            node_count: response.nodes?.length ?? 0,
            ...describeGraphPage(response, autoPaged, pagingRequested),
            nodes: graphNodes,
            connection_count: connections.length,
            connections,
            tried_graph_names: triedGraphNames
          }
        }

        /**
         * 连线从 `pins[].linked_to` 推出来。
         *
         * ## 为什么不能只读顶层的 connections
         *
         * 这里原来是 `response.connections ?? response.links ?? []` —— 而插件
         * **两个都不发**。真机上 get_graph 的顶层字段只有
         * `blueprint_path / graph_name / nodes / ok`，连线信息全在每个引脚的
         * `linked_to` 里。
         *
         * 后果是每一张图都报 `connection_count: 0`，不管它实际连了多少根。
         * 而「读回来改一改整图写回去」是这套接口的主要用法 ——
         * 调用方看到 0 条连线，写回去的就是一张**完全断开**的图。
         * 真机验证时抓到的：图里明明有 4 个连线端点，工具报 0。
         *
         * 顶层字段仍然优先读（插件哪天补上就自动用），只是不再指望它存在。
         */
        const rawConnections =
          response.connections ?? response.links ?? deriveConnectionsFromPins(response.nodes)

        const graphConnections = rawConnections
          .map((connection) => ({
            from_node:
              (connection.from_node_id as string) ||
              (connection.source_node_id as string) ||
              (connection.from_node as string) ||
              (connection.source as string) ||
              '',
            from_pin:
              (connection.from_pin as string) ||
              (connection.source_pin as string) ||
              (connection.from as string) ||
              (connection.source_pin_name as string) ||
              '',
            to_node:
              (connection.to_node_id as string) ||
              (connection.target_node_id as string) ||
              (connection.to_node as string) ||
              (connection.target as string) ||
              '',
            to_pin:
              (connection.to_pin as string) ||
              (connection.target_pin as string) ||
              (connection.to as string) ||
              (connection.target_pin_name as string) ||
              ''
          }))
          .filter((connection) => connection.from_node && connection.to_node)

        // 这里原来还回一个 `node_list`（`id 前 8 位:标题` 拼成的一行）和一个
        // `summary`（"Graph X has N nodes."）。两个都是 Router 时代的摘要行：
        // 当时专家看不到完整 `nodes`，只能靠这一行认路。
        //
        // 现在 `nodes` 就在同一个返回里，摘要行等于把同一份数据抄第二遍；
        // 更糟的是那个 8 位短 id **不是真的 node_id**，模型很容易照抄进下一次
        // 调用，然后得到一句「找不到节点」而不知道问题出在哪。
        return {
          success: true,
          blueprint_path: response.blueprint_path,
          graph_name: response.graph_name,
          ...(response.graph_kind ? { graph_kind: response.graph_kind } : {}),
          ...(response.local_variables ? { local_variables: response.local_variables } : {}),
          node_count: response.nodes?.length ?? 0,
          ...describeGraphPage(response, autoPaged, pagingRequested),
          nodes: graphNodes,
          connection_count: graphConnections.length,
          connections: graphConnections,
          tried_graph_names: triedGraphNames
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
