/**
 * 把 Creator Plan 的清单落成本地的来源（provider）和角色绑定。纯函数，不碰磁盘。
 *
 * 规则：
 * - 套餐生成的来源 id 固定以 `creator-plan` 开头，共用一把密钥（`PLAN_KEY_ID`）。
 * - 套餐绑定的角色带 `source: 'plan'`。用户之后手动改了哪个角色，那个角色就自动
 *   脱离套餐（渲染层改绑定时不带 source），重新导入也不会覆盖它。
 * - 导入时默认只接管「没绑的」和「本来就由套餐管着的」角色；用户手动配过的，
 *   要在预览里自己勾上才会被换掉。
 */

import {
  MODEL_ROLES,
  ROLE_KIND,
  type ModelConfig,
  type ModelRole,
  type RoleBindings
} from '../../../shared/aiProvider'
import type {
  CreatorPlanChatSpec,
  CreatorPlanManifest,
  CreatorPlanRoleChange,
  CreatorPlanSummary
} from '../../../shared/creatorPlan'
import type { AiProviderSettings, ApiKeyRef, ProviderConfig } from '../types'

export const PLAN_PROVIDER_ID = 'creator-plan'
export const PLAN_KEY_ID = 'creator-plan:key'
const PLAN_DISPLAY_NAME = 'Creator Plan'

/** 目前只接对话类角色；其余角色的协议适配器还没写，清单里给了也先不接 */
const SUPPORTED_ROLES: readonly ModelRole[] = MODEL_ROLES.filter(
  (role) => ROLE_KIND[role] === 'chat'
)

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function isPlanProvider(providerId: string): boolean {
  return providerId === PLAN_PROVIDER_ID || providerId.startsWith(`${PLAN_PROVIDER_ID}-`)
}

function isChatSpec(value: unknown): value is CreatorPlanChatSpec {
  const spec = value as Partial<CreatorPlanChatSpec> | null
  return (
    !!spec &&
    typeof spec.model === 'string' &&
    typeof spec.context_window === 'number' &&
    typeof spec.max_output_tokens === 'number'
  )
}

/** 清单里这次能接的角色 → 规格 */
export function planRoleSpecs(
  manifest: CreatorPlanManifest
): Partial<Record<ModelRole, CreatorPlanChatSpec>> {
  const out: Partial<Record<ModelRole, CreatorPlanChatSpec>> = {}
  for (const role of SUPPORTED_ROLES) {
    const spec = manifest.roles[role]
    if (isChatSpec(spec)) out[role] = spec
  }
  return out
}

function toModelConfig(spec: CreatorPlanChatSpec): ModelConfig {
  const efforts = new Set(spec.reasoning_efforts ?? [])
  return {
    id: spec.model,
    displayName: spec.display_name ?? spec.model,
    supportsVision: spec.supports_vision,
    supportsVideo: spec.supports_video,
    supportsTools: spec.supports_tools,
    supportsReasoning: spec.supports_reasoning,
    contextWindow: spec.context_window,
    maxOutputTokens: spec.max_output_tokens,
    structuredOutputApi: spec.structured_output,
    ...(spec.supports_reasoning
      ? {
          thinkingLevelMap: Object.fromEntries(
            THINKING_LEVELS.map((level) => [level, efforts.has(level) ? level : null])
          )
        }
      : {})
  }
}

/** 清单 → 套餐的来源。现在只有对话一类，一个来源装下全部对话模型 */
export function planProviders(manifest: CreatorPlanManifest, apiKey: ApiKeyRef): ProviderConfig[] {
  const specs = Object.values(planRoleSpecs(manifest))
  const models = new Map<string, ModelConfig>()
  for (const spec of specs) if (!models.has(spec.model)) models.set(spec.model, toModelConfig(spec))
  if (models.size === 0) return []
  return [
    {
      id: PLAN_PROVIDER_ID,
      displayName: PLAN_DISPLAY_NAME,
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: manifest.api.base_url,
      apiKey,
      models: [...models.values()]
    }
  ]
}

export function planSummary(manifest: CreatorPlanManifest): CreatorPlanSummary {
  const text = manifest.quotas.text_tokens
  return {
    tierName: manifest.plan.tier_name,
    status: manifest.plan.status,
    interval: manifest.plan.interval,
    currentPeriodEnd: manifest.plan.current_period_end,
    cancelAtPeriodEnd: manifest.plan.cancel_at_period_end,
    quotaResetsAt: manifest.plan.quota_resets_at,
    manageUrl: manifest.plan.manage_url,
    textTokens: text ? { limit: text.limit, used: text.used } : null
  }
}

/** 导入预览：套餐能接的每个角色，现在是什么、默认勾不勾 */
export function planRoleChanges(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest
): CreatorPlanRoleChange[] {
  const specs = planRoleSpecs(manifest)
  return SUPPORTED_ROLES.flatMap((role) => {
    const spec = specs[role]
    if (!spec) return []
    const binding = settings.roles[role]
    const provider = binding && settings.providers.find((p) => p.id === binding.providerId)
    const managed = binding?.source === 'plan'
    return [
      {
        role,
        model: spec.model,
        modelDisplayName: spec.display_name ?? spec.model,
        current:
          binding && provider
            ? {
                providerId: binding.providerId,
                modelId: binding.modelId,
                providerName: provider.displayName
              }
            : null,
        managed,
        defaultSelected: !binding || managed
      }
    ]
  })
}

/**
 * 应用清单：换上套餐的来源，把选中的角色绑过去。
 *
 * 选中的角色 → 绑到套餐（source: 'plan'）。
 * 本来由套餐管着、这次没选中的 → 解绑（用户取消勾选，就是不要套餐管它了）。
 * 本来由套餐管着、但清单里已经没有的 → 解绑。
 */
export function applyPlan(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest,
  apiKey: ApiKeyRef,
  selected: readonly ModelRole[]
): AiProviderSettings {
  const specs = planRoleSpecs(manifest)
  const providers = [
    ...settings.providers.filter((p) => !isPlanProvider(p.id)),
    ...planProviders(manifest, apiKey)
  ]

  const roles: RoleBindings = { ...settings.roles }
  for (const role of SUPPORTED_ROLES) {
    const spec = specs[role]
    if (spec && selected.includes(role)) {
      roles[role] = { providerId: PLAN_PROVIDER_ID, modelId: spec.model, source: 'plan' }
    } else if (roles[role]?.source === 'plan') {
      delete roles[role]
    }
  }
  return { ...settings, providers, roles }
}

/** 断开：删掉套餐的来源，以及绑在它们上面的角色 */
export function removePlan(settings: AiProviderSettings): AiProviderSettings {
  const roles: RoleBindings = {}
  for (const [role, binding] of Object.entries(settings.roles) as [
    ModelRole,
    NonNullable<RoleBindings[ModelRole]>
  ][]) {
    if (binding.source === 'plan' || isPlanProvider(binding.providerId)) continue
    roles[role] = binding
  }
  return {
    ...settings,
    providers: settings.providers.filter((p) => !isPlanProvider(p.id)),
    roles
  }
}

export function managedRoles(settings: AiProviderSettings): ModelRole[] {
  return (Object.entries(settings.roles) as [ModelRole, RoleBindings[ModelRole]][])
    .filter(([, binding]) => binding?.source === 'plan')
    .map(([role]) => role)
}
