import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAssetData, initAssetDataModel } from '../models/assetData'
import { createAssetFolder, initAssetFolderModel } from '../models/assetFolder'
import { DragMoveService } from './dragMoveService'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  for (const [folderKey, fatherKey] of [
    ['ALL', null],
    ['source', 'ALL'],
    ['child', 'source'],
    ['target', 'ALL']
  ]) {
    createAssetFolder(db, {
      folderKey: folderKey!,
      fatherKey,
      folderName: folderKey!,
      type: 'folder'
    })
  }
})

afterEach(() => db.close())

const snapshot = (): unknown[] => db.prepare('SELECT * FROM assetFolder ORDER BY folderKey').all()

describe('folder move integrity', () => {
  it.each(['source', 'child'])(
    'rejects moving a folder into %s without changing any row',
    async (target) => {
      const before = snapshot()
      const result = await new DragMoveService(db).moveItems(
        [{ id: 'source', type: 'folder' }],
        target
      )

      expect(result.success).toBe(false)
      expect(result.changedFolderKeys).toEqual([])
      expect(snapshot()).toEqual(before)
    }
  )

  it('rolls back the complete subtree if recalculating a child path fails', async () => {
    db.exec(`CREATE TRIGGER reject_child_path BEFORE UPDATE OF fullPath ON assetFolder
      WHEN NEW.folderKey = 'child' BEGIN SELECT RAISE(ABORT, 'test path failure'); END`)
    const before = snapshot()
    const result = await new DragMoveService(db).moveItems(
      [{ id: 'source', type: 'folder' }],
      'target'
    )

    expect(result.success).toBe(false)
    expect(result.errors?.join()).toContain('test path failure')
    expect(result.changedFolderKeys).toEqual([])
    expect(snapshot()).toEqual(before)
  })

  it('rejects an existing cycle in the target ancestry instead of looping', async () => {
    db.prepare('UPDATE assetFolder SET fatherKey = ? WHERE folderKey = ?').run('target', 'target')
    const before = snapshot()
    const result = await new DragMoveService(db).moveItems(
      [{ id: 'source', type: 'folder' }],
      'target'
    )
    expect(result.success).toBe(false)
    expect(snapshot()).toEqual(before)
  })

  it('keeps successful items while rolling back an individual failed folder move', async () => {
    createAssetData(db, { assetKey: 'file', assetName: 'file', folderKey: 'ALL' })
    db.exec(`CREATE TRIGGER reject_child_path BEFORE UPDATE OF fullPath ON assetFolder
      WHEN NEW.folderKey = 'child' BEGIN SELECT RAISE(ABORT, 'test path failure'); END`)
    const before = snapshot()
    const result = await new DragMoveService(db).moveItems(
      [
        { id: 'file', type: 'file' },
        { id: 'source', type: 'folder' }
      ],
      'target'
    )

    expect(result.success).toBe(false)
    expect(result.changedAssetKeys).toEqual(['file'])
    expect(result.changedFolderKeys).toEqual([])
    expect(snapshot()).toEqual(before)
    expect(db.prepare('SELECT folderKey FROM assetData WHERE assetKey = ?').get('file')).toEqual({
      folderKey: 'target'
    })
  })

  it('moves a valid subtree and updates its paths', async () => {
    const result = await new DragMoveService(db).moveItems(
      [{ id: 'source', type: 'folder' }],
      'target'
    )
    expect(result.success).toBe(true)
    expect(result.changedFolderKeys).toEqual(['source', 'child'])
    expect(
      db.prepare('SELECT fatherKey, fullPath FROM assetFolder WHERE folderKey = ?').get('source')
    ).toEqual({ fatherKey: 'target', fullPath: '/ALL/target/source' })
    expect(db.prepare('SELECT fullPath FROM assetFolder WHERE folderKey = ?').get('child')).toEqual(
      { fullPath: '/ALL/target/source/child' }
    )
  })
})
