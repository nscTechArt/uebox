/**
 * `uebox team guard --hook` —— 混合团队制作人的 PreToolUse 守卫。
 *
 * 混合团队里制作人（Claude Code）只协调，活由盒子里的队员干（docs/混合团队设计-2026-10-24.md
 * 第 2 节「不让制作人自己动手」）。盒子拦得住它经盒子 MCP 调的写工具，拦不住 Claude Code 自己的
 * 文件工具和 shell，这一层由 hook 拦：
 *
 * - Write / Edit / MultiEdit / NotebookEdit：一律不许。
 * - Bash：只许单条 `uebox …`（绑团队、查交付闸），不许拼接别的命令。
 * - Task / Agent：只许起 `uebox-acceptor`（验收员）。
 * - 盒子的 MCP：只许制作人那条（`uebox-producer`）和验收员那条（`uebox-acceptor`）。再接一条完整的
 *   盒子连接，制作人手上就有了全套写工具。别家的 MCP 不管。
 *
 * 读文件、搜索、联网这些不拦：Fable 保留 Claude Code 自带的读和查（设计稿第 5 节「公平性」）。
 * 拒绝时按 Claude Code 的约定回 `permissionDecision: deny`，放行时什么都不输出。
 */

/** 制作人那条盒子连接、验收员那条盒子连接（插件里 `.mcp.json` 和 agents 里的名字） */
const PRODUCER_SERVER = 'uebox-producer'
const ACCEPTOR_SERVER = 'uebox-acceptor'
const ACCEPTOR_AGENT = 'uebox-acceptor'

const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit'
])

/** 像是另一条盒子连接的 MCP server 名（`unreal-box`、`uebox`、插件里的 `plugin_uebox_…`） */
const BOX_SERVER = /unreal[-_]?box|uebox/i

/** shell 里能把第二条命令接上去的写法 */
const CHAINING = /[;&|`<>\n]|\$\(/

export interface GuardDecision {
  deny: boolean
  reason: string
}

const allow = (reason: string): GuardDecision => ({ deny: false, reason })
const deny = (reason: string): GuardDecision => ({ deny: true, reason })

export function decideGuard(toolName: string, toolInput: unknown): GuardDecision {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<
    string,
    unknown
  >

  if (FILE_WRITE_TOOLS.has(toolName)) {
    return deny(
      'In an Unreal Box hybrid team the producer does not edit files. Put the change in a team_send to a teammate.'
    )
  }

  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (/^uebox(\s|$)/.test(command) && !CHAINING.test(command)) return allow('uebox 命令')
    return deny(
      'In an Unreal Box hybrid team the producer only runs single `uebox …` commands (for example `uebox team use <team id>`). Work on the project goes to teammates through team_send.'
    )
  }

  if (toolName === 'Task' || toolName === 'Agent') {
    const agent = typeof input.subagent_type === 'string' ? input.subagent_type : ''
    if (agent === ACCEPTOR_AGENT || agent.endsWith(`:${ACCEPTOR_AGENT}`)) return allow('验收员')
    return deny(
      `In an Unreal Box hybrid team the only subagent is ${ACCEPTOR_AGENT}. Teammates run inside Unreal Box: hire with team_hire and give work with team_send.`
    )
  }

  const mcp = /^mcp__(.+?)__/.exec(toolName)
  if (mcp) {
    const server = mcp[1]!
    if (server.includes(PRODUCER_SERVER) || server.includes(ACCEPTOR_SERVER)) {
      return allow('混合团队的盒子连接')
    }
    if (BOX_SERVER.test(server)) {
      return deny(
        `This is a second Unreal Box connection (${server}). In a hybrid team the producer only uses the ${PRODUCER_SERVER} tools; teammates do the work.`
      )
    }
  }

  return allow('不归守卫管')
}

/** hook 的 stdin → Claude Code 认的 PreToolUse 输出。放行时空串 */
export function runGuardHook(stdin: string): string {
  let toolName = ''
  let toolInput: unknown
  try {
    const parsed = JSON.parse(stdin) as { tool_name?: unknown; tool_input?: unknown }
    toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : ''
    toolInput = parsed.tool_input
  } catch {
    // 读不懂就放行：一个坏掉的守卫不该让制作人什么都干不了
    return ''
  }
  const decision = decideGuard(toolName, toolInput)
  if (!decision.deny) return ''
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason
    }
  })}\n`
}
