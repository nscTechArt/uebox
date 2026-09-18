import type { AiProviderSettings } from '../../../ai/types'

/**
 * 视频模型的挑选与报错话术。
 *
 * 与 `imageModels.ts` 是同一套形状，单独一份而不是抽公共的：两边的错误文案要
 * 说清「到哪儿配什么」，而那句话各自不一样；抽成一个带参数的模板之后，改一边
 * 的措辞会牵动另一边，收益抵不上。真到第三种模态再说。
 */

export interface VideoModelChoice {
  providerId: string
  modelId: string
  /** 给人看的名字，形如 `火山方舟 Seedance:doubao-seedance-2-5-260628` */
  label: string
}

/** 用途为「视频生成」的 Provider 下的全部模型，按 Provider 顺序排 */
export function listVideoModels(settings: AiProviderSettings): VideoModelChoice[] {
  return settings.providers
    .filter((provider) => provider.kind === 'video')
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
 * 三级：完全相同 → 忽略大小写相同 → 子串命中。子串这一级对视频尤其有用 ——
 * 用户嘴上说的是「Seedance 2.5」，实际型号是 `doubao-seedance-2-5-260628`，
 * 那串日期后缀谁也记不住。
 */
export function pickVideoModel(
  models: VideoModelChoice[],
  requested: string
): VideoModelChoice | undefined {
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
export function describeMissingVideoModel(models: VideoModelChoice[], requested: string): string {
  if (models.length === 0) {
    return (
      `没有找到叫「${requested}」的视频模型，而且当前一个视频模型都没有配置。` +
      '请用户到 设置 → 模型 添加一个用途为「视频生成」的服务商' +
      '（目录里有火山方舟 Seedance 和 MiniMax 海螺）。'
    )
  }

  return (
    `没有找到叫「${requested}」的视频模型。已配置的是：` +
    `${models.map((model) => model.label).join('、')}。` +
    '照着填一个，或者不填 model 用用户绑定的那个。'
  )
}
