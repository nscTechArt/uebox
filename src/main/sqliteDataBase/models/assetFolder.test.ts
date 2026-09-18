import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  createAssetFolder,
  findOrCreateAssetFolder,
  getAssetFolderByKey,
  getAssetFoldersByFatherKey,
  initAssetFolderModel
} from './assetFolder'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  initAssetFolderModel(db)
  db.prepare(
    `
      INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
      VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)
    `
  ).run()
  return db
}

describe('assetFolder model', () => {
  it('returns same-name root children with different folder keys', () => {
    const db = createTestDb()

    createAssetFolder(db, {
      folderKey: 'ui_original',
      fatherKey: 'ALL',
      type: 'folder',
      folderName: 'UI'
    })
    createAssetFolder(db, {
      folderKey: 'ui_reimported',
      fatherKey: 'ALL',
      type: 'folder',
      folderName: 'UI'
    })

    const folders = getAssetFoldersByFatherKey(db, 'ALL')
    const uiFolderKeys = folders
      .filter((folder) => folder.folderName === 'UI')
      .map((folder) => folder.folderKey)
      .sort()

    expect(uiFolderKeys).toEqual(['ui_original', 'ui_reimported'])
    db.close()
  })

  describe('findOrCreateAssetFolder', () => {
    it('复用同父级下的同名文件夹，重复导入不会长出第二棵树', () => {
      const db = createTestDb()

      const first = findOrCreateAssetFolder(db, {
        folderKey: 'demo_first',
        fatherKey: 'ALL',
        type: 'folder',
        folderName: 'Demo'
      })
      const second = findOrCreateAssetFolder(db, {
        folderKey: 'demo_second',
        fatherKey: 'ALL',
        type: 'folder',
        folderName: 'Demo'
      })

      expect(first).toEqual({ folderKey: 'demo_first', created: true })
      expect(second).toEqual({ folderKey: 'demo_first', created: false })
      expect(getAssetFoldersByFatherKey(db, 'ALL')).toHaveLength(1)
      db.close()
    })

    it('同名但父级不同的文件夹各建各的', () => {
      const db = createTestDb()

      createAssetFolder(db, {
        folderKey: 'pcg',
        fatherKey: 'ALL',
        type: 'folder',
        folderName: 'PCG'
      })
      const underAll = findOrCreateAssetFolder(db, {
        folderKey: 'maps_all',
        fatherKey: 'ALL',
        type: 'folder',
        folderName: 'Maps'
      })
      const underPcg = findOrCreateAssetFolder(db, {
        folderKey: 'maps_pcg',
        fatherKey: 'pcg',
        type: 'folder',
        folderName: 'Maps'
      })

      expect(underAll.created).toBe(true)
      expect(underPcg).toEqual({ folderKey: 'maps_pcg', created: true })
      db.close()
    })

    it('复用时补上先前缺失的图标', () => {
      const db = createTestDb()

      findOrCreateAssetFolder(db, {
        folderKey: 'plugin_folder',
        fatherKey: 'ALL',
        type: 'folder',
        folderName: 'SoStylized',
        img: ''
      })
      findOrCreateAssetFolder(db, {
        folderKey: 'ignored',
        fatherKey: 'ALL',
        type: 'plugin',
        folderName: 'SoStylized',
        img: 'C:/icons/so.png'
      })

      const folder = getAssetFolderByKey(db, 'plugin_folder')
      expect(folder?.img).toBe('C:/icons/so.png')
      expect(folder?.type).toBe('plugin')
      db.close()
    })
  })
})
