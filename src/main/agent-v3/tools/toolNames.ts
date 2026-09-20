/**
 * V2 点号工具名 → V3 下划线工具名。
 *
 * **这个模块刻意零依赖。** 工具注册表和 skill 层都要用它，而 skill 层不该为了
 * 一个字符串替换把整棵工具树（electron / @aws-sdk / sharp）拉进自己的依赖图。
 *
 * ## 为什么要改名
 *
 * V2 里蓝图/材质/粒子/Widget 用点号命名（`blueprint.add_node`），但 OpenAI 等
 * 厂商要求工具名匹配 `^[a-zA-Z0-9_-]+$`，点号会被直接拒。
 *
 * ## 为什么光改名不够
 *
 * 旧名字出现在三个地方，都得跟着改，否则模型会照着看到的指示去调一个
 * 不存在的工具：
 *
 *   1. 工具自己的 description（「用 material.get_graph 先拿 node_id」）
 *   2. skill 的 description（常驻 system prompt）
 *   3. skill 的正文与 references/（53 个内置 skill 里有 13 个引用）
 */

/**
 * V2 点号名 → V3 下划线名。
 *
 * 用于把工具描述里的交叉引用一起改掉。手写而不是从 REGISTRATIONS 推导 ——
 * 描述里引用的是 V2 的名字，两者不是一一对应（有些 V2 名字没被 V3 沿用）。
 */
const CROSS_REFERENCE_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  'blueprint.describe': 'blueprint_describe',
  'blueprint.get_graph': 'blueprint_get_graph',
  'blueprint.list_graphs': 'blueprint_describe',
  'blueprint.create': 'blueprint_create',
  'blueprint.create_graph': 'blueprint_apply_graph',
  'blueprint.search_nodes': 'blueprint_search_nodes',
  'blueprint.add_component': 'blueprint_add_component',
  'blueprint.set_property': 'blueprint_set_property',
  'blueprint.compile': 'blueprint_compile',
  'blueprint.compile_all': 'blueprint_compile_all',
  'blueprint.set_node_positions': 'blueprint_tidy_graph',
  'editor.save': 'ue_save',
  'pie.run': 'ue_playtest',
  'editor.get_dirty': 'ue_list_unsaved',
  'level.get_current': 'ue_get_current_level',
  'level.save': 'ue_save_level',
  'level.open': 'ue_open_level',
  'level.new': 'ue_new_level',
  'blueprint.create_function': 'blueprint_create_function',
  'blueprint.add_variable': 'blueprint_add_variable',
  // 已下线的节点级写图工具 —— 指向 blueprint_apply_graph。
  //
  // 它们的名字还散落在 skill 正文和历史工具描述里。删掉映射的话，模型会照着
  // 那些文字去调一个不存在的工具，然后在「工具不存在」和「换个名字再试」
  // 之间空转 —— 而正确答案（整图写入）它本来就有。指过去，读到旧写法也能落到对的工具上。
  'blueprint.add_node': 'blueprint_apply_graph',
  'blueprint.connect_pins': 'blueprint_apply_graph',
  'blueprint.set_pin_value': 'blueprint_apply_graph',
  'blueprint.add_timeline': 'blueprint_apply_graph',
  // 删节点回来了（整图重写代价太大），所以它指向自己而不是 apply_graph
  'blueprint.delete_node': 'blueprint_delete_node',
  'blueprint.disconnect_pins': 'blueprint_disconnect_pins',
  'blueprint.set_comment': 'blueprint_comment',
  'material.create': 'material_create',
  'material.create_instance': 'material_create_instance',
  'material.apply': 'material_apply',
  'material.describe': 'material_describe',
  'material.set_property': 'material_set_property',
  'material.set_param': 'material_set_param',
  'material.get_graph': 'material_get_graph',
  'material.search_nodes': 'material_search_nodes',
  // 和上面蓝图那六个同样的下场：逐节点写图不排版，已下线，指向整图写入。
  // 名字还留在 skill 正文和历史工具描述里，指过去才不会让模型去调一个不存在的工具
  'material.add_node': 'material_apply_graph',
  'material.connect_pins': 'material_apply_graph',
  'material.compile': 'material_compile',
  'material.set_node_value': 'material_set_node_value',
  'material.delete_node': 'material_delete_node',
  'material.set_node_positions': 'material_tidy_graph',
  'widget.get_hierarchy': 'widget_get_hierarchy',
  'widget.create': 'widget_create',
  'widget.add_child': 'widget_add_child',
  'widget.preview': 'widget_preview',
  'widget.make_variable': 'widget_make_variable',
  'widget.set_property': 'widget_set_property',
  // 2026-09-11 两合一（见 registry.ts 的 ue_insights_trace）。旧名还会出现在
  // 历史会话和第三方 skill 里，指过去才不会让模型去调一个不存在的工具。
  // 注意这两个键**没有点号**：rewriteCrossReferences 对键做整词替换，不依赖点号。
  ue_capture_insights_trace: 'ue_insights_trace',
  ue_analyze_insights_trace: 'ue_insights_trace'
})

/**
 * Agent 浏览器的六个工具名。
 *
 * 放在这个零依赖模块里，是因为有三处要用而它们互不相干：注册表补
 * `allToolNames()`、HTTP 调试入口拒绝执行、工具实现本身。任何一处去 import
 * 工具实现，都会把 electron 窗口那套拖进不该有它的依赖图。
 */
export const BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_read',
  'browser_navigate',
  'browser_interact',
  'browser_screenshot',
  'browser_close'
] as const

/**
 * 反问用户那个工具的名字。
 *
 * 和 `BROWSER_TOOL_NAMES` 同样的理由放在这个零依赖模块里：注册表要用它补
 * `allToolNames()`，而**续跑修复**（`core/resume.ts`）也要用它认出「崩溃时
 * 挂在半路的那次提问」。后者去 import 工具实现，会把 zod 和整棵工具树拖进
 * transcript 持久化的依赖图里。
 */
export const ASK_USER_TOOL_NAME = 'ask_user'

/**
 * 换会话归属那个工具的名字。同上，放在零依赖模块里给注册表补名单和风险表用。
 *
 * 它和 `ask_user` / `voice_report` 一样是在 `resolveTools` 里现造的（要宿主给的
 * 通道），进不了 `REGISTRATIONS`。但它是这批现造工具里**唯一一个 `mutating`**，
 * 所以风险表必须专门补上它：渲染层的「本轮改动」按
 * `riskTable[name]`，查不到就跳过，于是一个特意标成 `mutating` 的工具
 * 一次都不会出现在改动清单里 —— 而漏报比没有清单更糟。
 */
export const SET_SESSION_PROJECT_TOOL_NAME = 'set_session_project'

/** 现造工具里唯一的非 safe 那个，风险表照它补 */
export const SET_SESSION_PROJECT_RISK = 'mutating' as const

/**
 * 引擎没连上也要留着的 ue.* 工具。
 *
 * `ue_get_crash_logs` 直接读 `Saved/Crashes` 和 `Saved/Logs` 里的文件，插件连接
 * 只是可选的补充。而它被 ue.* 的过滤规则一刀切掉了 —— **编辑器崩了的时候正是
 * 连接断开的时候**，用户问「刚才为什么崩了」，模型手里恰好没有那个工具，
 * 只能回一句「请先连接虚幻引擎」。
 *
 * `ue_session_health` 同理，而且更直接：它回答的就是「到底连没连上」。
 * 把它按 `ue.*` 一刀切掉的话，恰恰在唯一需要它的场景里它不在 ——
 * 模型只能退回去 shell 里 `tasklist` 数进程，再拿别的引擎工具反复试探。
 *
 * 这条豁免名单只放「不依赖 RPC 就能完成主要工作」的工具。
 *
 * 和上面两个常量同样的理由放在这个零依赖模块里：`core/createAgent.ts` 按它
 * 挑工具，对外 MCP 服务按它标 `projectScoped`（外部调用方据此判断这次要不要
 * 带工程路径）。抄成两份的话，加一个离线工具时必然只改一处。
 */
export const OFFLINE_UE_TOOLS: ReadonlySet<string> = new Set([
  'ue_get_crash_logs',
  'ue_session_health'
])

/** 这个名字是不是浏览器工具 */
export function isBrowserToolName(name: string): boolean {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * 把描述里的 V2 工具名换成 V3 的。
 *
 * 不做这一步，模型会照着描述去调 `material.get_graph`，而注册的是
 * `material_get_graph` —— 表现为「模型反复调用不存在的工具」。
 */
export function rewriteCrossReferences(text: string): string {
  let out = text
  for (const [from, to] of Object.entries(CROSS_REFERENCE_RENAMES)) {
    // 转义点号，避免它匹配任意字符；整词匹配，避免 `foo_bar` 命中 `foo`
    out = out.replace(new RegExp(`\\b${from.replace('.', '\\.')}\\b`, 'g'), to)
  }
  return out
}
