/**
 * 资产查询 worker 的调度：派发、作废、放手、崩溃退回、WAL 检查点交接。
 *
 * worker 换成假的（同样的消息协议），库用临时目录里的真文件 —— runner 只接磁盘上的库。
 * 每一条都对应代码审查里复现过的问题：放手超时把慢查询拿回主线程重跑、放手途中的查询
 * 把老库文件重新打开、每敲一次键都排一条完整查询；外加 54 万行对账时 WAL 一直追不平长到 7 GB。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 取消 tests/setup.ts 里对 better-sqlite3 的全局 mock —— 这里要真的建库
vi.unmock('better-sqlite3')

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AssetQueryRunner, QueryCancelledError, type QueryWorkerLike } from './assetQueryRunner'
import type { AssetQueryResponse } from './assetQueryProtocol'
import { applyVaultSchema } from '../vaultSchema'
import { WATCHED_WAL_AUTOCHECKPOINT } from '../vaultConnectionPragmas'

type Posted = { id: number; op: string; [key: string]: unknown }

class FakeWorker implements QueryWorkerLike {
  posted: Posted[] = []
  autoRespond = true
  private listeners: Record<string, Array<(arg: never) => void>> = {
    message: [],
    error: [],
    exit: []
  }
  terminate = vi.fn(async () => 0)

  on(event: string, listener: (arg: never) => void): this {
    this.listeners[event].push(listener)
    return this
  }

  postMessage(message: unknown): void {
    const msg = message as Posted
    this.posted.push(msg)
    if (this.autoRespond) {
      setImmediate(() =>
        this.respond(msg.id, msg.op === 'search' ? [{ assetKey: 'from-worker' }] : null)
      )
    }
  }

  respond(id: number, data: unknown): void {
    const response: AssetQueryResponse = { id, ok: true, data }
    for (const listener of this.listeners.message) listener(response as never)
  }

  crash(): void {
    for (const listener of this.listeners.exit) listener(1 as never)
  }
}

let dir: string
let db: Database.Database
let fake: FakeWorker
let runner: AssetQueryRunner

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'asset-query-runner-'))
  db = new Database(join(dir, 'vault-data.db'))
  db.pragma('journal_mode = WAL')
  applyVaultSchema(db)
  fake = new FakeWorker()
  runner = new AssetQueryRunner(() => fake)
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const criteria = { folderKey: 'ALL', limit: 50 }

describe('派发', () => {
  it('查询交给 worker，带上库路径和内存映射开关', async () => {
    const rows = await runner.search(db, criteria, null)
    expect(rows).toEqual([{ assetKey: 'from-worker' }])
    expect(fake.posted[0]).toMatchObject({ op: 'search', vaultDbPath: db.name, mmap: false })
  })

  it('同一组的新查询作废排着还没开始的旧查询', async () => {
    fake.autoRespond = false
    const first = runner.search(db, criteria, null, 'asset-list')
    const second = runner.search(db, criteria, null, 'asset-list')
    const third = runner.search(db, criteria, null, 'asset-list')
    await expect(second).rejects.toBeInstanceOf(QueryCancelledError)
    // 第一条已经在 worker 里跑，不动它；它回来之后派的是最新那条
    fake.respond(fake.posted[0].id, ['first'])
    await expect(first).resolves.toEqual(['first'])
    await vi.waitFor(() => expect(fake.posted).toHaveLength(2))
    fake.respond(fake.posted[1].id, ['third'])
    await expect(third).resolves.toEqual(['third'])
  })
})

describe('放手', () => {
  it('放手超时：在途的慢查询按取消处理，不拿回主线程重跑', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    fake.autoRespond = false
    const slow = expect(runner.search(db, criteria, null)).rejects.toBeInstanceOf(
      QueryCancelledError
    )
    const release = runner.release(db)
    await vi.advanceTimersByTimeAsync(3_000)
    await release
    await slow
    expect(fake.terminate).toHaveBeenCalled()
  })

  it('放手之后，旧连接上来的查询一律拒绝（不让 worker 把老库文件又打开）', async () => {
    await runner.release(db)
    const postedBefore = fake.posted.length
    await expect(runner.search(db, criteria, null)).rejects.toBeInstanceOf(QueryCancelledError)
    expect(fake.posted).toHaveLength(postedBefore)
  })
})

describe('worker 不可用', () => {
  it('worker 崩了：这一次退回主进程查', async () => {
    fake.autoRespond = false
    const pending = runner.search(db, criteria, null)
    fake.crash()
    // 主进程查的是真库：空库返回空数组，不抛
    await expect(pending).resolves.toEqual([])
  })
})

describe('WAL 检查点交接', () => {
  const autocheckpoint = (): number => Number(db.pragma('wal_autocheckpoint', { simple: true }))

  it('worker 确认接手后主连接的自动检查点调大到只当兜底；worker 没了再恢复默认', async () => {
    runner.startWalCheckpointing(db)
    expect(fake.posted[0]).toMatchObject({ op: 'watch-wal', path: db.name })
    await vi.waitFor(() => expect(autocheckpoint()).toBe(WATCHED_WAL_AUTOCHECKPOINT))
    fake.crash()
    expect(autocheckpoint()).toBe(1000)
  })

  it('连接要关之前交回：worker 关掉检查点连接，主连接恢复默认的自动检查点', async () => {
    runner.startWalCheckpointing(db)
    await vi.waitFor(() => expect(autocheckpoint()).toBe(WATCHED_WAL_AUTOCHECKPOINT))
    await runner.stopWalCheckpointing(db)
    expect(fake.posted.map((m) => m.op)).toContain('unwatch-wal')
    expect(autocheckpoint()).toBe(1000)
  })

  it('等 WAL 追平：交接之后让 worker 当场做一次检查点，做完才返回', async () => {
    runner.startWalCheckpointing(db)
    await vi.waitFor(() => expect(autocheckpoint()).toBe(WATCHED_WAL_AUTOCHECKPOINT))
    fake.autoRespond = false
    let done = false
    const waiting = runner.waitForWalCheckpoint(db).then(() => (done = true))
    const request = fake.posted[fake.posted.length - 1]
    expect(request).toMatchObject({ op: 'checkpoint-wal', path: db.name })
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    fake.respond(request.id, { log: 10, checkpointed: 10 })
    await waiting
    expect(done).toBe(true)
  })

  it('没交给 worker 的连接：等 WAL 追平什么都不做，也不为此拉起 worker', async () => {
    const spawn = vi.fn(() => fake)
    const idle = new AssetQueryRunner(spawn)
    await idle.waitForWalCheckpoint(db)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('等的时候 worker 崩了：照常返回，不抛', async () => {
    runner.startWalCheckpointing(db)
    await vi.waitFor(() => expect(autocheckpoint()).toBe(WATCHED_WAL_AUTOCHECKPOINT))
    fake.autoRespond = false
    const waiting = runner.waitForWalCheckpoint(db)
    fake.crash()
    await expect(waiting).resolves.toBeUndefined()
  })
})
