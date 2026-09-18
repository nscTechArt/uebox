/**
 * 版本冲突弹窗里「哪些资产被挡下了」这句话的取材。
 *
 * 原来是内联的一句 `blocked.map(...).join('、')`，没有上限 —— 一个 111 个资产的素材包
 * 一口气挡下 104 项，104 个名字全铺进弹窗，直接撑到满屏、把按钮顶出可视区。
 * 而且第 6 个名字之后没有任何新信息：人要判断的是「哪个包、差多少版本、有多少项」，
 * 不是把 104 个名字读一遍。
 *
 * 抽出来是为了测得到这个上限。文案拼接留在调用方，这里不碰 i18n。
 */

export interface BlockedAsset {
  assetName: string
  version: string
}

export interface BlockedAssetsSummary {
  /** 点到名的那几个，已经拼成「名字 (UE 5.2)」并用顿号连好 */
  listed: string
  /** 没点到名的还剩几个；0 表示全列出来了 */
  rest: number
}

/** 默认最多点名 5 个 */
export const BLOCKED_ASSETS_LIST_LIMIT = 5

export const summarizeBlockedAssets = (
  blocked: readonly BlockedAsset[],
  limit: number = BLOCKED_ASSETS_LIST_LIMIT
): BlockedAssetsSummary => {
  const safeLimit = Math.max(0, limit)
  const listed = blocked
    .slice(0, safeLimit)
    .map((asset) => `${asset.assetName} (UE ${asset.version})`)
    .join('、')
  return { listed, rest: Math.max(0, blocked.length - safeLimit) }
}
