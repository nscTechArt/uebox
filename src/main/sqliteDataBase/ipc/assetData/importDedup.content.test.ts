import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAssetData, deleteAssetData, initAssetDataModel } from '../../models/assetData'
import { createAssetFolder, initAssetFolderModel } from '../../models/assetFolder'
import { calculateFastFileHash } from './fileUtils'
import { findExistingAssetRow, findIdenticalLocalAssets } from './importDedup'

let dir: string
let db: Database.Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-dedup-content-'))
  db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  createAssetFolder(db, { folderKey: 'ALL', fatherKey: null, folderName: 'ALL', type: 'folder' })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('legacy hash candidates require full content verification', () => {
  it('finds the real match after a sampled collision and keeps relative backup paths compatible', async () => {
    const original = Buffer.alloc(1024 * 1024, 42)
    const incoming = Buffer.from(original)
    incoming[256 * 1024] = 99
    const source = join(dir, 'source.bin')
    writeFileSync(source, incoming)
    writeFileSync(join(dir, 'old.bin'), original)
    writeFileSync(join(dir, 'matching.bin'), incoming)
    const fileMd5 = await calculateFastFileHash(source)
    expect(await calculateFastFileHash(join(dir, 'old.bin'))).toBe(fileMd5)
    for (const [assetKey, filePath] of [
      ['collision', 'old.bin'],
      ['match', 'matching.bin'],
      ['missing', 'gone.bin']
    ]) {
      createAssetData(db, {
        assetKey,
        assetName: assetKey,
        folderKey: 'ALL',
        fileMd5,
        filePath,
        originPath: source
      })
    }

    const verifiedLocalAssets = await findIdenticalLocalAssets(db, source, fileMd5, dir)
    expect(verifiedLocalAssets.map((asset) => asset.assetKey)).toEqual(['match'])
    expect(
      findExistingAssetRow(db, { isNetworkMode: false, fileMd5, folderKey: 'ALL' })
    ).toBeUndefined()
    expect(
      findExistingAssetRow(db, {
        isNetworkMode: false,
        fileMd5,
        folderKey: 'ALL',
        originPath: source,
        verifiedLocalAssets
      })?.assetKey
    ).toBe('match')

    deleteAssetData(db, 'match')
    expect(
      findExistingAssetRow(db, {
        isNetworkMode: false,
        fileMd5,
        folderKey: 'ALL',
        verifiedLocalAssets
      })
    ).toBeUndefined()
    expect(await findIdenticalLocalAssets(db, source, fileMd5, dir)).toEqual([])
  })

  it('propagates an unreadable source instead of claiming content equality', async () => {
    createAssetData(db, {
      assetKey: 'candidate',
      assetName: 'candidate',
      folderKey: 'ALL',
      fileMd5: 'old',
      filePath: 'copy.bin'
    })
    await expect(
      findIdenticalLocalAssets(db, join(dir, 'missing.bin'), 'old', dir)
    ).rejects.toThrow()
  })
})
