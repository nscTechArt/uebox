import type { AiProviderSettings } from '../../../ai/types'

/**
 * 3D 模型的挑选与报错话术。与 `videoModels.ts` / `imageModels.ts` 同一套形状。
 *
 * 三份没抽成一份：错误文案要说清「到哪儿配什么」，而那句话各自不一样 ——
 * 抽成带参数的模板之后，改一边的措辞会牵动另外两边。
 */

export interface Model3dChoice {
  providerId: string
  modelId: string
  /** 给人看的名字，形如 `Tripo（VAST AI）:v3.1-20260211` */
  label: string
}

/** 用途为「3D 生成」的 Provider 下的全部模型，按 Provider 顺序排 */
export function listModel3dModels(settings: AiProviderSettings): Model3dChoice[] {
  return settings.providers
    .filter((provider) => provider.kind === 'model3d')
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
 * 子串这一级对 3D 尤其有用：用户嘴上说的是「Tripo 3.1」，型号是
 * `v3.1-20260211`；说「Rodin」时厂商那边叫 `Gen-2`。全称谁也记不住。
 */
export function pickModel3d(models: Model3dChoice[], requested: string): Model3dChoice | undefined {
  const wanted = requested.trim()
  if (!wanted) return undefined

  const lower = wanted.toLowerCase()
  return (
    models.find((model) => model.modelId === wanted) ??
    models.find((model) => model.modelId.toLowerCase() === lower) ??
    models.find((model) => model.modelId.toLowerCase().includes(lower)) ??
    // 型号名认不出来时再按 Provider 名找一次 —— 用户说「用 Rodin」时
    // 指的是厂商，而 Rodin 的型号叫 Gen-2，字面上一个字都不沾
    models.find((model) => model.label.toLowerCase().includes(lower))
  )
}

/** 挑不到时给模型看的话。带上清单，它下一次才填得对 */
export function describeMissingModel3d(models: Model3dChoice[], requested: string): string {
  if (models.length === 0) {
    return (
      `没有找到叫「${requested}」的 3D 模型，而且当前一个 3D 模型都没有配置。` +
      '请用户到 设置 → 模型 添加一个用途为「3D 生成」的服务商' +
      '（目录里有 Hyper3D Rodin、Tripo、Meshy）。'
    )
  }

  return (
    `没有找到叫「${requested}」的 3D 模型。已配置的是：` +
    `${models.map((model) => model.label).join('、')}。` +
    '照着填一个，或者不填 model 用用户绑定的那个。'
  )
}
