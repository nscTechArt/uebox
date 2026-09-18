import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  rollbackRemoteImportLocalRows,
  shouldRollbackRemoteImportLocalRows
} from './remoteImportLocalRollback'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE assetFolder (
      folderKey TEXT PRIMARY KEY,
      fatherKey TEXT,
      folderName TEXT,
      isDelete INTEGER DEFAULT 0,
      FOREIGN KEY (fatherKey) REFERENCES assetFolder(folderKey) ON DELETE CASCADE
    );
    CREATE TABLE assetData (
      assetKey TEXT PRIMARY KEY,
      folderKey TEXT NOT NULL,
      assetName TEXT NOT NULL,
      isDelete INTEGER DEFAULT 0,
      FOREIGN KEY (folderKey) REFERENCES assetFolder(folderKey) ON DELETE CASCADE
    );
    CREATE TABLE asset_tags (assetKey TEXT, tagId TEXT);
    CREATE TABLE asset_favorites (assetKey TEXT, userId TEXT);
  `)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, folderName) VALUES ('ALL', NULL, 'ALL')`
  ).run()
  return db
}

function count(db: Database.Database, tableName: string, column: string, value: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${column} = ?`).get(value) as {
      count: number
    }
  ).count
}

describe('rollbackRemoteImportLocalRows', () => {
  it('restores an existing asset and removes new rows when local preparation is cancelled', () => {
    const db = createDb()
    db.prepare(
      "INSERT INTO assetData (assetKey, folderKey, assetName) VALUES ('existing', 'ALL', 'Before')"
    ).run()
    const before = db
      .prepare("SELECT * FROM assetData WHERE assetKey = 'existing'")
      .get() as Record<string, unknown>
    db.prepare("UPDATE assetData SET assetName = 'Unuploaded' WHERE assetKey = 'existing'").run()
    db.prepare(
      "INSERT INTO assetData (assetKey, folderKey, assetName) VALUES ('new', 'ALL', 'Unuploaded')"
    ).run()
    db.transaction(() =>
      rollbackRemoteImportLocalRows(db, {
        assetKeys: ['new'],
        folderKeys: [],
        previousAssets: [before]
      })
    )()
    expect(db.prepare('SELECT * FROM assetData').all()).toEqual([before])
    db.close()
  })
  it('rolls back failed remote imports even when commit outcome is ambiguous', () => {
    expect(
      shouldRollbackRemoteImportLocalRows({
        remoteSyncStatus: 'failed',
        remoteCommittedChanges: false,
        createdAssetCount: 1,
        createdFolderCount: 0
      })
    ).toBe(true)
  })

  it('removes only optimistic remote import assets and folders', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, folderName) VALUES ('target', 'ALL', 'Target')`
    ).run()
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, folderName) VALUES ('created', 'target', 'Created')`
    ).run()
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName) VALUES ('ghost', 'created', 'Ghost')`
    ).run()
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName) VALUES ('kept', 'target', 'Kept')`
    ).run()
    db.prepare(`INSERT INTO asset_tags (assetKey, tagId) VALUES ('ghost', 'tag')`).run()
    db.prepare(`INSERT INTO asset_favorites (assetKey, userId) VALUES ('ghost', 'user')`).run()

    const result = rollbackRemoteImportLocalRows(db, {
      assetKeys: ['ghost'],
      folderKeys: ['created', 'ALL']
    })

    expect(result.deletedAssets).toBe(1)
    expect(result.deletedFolders).toBe(1)
    expect(count(db, 'assetData', 'assetKey', 'ghost')).toBe(0)
    expect(count(db, 'assetFolder', 'folderKey', 'created')).toBe(0)
    expect(count(db, 'assetData', 'assetKey', 'kept')).toBe(1)
    expect(count(db, 'assetFolder', 'folderKey', 'ALL')).toBe(1)
    expect(count(db, 'asset_tags', 'assetKey', 'ghost')).toBe(0)
    expect(count(db, 'asset_favorites', 'assetKey', 'ghost')).toBe(0)
  })

  it('does not delete rollback folders that now contain non-rollback assets', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, folderName) VALUES ('target', 'ALL', 'Target')`
    ).run()
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, folderName) VALUES ('created', 'target', 'Created')`
    ).run()
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName) VALUES ('ghost', 'created', 'Ghost')`
    ).run()
    db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName) VALUES ('kept', 'created', 'Kept')`
    ).run()
    db.prepare(`INSERT INTO asset_tags (assetKey, tagId) VALUES ('kept', 'tag')`).run()
    db.prepare(`INSERT INTO asset_favorites (assetKey, userId) VALUES ('kept', 'user')`).run()

    const result = rollbackRemoteImportLocalRows(db, {
      assetKeys: ['ghost'],
      folderKeys: ['created']
    })

    expect(result.deletedAssets).toBe(1)
    expect(result.deletedFolders).toBe(0)
    expect(count(db, 'assetData', 'assetKey', 'ghost')).toBe(0)
    expect(count(db, 'assetData', 'assetKey', 'kept')).toBe(1)
    expect(count(db, 'assetFolder', 'folderKey', 'created')).toBe(1)
    expect(count(db, 'asset_tags', 'assetKey', 'kept')).toBe(1)
    expect(count(db, 'asset_favorites', 'assetKey', 'kept')).toBe(1)
  })
})
