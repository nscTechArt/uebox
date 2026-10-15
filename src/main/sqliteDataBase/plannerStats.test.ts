/**
 * 规划器统计什么时候重算。
 *
 * 两个坑：拿「活行数」去和统计表里的「总行数」比（回收站一多就永远差两倍，每轮都重算）；
 * 拿部分索引（回收站那个）的统计行当全表行数（以为库是空的，每轮都重算）。
 */
import { describe, expect, it, vi } from 'vitest'

// 取消 tests/setup.ts 里对 better-sqlite3 的全局 mock —— 这里要真的 ANALYZE
vi.unmock('better-sqlite3')

import Database from 'better-sqlite3'
import { applyVaultSchema } from './vaultSchema'
import { refreshPlannerStatsIfStale } from './plannerStats'

function vaultWith(active: number, deleted: number): Database.Database {
  const db = new Database(':memory:')
  applyVaultSchema(db)
  const insert = db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, isDelete) VALUES (?, 'ALL', ?, ?)`
  )
  db.transaction(() => {
    for (let i = 0; i < active; i += 1) insert.run(`a${i}`, `a${i}`, 0)
    for (let i = 0; i < deleted; i += 1) insert.run(`d${i}`, `d${i}`, 1)
  })()
  return db
}

const noYield = { yieldFn: async (): Promise<void> => undefined }

describe('refreshPlannerStatsIfStale', () => {
  it('没有统计时算一遍，之后行数没怎么变就不再算', async () => {
    const db = vaultWith(1000, 0)
    expect(await refreshPlannerStatsIfStale(db, noYield)).toBe(true)
    expect(await refreshPlannerStatsIfStale(db, noYield)).toBe(false)
  })

  it('回收站比活的还多：照样只算一次（按总行数比，不按活行数）', async () => {
    const db = vaultWith(1000, 1500)
    expect(await refreshPlannerStatsIfStale(db, noYield)).toBe(true)
    expect(await refreshPlannerStatsIfStale(db, noYield)).toBe(false)
  })

  it('库长大两倍以上就重算', async () => {
    const db = vaultWith(1000, 0)
    await refreshPlannerStatsIfStale(db, noYield)
    const insert = db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName) VALUES (?, 'ALL', ?)`
    )
    db.transaction(() => {
      for (let i = 0; i < 2000; i += 1) insert.run(`n${i}`, `n${i}`)
    })()
    expect(await refreshPlannerStatsIfStale(db, noYield)).toBe(true)
  })

  it('空库不算（空表 ANALYZE 不写统计，算了也白算）', async () => {
    const db = vaultWith(0, 0)
    expect(await refreshPlannerStatsIfStale(db, noYield)).toBe(false)
  })

  it('一个索引一个索引地算，中间让出；被叫停就不再继续', async () => {
    const db = vaultWith(500, 0)
    const yieldFn = vi.fn(async () => undefined)
    let stop = false
    const done = await refreshPlannerStatsIfStale(db, {
      yieldFn: async () => {
        await yieldFn()
        stop = true
      },
      shouldStop: () => stop
    })
    expect(done).toBe(false)
    expect(yieldFn).toHaveBeenCalledTimes(1)
  })
})
