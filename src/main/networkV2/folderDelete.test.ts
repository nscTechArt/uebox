/**
 * folderDelete.test.ts — 文件夹递归删除 + 同步传播 测试
 *
 * 覆盖层次：
 *  1. deleteAssetFolder 模型层递归 CTE
 *  2. ChangeTracker 多条 delete change 记录
 *  3. SyncClient 应用 delete changes 后客户端状态一致性
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel, deleteAssetFolder } from '../sqliteDataBase/models/assetFolder'
import { ChangeTracker } from './ChangeTracker'
import {
  isFolderActive,
  collectFolderSubtreeKeys,
  recordSubtreeDeletionChanges
} from './folderDeleteHelper'
import { SyncClient } from './SyncClient'

// ─────────────────────── helpers ───────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  // 二次调用触发 ALTER TABLE 迁移，添加 note/tags/color/pluginInfo 等列
  // （SyncClient.prepareStatements 需要这些列）
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
  depth: number
): void {
  db.prepare(
    `
    INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
    VALUES (?, ?, 'folder', ?, ?, '[]', ?, '[]', 0)
  `
  ).run(folderKey, fatherKey, folderName, `/${folderName}`, depth)
}

function insertAsset(db: Database.Database, assetKey: string, folderKey: string): void {
  db.prepare(
    `
    INSERT INTO assetData (assetKey, folderKey, assetName, isDelete)
    VALUES (?, ?, ?, 0)
  `
  ).run(assetKey, folderKey, `${assetKey}.uasset`)
}

function getIsDelete(
  db: Database.Database,
  table: 'assetFolder' | 'assetData',
  key: string
): number | undefined {
  const col = table === 'assetFolder' ? 'folderKey' : 'assetKey'
  const row = db.prepare(`SELECT isDelete FROM ${table} WHERE ${col} = ?`).get(key) as
    | { isDelete: number }
    | undefined
  return row?.isDelete
}

/**
 * 模拟 server 端递归删除的完整流程（使用共享 helper）
 */
function simulateServerFolderDelete(
  db: Database.Database,
  tracker: ChangeTracker,
  rootFolderKey: string
): { folderKeys: string[]; assetKeys: string[] } {
  // 使用共享 helper 收集子树 key
  const { folderKeys, assetKeys } = collectFolderSubtreeKeys(db, rootFolderKey)

  // 递归软删除
  deleteAssetFolder(db, rootFolderKey)

  // 使用共享 helper 记录 change log
  recordSubtreeDeletionChanges(tracker, folderKeys, assetKeys)

  return { folderKeys, assetKeys }
}

// ─────────────────────── Model layer tests ───────────────────────

describe('deleteAssetFolder — model layer', () => {
  it('recursively soft-deletes sub-folders and their assets', () => {
    const db = createTestDb()

    // parent → child → grandchild, each with one asset
    insertFolder(db, 'parent', 'ALL', 'Parent', 1)
    insertFolder(db, 'child', 'parent', 'Child', 2)
    insertFolder(db, 'grandchild', 'child', 'GrandChild', 3)
    insertAsset(db, 'asset_p', 'parent')
    insertAsset(db, 'asset_c', 'child')
    insertAsset(db, 'asset_gc', 'grandchild')

    const result = deleteAssetFolder(db, 'parent')
    expect(result).toBe(true)

    // All 3 folders should be soft-deleted
    expect(getIsDelete(db, 'assetFolder', 'parent')).toBe(1)
    expect(getIsDelete(db, 'assetFolder', 'child')).toBe(1)
    expect(getIsDelete(db, 'assetFolder', 'grandchild')).toBe(1)

    // All 3 assets should be soft-deleted
    expect(getIsDelete(db, 'assetData', 'asset_p')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'asset_c')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'asset_gc')).toBe(1)

    // ALL folder should remain unaffected
    expect(getIsDelete(db, 'assetFolder', 'ALL')).toBe(0)
  })

  it('does not affect sibling folders or their assets', () => {
    const db = createTestDb()

    insertFolder(db, 'parent', 'ALL', 'Parent', 1)
    insertFolder(db, 'child_a', 'parent', 'ChildA', 2)
    insertFolder(db, 'child_b', 'parent', 'ChildB', 2)
    insertAsset(db, 'asset_a', 'child_a')
    insertAsset(db, 'asset_b', 'child_b')

    deleteAssetFolder(db, 'child_a')

    expect(getIsDelete(db, 'assetFolder', 'child_a')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'asset_a')).toBe(1)

    // Sibling and parent unaffected
    expect(getIsDelete(db, 'assetFolder', 'parent')).toBe(0)
    expect(getIsDelete(db, 'assetFolder', 'child_b')).toBe(0)
    expect(getIsDelete(db, 'assetData', 'asset_b')).toBe(0)
  })

  it('returns false for non-existent folder', () => {
    const db = createTestDb()
    expect(deleteAssetFolder(db, 'nonexistent')).toBe(false)
  })
})

// ─────────────────────── Sync layer tests ───────────────────────

describe('folder delete — sync propagation', () => {
  it('records delete changes for every folder and asset in the sub-tree', () => {
    const serverDb = createTestDb()
    const tracker = new ChangeTracker(serverDb)

    // 3-level tree with assets
    insertFolder(serverDb, 'root_f', 'ALL', 'Root', 1)
    insertFolder(serverDb, 'mid_f', 'root_f', 'Mid', 2)
    insertFolder(serverDb, 'leaf_f', 'mid_f', 'Leaf', 3)
    insertAsset(serverDb, 'a1', 'root_f')
    insertAsset(serverDb, 'a2', 'mid_f')
    insertAsset(serverDb, 'a3', 'leaf_f')
    insertAsset(serverDb, 'a4', 'leaf_f')

    const { folderKeys, assetKeys } = simulateServerFolderDelete(serverDb, tracker, 'root_f')

    // Should have found all 3 folders and 4 assets
    expect(folderKeys).toEqual(expect.arrayContaining(['root_f', 'mid_f', 'leaf_f']))
    expect(assetKeys).toEqual(expect.arrayContaining(['a1', 'a2', 'a3', 'a4']))

    // ChangeLog should have 7 entries (4 assets + 3 folders)
    const changes = tracker.getChangesSince(0, 100)
    expect(changes).toHaveLength(7)
    expect(changes.every((c) => c.op === 'delete')).toBe(true)

    const assetChanges = changes.filter((c) => c.tableName === 'assetData')
    const folderChanges = changes.filter((c) => c.tableName === 'assetFolder')
    expect(assetChanges).toHaveLength(4)
    expect(folderChanges).toHaveLength(3)

    // Verify all keys are present
    expect(assetChanges.map((c) => c.recordKey).sort()).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(folderChanges.map((c) => c.recordKey).sort()).toEqual(['leaf_f', 'mid_f', 'root_f'])
  })

  it('client correctly applies all delete changes from server', () => {
    // --- Server side: create tree, delete, record changes ---
    const serverDb = createTestDb()
    const tracker = new ChangeTracker(serverDb)

    insertFolder(serverDb, 'f1', 'ALL', 'Folder1', 1)
    insertFolder(serverDb, 'f2', 'f1', 'Folder2', 2)
    insertAsset(serverDb, 'asset_x', 'f1')
    insertAsset(serverDb, 'asset_y', 'f2')

    // --- Client side: replicate the same data (as if initial sync already happened) ---
    const clientDb = createTestDb()
    insertFolder(clientDb, 'f1', 'ALL', 'Folder1', 1)
    insertFolder(clientDb, 'f2', 'f1', 'Folder2', 2)
    insertAsset(clientDb, 'asset_x', 'f1')
    insertAsset(clientDb, 'asset_y', 'f2')

    // Verify client has data
    expect(getIsDelete(clientDb, 'assetFolder', 'f1')).toBe(0)
    expect(getIsDelete(clientDb, 'assetFolder', 'f2')).toBe(0)
    expect(getIsDelete(clientDb, 'assetData', 'asset_x')).toBe(0)
    expect(getIsDelete(clientDb, 'assetData', 'asset_y')).toBe(0)

    // Server deletes recursively
    simulateServerFolderDelete(serverDb, tracker, 'f1')

    // Get changes and apply to client via SyncClient
    const changes = tracker.getChangesSince(0, 100)
    expect(changes).toHaveLength(4) // 2 assets + 2 folders

    const client = new SyncClient(clientDb, {
      serverUrl: 'http://127.0.0.1:18900',
      vaultId: 'test-vault',
      clientId: 'test-client',
      hostname: 'test-host'
    })

    // Apply changes (calling the private method directly for testing)
    ;(client as any).applyChanges(changes)

    // Client should now have all 4 records soft-deleted
    expect(getIsDelete(clientDb, 'assetFolder', 'f1')).toBe(1)
    expect(getIsDelete(clientDb, 'assetFolder', 'f2')).toBe(1)
    expect(getIsDelete(clientDb, 'assetData', 'asset_x')).toBe(1)
    expect(getIsDelete(clientDb, 'assetData', 'asset_y')).toBe(1)

    // ALL should remain unaffected
    expect(getIsDelete(clientDb, 'assetFolder', 'ALL')).toBe(0)
  })

  it('repeat delete on already-deleted folder produces zero new changes', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertFolder(db, 'folder_r', 'ALL', 'Repeat', 1)
    insertAsset(db, 'asset_r1', 'folder_r')
    insertAsset(db, 'asset_r2', 'folder_r')

    // First delete — should produce 3 changes (1 folder + 2 assets)
    simulateServerFolderDelete(db, tracker, 'folder_r')
    const afterFirst = tracker.getChangesSince(0, 100)
    expect(afterFirst).toHaveLength(3)

    // Second delete — collectFolderSubtreeKeys with isDelete=0 filter
    // should return empty since folder_r is already deleted
    const subtree = collectFolderSubtreeKeys(db, 'folder_r')
    expect(subtree.folderKeys).toHaveLength(0)
    expect(subtree.assetKeys).toHaveLength(0)

    // recordSubtreeDeletionChanges with empty keys should be a no-op
    const lastSeq = recordSubtreeDeletionChanges(tracker, subtree.folderKeys, subtree.assetKeys)
    expect(lastSeq).toBe(0)

    // Total changes should still be exactly 3 — no new entries
    const afterSecond = tracker.getChangesSince(0, 100)
    expect(afterSecond).toHaveLength(3)
  })
})

// ─────────────────────── Helper layer tests ───────────────────────

describe('folderDeleteHelper — active subtree semantics', () => {
  it('isFolderActive returns true for existing active folder', () => {
    const db = createTestDb()
    insertFolder(db, 'active_f', 'ALL', 'Active', 1)
    expect(isFolderActive(db, 'active_f')).toBe(true)
  })

  it('isFolderActive returns false for deleted folder', () => {
    const db = createTestDb()
    insertFolder(db, 'del_f', 'ALL', 'Deleted', 1)
    deleteAssetFolder(db, 'del_f')
    expect(isFolderActive(db, 'del_f')).toBe(false)
  })

  it('isFolderActive returns false for non-existent folder', () => {
    const db = createTestDb()
    expect(isFolderActive(db, 'no_such_key')).toBe(false)
  })

  it('collectFolderSubtreeKeys only returns active (isDelete=0) nodes', () => {
    const db = createTestDb()

    // Create tree: parent → child → grandchild
    insertFolder(db, 'p', 'ALL', 'P', 1)
    insertFolder(db, 'c', 'p', 'C', 2)
    insertFolder(db, 'gc', 'c', 'GC', 3)
    insertAsset(db, 'a_p', 'p')
    insertAsset(db, 'a_c', 'c')
    insertAsset(db, 'a_gc', 'gc')

    // Full active tree
    const before = collectFolderSubtreeKeys(db, 'p')
    expect(before.folderKeys.sort()).toEqual(['c', 'gc', 'p'])
    expect(before.assetKeys.sort()).toEqual(['a_c', 'a_gc', 'a_p'])

    // Delete grandchild only
    deleteAssetFolder(db, 'gc')

    // Now collect from parent — grandchild and its asset should not appear
    const after = collectFolderSubtreeKeys(db, 'p')
    expect(after.folderKeys.sort()).toEqual(['c', 'p'])
    expect(after.assetKeys.sort()).toEqual(['a_c', 'a_p'])
    // a_gc should not appear since its parent folder gc is isDelete=1
  })

  it('collectFolderSubtreeKeys returns empty for deleted root', () => {
    const db = createTestDb()
    insertFolder(db, 'root_del', 'ALL', 'Root', 1)
    deleteAssetFolder(db, 'root_del')

    const result = collectFolderSubtreeKeys(db, 'root_del')
    expect(result.folderKeys).toEqual([])
    expect(result.assetKeys).toEqual([])
  })
})
