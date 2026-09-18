import type { SettingsView } from '@core/shared/aiProvider'
import { findImageModelOption } from '@core/shared/imageGenerationModels'
import { DEFAULT_INFOGRAPHIC_CONFIG, type InfographicConfig } from './types'

export interface InfographicModelOption {
  id: string
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  imageSize: InfographicConfig['imageSize']
  aspectRatio: InfographicConfig['aspectRatio']
}

function hasUsableCredential(provider: SettingsView['providers'][number]): boolean {
  return provider.apiKey.kind === 'none' || provider.apiKey.hasKey
}

/**
 * 信息图只能列出用户已经保存、凭据可用、并明确标为「生图」的模型。
 * 模型顺序沿用模型页，避免两个入口看起来像两套互不相干的配置。
 */
export function buildInfographicModelOptions(settings: SettingsView): InfographicModelOption[] {
  return settings.providers.flatMap((provider) => {
    if (!hasUsableCredential(provider)) return []

    // 能力不再看模型上的位，看 Provider 的用途
    if (provider.kind !== 'image') return []

    return provider.models.map((model) => {
      const capability = findImageModelOption(model.id)
      return {
        id: JSON.stringify([provider.id, model.id]),
        providerId: provider.id,
        providerName: provider.displayName,
        modelId: model.id,
        modelName: model.displayName?.trim() || model.id,
        imageSize: capability?.defaultResolution ?? DEFAULT_INFOGRAPHIC_CONFIG.imageSize,
        aspectRatio: capability?.defaultRatio ?? DEFAULT_INFOGRAPHIC_CONFIG.aspectRatio
      }
    })
  })
}

/**
 * 优先恢复信息图自己的选择；它已失效时退回全局「生图」绑定，再退到第一项。
 */
export function resolveInfographicModelSelection(
  options: readonly InfographicModelOption[],
  config: InfographicConfig,
  settings: SettingsView
): string {
  const saved = options.find(
    (option) => option.providerId === config.providerId && option.modelId === config.modelId
  )
  if (saved) return saved.id

  const imageRole = settings.roles.image
  const bound = options.find(
    (option) => option.providerId === imageRole?.providerId && option.modelId === imageRole?.modelId
  )
  return bound?.id ?? options[0]?.id ?? ''
}
