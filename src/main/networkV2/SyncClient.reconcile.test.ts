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
import { AdaptiveSliceSizer } from './adaptiveSlice'

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

/**
 * 旧 asset-server-standalone 存的是 path.extname 的结果（'.wav'）。以前原样抄进本地库，
 * 类型下拉（ext = 'uasset'）、统计分桶、详情面板全对不上。
 */
describe('扩展名写成小写、不带点', () => {
  const extOf = (assetKey: string): unknown =>
    db
      .prepare(`SELECT ext, fileExtension, updated_at FROM assetData WHERE assetKey = ?`)
      .get(assetKey)

  it('对账拉来的新行去点', async () => {
    install(
      fakeServer({
        folders: [],
        assets: [asset('a0', { ext: '.WAV', fileExtension: '.wav' })]
      })
    )
    await reconcile()
    expect(extOf('a0')).toMatchObject({ ext: 'wav', fileExtension: 'wav' })
  })

  it('实时推来的变更去点', () => {
    ;(client as unknown as { applySingleChange: (c: unknown) => void }).applySingleChange({
      seq: 1,
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'a0',
      payload: JSON.stringify(asset('a0', { ext: '.uasset', fileExtension: '.uasset' }))
    })
    expect(extOf('a0')).toMatchObject({ ext: 'uasset', fileExtension: 'uasset' })
  })

  /** 不然每一轮对账都把带点的行当成「变了」，或者迁移跑完前那轮把老行整批重写 */
  it('只差一个点不算变：已去点的、还没迁移的老行都不重写', async () => {
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, ext, fileExtension, isDelete, updated_at)
       VALUES ('a0', 'ALL', 'a0', 'wav', 'wav', 0, '2020-01-01 00:00:00'),
              ('a1', 'ALL', 'a1', '.wav', '.wav', 0, '2020-01-01 00:00:00')`
    ).run()
    install(
      fakeServer({
        folders: [],
        assets: [
          asset('a0', { ext: '.wav', fileExtension: '.wav' }),
          asset('a1', { ext: '.wav', fileExtension: '.wav' })
        ]
      })
    )
    await reconcile()
    expect(extOf('a0')).toMatchObject({ ext: 'wav', updated_at: '2020-01-01 00:00:00' })
    // 老行留给 normalizeStoredExtensions 改（它不刷 updated_at）
    expect(extOf('a1')).toMatchObject({ ext: '.wav', updated_at: '2020-01-01 00:00:00' })
  })
})

describe('实时变更攒批', () => {
  it('连发的变更攒成几批写，界面只收到一条汇总通知', async () => {
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
      // 一批太大时按实测耗时分几片写（见 adaptiveSlice），但远少于一条一个事务
      await vi.waitFor(() => expect(activeKeys()).toHaveLength(50))
      expect(applySpy.mock.calls.length).toBeGreaterThan(0)
      expect(applySpy.mock.calls.length).toBeLessThan(10)
      // 文件夹也在这一批里 → 汇总通知要让界面刷目录树
      expect(changes).toEqual([
        expect.objectContaining({ op: 'batch', tableName: 'assetFolder', count: 51 })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  /** 以前分片写一开头就发通知：界面防抖后读到的只有第一片，之后再没有通知来刷新 */
  it('一批要分片写时，所有片都写完才发通知', async () => {
    ;(client as unknown as { lastSeq: number }).lastSeq = 0
    const rowsAtNotify: number[] = []
    client.on('change', () => rowsAtNotify.push(activeKeys().length))
    const handle = (msg: unknown): void =>
      (client as unknown as { handleWsMessage: (m: unknown) => void }).handleWsMessage(msg)
    // 少于 WS_CHANGE_BATCH_MAX（200），只攒成一批；又多过起始片大小，要分片写
    for (let i = 0; i < 150; i += 1) {
      handle({
        type: 'change',
        seq: i + 1,
        op: 'insert',
        tableName: 'assetData',
        recordKey: `a${i}`,
        payload: JSON.stringify({
          assetKey: `a${i}`,
          folderKey: 'ALL',
          assetName: `a${i}`,
          isDelete: 0
        }),
        clientId: 'other'
      })
    }
    ;(client as unknown as { flushWsChanges: () => void }).flushWsChanges()

    await vi.waitFor(() => expect(rowsAtNotify).toHaveLength(1))
    expect(rowsAtNotify).toEqual([150])
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

/**
 * 对账要跑好几分钟，这期间本地和服务端都还在变。下面这些是代码审查里逐条复现过的
 * 「期间发生了什么」：每一条在修之前都会让服务端还活着的行在本地被软删、或者变更被跳过。
 */
describe('对账进行中，本地和服务端还在变', () => {
  const hookAssetPage = (server: FakeServer, page: number, during: () => void): void => {
    const original = server.httpGet.getMockImplementation()!
    let seen = 0
    server.httpGet.mockImplementation(async (path: string) => {
      if (path.includes('type=assets')) {
        seen += 1
        if (seen === page) during()
      }
      return original(path)
    })
  }

  it('期间本地新建的、实时推来恢复的、实时改过的行：不被差集软删，也不被快照旧值盖回去', async () => {
    // x 本地有、服务端快照里没有（拍快照时已删），期间被同事恢复
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, isDelete) VALUES ('x', 'ALL', 'x', 0)`
    ).run()
    const assets = Array.from({ length: 9 }, (_, i) => asset(`a${i}`, { note: 'old' }))
    const server = fakeServer({ folders: [], assets })
    install(server)
    hookAssetPage(server, 2, () => {
      // 用户在拉取途中新建了一个资产（推送成功后才会 markLocalWrite —— 这里不标）
      db.prepare(
        `INSERT INTO assetData (assetKey, folderKey, assetName, isDelete) VALUES ('mine', 'ALL', 'mine', 0)`
      ).run()
      // 实时推来：x 被恢复、a7（还没拉到那一页）被改了备注
      ;(client as unknown as { applyChanges: (c: unknown[], o?: unknown) => void }).applyChanges(
        [
          {
            seq: 50,
            op: 'update',
            tableName: 'assetData',
            recordKey: 'x',
            payload: JSON.stringify({ isDelete: 0 }),
            clientId: 'other',
            createdAt: 0
          },
          {
            // 服务端广播的是整行
            seq: 51,
            op: 'update',
            tableName: 'assetData',
            recordKey: 'a7',
            payload: JSON.stringify({
              assetKey: 'a7',
              folderKey: 'ALL',
              assetName: 'a7',
              note: 'new'
            }),
            clientId: 'other',
            createdAt: 0
          },
          {
            // 局部 payload、本地又还没有这行：写不进去，也不许挡住它所在的快照页
            seq: 52,
            op: 'update',
            tableName: 'assetData',
            recordKey: 'a8',
            payload: JSON.stringify({ note: 'partial' }),
            clientId: 'other',
            createdAt: 0
          }
        ],
        { advanceSeqTo: null }
      )
    })

    await reconcile()

    expect(activeKeys()).toEqual(expect.arrayContaining(['mine', 'x', 'a8']))
    const a7 = db.prepare(`SELECT note FROM assetData WHERE assetKey = 'a7'`).get() as {
      note: string
    }
    // a7 那一页晚到，带着旧备注 —— 它已经被更新的变更碰过，不许盖回去
    expect(a7.note).toBe('new')
  })

  it('断点之后本地已经吃进了更新的变更：不续老断点，从头来', async () => {
    const assets = Array.from({ length: 9 }, (_, i) => asset(`a${i}`))
    const server = fakeServer({ folders: [], assets })
    install(server)
    server.failCall(3)
    await expect(reconcile()).rejects.toThrow()

    // 之后增量把 lastSeq 推过了老快照（42）
    ;(client as unknown as { lastSeq: number }).lastSeq = 100
    const fresh = fakeServer({ folders: [], assets })
    install(fresh)
    await reconcile()
    // 从头来：重新拉文件夹、资产从 cursor=0 开始
    expect(fresh.requests.some((p) => p.includes('type=folders'))).toBe(true)
    expect(fresh.assetPageRequests()[0]).toContain('cursor=0')
  })

  it('每一轮对账结尾都补一次增量 —— 校验触发的也一样', async () => {
    const server = fakeServer({ folders: [], assets: [asset('a0')] })
    install(server)
    const original = server.httpGet.getMockImplementation()!
    server.httpGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/checksum')) return { assetCount: 99, folderCount: 99, latestSeq: 42 }
      return original(path)
    })
    ;(client as unknown as { lastSeq: number }).lastSeq = 42
    ;(client as unknown as { checksumMismatchStreak: number }).checksumMismatchStreak = 1
    await (client as unknown as { verifyChecksum: () => Promise<void> }).verifyChecksum()

    const lastFullDataIndex = Math.max(
      ...server.requests.map((p, i) => (p.includes('full-data') ? i : -1))
    )
    const syncAfter = server.requests.findIndex(
      (p, i) => i > lastFullDataIndex && p.includes('/sync?since=42')
    )
    expect(lastFullDataIndex).toBeGreaterThan(0)
    expect(syncAfter).toBeGreaterThan(lastFullDataIndex)
  })
})

describe('实时变更和拉取的先后', () => {
  const ws = (seq: number, op: string, recordKey: string, payload: Row | null): unknown => ({
    type: 'change',
    seq,
    op,
    tableName: 'assetData',
    recordKey,
    payload: payload ? JSON.stringify(payload) : null,
    clientId: 'other'
  })
  const handle = (msg: unknown): void =>
    (client as unknown as { handleWsMessage: (m: unknown) => void }).handleWsMessage(msg)
  const flush = (): void => (client as unknown as { flushWsChanges: () => void }).flushWsChanges()
  const noChangesServer = (): void => {
    ;(client as unknown as { httpGet: unknown }).httpGet = vi
      .fn()
      .mockResolvedValue({ changes: [], latestSeq: 500, fullSyncRequired: false })
  }

  it('一批里先删后恢复：结果是恢复（合成之后再排序，不被拆开重排）', () => {
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, isDelete) VALUES ('a1', 'ALL', 'a1', 0)`
    ).run()
    noChangesServer()
    ;(client as unknown as { lastSeq: number }).lastSeq = 10
    handle(ws(11, 'delete', 'a1', null))
    handle(ws(12, 'update', 'a1', { isDelete: 0 }))
    flush()
    expect(activeKeys()).toContain('a1')
  })

  it('已经被拉取写过的实时变更不再重放', () => {
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, note, isDelete) VALUES ('a1', 'ALL', 'a1', 'pulled', 0)`
    ).run()
    noChangesServer()
    ;(client as unknown as { lastSeq: number }).lastSeq = 20
    handle(ws(15, 'update', 'a1', { note: 'stale' }))
    flush()
    const row = db.prepare(`SELECT note FROM assetData WHERE assetKey = 'a1'`).get() as {
      note: string
    }
    expect(row.note).toBe('pulled')
  })

  it('大批增量分片写入期间，实时变更先攒着：不夹在片与片之间，也不把 lastSeq 推到前面去', async () => {
    const changes = Array.from({ length: 450 }, (_, i) => ({
      seq: 11 + i,
      op: 'insert',
      tableName: 'assetData',
      recordKey: `c${i}`,
      payload: JSON.stringify({
        assetKey: `c${i}`,
        folderKey: 'ALL',
        assetName: `c${i}`,
        note: 'old',
        isDelete: 0
      }),
      clientId: 'other',
      createdAt: 0
    }))
    noChangesServer()
    ;(client as unknown as { lastSeq: number }).lastSeq = 10
    const slicing = (
      client as unknown as { applyChangesInSlices: (c: unknown[]) => Promise<void> }
    ).applyChangesInSlices(changes)
    // 第一片已经写了，正在让出事件循环：这时来一条更新的实时变更
    handle(ws(500, 'update', 'c300', { note: 'new' }))
    flush()
    const persisted = (): number =>
      (
        db.prepare(`SELECT last_seq FROM sync_state WHERE vault_id = 'v1'`).get() as
          | { last_seq: number }
          | undefined
      )?.last_seq ?? 0
    expect(persisted()).toBe(0)

    await slicing
    expect(persisted()).toBe(460)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const row = db.prepare(`SELECT note FROM assetData WHERE assetKey = 'c300'`).get() as {
      note: string
    }
    // 实时变更在整批写完之后才落，所以留下的是它（新的），不是 seq 300 那条旧的
    expect(row.note).toBe('new')
  })
})

describe('别的生命周期', () => {
  it('启动失败、靠重连恢复的客户端也有定时校验', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    try {
      ;(client as unknown as { flushOutbox: unknown }).flushOutbox = vi
        .fn()
        .mockResolvedValue({ flushed: 0, failed: 0 })
      const pull = vi
        .fn()
        .mockRejectedValueOnce(new Error('HTTP timeout'))
        .mockResolvedValue(undefined)
      ;(client as unknown as { pullChanges: unknown }).pullChanges = pull
      ;(client as unknown as { connectWs: unknown }).connectWs = vi.fn()

      await client.start()
      expect((client as unknown as { checksumTimer: unknown }).checksumTimer).toBeNull()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pull).toHaveBeenCalledTimes(2)
      expect((client as unknown as { checksumTimer: unknown }).checksumTimer).not.toBeNull()
      expect((client as unknown as { outboxTimer: unknown }).outboxTimer).not.toBeNull()
    } finally {
      client.stop()
      vi.useRealTimers()
    }
  })

  it('中途加入同一轮拉取的调用方也拿不到中止哨兵', async () => {
    ;(client as unknown as { doPullChanges: unknown }).doPullChanges = vi
      .fn()
      .mockRejectedValue(new Error('SYNC_ABORTED_BY_STOP'))
    const first = client.pullChanges()
    const second = client.pullChanges()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })

  it('本地缺的文件夹按需补：拉一遍文件夹列表，只补缺的那几个，不升级成全量', async () => {
    const server = fakeServer({
      folders: [
        { folderKey: 'ALL', type: 'system', folderName: 'ALL', depth: 0 },
        { folderKey: 'f9', fatherKey: 'ALL', type: 'folder', folderName: 'f9', depth: 1 }
      ],
      assets: []
    })
    install(server)
    await (
      client as unknown as { repairMissingRows: (b: unknown[]) => Promise<void> }
    ).repairMissingRows([{ tableName: 'assetFolder', recordKey: 'f9' }])
    expect(
      db.prepare(`SELECT folderKey FROM assetFolder WHERE folderKey = 'f9'`).get()
    ).toBeTruthy()
    expect(server.assetPageRequests()).toHaveLength(0)
  })
})

describe('写得多就停下来等 WAL 追平', () => {
  const config = { serverUrl: 'http://127.0.0.1:1', vaultId: 'v1', clientId: 'c1', hostname: 'h1' }
  const useClient = (waitForWalCheckpoint: () => Promise<void>): void => {
    client.stop()
    client = new SyncClient(db, { ...config, waitForWalCheckpoint })
  }
  const insertChange = (seq: number, key: string): Record<string, unknown> => ({
    seq,
    op: 'insert',
    tableName: 'assetData',
    recordKey: key,
    payload: JSON.stringify({ assetKey: key, folderKey: 'ALL', assetName: key, isDelete: 0 }),
    clientId: 'other',
    createdAt: 0
  })

  it('大批增量分片写：累计写满一段就等一次，等的时候不写', async () => {
    const writtenWhileWaiting: number[] = []
    const wait = vi.fn(async () => {
      const before = activeKeys().length
      await new Promise((resolve) => setTimeout(resolve, 5))
      writtenWhileWaiting.push(activeKeys().length - before)
    })
    useClient(wait)
    // 每量一次时间都过去 50 ms：每片「写 + 提交」都算 50 ms
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 50))
    try {
      await (
        client as unknown as { applyChangesInSlices: (c: unknown[]) => Promise<void> }
      ).applyChangesInSlices(Array.from({ length: 450 }, (_, i) => insertChange(1000 + i, `c${i}`)))
    } finally {
      clock.mockRestore()
    }
    expect(activeKeys()).toHaveLength(450)
    expect(wait.mock.calls.length).toBeGreaterThan(1)
    expect(writtenWhileWaiting.every((n) => n === 0)).toBe(true)
  })

  it('实时变更连着来：累计写满一段也等一次，攒着的变更等完再写', async () => {
    let release!: () => void
    const wait = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    useClient(wait)
    ;(client as unknown as { httpGet: unknown }).httpGet = vi
      .fn()
      .mockResolvedValue({ changes: [], latestSeq: 11, fullSyncRequired: false })
    ;(client as unknown as { lastSeq: number }).lastSeq = 10
    ;(client as unknown as { writeMsSinceWalSync: number }).writeMsSinceWalSync = 1_000
    ;(client as unknown as { handleWsMessage: (m: unknown) => void }).handleWsMessage({
      type: 'change',
      ...insertChange(11, 'w1')
    })
    ;(client as unknown as { flushWsChanges: () => void }).flushWsChanges()
    expect(wait).toHaveBeenCalledTimes(1)
    expect(activeKeys()).not.toContain('w1')

    release()
    await vi.waitFor(() => expect(activeKeys()).toContain('w1'))
  })

  it('差集分片软删之间被实时变更碰过的行不删', async () => {
    // 本地 30 行服务端快照里都没有 → 都是差集候选；每片固定 10 行
    const insert = db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, isDelete) VALUES (?, 'ALL', ?, 0)`
    )
    for (let i = 0; i < 30; i++) insert.run(`z${String(i).padStart(2, '0')}`, `z${i}`)
    install(fakeServer({ folders: [], assets: [asset('keep')] }))
    const c = client as unknown as {
      sliceSizer: AdaptiveSliceSizer
      pauseBetweenWrites: () => Promise<void>
      markSeenForActiveRun: (tableName: string, recordKey: string) => void
    }
    c.sliceSizer = new AdaptiveSliceSizer(40, 10, 10, 10)
    const original = c.pauseBetweenWrites.bind(client)
    let touched = false
    c.pauseBetweenWrites = async () => {
      const z00 = db.prepare(`SELECT isDelete FROM assetData WHERE assetKey = 'z00'`).get() as {
        isDelete: number
      }
      if (!touched && z00.isDelete === 1) {
        // 第一片已经删了：这时同事把 z29 改了一下，实时推过来写进本地
        touched = true
        c.markSeenForActiveRun('assetData', 'z29')
      }
      return original()
    }
    await reconcile()
    expect(touched).toBe(true)
    expect(activeKeys()).toEqual(['keep', 'z29'])
  })
})

/**
 * 服务端的文件扫描、批量导入直接写库，不进 change_log。整个库都是这么来的话，
 * change_log 是空的，快照点就是 0，对完一轮 lastSeq 还是 0 —— 以前被当成「从没同步过」，
 * 每次启动、每次重连都把整个库重新过一遍。
 */
describe('服务端变更日志一直是空的', () => {
  const emptyLogServer = (assets: Row[]): FakeServer => {
    const server = fakeServer({ folders: [], assets })
    const original = server.httpGet.getMockImplementation()!
    server.httpGet.mockImplementation(async (path: string) => {
      server.requests.push(path)
      if (path.includes('/sync')) return { changes: [], latestSeq: 0, fullSyncRequired: false }
      if (path.includes('/checksum')) {
        const folders = db
          .prepare(`SELECT COUNT(*) AS c FROM assetFolder WHERE isDelete = 0`)
          .get() as { c: number }
        return { assetCount: assets.length, folderCount: folders.c, latestSeq: 0 }
      }
      server.requests.pop() // 交给原实现记
      const page = (await original(path)) as Record<string, unknown>
      return { ...page, snapshotSeq: 0 }
    })
    return server
  }

  it('对完一轮之后再拉：条数对得上就只走增量，不再全量', async () => {
    const server = emptyLogServer([asset('a1'), asset('a2')])
    install(server)
    await client.pullChanges()
    expect(activeKeys()).toEqual(['a1', 'a2'])
    const pagesAfterFirst = server.assetPageRequests().length

    await client.pullChanges()
    expect(server.assetPageRequests()).toHaveLength(pagesAfterFirst)
    expect(server.requests.some((p) => p.includes('/checksum'))).toBe(true)
  })

  it('条数对不上（服务端扫描 / 批量导入进来的）才全量', async () => {
    const assets = [asset('a1')]
    const server = emptyLogServer(assets)
    install(server)
    await client.pullChanges()
    expect(activeKeys()).toEqual(['a1'])

    assets.push(asset('a2'))
    await client.pullChanges()
    expect(activeKeys()).toEqual(['a1', 'a2'])
  })

  it('没对完过（中途断了）的照旧接着全量', async () => {
    const server = emptyLogServer(Array.from({ length: 7 }, (_, i) => asset(`a${i}`)))
    install(server)
    server.failCall(4)
    await client.pullChanges().catch(() => undefined)
    expect(activeKeys().length).toBeLessThan(7)

    await client.pullChanges()
    expect(activeKeys()).toHaveLength(7)
  })
})
