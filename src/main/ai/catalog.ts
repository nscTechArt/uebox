import type { CatalogEntry } from '../../shared/aiProvider'
import { GENERATED_CATALOG } from './catalog.generated'

export type { CatalogEntry }

/**
 * 内置 Provider 精选目录。
 *
 * 纯静态数据，**不联网**。社区版承诺离线可用，打开「添加 Provider」不该是
 * 一次对外请求 —— 目录由 `scripts/sync-provider-catalog.mjs` 从 models.dev
 * 生成快照后提交进仓库，发版前跑一次即可。
 *
 * 要增删厂商或改 Base URL，改那个脚本里的 CURATED 清单再重新生成，
 * 不要手改 catalog.generated.ts。
 *
 * 这里给的模型清单只是「开箱可用的常见项」（每家最多 12 个），不追求穷举 ——
 * 用户可以在 Provider 详情里用「导入模型」从厂商的 /models 接口拉全量，
 * 也可以手填。所以清单过期不会让功能不可用，只是少了点默认值。
 */
export const PROVIDER_CATALOG: readonly CatalogEntry[] = GENERATED_CATALOG

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.id === id)
}
