/**
 * syncOutbox.test.ts — 待推送队列 + 无损对账
 *
 * 这些用例对修复前的代码全部失败：那时推送失败被静默吞掉，而 fullSync 的第一步
 * 是 `DELETE FROM assetData` / `DELETE FROM assetFolder` —— 只存在于本地、还没
 * 推上去的记录会被连根拔掉。用户看到的就是「界面说保存成功，过一会儿数据自己
 * 消失，没有回收站、不可恢复」。
 */
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel } from '../sqliteDataBase/models/assetFolder'
import { SyncClient } from './SyncClient'

let db: Database.Database
let client: SyncClient

function createTestDb(): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  initAssetFolderModel(database)
  initAssetDataModel(database)
  initAssetDataModel(database)
  database
    .prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
    )
    .run()
  return database
}

const addFolder = (folderKey: string, fatherKey = 'ALL', depth = 1): void => {
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES (?, ?, 'folder', ?, ?, '[]', ?, '[]', 0)`
  ).run(folderKey, fatherKey, folderKey, `/${folderKey}`, depth)
}

const addAsset = (assetKey: string, folderKey = 'ALL'): void => {
  db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, isDelete)
     VALUES (?, ?, ?, 0)`
  ).run(assetKey, folderKey, assetKey)
}

const assetIsActive = (assetKey: string): boolean => {
  const row = db.prepare(`SELECT isDelete FROM assetData WHERE assetKey = ?`).get(assetKey) as
    | { isDelete: number }
    | undefined
  return row?.isDelete === 0
}

const folderIsActive = (folderKey: string): boolean => {
  const row = db.prepare(`SELECT isDelete FROM assetFolder WHERE folderKey = ?`).get(folderKey) as
    | { isDelete: number }
    | undefined
  return row?.isDelete === 0
}

/** 让 reconcileSync 拿到一个空快照 */
const stubEmptySnapshot = (snapshotSeq = 9): void => {
  ;(client as unknown as { httpGet: unknown }).httpGet = vi.fn().mockResolvedValue({
    rows: [],
    type: 'folders',
    cursor: 0,
    hasMore: false,
    total: 0,
    snapshotMaxRowid: 0,
    snapshotSeq
  })
}

const reconcile = (): Promise<void> =>
  (client as unknown as { reconcileSync: () => Promise<void> }).reconcileSync()

beforeEach(() => {
  db = createTestDb()
  client = new SyncClient(db, {
    serverUrl: 'http://127.0.0.1:1',
    vaultId: 'v1',
    clientId: 'c1',
    hostname: 'h1'
  })
})

describe('对账同步不再删掉本地独有数据', () => {
  it('有未推送变更的记录会被保留', async () => {
    addFolder('folder_local')
    addAsset('asset_local', 'folder_local')
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetFolder',
      recordKey: 'folder_local',
      payload: { folderKey: 'folder_local', type: 'folder', folderName: 'folder_local' }
    })
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'asset_local',
      payload: { assetKey: 'asset_local', folderKey: 'folder_local', assetName: 'asset_local' }
    })

    stubEmptySnapshot()
    await reconcile()

    // 旧实现：DELETE FROM 两张表 → 这两行连同回收站一起被清空
    expect(folderIsActive('folder_local')).toBe(true)
    expect(assetIsActive('asset_local')).toBe(true)
  })

  it('服务端确实没有的行只做软删除，不物理删除', async () => {
    addAsset('asset_gone')

    stubEmptySnapshot()
    await reconcile()

    const row = db
      .prepare(`SELECT isDelete FROM assetData WHERE assetKey = ?`)
      .get('asset_gone') as { isDelete: number } | undefined
    // 行还在，只是进了回收站 —— 旧实现是物理删除，顺手清空本地回收站
    expect(row).toBeDefined()
    expect(row?.isDelete).toBe(1)
  })

  it('受保护资产的祖先链一并保护，避免整棵子树消失', async () => {
    addFolder('parent')
    addFolder('sub', 'parent', 2)
    addAsset('asset_pending', 'sub')
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'asset_pending',
      payload: { assetKey: 'asset_pending', folderKey: 'sub', assetName: 'asset_pending' }
    })

    stubEmptySnapshot()
    await reconcile()

    expect(assetIsActive('asset_pending')).toBe(true)
    expect(folderIsActive('sub')).toBe(true)
    expect(folderIsActive('parent')).toBe(true)
  })

  it('对账前先刷待推送队列', async () => {
    const flush = vi.spyOn(client, 'flushOutbox').mockResolvedValue({ flushed: 0, failed: 0 })
    stubEmptySnapshot()

    await reconcile()

    expect(flush).toHaveBeenCalled()
  })
})

describe('队列的合并规则', () => {
  it('同一记录的连续 update 合并成一条', () => {
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { tags: '["x"]' }
    })
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { note: 'hello' }
    })

    expect(client.pendingPushCount).toBe(1)
    const row = db.prepare(`SELECT payload FROM sync_outbox WHERE record_key = 'a1'`).get() as {
      payload: string
    }
    expect(JSON.parse(row.payload)).toEqual({ tags: '["x"]', note: 'hello' })
  })

  it('本地建了又本地删、从未推送成功的，整条丢弃', () => {
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'a2',
      payload: { assetKey: 'a2' }
    })
    client.enqueueOutbox({ op: 'delete', tableName: 'assetData', recordKey: 'a2', payload: null })

    // 服务端根本不知道它存在过，没必要发一条删除
    expect(client.pendingPushCount).toBe(0)
  })

  it('删 → 重建 → 再删：那条 delete 必须留下，否则服务端的行永远删不掉', () => {
    client.enqueueOutbox({ op: 'delete', tableName: 'assetData', recordKey: 'a4', payload: null })
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'a4',
      payload: { assetKey: 'a4' }
    })
    client.enqueueOutbox({ op: 'delete', tableName: 'assetData', recordKey: 'a4', payload: null })

    // 链头是 delete，说明这条记录服务端**本来就有**。
    // 旧实现看到链上有 insert 就整链丢弃 → 什么都不推 → 下次对账把它复活。
    const rows = db
      .prepare(`SELECT op FROM sync_outbox WHERE record_key = 'a4' ORDER BY id`)
      .all() as { op: string }[]
    expect(rows.map((r) => r.op)).toEqual(['delete'])
  })

  it('先删后建保持因果顺序，不合并', () => {
    client.enqueueOutbox({ op: 'delete', tableName: 'assetData', recordKey: 'a3', payload: null })
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'a3',
      payload: { assetKey: 'a3' }
    })

    const rows = db
      .prepare(`SELECT op FROM sync_outbox WHERE record_key = 'a3' ORDER BY id`)
      .all() as { op: string }[]
    expect(rows.map((r) => r.op)).toEqual(['delete', 'insert'])
  })
})

describe('队列重放', () => {
  it('遇到可重试失败就停下，保住因果顺序', async () => {
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { assetKey: 'a1' }
    })
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a2',
      payload: { note: 'x' }
    })

    const createAsset = vi.fn().mockRejectedValue(new Error('network down'))
    const updateAsset = vi.fn().mockResolvedValue(undefined)
    ;(client as unknown as { createAsset: unknown }).createAsset = createAsset
    ;(client as unknown as { updateAsset: unknown }).updateAsset = updateAsset

    const result = await client.flushOutbox()

    expect(result.flushed).toBe(0)
    // 第二条不能抢先落地 —— insert 必须先于 update
    expect(updateAsset).not.toHaveBeenCalled()
    expect(client.pendingPushCount).toBe(2)
  })

  it('不可重试的失败进死信，不挡住后面的条目', async () => {
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { note: 'x' }
    })
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a2',
      payload: { note: 'y' }
    })

    const updateAsset = vi
      .fn()
      .mockImplementationOnce(() => {
        const err = Object.assign(new Error('conflict'), { statusCode: 409 })
        return Promise.reject(err)
      })
      .mockResolvedValue(undefined)
    ;(client as unknown as { updateAsset: unknown }).updateAsset = updateAsset

    const blocked = vi.fn()
    client.on('outbox-blocked', blocked)

    const result = await client.flushOutbox()

    expect(blocked).toHaveBeenCalledTimes(1)
    expect(result.flushed).toBe(1)
    const dead = db.prepare(`SELECT state FROM sync_outbox WHERE record_key = 'a1'`).get() as {
      state: string
    }
    expect(dead.state).toBe('dead')
  })

  it('死信行同样受对账保护 —— 它仍然是本地独有数据', async () => {
    addAsset('asset_dead')
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'asset_dead',
      payload: { assetKey: 'asset_dead' }
    })
    db.prepare(`UPDATE sync_outbox SET state = 'dead' WHERE record_key = 'asset_dead'`).run()

    stubEmptySnapshot()
    await reconcile()

    expect(assetIsActive('asset_dead')).toBe(true)
  })

  it('insert 撞冲突时降级成 update，不进死信', async () => {
    client.enqueueOutbox({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { assetKey: 'a1' }
    })

    const createAsset = vi
      .fn()
      .mockRejectedValue(new Error('UNIQUE constraint failed: assetData.assetKey'))
    const updateAsset = vi.fn().mockResolvedValue(undefined)
    ;(client as unknown as { createAsset: unknown }).createAsset = createAsset
    ;(client as unknown as { updateAsset: unknown }).updateAsset = updateAsset

    const result = await client.flushOutbox()

    expect(updateAsset).toHaveBeenCalledTimes(1)
    expect(result.flushed).toBe(1)
    expect(client.pendingPushCount).toBe(0)
  })
})

describe('推送途中并发写不会被连行删掉', () => {
  it('慢推送在途时改同一条记录，第二次编辑照样能上服务器', async () => {
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { note: '第一次改' }
    })

    // 第一次推送卡在网络上（写超时上限 30s），期间用户又改了同一条记录
    const sent: unknown[] = []
    let releaseFirst: () => void = () => {}
    let firstStarted: () => void = () => {}
    const firstInFlight = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    ;(client as unknown as { updateAsset: unknown }).updateAsset = vi.fn(
      (_key: string, payload: unknown) => {
        sent.push(payload)
        if (sent.length > 1) return Promise.resolve()
        return new Promise<void>((done) => {
          releaseFirst = done
          firstStarted()
        })
      }
    )

    const flushing = client.flushOutbox()
    await firstInFlight

    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { note: '第二次改' }
    })

    releaseFirst()
    await flushing

    // 旧实现：第二次改动被合并进在途那一行，第一次推送成功后
    // `DELETE WHERE id = ?` 把它一起删掉 —— 只会发出一次，这次编辑永远上不了服务器
    expect(sent).toEqual([{ note: '第一次改' }, { note: '第二次改' }])
    expect(client.pendingPushCount).toBe(0)
  })

  it('在途行也算「待同步」，不能让界面显示成已经推完了', async () => {
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { note: 'x' }
    })

    let releaseSend: () => void = () => {}
    const sendStarted = new Promise<void>((resolve) => {
      ;(client as unknown as { updateAsset: unknown }).updateAsset = vi.fn(
        () =>
          new Promise<void>((done) => {
            releaseSend = done
            resolve()
          })
      )
    })

    const flushing = client.flushOutbox()
    await sendStarted
    expect(client.pendingPushCount).toBe(1)

    releaseSend()
    await flushing
    expect(client.pendingPushCount).toBe(0)
  })

  it('进程在推送途中被杀掉：重建客户端时把在途行放回队列', () => {
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { note: 'x' }
    })
    db.prepare(`UPDATE sync_outbox SET state = 'sending'`).run()

    // 新进程起来 —— 不恢复的话这行永远等不到人来收，等于静默丢一条改动
    const revived = new SyncClient(db, {
      serverUrl: 'http://127.0.0.1:1',
      vaultId: 'v1',
      clientId: 'c1',
      hostname: 'h1'
    })

    expect(revived.pendingPushCount).toBe(1)
    const row = db.prepare(`SELECT state FROM sync_outbox WHERE record_key = 'a1'`).get() as {
      state: string
    }
    expect(row.state).toBe('pending')
  })
})

describe('对账不覆盖本地未推送的改动', () => {
  /** 让 reconcileSync 拿到一份「服务端还是旧值」的快照 */
  const stubSnapshot = (folders: unknown[], assets: unknown[], snapshotSeq = 9): void => {
    ;(client as unknown as { httpGet: unknown }).httpGet = vi
      .fn()
      .mockImplementation((path: string) => {
        const isFolders = path.includes('folders')
        const rows = isFolders ? folders : assets
        return Promise.resolve({
          rows,
          type: isFolders ? 'folders' : 'assets',
          cursor: 0,
          hasMore: false,
          total: rows.length,
          snapshotMaxRowid: 0,
          snapshotSeq
        })
      })
  }

  it('本地改了备注还没推上去，对账不能把服务端的旧备注盖回来', async () => {
    addAsset('a1')
    db.prepare(`UPDATE assetData SET note = '本地刚改的' WHERE assetKey = 'a1'`).run()
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { note: '本地刚改的' }
    })

    stubSnapshot([], [{ assetKey: 'a1', folderKey: 'ALL', assetName: 'a1', note: '服务端旧值' }])
    await reconcile()

    const row = db.prepare(`SELECT note FROM assetData WHERE assetKey = 'a1'`).get() as {
      note: string
    }
    expect(row.note).toBe('本地刚改的')
  })

  it('本地删了还没推上去，对账不能把它复活', async () => {
    addAsset('a1')
    db.prepare(`UPDATE assetData SET isDelete = 1 WHERE assetKey = 'a1'`).run()
    client.enqueueOutbox({ op: 'delete', tableName: 'assetData', recordKey: 'a1', payload: null })

    // 服务端那边这条还活着
    stubSnapshot([], [{ assetKey: 'a1', folderKey: 'ALL', assetName: 'a1', isDelete: 0 }])
    await reconcile()

    expect(assetIsActive('a1')).toBe(false)
  })

  it('只有子孙有未推送改动时，父文件夹照常接收服务端的改名', async () => {
    addFolder('parent')
    addFolder('sub', 'parent', 2)
    addAsset('a1', 'sub')
    client.enqueueOutbox({
      op: 'update',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { note: 'x' }
    })

    stubSnapshot(
      [
        {
          folderKey: 'parent',
          fatherKey: 'ALL',
          type: 'folder',
          folderName: '同事改的名字',
          depth: 1
        },
        { folderKey: 'sub', fatherKey: 'parent', type: 'folder', folderName: 'sub', depth: 2 }
      ],
      []
    )
    await reconcile()

    // 「不覆盖」只保护这一行自己有改动的情况；
    // 拿祖先链去挡覆盖会让同事的改名永远下不来
    const row = db
      .prepare(`SELECT folderName FROM assetFolder WHERE folderKey = 'parent'`)
      .get() as { folderName: string } | undefined
    expect(row?.folderName).toBe('同事改的名字')
  })
})
