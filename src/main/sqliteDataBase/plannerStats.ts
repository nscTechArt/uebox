/**
 * 规划器统计信息（sqlite_stat1）—— 什么时候重算、怎么算，只有这一处。
 *
 * 以前两处各有一套：VaultManager 只在「完全没有统计」时整库 ANALYZE 一次（52 万行约 5 秒，
 * 主进程不响应，之后库再怎么长也不再算），SyncClient 对账后另一套判据。
 *
 * - 何时算：统计表里记的行数和现在的行数差两倍以上（含首次从空库灌满）。两边都按
 *   **全部行**数（统计表的第一个数就是索引里的总行数，软删的也算在内）—— 拿活行数去比，
 *   回收站一多就永远「差两倍」，每轮都重算。
 * - 怎么算：一个索引一个索引地算，中间让出事件循环。整库一句 ANALYZE 会一口气占住主线程。
 * - 别用 analysis_limit 采样提速，理由见 vaultConnectionPragmas.ts。
 */
import type Database from 'better-sqlite3'

const TABLES = ['assetData', 'assetFolder'] as const

export interface PlannerStatsOptions {
  /** 返回 true 就停（连接被关、客户端被换掉） */
  shouldStop?: () => boolean
  /** 两个索引之间怎么让出；默认 setImmediate */
  yieldFn?: () => Promise<void>
}

function readAnalyzedRows(db: Database.Database): number {
  try {
    // 每个索引一行，第一个数是统计时这个索引的行数。取最大的：部分索引（回收站那个只收
    // isDelete = 1 的行）记的是它自己的行数，拿它当全表行数会以为库是空的
    const rows = db.prepare(`SELECT stat FROM sqlite_stat1 WHERE tbl = 'assetData'`).all() as {
      stat?: string
    }[]
    let max = 0
    for (const row of rows) max = Math.max(max, Number(String(row.stat ?? '').split(' ')[0]) || 0)
    return max
  } catch {
    return 0 // 还没有 sqlite_stat1
  }
}

/** @returns 这次是否重算了 */
export async function refreshPlannerStatsIfStale(
  db: Database.Database,
  options: PlannerStatsOptions = {}
): Promise<boolean> {
  const shouldStop = options.shouldStop ?? ((): boolean => !db.open)
  const yieldFn =
    options.yieldFn ?? ((): Promise<void> => new Promise((resolve) => setImmediate(resolve)))
  try {
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM assetData`).get() as { c: number }).c
    if (total === 0) return false // 空表 ANALYZE 不写统计行，算了也白算
    const analyzed = readAnalyzedRows(db)
    const ratio = (total + 1) / (analyzed + 1)
    if (analyzed > 0 && ratio < 2 && ratio > 0.5) return false

    const started = Date.now()
    const indexes = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name IN (${TABLES.map(() => '?').join(', ')})
             AND sql IS NOT NULL`
        )
        .all(...TABLES) as { name: string }[]
    ).map((row) => row.name)
    for (const name of indexes) {
      if (shouldStop()) return false
      db.exec(`ANALYZE "${name.replace(/"/g, '""')}"`)
      await yieldFn()
    }
    console.log(
      `[plannerStats] 资产数从 ${analyzed} 变为 ${total}，重新统计 ${indexes.length} 个索引，耗时 ${Date.now() - started} ms`
    )
    return true
  } catch (err) {
    console.warn('[plannerStats] 刷新统计信息失败（不影响数据）:', err)
    return false
  }
}
