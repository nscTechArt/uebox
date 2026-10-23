/** 主进程 ↔ 资产查询 worker 的消息格式（两边共用，别各写一份） */
import type { AssetSearchCriteria } from '../models/assetSearchCore'

export type AssetQueryRequest =
  | {
      id: number
      /** search = 取一页资产；engine-facet = 各引擎版本有几个（筛选栏的版本下拉） */
      op: 'search' | 'engine-facet'
      vaultDbPath: string
      /** 主连接开了内存映射才开，见 vaultConnectionPragmas */
      mmap: boolean
      publicDbPath: string | null
      criteria: AssetSearchCriteria
    }
  /** 关掉手上所有库文件（读连接和检查点连接都关） */
  | { id: number; op: 'release' }
  /** 接手这个库的 WAL 检查点 */
  | { id: number; op: 'watch-wal'; path: string }
  | { id: number; op: 'unwatch-wal'; path: string }
  /** 当场做一次 PASSIVE 检查点，回报 { log, checkpointed }（没在管这个库就回 null） */
  | { id: number; op: 'checkpoint-wal'; path: string }

export type AssetQueryResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; code?: string }
