/**
 * partialUpdate.test.ts — 局部更新不得抹掉兄弟字段
 *
 * 这些用例对修复前的代码全部失败：那时客户端用一条「写所有列」的整行 UPSERT
 * 应用变更，payload 里没出现的列会被 normalizeRow 填成 NULL/''，于是主机上
 * 一次「只改 folderKey」的拖动，就能把所有客户端上这个资产的名字、路径、
 * 缩略图、标签全部抹掉。
 */
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel } from '../sqliteDataBase/models/assetFolder'
import { SyncClient } from './SyncClient'
import type { ChangeLogEntry } from './SyncProtocol'

let db: Database.Database
let client: SyncClient

function createTestDb(): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  initAssetFolderModel(database)
  initAssetDataModel(database)
  // 二次调用触发 ALTER TABLE 迁移，补齐 note/tags/color 等列
  initAssetDataModel(database)
  database
    .prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
    )
    .run()
  return database
}

/** 直接调用私有的 applySingleChange —— 这里要测的就是「应用一条变更」的行为 */
function applyChange(change: Partial<ChangeLogEntry>): void {
  const full: ChangeLogEntry = {
    seq: 1,
    op: 'update',
    tableName: 'assetData',
    recordKey: '',
    payload: null,
    clientId: 'server',
    createdAt: Date.now(),
    ...change
  } as unknown as ChangeLogEntry
  ;(client as unknown as { applySingleChange: (c: ChangeLogEntry) => void }).applySingleChange(full)
}

const assetRow = (assetKey: string): Record<string, unknown> | undefined =>
  db.prepare(`SELECT * FROM assetData WHERE assetKey = ?`).get(assetKey) as
    | Record<string, unknown>
    | undefined

const folderRow = (folderKey: string): Record<string, unknown> | undefined =>
  db.prepare(`SELECT * FROM assetFolder WHERE folderKey = ?`).get(folderKey) as
    | Record<string, unknown>
    | undefined

beforeEach(() => {
  db = createTestDb()
  client = new SyncClient(db, {
    serverUrl: 'http://127.0.0.1:1',
    vaultId: 'v1',
    clientId: 'c1',
    hostname: 'h1'
  })
})

describe('资产的局部更新', () => {
  const seedAsset = (): void => {
    db.prepare(
      `INSERT INTO assetData
         (assetKey, folderKey, assetName, filePath, imgLocalPath, note, tags, isDelete)
       VALUES ('asset_1', 'ALL', 'Hero.uasset', '/a/Hero.uasset', 'thumb.png', 'my note', '["old"]', 0)`
    ).run()
  }

  it('只改 tags 时，名字 / 路径 / 缩略图 / 备注原样保留', () => {
    seedAsset()

    applyChange({
      recordKey: 'asset_1',
      payload: JSON.stringify({ tags: '["new"]' })
    })

    const row = assetRow('asset_1')
    expect(row?.tags).toBe('["new"]')
    // 旧实现里这四个会分别变成 '' 和 null
    expect(row?.assetName).toBe('Hero.uasset')
    expect(row?.filePath).toBe('/a/Hero.uasset')
    expect(row?.imgLocalPath).toBe('thumb.png')
    expect(row?.note).toBe('my note')
  })

  it('只改 folderKey（拖动）时其余字段不受影响', () => {
    seedAsset()
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('target', 'ALL', 'folder', 'Target', '/Target', '[]', 1, '[]', 0)`
    ).run()

    applyChange({ recordKey: 'asset_1', payload: JSON.stringify({ folderKey: 'target' }) })

    const row = assetRow('asset_1')
    expect(row?.folderKey).toBe('target')
    expect(row?.assetName).toBe('Hero.uasset')
    expect(row?.imgLocalPath).toBe('thumb.png')
  })

  it('本地没有这行时不凭空造行，而是登记待修复', () => {
    applyChange({ recordKey: 'asset_unknown', payload: JSON.stringify({ tags: '["x"]' }) })

    // 旧实现会插入一条 assetName='' 的「无名白卡」
    expect(assetRow('asset_unknown')).toBeUndefined()
    const buffer = (client as unknown as { missingRowBuffer: Array<{ recordKey: string }> })
      .missingRowBuffer
    expect(buffer.map((item) => item.recordKey)).toContain('asset_unknown')
  })

  it('payload 足够完整时才允许建行', () => {
    applyChange({
      recordKey: 'asset_new',
      payload: JSON.stringify({
        assetKey: 'asset_new',
        folderKey: 'ALL',
        assetName: 'New.uasset'
      })
    })

    expect(assetRow('asset_new')?.assetName).toBe('New.uasset')
  })

  it('身份列被给成空串时不覆盖，避免二次抹名', () => {
    seedAsset()

    applyChange({
      recordKey: 'asset_1',
      payload: JSON.stringify({ assetName: '', note: 'changed' })
    })

    const row = assetRow('asset_1')
    expect(row?.assetName).toBe('Hero.uasset')
    // 非身份列照常更新
    expect(row?.note).toBe('changed')
  })

  it('delete 变更走软删除，不动其他字段', () => {
    seedAsset()

    applyChange({ op: 'delete', recordKey: 'asset_1', payload: null })

    const row = assetRow('asset_1')
    expect(row?.isDelete).toBe(1)
    expect(row?.assetName).toBe('Hero.uasset')
  })
})

describe('文件夹的局部更新', () => {
  const seedFolder = (): void => {
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('folder_parent', 'ALL', 'folder', 'Parent', '/Parent', '[]', 1, '[]', 0)`
    ).run()
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('folder_child', 'folder_parent', 'folder', 'Child', '/Parent/Child', '[]', 2, '[]', 0)`
    ).run()
  }

  it('只改 folderName 时 fatherKey / depth / fullPath 保留', () => {
    seedFolder()

    applyChange({
      tableName: 'assetFolder',
      recordKey: 'folder_child',
      payload: JSON.stringify({ folderName: 'Renamed' })
    })

    const row = folderRow('folder_child')
    expect(row?.folderName).toBe('Renamed')
    // 旧实现里 fatherKey 会变 NULL —— 整棵子树从目录树上消失
    expect(row?.fatherKey).toBe('folder_parent')
    expect(row?.depth).toBe(2)
    expect(row?.fullPath).toBe('/Parent/Child')
  })

  it('payload 不带 depth 时按本地 depth 排序，不塌成 0', () => {
    seedFolder()

    const depth = (client as unknown as { parseDepth: (c: ChangeLogEntry) => number }).parseDepth({
      seq: 1,
      op: 'update',
      tableName: 'assetFolder',
      recordKey: 'folder_child',
      payload: JSON.stringify({ folderName: 'X' }),
      clientId: 'server',
      createdAt: Date.now()
    } as unknown as ChangeLogEntry)

    expect(depth).toBe(2)
  })
})
