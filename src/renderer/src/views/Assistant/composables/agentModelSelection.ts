import {
  ROLE_KIND,
  type ModelBinding,
  type ProviderView,
  type SettingsView
} from '@core/shared/aiProvider'

export interface AgentModelOption {
  key: string
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  fullLabel: string
}

export interface AgentModelGroup {
  providerId: string
  providerName: string
  options: AgentModelOption[]
}

export interface AgentModelCatalog {
  groups: AgentModelGroup[]
  options: AgentModelOption[]
  /** Agent 没有单独绑定时，内核会沿用 chat 角色；这里必须显示同一个实际结果。 */
  binding: ModelBinding | null
  selected: AgentModelOption | null
}

/** Provider / model id 都可能含分隔符，JSON 数组键不会出现拆错位置的问题。 */
export function agentModelOptionKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId])
}

function modelName(model: ProviderView['models'][number]): string {
  return model.displayName?.trim() || model.id
}

function modelFullLabel(providerName: string, name: string): string {
  if (!providerName) return name
  if (name.toLowerCase().startsWith(providerName.toLowerCase())) return name
  return `${name} · ${providerName}`
}

/**
 * 输入栏只列能承担 Agent 角色的模型，并保持设置页里的 Provider / 模型顺序。
 * Agent 和普通对话都来自 chat Provider；能力判定沿用共享的 ROLE_KIND，避免另写一套。
 */
export function buildAgentModelCatalog(settings: SettingsView): AgentModelCatalog {
  const groups = settings.providers
    .filter((provider) => provider.kind === ROLE_KIND.agent && provider.models.length > 0)
    .map((provider): AgentModelGroup => {
      const providerName = provider.displayName.trim() || provider.id
      return {
        providerId: provider.id,
        providerName,
        options: provider.models.map((model): AgentModelOption => {
          const name = modelName(model)
          return {
            key: agentModelOptionKey(provider.id, model.id),
            providerId: provider.id,
            providerName,
            modelId: model.id,
            modelName: name,
            fullLabel: modelFullLabel(providerName, name)
          }
        })
      }
    })

  const options = groups.flatMap((group) => group.options)
  const binding = settings.roles.agent ?? settings.roles.chat ?? null
  const selected = binding
    ? (options.find(
        (option) => option.providerId === binding.providerId && option.modelId === binding.modelId
      ) ?? null)
    : null

  return { groups, options, binding, selected }
}
