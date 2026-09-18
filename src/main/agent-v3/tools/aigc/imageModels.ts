/**
 * 「用哪个生图模型」的解析。
 *
 * ## 为什么不让模型自己填 provider + model 两个参数
 *
 * 那两个 id 只存在于用户的 `models.json` 里，agent 看不到 —— 给它两个填不出来的
 * 参数，等于给了一个永远只能留空的开关。所以工具上只有一个 `model`：模型 id 的
 * 全称或片段，在**所有已配置的 Provider** 里找，找不到就把可选清单原样报回去。
 * 那份清单本身就是「你可以填什么」的答案，比再加一个列举工具便宜。
 *
 * 单独成一个模块是为了能被测到 —— 它是一堆纯粹的匹配规则，而 `generateImage.ts`
 * 那边挂着网络请求和资产库写盘。
 */

import type { AiProviderSettings } from '../../../ai/types'

export interface ImageModelChoice {
  providerId: string
  modelId: string
  /** 给人看的名字，形如 `火山方舟:doubao-seedream-4-0` */
  label: string
}

/** 用途为「生图」的 Provider 下的全部模型，按 Provider 顺序排 */
export function listImageModels(settings: AiProviderSettings): ImageModelChoice[] {
  return settings.providers
    .filter((provider) => provider.kind === 'image')
    .flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        label: `${provider.displayName}:${model.id}`
      }))
    )
}

/**
 * 按用户给的字符串挑一个模型。
 *
 * 三级：完全相同 → 忽略大小写相同 → 子串命中（网关会给模型名加厂商前缀，
 * `doubao-seedream-4-0` 在某些网关上叫 `volcengine/doubao-seedream-4-0`，
 * 让模型必须写全那个前缀是在为一件它猜不到的事罚它）。
 *
 * 子串有多个命中时取第一个 —— 调用方会把用了哪个如实写在返回值里，
 * 挑错了用户看得见，比在这里凭规则猜一个「更像的」诚实。
 */
export function pickImageModel(
  models: ImageModelChoice[],
  requested: string
): ImageModelChoice | undefined {
  const wanted = requested.trim()
  if (!wanted) return undefined

  const lower = wanted.toLowerCase()
  return (
    models.find((model) => model.modelId === wanted) ??
    models.find((model) => model.modelId.toLowerCase() === lower) ??
    models.find((model) => model.modelId.toLowerCase().includes(lower))
  )
}

/** 挑不到时给模型看的话。带上清单，它下一次才填得对 */
export function describeMissingModel(models: ImageModelChoice[], requested: string): string {
  if (models.length === 0) {
    return (
      `没有找到叫「${requested}」的生图模型，而且当前一个生图模型都没有配置。` +
      '请用户到 设置 → 模型 添加一个服务商，' +
      '在它的模型清单里勾上「生图」。'
    )
  }

  return (
    `没有找到叫「${requested}」的生图模型。已配置的是：` +
    `${models.map((model) => model.label).join('、')}。` +
    '照着填一个，或者不填 model 用用户绑定的那个。'
  )
}
