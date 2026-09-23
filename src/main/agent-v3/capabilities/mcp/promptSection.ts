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
 * 这类信息必须常驻，而且很便宜：没配 server 时只有两句话，见 `NO_SERVER_LINES`。
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
 * 设置页能一键装上的集成，写给模型看的说法。
 *
 * 模型的默认反应是「工具列表里没有 = 我没这个能力」，而盒子的设置页里
 * 就摆着一个一键接入的按钮 —— 真机上用户说「我装了 Blender，你连一下」，
 * 它回一句「我没有连 Blender 的工具」，**那是假话**，还把用户推向了
 * 完全错误的方向（去换别的客户端）。
 *
 * 只写接入口在哪，不写怎么用 —— 真接上之后 `describe` 会把 server 和工具数
 * 讲清楚，这几句的唯一任务是让模型别把「现在没有」说成「不可能有」。
 */
export const BLENDER_INSTALLABLE =
  'Blender (the official Blender Lab MCP, giving Blender modelling and a UE round-trip)'

/**
 * 设置页此刻真的能一键装上的东西。
 *
 * 两道筛子，缺一句话就变成假话：
 *
 *   - **平台。** 安装脚本只有 Windows 和 macOS 有（同 `blenderSetup.ts` 的
 *     `summarizeState`）。Linux 也是发行目标，在那儿把模型指到一个不存在的
 *     按钮前面，和它原来说「做不到」一样是错的，只是换了个方向错。
 *   - **已经连上了就不必再提。** 那时 `describe` 已经把工具数讲清楚了。
 *     按 id 里有没有 `blender` 认 —— 只用来压掉一句提示，认错了也不伤人。
 */
export function installableIntegrations(
  statuses: McpServerStatus[],
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== 'win32' && platform !== 'darwin') return []
  if (statuses.some((s) => s.connected && /blender/i.test(s.id))) return []
  return [BLENDER_INSTALLABLE]
}

/**
 * 收尾：把「可以一键装什么」和「怎么再接一台」接在后面。两处出口都要走它。
 *
 * 第二句（"下一条消息"）不能省：工具清单每条消息开头装配一次，`connect_mcp_server`
 * 接进来的工具本轮不在清单里。不明说的话，模型接完就去调，拿到「工具不存在」，
 * 然后把一次**成功**的接入报成失败 —— 用户以为白忙了，其实配置已经好了。
 * 工具自己的返回值里也写了这件事，这里是给那一步之前的规划用的。
 */
function finish(lines: string[], installable: string[], canConnect: boolean): string {
  /*
   * 手里没有 `connect_mcp_server` 就不提它（Ask / 只读模式、用户在设置里关了、子任务白名单）。
   * 提了模型就会去调一个不存在的工具，或者答应用户一件做不到的事
   */
  if (canConnect) {
    lines.push(
      '',
      'To connect another server the user names, call `connect_mcp_server` with its launch command or URL (a bare port works); it probes first and only saves a config that actually handshakes.',
      'Tools from a server connected that way arrive on the NEXT user message, not in the turn that added it.'
    )
  }

  if (installable.length > 0) {
    lines.push(
      '',
      `Settings → MCP can install these for the user in one click: ${installable.join('; ')}.`,
      'So do NOT tell the user such a capability is impossible here — say it is not connected yet and point them at Settings → MCP.'
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * 生成 MCP 那一段。
 *
 * ## 两个参数是两件独立的事实，不要再合成一个
 *
 * 第一版把「可以一键装什么」挂在 `statuses.length === 0` 上。那个判据错了两次：
 *
 *   - **漏报。** `statuses` 里还有引擎自动发现的和插件带来的 server
 *     （`index.ts` 把三份合并成一份）。开着 UE 5.8 工程的用户长度不为 0，
 *     于是这段话永远到不了他 —— 而他正是会来问「连一下 Blender」的那个人。
 *   - **误报。** `ensureConnected()` 失败时会吞掉异常、返回空列表；那时候
 *     断言「你一个都没配」是对着一个配置好好的用户说假话。
 *
 * 所以现在分开：`statuses` 只管报已有 server 的真实状态，`installable` 由
 * 调用方按「这个平台有没有、装没装过」单独算出来，两者互不影响。
 *
 * `statuses` 传 `undefined` 表示**根本没有 MCP 管理器**（不知道），
 * 和「有管理器但一条都没配」是两回事 —— 前者一个字都不说。
 *
 * 返回值以 `\n` 开头（若非空），调用方直接拼进提示词即可。
 */
export function buildMcpSection(
  statuses?: McpServerStatus[],
  installable: string[] = [],
  /** 这一轮手里有没有 `connect_mcp_server`。没有就不教它去调 */
  canConnect = true
): string {
  if (!statuses) return ''
  if (statuses.length === 0 && installable.length === 0) return ''

  if (statuses.length === 0) {
    // 措辞是「没有连上的」而不是「没配过」：发现流程失败时这里也会是空列表，
    // 那时候「你一个都没配」是假话，而「现在没有连上的」两种情况都成立
    return finish(['', 'No MCP servers are connected right now.'], installable, canConnect)
  }

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

  return finish(lines, installable, canConnect)
}
