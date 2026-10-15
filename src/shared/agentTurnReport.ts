/**
 * Agent 在一轮里向用户交代进度和收尾的两样东西：任务清单、收尾提问。
 *
 * 放 `shared/` 的理由同 `agentQuestion.ts`：工具（`main/agent-v3/tools/builtin/turnReport.ts`）
 * 造这份数据，界面（`renderer/.../composables/agentTurnReport.ts`）从过程日志里把它读回来。
 * 两边各抄一份的话，哪天改个字段名，表现是「清单不显示了」——没有报错。
 */

export const UPDATE_PLAN_TOOL_NAME = 'update_plan'
export const WRAP_UP_TOOL_NAME = 'wrap_up'

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanItem {
  content: string
  status: PlanItemStatus
}

/** `update_plan` 结果的 details：这一刻的整张清单 */
export interface PlanSnapshot {
  items: PlanItem[]
}

export interface WrapUpAction {
  /** 按钮上的字 */
  label: string
  /** 点了以后当作用户消息发出去的那句话。没给就发 label */
  message?: string
}

/** `wrap_up` 结果的 details */
export interface WrapUp {
  ask: string
  actions: WrapUpAction[]
}

export const MAX_PLAN_ITEMS = 12
export const MAX_PLAN_ITEM_CHARS = 40
export const MAX_WRAP_UP_ASK_CHARS = 100
export const MAX_WRAP_UP_LABEL_CHARS = 24
export const MAX_WRAP_UP_MESSAGE_CHARS = 300
export const MAX_WRAP_UP_ACTIONS = 2
