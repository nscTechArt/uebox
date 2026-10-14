/** 主进程 ↔ 资产查询 worker 的消息格式（两边共用，别各写一份） */
import type { AssetSearchCriteria } from '../models/assetSearchCore'

export type AssetQueryRequest =
  | {
      id: number
      op: 'search'
      vaultDbPath: string
      publicDbPath: string | null
      criteria: AssetSearchCriteria
    }
  | { id: number; op: 'release' }

export type AssetQueryResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; code?: string }
