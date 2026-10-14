/**
 * SyncClient.reconcile.test.ts — 全量对账在大库上的行为
 *
 * 54 万资产的库上，旧对账是「全拉进内存、最后一个事务写完」：进度停在 70%
 * 然后崩掉，重启从 0 开始；服务端一行缺字段的数据还会让对账一完 3 秒后再来一轮。
 * 这里用一个按旧服务端 /full-data 语义（rowid 游标分页）实现的假服务端把这些情形
 * 逐条钉住。
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel } from '../sqliteDataBase/models/assetFolder'
import { SyncClient } from './SyncClient'

type Row = Record<string, unknown>

let db: Database.Database
let client: SyncClient

function createTestDb(): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  initAssetFolderModel(database)
  initAssetDataModel(database)
  database
    .prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
    )
    .run()
  return database
}

/**
 * 假服务端：按旧 asset-server-standalone 的 /full-data 语义分页
 * （cursor = 上一页最后一行的 rowid，maxRowid 截住快照边界）。
 */
interface FakeServer {
  httpGet: ReturnType<typeof vi.fn<(path: string) => Promise<unknown>>>
  requests: string[]
  failCall: (n: number) => void
  assetPageRequests: () => string[]
}

function fakeServer(options: { folders: Row[]; assets: Row[]; pageSize?: number }): FakeServer {
  const requests: string[] = []
  const failOnce = new Set<number>()
  let call = 0
  const pageSize = options.pageSize ?? 3

  const httpGet = vi.fn(async (path: string): Promise<unknown> => {
    requests.push(path)
    call += 1
    if (failOnce.has(call)) {
      failOnce.delete(call)
      throw new Error('HTTP timeout')
    }
    const url = new URL(path, 'http://x')
    if (url.pathname.endsWith('/sync')) {
      return { changes: [], latestSeq: 42, fullSyncRequired: false }
    }
    const type = url.searchParams.get('type') as 'folders' | 'assets'
    const cursor = Number(url.searchParams.get('cursor') || 0)
    const source = type === 'folders' ? options.folders : options.assets
    const maxRowid = cursor === 0 ? source.length : Number(url.searchParams.get('maxRowid'))
    const rows = source
      .map((row, index) => ({ ...row, _rowid: index + 1 }))
      .filter((row) => row._rowid > cursor && row._rowid <= maxRowid)
      .slice(0, pageSize)
    const nextCursor = rows.length ? rows[rows.length - 1]._rowid : cursor
    return {
      rows,
      type,
      cursor: nextCursor,
      hasMore: rows.length === pageSize && nextCursor < maxRowid,
      total: source.length,
      snapshotMaxRowid: maxRowid,
      snapshotSeq: 42
    }
  })

  return {
    httpGet,
    requests,
    /** 第 n 次请求（从 1 数）失败一次 */
    failCall: (n: number) => {
      failOnce.add(n)
    },
    assetPageRequests: () => requests.filter((p) => p.includes('type=assets'))
  }
}

const asset = (assetKey: string, extra: Row = {}): Row => ({
  assetKey,
  folderKey: 'ALL',
  assetName: assetKey,
  isDelete: 0,
  ...extra
})

const reconcile = (): Promise<void> =>
  (client as unknown as { reconcileSync: () => Promise<void> }).reconcileSync()

const install = (server: FakeServer): void => {
  ;(client as unknown as { httpGet: unknown }).httpGet = server.httpGet
  ;(client as unknown as { flushOutbox: unknown }).flushOutbox = vi
    .fn()
    .mockResolvedValue({ flushed: 0, failed: 0 })
}

const activeKeys = (): string[] =>
  (
    db.prepare(`SELECT assetKey FROM assetData WHERE isDelete = 0 ORDER BY assetKey`).all() as {
      assetKey: string
    }[]
  ).map((r) => r.assetKey)

beforeEach(() => {
  db = createTestDb()
  client = new SyncClient(db, {
    serverUrl: 'http://127.0.0.1:1',
    vaultId: 'v1',
    clientId: 'c1',
    hostname: 'h1'
  })
})

afterEach(() => {
  client.stop()
  db.close()
})

describe('分页落盘', () => {
  it('每一页拉下来就写进本地，断点随页前进', async () => {
    const assets = Array.from({ length: 7 }, (_, i) => asset(`a${i}`))
    const server = fakeServer({ folders: [], assets })
    install(server)

    const seenDuringDownload: number[] = []
    const original = server.httpGet.getMockImplementation()!
    server.httpGet.mockImplementation(async (path: string) => {
      if (path.includes('type=assets')) {
        seenDuringDownload.push(
          (db.prepare(`SELECT COUNT(*) AS c FROM assetData`).get() as { c: number }).c
        )
      }
      return original(path)
    })

    await reconcile()

    // 每次请求下一页时，前几页已经在库里了 —— 不是攒到最后一起写
    expect(seenDuringDownload).toEqual([0, 3, 6])
    expect(activeKeys()).toEqual(assets.map((a) => a.assetKey).sort())
    const state = db.prepare(`SELECT last_seq FROM sync_state WHERE vault_id = 'v1'`).get() as {
      last_seq: number
    }
    expect(state.last_seq).toBe(42)
  })

  it('中途断网后，下一次从断点接着拉，而不是从头', async () => {
    const assets = Array.from({ length: 9 }, (_, i) => asset(`a${i}`))
    const server = fakeServer({ folders: [], assets })
    install(server)
    // 请求顺序：1=folders，2/3/4=assets 第 1/2/3 页。第 3 次（资产第 2 页）超时
    server.failCall(3)

    await expect(reconcile()).rejects.toThrow('HTTP timeout')
    expect(activeKeys()).toEqual(['a0', 'a1', 'a2'])

    // 重启：新客户端读同一个库
    client.stop()
    client = new SyncClient(db, {
      serverUrl: 'http://127.0.0.1:1',
      vaultId: 'v1',
      clientId: 'c1',
      hostname: 'h1'
    })
    const resumed = fakeServer({ folders: [], assets })
    install(resumed)
    await reconcile()

    // 没有再请求 folders，资产第一页也没有重拉：直接从 cursor=3 开始
    expect(resumed.requests.some((p) => p.includes('type=folders'))).toBe(false)
    expect(resumed.assetPageRequests()[0]).toContain('cursor=3')
    expect(activeKeys()).toEqual(assets.map((a) => a.assetKey).sort())
  })

  it('续传之后差集照样对：本地有、服务端没有的被软删', async () => {
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, isDelete) VALUES ('gone', 'ALL', 'gone', 0)`
    ).run()
    const assets = Array.from({ length: 6 }, (_, i) => asset(`a${i}`))
    const server = fakeServer({ folders: [], assets })
    install(server)
    server.failCall(3)
    await expect(reconcile()).rejects.toThrow()
    // 中断时还没到差集阶段，不能提前软删
    expect(activeKeys()).toContain('gone')

    install(fakeServer({ folders: [], assets }))
    await reconcile()
    expect(activeKeys()).not.toContain('gone')
    expect(activeKeys()).toHaveLength(6)
  })

  it('别的轮次留下的「见过」记录不算数', async () => {
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, isDelete) VALUES ('gone', 'ALL', 'gone', 0)`
    ).run()
    // 上一轮（被换掉的旧实例）记下过 gone
    db.prepare(
      `INSERT INTO sync_reconcile_seen (scope, run_id, table_name, record_key) VALUES ('v1', 1, 'assetData', 'gone')`
    ).run()
    install(fakeServer({ folders: [], assets: [asset('a0')] }))
    await reconcile()
    expect(activeKeys()).toEqual(['a0'])
    // 这一轮做完把自己的记录清掉，旧轮次的残留在开新一轮时就清了
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM sync_reconcile_seen`).get() as { c: number }).c
    ).toBe(0)
  })

  it('库的规模没变就不重算统计信息（54 万行一次要好几秒）', async () => {
    const assets = Array.from({ length: 30 }, (_, i) => asset(`a${i}`))
    install(fakeServer({ folders: [], assets }))
    await reconcile()
    const execSpy = vi.spyOn(db, 'exec')
    install(fakeServer({ folders: [], assets }))
    await reconcile()
    // 回收站的部分索引统计行数是 0，不能拿它当全表行数（那样每轮都会重算）
    expect(execSpy.mock.calls.some(([sql]) => /ANALYZE/i.test(String(sql)))).toBe(false)
  })

  it('同时触发两次对账只跑一轮', async () => {
    const server = fakeServer({ folders: [], assets: [asset('a0')] })
    install(server)
    await Promise.all([reconcile(), reconcile()])
    expect(server.assetPageRequests()).toHaveLength(1)
  })
})

describe('服务端的坏数据只跳过那一行', () => {
  it('缺名字的行不会让对账一完又来一轮', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const server = fakeServer({
        folders: [],
        assets: [asset('ok'), asset('broken', { assetName: '' })]
      })
      install(server)
      await reconcile()
      expect(activeKeys()).toEqual(['ok'])

      // 旧实现：broken 进了缺行缓冲 → 3 秒后再全量对账一次 → 又进缓冲 → 永远循环
      await vi.advanceTimersByTimeAsync(10_000)
      expect(server.assetPageRequests()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('所在文件夹不存在的资产被跳过，其余照常写入', async () => {
    const server = fakeServer({
      folders: [],
      assets: [asset('a0'), asset('orphan', { folderKey: 'no_such_folder' }), asset('a1')]
    })
    install(server)
    // 旧实现：一行外键失败回滚整个事务 → 一行都写不进 → 下次再全量 → 再回滚
    await reconcile()
    expect(activeKeys()).toEqual(['a0', 'a1'])
  })

  it('跳过的行计入校验，不会每两次校验就升级成全量', async () => {
    const server = fakeServer({
      folders: [],
      assets: [asset('a0'), asset('orphan', { folderKey: 'no_such_folder' })]
    })
    install(server)
    await reconcile()

    // 服务端数的是 2 个，本地存下了 1 个（文件夹两边都只有 ALL 根）
    server.httpGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/checksum')) return { assetCount: 2, folderCount: 1, latestSeq: 42 }
      return { changes: [], latestSeq: 42, fullSyncRequired: false }
    })
    const reconcileSpy = vi.fn().mockResolvedValue(undefined)
    ;(client as unknown as { reconcileSync: unknown }).reconcileSync = reconcileSpy
    const verify = (): Promise<void> =>
      (client as unknown as { verifyChecksum: () => Promise<void> }).verifyChecksum()
    await verify()
    await verify()
    await verify()
    expect(reconcileSpy).not.toHaveBeenCalled()
  })
})

describe('没变的行不写', () => {
  it('值和本地一样时不改 updated_at（不触发索引重建）', async () => {
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, note, isDelete, updated_at)
       VALUES ('a0', 'ALL', 'a0', '原样', 0, '2020-01-01 00:00:00'),
              ('a1', 'ALL', 'a1', '旧备注', 0, '2020-01-01 00:00:00')`
    ).run()
    install(
      fakeServer({
        folders: [],
        assets: [asset('a0', { note: '原样' }), asset('a1', { note: '新备注' })]
      })
    )
    await reconcile()

    const rows = db
      .prepare(`SELECT assetKey, note, updated_at FROM assetData ORDER BY assetKey`)
      .all() as { assetKey: string; note: string; updated_at: string }[]
    expect(rows[0]).toMatchObject({ note: '原样', updated_at: '2020-01-01 00:00:00' })
    expect(rows[1].note).toBe('新备注')
    expect(rows[1].updated_at).not.toBe('2020-01-01 00:00:00')
  })
})

describe('实时变更攒批', () => {
  it('连发的变更一个事务写完，界面只收到一条汇总通知', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const changes: Array<{ op: string; tableName: string; count?: number }> = []
      client.on('change', (entry) => changes.push(entry))
      const applySpy = vi.spyOn(client as unknown as { applyChanges: () => void }, 'applyChanges')
      const handle = (msg: unknown): void =>
        (client as unknown as { handleWsMessage: (m: unknown) => void }).handleWsMessage(msg)

      handle({
        type: 'change',
        seq: 1,
        op: 'insert',
        tableName: 'assetFolder',
        recordKey: 'f1',
        payload: JSON.stringify({
          folderKey: 'f1',
          fatherKey: 'ALL',
          type: 'folder',
          folderName: 'f1',
          depth: 1
        }),
        clientId: 'other'
      })
      for (let i = 0; i < 50; i += 1) {
        handle({
          type: 'change',
          seq: i + 2,
          op: 'insert',
          tableName: 'assetData',
          recordKey: `a${i}`,
          payload: JSON.stringify({
            assetKey: `a${i}`,
            folderKey: 'f1',
            assetName: `a${i}`,
            isDelete: 0
          }),
          clientId: 'other'
        })
      }
      expect(applySpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)

      expect(applySpy).toHaveBeenCalledTimes(1)
      expect(activeKeys()).toHaveLength(50)
      // 文件夹也在这一批里 → 汇总通知要让界面刷目录树
      expect(changes).toEqual([
        expect.objectContaining({ op: 'batch', tableName: 'assetFolder', count: 51 })
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('大批增量分片写', () => {
  const changesFor = (count: number): unknown[] =>
    Array.from({ length: count }, (_, i) => ({
      seq: 1000 + i,
      op: 'insert',
      tableName: 'assetData',
      recordKey: `c${i}`,
      payload: JSON.stringify({
        assetKey: `c${i}`,
        folderKey: 'ALL',
        assetName: `c${i}`,
        isDelete: 0
      }),
      clientId: 'other',
      createdAt: 0
    }))
  const applyInSlices = (changes: unknown[]): Promise<void> =>
    (
      client as unknown as { applyChangesInSlices: (c: unknown[]) => Promise<void> }
    ).applyChangesInSlices(changes)
  const lastSeq = (): number => (client as unknown as { lastSeq: number }).lastSeq

  it('分成多个事务写完，最后才推进 seq', async () => {
    const applySpy = vi.spyOn(client as unknown as { applyChanges: () => void }, 'applyChanges')
    await applyInSlices(changesFor(450))
    expect(applySpy.mock.calls.length).toBeGreaterThan(1)
    expect(activeKeys()).toHaveLength(450)
    expect(lastSeq()).toBe(1449)
  })

  it('中途被停掉时 seq 不前进，下次从原处重拉', async () => {
    const before = lastSeq()
    const promise = applyInSlices(changesFor(450))
    client.stop()
    await expect(promise).rejects.toThrow()
    expect(lastSeq()).toBe(before)
  })
})

describe('启动失败', () => {
  it('没人监听 error 也不会抛出，而是排期重连', async () => {
    ;(client as unknown as { flushOutbox: unknown }).flushOutbox = vi
      .fn()
      .mockResolvedValue({ flushed: 0, failed: 0 })
    ;(client as unknown as { pullChanges: unknown }).pullChanges = vi
      .fn()
      .mockRejectedValue(new Error('HTTP timeout'))
    const scheduleReconnect = vi.fn()
    ;(client as unknown as { scheduleReconnect: unknown }).scheduleReconnect = scheduleReconnect
    const statuses: string[] = []
    client.on('status', (s) => statuses.push(s))

    // 旧实现：emit('error') 没有监听者 → 原地抛出 → 下面两步都走不到
    await expect(client.start()).resolves.toBeUndefined()
    expect(statuses).toContain('error')
    expect(scheduleReconnect).toHaveBeenCalledTimes(1)
  })
})
