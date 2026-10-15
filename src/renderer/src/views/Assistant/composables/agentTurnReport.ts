/**
 * 从过程日志里读回 `update_plan` 的最新清单和 `wrap_up` 的收尾提问。
 *
 * 不进时间线切块（`agentTimeline.ts`）：清单是「这一轮整体走到哪了」，
 * 跟着某一步长在中间的话，跑完一折叠就被收进去了；收尾提问要挨着建议按钮那排。
 * 两样都是「整条回复只取最后一份」，所以在这里一次扫完。
 */
import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import { normalizeToolName, parseStructuredValue } from '../components/agentToolCallData'
import {
  UPDATE_PLAN_TOOL_NAME,
  WRAP_UP_TOOL_NAME,
  type PlanItem,
  type PlanItemStatus,
  type WrapUp,
  type WrapUpAction
} from '@core/shared/agentTurnReport'

const PLAN_STATUSES = new Set<PlanItemStatus>(['pending', 'in_progress', 'completed'])

/** 某个工具最后一次**成功**结果的 details。失败的那次没显示给用户，不算 */
function lastResult(
  items: readonly AgentProcessItem[] | undefined,
  toolName: string
): Record<string, unknown> | null {
  if (!items) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type !== 'tool-result') continue
    const data = (item.data ?? {}) as { toolName?: unknown; isError?: unknown; result?: unknown }
    if (typeof data.toolName !== 'string' || normalizeToolName(data.toolName) !== toolName) continue
    if (data.isError === true) continue
    return parseStructuredValue(data.result)
  }
  return null
}

export function readLatestPlan(items: readonly AgentProcessItem[] | undefined): PlanItem[] {
  const raw = lastResult(items, UPDATE_PLAN_TOOL_NAME)?.items
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is PlanItem =>
      typeof item?.content === 'string' &&
      item.content.length > 0 &&
      PLAN_STATUSES.has(item.status as PlanItemStatus)
  )
}

export function readWrapUp(items: readonly AgentProcessItem[] | undefined): WrapUp | null {
  const raw = lastResult(items, WRAP_UP_TOOL_NAME)
  if (!raw || typeof raw.ask !== 'string' || !raw.ask.trim() || !Array.isArray(raw.actions))
    return null
  const actions = raw.actions.filter(
    (action): action is WrapUpAction =>
      typeof action?.label === 'string' && action.label.trim().length > 0
  )
  // 一个按钮都没有的问题用户没法点着回答，等于没问 —— 那就让猜的那排照旧出来
  return actions.length > 0 ? { ask: raw.ask, actions } : null
}

/** 点按钮发出去的那句话 */
export function wrapUpActionMessage(action: WrapUpAction): string {
  return action.message?.trim() || action.label
}
