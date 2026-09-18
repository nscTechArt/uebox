import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { SyncClient } from './SyncClient'
import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel } from '../sqliteDataBase/models/assetFolder'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  db.prepare(
    `
      INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
      VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)
    `
  ).run()
  return db
}

function createClient(db: Database.Database): SyncClient {
  return new SyncClient(db, {
    serverUrl: 'http://127.0.0.1:18900',
    vaultId: 'test-vault',
    clientId: 'test-client',
    hostname: 'test-host'
  })
}

describe('SyncClient.applyChanges', () => {
  it('deduplicates concurrent pull requests for the same client', async () => {
    const db = createTestDb()
    const client = createClient(db)

    let finishFullSync!: () => void
    // fullSync 已更名为 reconcileSync（语义从「删光重灌」变成「无损对账」）
    const reconcileSync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFullSync = resolve
        })
    )
    ;(client as unknown as { reconcileSync: unknown }).reconcileSync = reconcileSync

    const firstPull = client.pullChanges()
    const secondPull = client.pullChanges()

    await Promise.resolve()

    expect(reconcileSync).toHaveBeenCalledTimes(1)

    finishFullSync()
    await Promise.all([firstPull, secondPull])
    db.close()
  })

  it('applies folder parents before child folders and assets', () => {
    const db = createTestDb()
    const client = createClient(db)

    ;(client as any).applyChanges([
      {
        seq: 3,
        op: 'insert',
        tableName: 'assetData',
        recordKey: 'asset_1',
        payload: JSON.stringify({
          assetKey: 'asset_1',
          folderKey: 'folder_child',
          assetName: 'Hero.uasset',
          isDelete: 0
        }),
        clientId: 'server',
        createdAt: Date.now()
      },
      {
        seq: 2,
        op: 'insert',
        tableName: 'assetFolder',
        recordKey: 'folder_child',
        payload: JSON.stringify({
          folderKey: 'folder_child',
          fatherKey: 'folder_parent',
          type: 'folder',
          folderName: 'Child',
          fullPath: '/Parent/Child',
          pathArray: '["folder_parent","folder_child"]',
          depth: 2,
          ancestorKeys: '["folder_parent"]',
          isDelete: 0
        }),
        clientId: 'server',
        createdAt: Date.now()
      },
      {
        seq: 1,
        op: 'insert',
        tableName: 'assetFolder',
        recordKey: 'folder_parent',
        payload: JSON.stringify({
          folderKey: 'folder_parent',
          fatherKey: 'ALL',
          type: 'folder',
          folderName: 'Parent',
          fullPath: '/Parent',
          pathArray: '["folder_parent"]',
          depth: 1,
          ancestorKeys: '[]',
          isDelete: 0
        }),
        clientId: 'server',
        createdAt: Date.now()
      }
    ])

    const asset = db
      .prepare(`SELECT assetKey, folderKey, isDelete FROM assetData WHERE assetKey = 'asset_1'`)
      .get() as { assetKey: string; folderKey: string; isDelete: number } | undefined

    expect(asset).toEqual({
      assetKey: 'asset_1',
      folderKey: 'folder_child',
      isDelete: 0
    })

    const syncState = db
      .prepare(`SELECT last_seq AS lastSeq FROM sync_state WHERE vault_id = 'test-vault'`)
      .get() as { lastSeq: number }
    expect(syncState.lastSeq).toBe(3)
  })

  it('rolls back the whole batch when foreign keys still cannot be resolved', () => {
    const db = createTestDb()
    const client = createClient(db)

    expect(() =>
      (client as any).applyChanges([
        {
          seq: 1,
          op: 'insert',
          tableName: 'assetFolder',
          recordKey: 'folder_parent',
          payload: JSON.stringify({
            folderKey: 'folder_parent',
            fatherKey: 'ALL',
            type: 'folder',
            folderName: 'Parent',
            fullPath: '/Parent',
            pathArray: '["folder_parent"]',
            depth: 1,
            ancestorKeys: '[]',
            isDelete: 0
          }),
          clientId: 'server',
          createdAt: Date.now()
        },
        {
          seq: 2,
          op: 'insert',
          tableName: 'assetData',
          recordKey: 'asset_orphan',
          payload: JSON.stringify({
            assetKey: 'asset_orphan',
            folderKey: 'missing_folder',
            assetName: 'Orphan.uasset',
            isDelete: 0
          }),
          clientId: 'server',
          createdAt: Date.now()
        }
      ])
    ).toThrow()

    const folder = db
      .prepare(`SELECT folderKey FROM assetFolder WHERE folderKey = 'folder_parent'`)
      .get()
    const asset = db.prepare(`SELECT assetKey FROM assetData WHERE assetKey = 'asset_orphan'`).get()
    const syncState = db
      .prepare(`SELECT last_seq AS lastSeq FROM sync_state WHERE vault_id = 'test-vault'`)
      .get() as { lastSeq: number } | undefined

    expect(folder).toBeUndefined()
    expect(asset).toBeUndefined()
    expect(syncState?.lastSeq ?? 0).toBe(0)
  })
})

describe('SyncClient remote mutations', () => {
  it('pulls server changes after deleting a folder', async () => {
    const db = createTestDb()
    const client = createClient(db)
    const httpRequest = vi.fn().mockResolvedValue({ folderKey: 'folder_stale' })
    const pullChanges = vi.fn().mockResolvedValue(undefined)
    ;(client as any).httpRequest = httpRequest
    client.pullChanges = pullChanges

    await expect(client.deleteFolder('folder_stale')).resolves.toEqual({
      folderKey: 'folder_stale'
    })

    expect(httpRequest).toHaveBeenCalledWith(
      'DELETE',
      '/api/vaults/test-vault/folders/folder_stale',
      undefined,
      30_000
    )
    expect(pullChanges).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('can defer folder-delete sync for batched deletes', async () => {
    const db = createTestDb()
    const client = createClient(db)
    const httpRequest = vi.fn().mockResolvedValue({ folderKey: 'folder_batched' })
    const pullChanges = vi.fn().mockResolvedValue(undefined)
    ;(client as any).httpRequest = httpRequest
    client.pullChanges = pullChanges

    await expect(client.deleteFolder('folder_batched', { syncAfter: false })).resolves.toEqual({
      folderKey: 'folder_batched'
    })

    expect(httpRequest).toHaveBeenCalledWith(
      'DELETE',
      '/api/vaults/test-vault/folders/folder_batched',
      undefined,
      30_000
    )
    expect(pullChanges).not.toHaveBeenCalled()
    db.close()
  })
})

describe('SyncClient.verifyChecksum', () => {
  /**
   * 语义变更：单次 COUNT 不等**不再**触发破坏性重建。
   *
   * 它至少有四种良性来源（本地有未推送新增、本地软删而服务端还没删、
   * 服务端广播在路上、客户端正在增量应用中途），拿它触发重建是「用核弹
   * 处理误报」。现在改成：先增量拉取，连续两次仍不等才对账。
   */
  const setup = (): {
    db: ReturnType<typeof createTestDb>
    client: SyncClient
    reconcileSync: ReturnType<typeof vi.fn>
    pullChanges: ReturnType<typeof vi.fn>
  } => {
    const db = createTestDb()
    const client = createClient(db)
    const reconcileSync = vi.fn().mockResolvedValue(undefined)
    const pullChanges = vi.fn().mockResolvedValue(undefined)
    ;(client as unknown as { httpGet: unknown }).httpGet = vi.fn().mockResolvedValue({
      assetCount: 0,
      folderCount: 2,
      latestSeq: 0
    })
    ;(client as unknown as { reconcileSync: unknown }).reconcileSync = reconcileSync
    client.pullChanges = pullChanges
    return { db, client, reconcileSync, pullChanges }
  }

  it('单次条数不等只做增量拉取，不重建', async () => {
    const { db, client, reconcileSync, pullChanges } = setup()

    await (client as unknown as { verifyChecksum: () => Promise<void> }).verifyChecksum()

    expect(pullChanges).toHaveBeenCalledTimes(1)
    expect(reconcileSync).not.toHaveBeenCalled()
    db.close()
  })

  it('连续两次不等才升级到对账同步', async () => {
    const { db, client, reconcileSync } = setup()

    await (client as unknown as { verifyChecksum: () => Promise<void> }).verifyChecksum()
    await (client as unknown as { verifyChecksum: () => Promise<void> }).verifyChecksum()

    expect(reconcileSync).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('中间恢复一致就把连击清零', async () => {
    const { db, client, reconcileSync } = setup()

    await (client as unknown as { verifyChecksum: () => Promise<void> }).verifyChecksum()
    // 这一轮服务端与本地一致（本地建库时插了一个 ALL 文件夹）
    ;(client as unknown as { httpGet: unknown }).httpGet = vi
      .fn()
      .mockResolvedValue({ assetCount: 0, folderCount: 1, latestSeq: 0 })
    await (client as unknown as { verifyChecksum: () => Promise<void> }).verifyChecksum()
    // 再次不等 —— 因为连击已清零，这次仍不该重建
    ;(client as unknown as { httpGet: unknown }).httpGet = vi
      .fn()
      .mockResolvedValue({ assetCount: 0, folderCount: 2, latestSeq: 0 })
    await (client as unknown as { verifyChecksum: () => Promise<void> }).verifyChecksum()

    expect(reconcileSync).not.toHaveBeenCalled()
    db.close()
  })
})
