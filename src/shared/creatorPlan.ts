/**
 * 创作者 Token Plan —— 主进程与渲染层共用的形状。
 *
 * Creator Plan 是一个**用户主动开通**的付费模型服务：一把 Key 覆盖多个角色。
 * 没连接时，应用里与它有关的代码一个请求都不发（见 `src/main/ai/creatorPlan/`）。
 *
 * 清单（manifest）只取这里用得到的字段；服务端多给的字段忽略。
 */

import type { ModelRole } from './aiProvider'

/**
 * 套餐生成的来源 id 固定以它开头。放在 shared 里是因为渲染层也要认：
 * 「模型来源」列表里这类来源只读，操作都走卡片。
 */
export const PLAN_PROVIDER_ID = 'creator-plan'

export function isPlanProvider(providerId: string): boolean {
  return providerId === PLAN_PROVIDER_ID || providerId.startsWith(`${PLAN_PROVIDER_ID}-`)
}

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
  /** 要下线的虚拟模型。命中正在用的模型时提示用户 */
  deprecations?: Array<{
    model: string
    replaced_by?: string | null
    deprecated_at?: string | null
    removed_at?: string | null
  }>
}

/**
 * 额度键，顺序即卡片上的显示顺序（同 00-conventions.md 的额度表）。
 * 清单里出现不认识的键也照样显示，排在这些后面。
 */
export const CREATOR_PLAN_QUOTA_KEYS = [
  'text_tokens',
  'images',
  'video_seconds',
  'model3d_tasks',
  'music_tasks',
  'realtime_minutes',
  'tts_characters',
  'stt_minutes',
  'searches'
] as const

export interface CreatorPlanQuota {
  key: string
  limit: number
  used: number
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
  /** 清单 quotas 逐项，按 CREATOR_PLAN_QUOTA_KEYS 排序 */
  quotas: CreatorPlanQuota[]
}

/** 清单 deprecations 命中了正在用的模型：哪个角色、哪个模型、换成什么、哪天下线 */
export interface CreatorPlanDeprecationHit {
  role: ModelRole
  model: string
  replacedBy: string | null
  removedAt: string | null
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
  /** 正在用、但清单说要下线的模型 */
  deprecations: CreatorPlanDeprecationHit[]
}

/** 断开的结果。`revoked` 为 false：服务端没吊销成功，本机 Key 已删，提示去网页端手动吊销 */
export interface CreatorPlanDisconnectResult {
  revoked: boolean
  /** 网页端 API Key 列表，手动吊销用 */
  keysUrl: string
}

/**
 * 调套餐来源时，服务端回的这几种错误在对话里给专门的提示（见 00-conventions.md「错误」）。
 * 前三种跳清单里的 manage_url；unauthorized 引导去「设置 → 模型」重新连接。
 */
export type CreatorPlanChatErrorCode =
  | 'subscription_inactive'
  | 'quota_exhausted'
  | 'role_not_in_plan'
  | 'unauthorized'

const CHAT_ERRORS: Readonly<Record<string, [number, CreatorPlanChatErrorCode]>> = {
  subscription_inactive: [402, 'subscription_inactive'],
  quota_exhausted: [402, 'quota_exhausted'],
  role_not_in_plan: [403, 'role_not_in_plan']
}

/**
 * 只对套餐来源的调用用它，别的来源的错误不经过这里。
 *
 * 402 / 403 要状态码和错误码都对得上；401 只看状态码 —— Key 被吊销时错误体
 * 万一没解析出来，也该引导重新连接，而不是落到通用的「密钥不对」。
 */
export function creatorPlanChatError(
  statusCode: number | undefined,
  code: string | undefined
): CreatorPlanChatErrorCode | null {
  if (statusCode === 401) return 'unauthorized'
  const hit = code && Object.hasOwn(CHAT_ERRORS, code) ? CHAT_ERRORS[code] : undefined
  return hit && hit[0] === statusCode ? hit[1] : null
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
