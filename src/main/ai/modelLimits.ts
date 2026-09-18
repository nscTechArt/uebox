/**
 * 一个模型的窗口与输出上限。
 *
 * 这份查法原来只长在 agent 那条路上（`agent-v3/core/piModel.ts` 里的 `limitsFor`），
 * 于是知识库那边只能拍脑袋写死字符上限。搬出来之后两边共用同一套。
 */

import { findCatalogEntry } from './catalog'
import type { ProviderConfig } from './types'
import type { ModelConfig } from '../../shared/aiProvider'
import { FALLBACK_MODEL_LIMITS, type ModelLimits } from '../../shared/tokenBudget'

/**
 * 窗口从三处按优先级取：models.json 里这条模型自己写的 → 内置目录里同名条目
 * → 缺省值。
 *
 * 中间那一档是给**已有安装**用的：目录里补上窗口之前存下来的 models.json 里
 * 没有这个字段，只按第一档取的话，老用户得把每个 Provider 删了重加才能吃到
 * 真实窗口。按 (providerId, modelId) 回查目录，他们什么都不用做。
 *
 * 第三档取什么、为什么不再取最保守的那侧，见 `shared/tokenBudget.ts` 里
 * `DEFAULT_CONTEXT_WINDOW` 的注释。
 */
export function resolveModelLimits(provider: ProviderConfig, model: ModelConfig): ModelLimits {
  const catalog = findCatalogEntry(provider.id)?.models.find((item) => item.id === model.id)
  return {
    contextWindow:
      model.contextWindow ?? catalog?.contextWindow ?? FALLBACK_MODEL_LIMITS.contextWindow,
    // pi 的 `maxTokens` 指的是**单次输出**上限，不是上下文总量
    maxOutputTokens:
      model.maxOutputTokens ?? catalog?.maxOutputTokens ?? FALLBACK_MODEL_LIMITS.maxOutputTokens
  }
}

/** 只知道 provider 与 modelId 时的查法（模型不在配置里就只能回落到目录 / 缺省） */
export function resolveModelLimitsById(provider: ProviderConfig, modelId: string): ModelLimits {
  const configured = provider.models?.find((item) => item.id === modelId)
  return resolveModelLimits(provider, configured ?? ({ id: modelId } as ModelConfig))
}
