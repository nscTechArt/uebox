/**
 * 把 Creator Plan 的清单落成本地的来源（provider）和角色绑定。纯函数，不碰磁盘。
 *
 * 规则：
 * - 套餐生成的来源 id 固定以 `creator-plan` 开头，共用一把密钥（`PLAN_KEY_ID`）。
 * - 套餐绑定的角色带 `source: 'plan'`。用户之后手动改了哪个角色，那个角色就自动
 *   脱离套餐（渲染层改绑定时不带 source），重新导入也不会覆盖它。
 * - 导入时默认只接管「没绑的」和「本来就由套餐管着的」角色；用户手动配过的，
 *   要在预览里自己勾上才会被换掉。
 * - 被接管的角色原来绑的是什么，记在套餐自己的状态文件里（`planState.ts`），
 *   不往 models.json 里塞；断开时照着还原。
 */

import {
  MODEL_ROLES,
  ROLE_KIND,
  type ModelBinding,
  type ModelConfig,
  type ModelRole,
  type RoleBindings
} from '../../../shared/aiProvider'
import {
  CREATOR_PLAN_QUOTA_KEYS,
  PLAN_PROVIDER_ID,
  isPlanProvider,
  type CreatorPlanChatSpec,
  type CreatorPlanDeprecationHit,
  type CreatorPlanManifest,
  type CreatorPlanQuota,
  type CreatorPlanRoleChange,
  type CreatorPlanSummary
} from '../../../shared/creatorPlan'
import type { AiProviderSettings, ApiKeyRef, ProviderConfig } from '../types'

export { PLAN_PROVIDER_ID, isPlanProvider }
export const PLAN_KEY_ID = 'creator-plan:key'

/** 被套餐接管前的绑定。null = 那个角色原来没设置 */
export type OriginalBindings = Partial<Record<ModelRole, ModelBinding | null>>
const PLAN_DISPLAY_NAME = 'Creator Plan'

/** 目前只接对话类角色；其余角色的协议适配器还没写，清单里给了也先不接 */
const SUPPORTED_ROLES: readonly ModelRole[] = MODEL_ROLES.filter(
  (role) => ROLE_KIND[role] === 'chat'
)

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

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

/** 清单 quotas 逐项。认识的键按额度表的顺序在前，不认识的也照样列出来 */
function planQuotas(manifest: CreatorPlanManifest): CreatorPlanQuota[] {
  const known: readonly string[] = CREATOR_PLAN_QUOTA_KEYS
  const rank = (key: string): number => {
    const index = known.indexOf(key)
    return index === -1 ? known.length : index
  }
  return Object.entries(manifest.quotas ?? {})
    .filter(
      (entry): entry is [string, { limit: number; used: number }] =>
        typeof entry[1]?.limit === 'number' && typeof entry[1]?.used === 'number'
    )
    .map(([key, quota]) => ({ key, limit: quota.limit, used: quota.used }))
    .sort((a, b) => rank(a.key) - rank(b.key))
}

export function planSummary(manifest: CreatorPlanManifest): CreatorPlanSummary {
  return {
    tierName: manifest.plan.tier_name,
    status: manifest.plan.status,
    interval: manifest.plan.interval,
    currentPeriodEnd: manifest.plan.current_period_end,
    cancelAtPeriodEnd: manifest.plan.cancel_at_period_end,
    quotaResetsAt: manifest.plan.quota_resets_at,
    manageUrl: manifest.plan.manage_url,
    quotas: planQuotas(manifest)
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

/**
 * 导入前记下这次要被接管的角色原来绑的是什么。
 *
 * 已经记过的角色不再覆盖：重新导入时它的「现在」是套餐，最初那条才是用户自己的配置。
 * 原来就由套餐管着、又没记录的（这个功能之前导入的），按「原来没设置」记。
 */
export function recordOriginals(
  originals: OriginalBindings,
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest,
  selected: readonly ModelRole[]
): OriginalBindings {
  const specs = planRoleSpecs(manifest)
  const next: OriginalBindings = { ...originals }
  for (const role of SUPPORTED_ROLES) {
    if (!specs[role] || !selected.includes(role) || Object.hasOwn(next, role)) continue
    const binding = settings.roles[role]
    next[role] =
      binding && binding.source !== 'plan' && !isPlanProvider(binding.providerId)
        ? { providerId: binding.providerId, modelId: binding.modelId }
        : null
  }
  return next
}

/**
 * 断开：删掉套餐的来源；还在套餐手里的角色还原成接管前的绑定。
 *
 * 原绑定指向的来源（或那个模型）已经被删掉了，就置为未设置。
 * 用户手动改过的角色早已脱离套餐，不动。
 */
export function removePlan(
  settings: AiProviderSettings,
  originals: OriginalBindings = {}
): AiProviderSettings {
  const providers = settings.providers.filter((p) => !isPlanProvider(p.id))
  const roles: RoleBindings = {}
  for (const [role, binding] of Object.entries(settings.roles) as [
    ModelRole,
    NonNullable<RoleBindings[ModelRole]>
  ][]) {
    if (binding.source !== 'plan' && !isPlanProvider(binding.providerId)) {
      roles[role] = binding
      continue
    }
    const original = originals[role]
    const provider = original && providers.find((p) => p.id === original.providerId)
    if (original && provider?.models.some((m) => m.id === original.modelId)) {
      roles[role] = { providerId: original.providerId, modelId: original.modelId }
    }
  }
  return { ...settings, providers, roles }
}

/**
 * 清单刷新后更新套餐来源里各模型的能力（能力只升不降，服务端后台换模型时会变）。
 *
 * 只改已有的模型，不增不删：增删角色是用户在「重新导入」里做的决定；
 * 订阅失效时清单的 roles 全是 null，这里要是跟着删，来源一没，连接也就没了。
 * 没变化时原样返回同一个对象，调用方据此跳过写盘。
 */
export function refreshPlanModels(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest
): AiProviderSettings {
  const specs = Object.values(planRoleSpecs(manifest))
  const bySpec = new Map(specs.map((spec) => [spec.model, toModelConfig(spec)]))
  let changed = false
  const providers = settings.providers.map((provider) => {
    if (!isPlanProvider(provider.id)) return provider
    const models = provider.models.map((model) => {
      const next = bySpec.get(model.id)
      // 只比清单管的那几项：落盘归一化会给模型补别的字段，整个对象比永远不等
      const differs =
        next &&
        (Object.keys(next) as (keyof ModelConfig)[]).some(
          (key) => JSON.stringify(next[key]) !== JSON.stringify(model[key])
        )
      if (!differs) return model
      changed = true
      return { ...model, ...next }
    })
    const baseUrl = manifest.api?.base_url || provider.baseUrl
    if (baseUrl !== provider.baseUrl) changed = true
    return { ...provider, baseUrl, models }
  })
  return changed ? { ...settings, providers } : settings
}

/** 清单 deprecations 里，有哪些是正在用的（绑在套餐来源上的角色） */
export function planDeprecationHits(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest | null
): CreatorPlanDeprecationHit[] {
  const deprecations = manifest?.deprecations ?? []
  if (deprecations.length === 0) return []
  return MODEL_ROLES.flatMap((role) => {
    const binding = settings.roles[role]
    if (!binding || !isPlanProvider(binding.providerId)) return []
    const hit = deprecations.find((d) => d.model === binding.modelId)
    return hit
      ? [
          {
            role,
            model: hit.model,
            replacedBy: hit.replaced_by ?? null,
            removedAt: hit.removed_at ?? null
          }
        ]
      : []
  })
}

export function managedRoles(settings: AiProviderSettings): ModelRole[] {
  return (Object.entries(settings.roles) as [ModelRole, RoleBindings[ModelRole]][])
    .filter(([, binding]) => binding?.source === 'plan')
    .map(([role]) => role)
}
