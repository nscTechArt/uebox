/**
 * 创作者 Token Plan —— 主进程与渲染层共用的形状。
 *
 * Creator Plan 是一个**用户主动开通**的付费模型服务：一把 Key 覆盖多个角色。
 * 没连接时，应用里与它有关的代码一个请求都不发（见 `src/main/ai/creatorPlan/`）。
 *
 * 清单（manifest）只取这里用得到的字段；服务端多给的字段忽略。
 */

import type { ModelRole } from './aiProvider'

export type CreatorPlanStatusValue = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none'

/** 对话类角色的能力下限（清单里 roles.chat / agent / vision / summary） */
export interface CreatorPlanChatSpec {
  model: string
  display_name?: string
  context_window: number
  max_output_tokens: number
  supports_vision: boolean
  supports_video: boolean
  supports_tools: boolean
  supports_reasoning: boolean
  reasoning_efforts?: string[]
  structured_output: 'json-schema' | 'json-object' | 'none'
}

export interface CreatorPlanManifest {
  schema: 1
  etag: string
  plan: {
    product: string
    tier: string | null
    tier_name: string | null
    status: CreatorPlanStatusValue
    interval: 'month' | 'year' | null
    current_period_end: string | null
    cancel_at_period_end: boolean
    quota_resets_at: string | null
    manage_url: string
  }
  quotas: Partial<Record<string, { limit: number; used: number }>>
  api: { base_url: string }
  /** 为 null 表示套餐不含这个角色（或服务端还没开放） */
  roles: Partial<Record<ModelRole, unknown>>
}

/** 卡片上显示的套餐摘要 */
export interface CreatorPlanSummary {
  tierName: string | null
  status: CreatorPlanStatusValue
  interval: 'month' | 'year' | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  quotaResetsAt: string | null
  manageUrl: string
  textTokens: { limit: number; used: number } | null
}

/** 导入前给用户看的一行：这个角色会从什么换成什么 */
export interface CreatorPlanRoleChange {
  role: ModelRole
  /** 套餐里对应的虚拟模型名 */
  model: string
  modelDisplayName: string
  /** 现在绑的是什么；没绑为 null */
  current: { providerId: string; modelId: string; providerName: string } | null
  /** 现在这个绑定是不是本来就由套餐管着 */
  managed: boolean
  /** 默认勾不勾：没绑的、套餐管着的勾；用户手动配过的不勾 */
  defaultSelected: boolean
}

export interface CreatorPlanPreview {
  summary: CreatorPlanSummary
  changes: CreatorPlanRoleChange[]
}

export interface CreatorPlanState {
  connected: boolean
  /** 连接了才有；拉清单失败时为 null，看 error */
  summary: CreatorPlanSummary | null
  /** 当前由套餐管着的角色 */
  managedRoles: ModelRole[]
  error: CreatorPlanErrorCode | null
}

export interface CreatorPlanDevicePrompt {
  userCode: string
  verificationUri: string
}

export type CreatorPlanErrorCode =
  | 'cancelled'
  | 'denied'
  | 'expired'
  | 'unauthorized'
  | 'network'
  | 'bad_response'
  | 'not_connected'
  | 'encryption_unavailable'
  | 'unknown'

export type CreatorPlanResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: CreatorPlanErrorCode; error: string }
