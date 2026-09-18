/**
 * MCP 状态 → 系统提示词里的一段。
 *
 * ## 为什么要有这个文件
 *
 * 提示词里原来只有一句写死的话：
 *
 *   > MCP servers and plugins the user has configured may add further tools;
 *   > those are prefixed with `mcp_`.
 *
 * 它在**每一种情况下都是错的或者没用的**：
 *
 *   - 用户一个 server 都没配 —— 白花 token 说一件不存在的事
 *   - 用户配了但连不上 —— 模型看不到 `mcp_filesystem_*`，于是回答
 *     「我没有访问文件系统的能力」。**这是一句假话**：能力是配了的，
 *     只是那个 server 没起来。用户按这个回答去排查，方向从一开始就是错的。
 *   - 用户配了而且连上了 —— 模型只能从工具名前缀猜来源，说不清
 *     「这个能力是你装的 xxx 提供的」
 *
 * 「工具不在」和「工具本该在但坏了」是两件事，模型只有被告知才分得清。
 * 这一段就是把运行时的真实状态讲给它听。
 *
 * ## 为什么放在提示词而不是做成一个工具
 *
 * 做成 `mcp_status` 工具的话，模型只有在**想到要查**的时候才会查 ——
 * 而它答「我没有这个能力」的时候恰恰是不觉得有什么好查的。
 * 这类信息必须常驻，而且很便宜：没配 server 时一个字都不占。
 */

import { isEpicServerId } from './epicToolsets'
import type { McpServerStatus } from './types'

/** 一条 server 的英文摘要。提示词全英文，见 createAgent.ts 的说明 */
function describe(status: McpServerStatus): string {
  if (status.disabled) return `- \`${status.id}\`: disabled by the user in settings.`

  if (status.connected) {
    const name = status.serverName ? ` (${status.serverName})` : ''
    const engine = isEpicServerId(status.id) ? " — Unreal Engine's own built-in toolsets" : ''
    return `- \`${status.id}\`${name}: connected, ${status.toolCount} tool(s), prefixed \`mcp_${status.id}_\`.${engine}`
  }

  // 原因原样带上。这是用户唯一能拿去排查的东西，概括一下反而没用了
  return `- \`${status.id}\`: FAILED TO CONNECT — ${status.error ?? 'no reason reported'}`
}

/**
 * 生成 MCP 那一段。没有任何 server 时返回空串。
 *
 * 返回值以 `\n` 开头（若非空），调用方直接拼进提示词即可。
 */
export function buildMcpSection(statuses: McpServerStatus[] = []): string {
  if (statuses.length === 0) return ''

  // 停用的一并算进来：对用户来说「本该有的能力现在没有」是同一件事，
  // 模型的错误反应（「我没有这个能力」）也是同一个
  const unavailable = statuses.filter((s) => !s.connected)
  const lines = [
    '',
    'MCP servers configured by the user (these add tools beyond the built-in ones):',
    ...statuses.map(describe)
  ]

  // 引擎内置 server 不讲清楚用法就等于没接：模型只看到 3 个工具名，
  // 猜不到后面还挂着约 900 个，会直接判定「这个 server 没什么用」。
  if (statuses.some((s) => s.connected && isEpicServerId(s.id))) {
    lines.push(
      '',
      "A server marked as Unreal Engine's own toolsets exposes only 3 tools directly (`list_toolsets`, `describe_toolset`, `call_tool`), but roughly 900 engine tools sit behind them — Niagara, PCG, animation and Sequencer, MetaHuman, Gameplay Ability System, StateTree, UMG, physics, and more.",
      "To use them: call `list_toolsets` to see what exists, `describe_toolset` to get a toolset's tool names and input schemas, then dispatch through `call_tool`. Do not conclude a capability is missing without checking `list_toolsets` first.",
      // 这里只写**核实过**的理由。初稿还写了「接了资产快照和撤销」——
      // 查下去 `core/assetSnapshot.ts` 的 IPC handler 根本没有调用方，
      // 那是一句假话，而且是写给模型当决策依据的假话。
      "Prefer this project's own built-in `ue.*` tools when both could do the job — they work on Unreal Engine 5.0 through 5.8, they do not need the Python plugin, and their arguments are schema-validated. Reach for the engine toolsets for things the built-in tools do not cover.",
      "These toolsets only exist on Unreal Engine 5.8 and newer, and they require the project's Python plugin. If a call fails because Python is unavailable, say so plainly instead of retrying."
    )
  }

  if (unavailable.length > 0) {
    // 这三句是整个改动的重点。模型的默认反应是「工具不在 = 我没这个能力」，
    // 必须明确告诉它这里的正确反应是什么。
    lines.push(
      '',
      'A server listed above as FAILED or disabled contributes no tools right now.',
      'If the user asks for something such a server would have handled, do NOT say you lack the capability — that is wrong and sends them looking in the wrong place.',
      'Say which server is unavailable, quote the reason above, and point them at Settings → MCP.'
    )
  }

  return `${lines.join('\n')}\n`
}
