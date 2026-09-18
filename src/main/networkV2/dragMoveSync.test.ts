import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { buildDragMoveSyncPlan } from '../sqliteDataBase/dragMoveSyncHelper'
import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel } from '../sqliteDataBase/models/assetFolder'
import { DragMoveService } from '../sqliteDataBase/services/dragMoveService'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  initAssetDataModel(db)
  db.prepare(
    `
    INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
    VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)
  `
  ).run()
  return db
}

function insertFolder(
  db: Database.Database,
  folderKey: string,
  fatherKey: string,
  folderName: string,
  fullPath: string,
  depth: number,
  pathArray: string,
  ancestorKeys: string
): void {
  db.prepare(
    `
    INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
    VALUES (?, ?, 'folder', ?, ?, ?, ?, ?, 0)
  `
  ).run(folderKey, fatherKey, folderName, fullPath, pathArray, depth, ancestorKeys)
}

function insertAsset(db: Database.Database, assetKey: string, folderKey: string): void {
  db.prepare(
    `
    INSERT INTO assetData (assetKey, folderKey, assetName, isDelete)
    VALUES (?, ?, ?, 0)
  `
  ).run(assetKey, folderKey, `${assetKey}.uasset`)
}

describe('drag move sync propagation', () => {
  it('returns asset updates when a file is moved into a logical folder', async () => {
    const db = createTestDb()
    insertFolder(db, 'folder_a', 'ALL', 'FolderA', '/FolderA', 1, '["folder_a"]', '[]')
    insertAsset(db, 'asset_1', 'ALL')

    const service = new DragMoveService(db)
    const result = await service.moveItems([{ id: 'asset_1', type: 'file' }], 'folder_a')
    const plan = buildDragMoveSyncPlan(db, result.changedAssetKeys, result.changedFolderKeys)

    expect(result.success).toBe(true)
    expect(result.changedAssetKeys).toEqual(['asset_1'])
    expect(result.changedFolderKeys).toEqual([])
    expect(plan.assetUpdates).toEqual([
      {
        assetKey: 'asset_1',
        updates: expect.objectContaining({
          folderKey: 'folder_a'
        })
      }
    ])
    expect(plan.folderUpdates).toEqual([])
  })

  it('returns subtree folder updates when a folder is moved', async () => {
    const db = createTestDb()
    insertFolder(db, 'target', 'ALL', 'Target', '/Target', 1, '["target"]', '[]')
    insertFolder(db, 'folder_a', 'ALL', 'FolderA', '/FolderA', 1, '["folder_a"]', '[]')
    insertFolder(
      db,
      'folder_b',
      'folder_a',
      'FolderB',
      '/FolderA/FolderB',
      2,
      '["folder_a","folder_b"]',
      '["folder_a"]'
    )
    insertAsset(db, 'asset_in_a', 'folder_a')
    insertAsset(db, 'asset_in_b', 'folder_b')

    const service = new DragMoveService(db)
    const result = await service.moveItems([{ id: 'folder_a', type: 'folder' }], 'target')
    const plan = buildDragMoveSyncPlan(db, result.changedAssetKeys, result.changedFolderKeys)

    expect(result.success).toBe(true)
    expect(result.changedFolderKeys.sort()).toEqual(['folder_a', 'folder_b'])
    expect(result.changedAssetKeys.sort()).toEqual(['asset_in_a', 'asset_in_b'])

    const movedRoot = plan.folderUpdates.find((item) => item.folderKey === 'folder_a')
    const movedChild = plan.folderUpdates.find((item) => item.folderKey === 'folder_b')

    expect(movedRoot?.updates).toEqual(
      expect.objectContaining({
        fatherKey: 'target',
        fullPath: '/Target/FolderA',
        depth: 2
      })
    )
    expect(movedChild?.updates).toEqual(
      expect.objectContaining({
        fatherKey: 'folder_a',
        fullPath: '/Target/FolderA/FolderB',
        depth: 3
      })
    )
  })

  it('does not emit sync payloads for no-op file moves', async () => {
    const db = createTestDb()
    insertFolder(db, 'folder_a', 'ALL', 'FolderA', '/FolderA', 1, '["folder_a"]', '[]')
    insertAsset(db, 'asset_1', 'folder_a')

    const service = new DragMoveService(db)
    const result = await service.moveItems([{ id: 'asset_1', type: 'file' }], 'folder_a')
    const plan = buildDragMoveSyncPlan(db, result.changedAssetKeys, result.changedFolderKeys)

    expect(result.success).toBe(true)
    expect(result.changedAssetKeys).toEqual([])
    expect(plan.assetUpdates).toEqual([])
    expect(plan.folderUpdates).toEqual([])
  })
})
