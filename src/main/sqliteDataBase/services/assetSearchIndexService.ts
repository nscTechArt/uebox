/**
 * 全文检索索引的后台补齐。
 *
 * 索引本身是「触发器记账 + JS 批量重建」（见 models/assetSearchIndex.ts）。
 * 记账是即时的，重建不是 —— 这个文件负责把欠账还上。
 *
 * 为什么不在搜索时同步补齐：几十万条资产第一次建索引要十几秒，卡在一次搜索里
 * 用户只会觉得应用死了。分片放到事件循环里做，期间搜索照常可用（退回 LIKE，
 * 慢但结果是全的），补齐之后自动切到索引路径。
 *
 * 为什么不用 worker 线程：better-sqlite3 是同步 API，一个连接不能跨线程共享；
 * 为它单开一条连接和一套 ABI 维护，代价远大于这里省下的那几秒主线程时间。
 */

import Database from 'better-sqlite3'
import {
  getAssetSearchIndexStatus,
  isAssetSearchIndexReady,
  markAllAssetsDirty,
  syncAssetSearchIndex,
  type AssetSearchIndexStatus
} from '../models/assetSearchIndex'

/** 一片处理多少条。太大主线程会有肉眼可见的卡顿，太小补齐要等很久 */
const CHUNK_SIZE = 1000

/** 两片之间让出多久。给 UI 事件和 IPC 留出缝隙 */
const CHUNK_INTERVAL_MS = 30

/**
 * 每个数据库连接只跑一个补齐循环。
 *
 * 用连接对象本身做键：保管库可以切换，切过去的那个库有它自己的欠账，
 * 两个循环各跑各的互不干扰；同一个库被反复触发时也不会叠出好几个循环。
 */
const runningLoops = new WeakSet<Database.Database>()

export interface WarmupOptions {
  publicDb?: Database.Database
  /** 每片处理多少条 */
  chunkSize?: number
}

/**
 * 确保这个保管库的索引在后台补齐。已经在跑或者已经追平的话什么都不做。
 *
 * 随手调用是安全的 —— 打开保管库时调一次，搜索发现索引没追上时再调一次，
 * 都不会重复起循环。
 */
export function ensureAssetSearchIndexWarm(
  db: Database.Database,
  options: WarmupOptions = {}
): void {
  if (runningLoops.has(db)) return
  if (isAssetSearchIndexReady(db)) return

  runningLoops.add(db)
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? CHUNK_SIZE))

  const step = (): void => {
    let pending = 0
    try {
      if (!db.open) {
        runningLoops.delete(db)
        return
      }
      const result = syncAssetSearchIndex(db, { publicDb: options.publicDb, budget: chunkSize })
      pending = result.pending
    } catch (error) {
      // 补齐失败不该拖垮任何东西：索引没追上时搜索会退回 LIKE，功能是全的。
      // 这里停掉循环而不是无限重试 —— 一直失败的话重试只是在刷日志。
      console.warn('[资产索引] 后台补齐失败，已停止；搜索将退回 LIKE:', error)
      runningLoops.delete(db)
      return
    }

    if (pending <= 0) {
      runningLoops.delete(db)
      console.log('[资产索引] 全文索引已追平')
      return
    }
    setTimeout(step, CHUNK_INTERVAL_MS)
  }

  setTimeout(step, 0)
}

/**
 * 从头重建整个索引。
 *
 * 给「设置里点一下修复」用：索引怀疑坏了、或者分词口径变了的时候。
 * 重建期间搜索退回 LIKE，不会中断。
 */
export function rebuildAssetSearchIndex(db: Database.Database, options: WarmupOptions = {}): void {
  markAllAssetsDirty(db)
  ensureAssetSearchIndexWarm(db, options)
}

export function getAssetSearchIndexProgress(db: Database.Database): AssetSearchIndexStatus {
  return getAssetSearchIndexStatus(db)
}
