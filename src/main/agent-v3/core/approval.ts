/**
 * 工具审批门。
 *
 * 取代 V2 的 `SensitiveToolWrapper`：那是在工具外面再包一层 `tool()`，
 * 拦截逻辑和工具定义混在一起；这里用 pi 的 `beforeToolCall` 钩子，
 * 审批策略与工具实现彻底分开。
 *
 * 审批期间 agent 阻塞但**不中断** —— 用户可以同时 `steer()` 插话改方向。
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'

import type { ToolRisk, UnrealAgentTool } from '../tools/defineTool'

/** 用户对一次审批的回应 */
export type ApprovalVerdict =
  | 'approve'
  /** 批准，并且本会话内该工具不再询问 */
  | 'always'
  | 'reject'

export type ApprovalMode =
  /** 每个非只读操作都问 */
  | 'ask'
  /** 可撤销的改动自动放行，不可逆的仍然问 */
  | 'auto-edit'
  /** 全部放行。危险，只在用户明确选择后启用 */
  | 'yolo'

export interface ApprovalRequest {
  sessionId: string
  toolCallId: string
  toolName: string
  namespace: string
  risk: ToolRisk
  args: unknown
  /**
   * 界面上要不要给「本次会话都允许」这个按钮。
   *
   * 逐次审批的工具（浏览器打开网址、往网页里输入）为 false —— 它们每次的
   * 参数都不一样，而参数本身就是风险，批准一次不能代表批准下一次。
   */
  allowAlways: boolean
}

export interface ApprovalDeps {
  sessionId: string
  /**
   * 审批档位。给函数则**每次调用现读**。
   *
   * 这一点是有代价换来的：原来这里存的是个定值，于是档位在这一轮开始时
   * 就写死了 —— 用户被确认框拦住、去把档位调松，本轮一个框都不会少弹，
   * 要等下一条消息才算数。而他恰恰是在被拦住的那一刻才去调的。
   */
  mode: ApprovalMode | (() => ApprovalMode)
  /** 实时只读约束，优先于审批档位和已经记住的授权。 */
  isReadOnly?: () => boolean
  /**
   * 本会话已被「始终允许」的工具。
   *
   * 由宿主传入才能跨轮保留 —— 审批门随 agent 创建，而 agent 每条消息重建
   * 一次。省略时退化成只在这一个 agent 实例内有效，那样按钮上写着
   * 「本次会话都允许」，实际只管到这一轮结束。
   */
  alwaysAllowed?: Set<string>
  /** 按 name 查工具元数据。注册表提供 */
  lookup: (toolName: string) => UnrealAgentTool<never> | undefined
  /** 向用户发起审批。实现在 host 层（IPC 往返） */
  request: (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalVerdict>
}

/** 判断这次调用是否需要问用户 */
export function needsApproval(
  risk: ToolRisk,
  mode: ApprovalMode,
  requiresExplicitApproval = false
): boolean {
  // 用户明确选择完全访问后，浏览器交互也无需逐次审批。
  if (mode === 'yolo') return false
  // 其他档位仍逐次确认，不能用「本次会话都允许」代替。
  if (requiresExplicitApproval) return true
  // 只读操作永远不问
  if (risk === 'safe') return false
  // 不可逆操作在 auto-edit 下仍然要问 —— 这正是 auto-edit 与 yolo 的区别
  if (risk === 'destructive') return true
  // 可撤销的改动：ask 问，auto-edit 放行
  return mode === 'ask'
}

/**
 * 构造 `beforeToolCall` 钩子。
 *
 * 契约：不能抛异常，但无法完成审批时必须阻止这次调用。
 * 审批链路故障不代表用户同意，模型应收到明确原因以便换路或稍后重试。
 */
export function createApprovalGate(deps: ApprovalDeps) {
  // 本会话内已被「始终允许」的工具。宿主没给就自己开一个（见 ApprovalDeps）
  const alwaysAllowed = deps.alwaysAllowed ?? new Set<string>()
  const currentMode = (): ApprovalMode =>
    typeof deps.mode === 'function' ? deps.mode() : deps.mode

  return async (
    ctx: BeforeToolCallContext,
    signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> => {
    try {
      const toolName = ctx.toolCall.name
      const tool = deps.lookup(toolName)
      const explicit = tool?.unrealBox.requiresExplicitApproval === true
      const declaredRisk: ToolRisk = tool?.unrealBox.risk ?? 'destructive'
      // 按这次的参数算实际风险（dry_run 之类降成 safe）。「本次会话都允许」按实际
      // 风险分开记：在预演上点的允许只对预演有效，真正的那次照样问
      const risk: ToolRisk = tool?.unrealBox.riskFor?.(ctx.args) ?? declaredRisk
      const allowKey = risk === declaredRisk ? toolName : `${toolName}#${risk}`
      const readOnlyBlock = (): BeforeToolCallResult | undefined =>
        deps.isReadOnly?.() && risk !== 'safe'
          ? { block: true, reason: 'This conversation is read-only. Do not perform changes.' }
          : undefined
      const blocked = readOnlyBlock()
      if (blocked) return blocked

      // 先判逐次审批，再看「本次会话都允许」的名单 —— 顺序反了的话，
      // 一个曾经被记住的工具名就能永久跳过审批。
      if (!explicit && (alwaysAllowed.has(toolName) || alwaysAllowed.has(allowKey))) {
        return undefined
      }

      // 查不到元数据的工具（例如以后接进来的 MCP 工具还没登记）按最危险处理。
      // 第三方来源的工具不可信，宁可多问一次。
      if (!needsApproval(risk, currentMode(), explicit)) return undefined

      const verdict = await deps.request(
        {
          sessionId: deps.sessionId,
          toolCallId: ctx.toolCall.id,
          toolName,
          namespace: tool?.unrealBox.namespace ?? 'unknown',
          risk,
          args: ctx.args,
          allowAlways: !explicit
        },
        signal
      )

      // 等待审批期间用户可能切到只读；旧确认框的批准不能覆盖新约束。
      const blockedAfterApproval = readOnlyBlock()
      if (blockedAfterApproval) return blockedAfterApproval
      if (signal?.aborted) return { block: true, reason: 'Tool execution was cancelled.' }

      if (verdict === 'always') {
        // 逐次审批的工具即使收到 always 也只按这一次批准处理 ——
        // 界面已经隐藏了那个按钮，但主进程不能依赖界面来守这条规则
        if (!explicit) alwaysAllowed.add(allowKey)
        return undefined
      }
      if (verdict === 'approve') return undefined

      return {
        block: true,
        // 这段文字会作为 tool result 交给模型，所以要写成「对模型的指示」
        // 而不是「对用户的提示」—— 否则模型会原样重试。
        reason:
          `用户拒绝执行 ${toolName}。不要重试这个操作。` +
          '请询问用户希望怎么做，或者换一种不需要该操作的方案。'
      }
    } catch {
      return { block: true, reason: 'Approval unavailable; tool execution was blocked.' }
    }
  }
}
