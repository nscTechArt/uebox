/**
 * 网络库重复导入的去重。
 *
 * 红灯用例是「非 UE 文件」那条：修复前只有解析成功的 uasset/umap 走了 originPath
 * 去重，贴图/fbx/zip 一律无条件新建。同一个文件夹第二次拖进网络库 →
 * 复制阶段判定内容相同、自动算成功 → 库里静默多出一整套重复记录。
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAssetData, getAssetDataByKey, initAssetDataModel } from '../../models/assetData'
import { initAssetFolderModel } from '../../models/assetFolder'
import { findExistingAssetRow } from './importDedup'

let db: Database.Database

const NETWORK_PATH = '//nas/vault/Textures/preview.png'

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()
})

afterEach(() => db.close())

const seedAsset = (assetKey: string, originPath: string, isDelete = 0): void => {
  createAssetData(db, {
    assetKey,
    folderKey: 'ALL',
    assetName: assetKey,
    originPath,
    isDelete
  } as never)
}

describe('findExistingAssetRow', () => {
  it('网络库里已有同一个网络路径的资产 → 复用旧行，不新建', () => {
    seedAsset('asset_old', NETWORK_PATH)

    const found = findExistingAssetRow(db, { isNetworkMode: true, originPath: NETWORK_PATH })

    expect(found?.assetKey).toBe('asset_old')
  })

  it('本地库不按 originPath 去重 —— 同一个源文件可以导入到不同文件夹', () => {
    seedAsset('asset_old', 'D:/src/preview.png')

    const found = findExistingAssetRow(db, {
      isNetworkMode: false,
      originPath: 'D:/src/preview.png'
    })

    expect(found).toBeUndefined()
  })

  it('HTTP NAS 模式查到的行优先，不再多查一次', () => {
    seedAsset('asset_by_path', NETWORK_PATH)
    const remote = { assetKey: 'asset_remote' } as never

    const found = findExistingAssetRow(db, {
      existingRemoteAsset: remote,
      isNetworkMode: true,
      originPath: NETWORK_PATH
    })

    expect(found).toBe(remote)
  })

  it('回收站里的同路径资产不算数，重导应该新建', () => {
    seedAsset('asset_deleted', NETWORK_PATH, 1)

    const found = findExistingAssetRow(db, { isNetworkMode: true, originPath: NETWORK_PATH })

    expect(found).toBeUndefined()
  })

  it('没有 originPath 时不去重（拿不到依据，宁可新建也不能乱认）', () => {
    seedAsset('asset_old', NETWORK_PATH)

    expect(findExistingAssetRow(db, { isNetworkMode: true })).toBeUndefined()
    expect(findExistingAssetRow(db, { isNetworkMode: true, originPath: '' })).toBeUndefined()
  })

  it('库里没有对应记录时返回 undefined', () => {
    expect(
      findExistingAssetRow(db, { isNetworkMode: true, originPath: '//nas/vault/other.png' })
    ).toBeUndefined()
  })
})

describe('本地库重复导入（中断后重来）', () => {
  const seedWithMd5 = (assetKey: string, md5: string, folderKey = 'ALL'): void => {
    createAssetData(db, {
      assetKey,
      folderKey,
      assetName: assetKey,
      fileMd5: md5,
      originPath: 'D:/source/a.png',
      isDelete: 0
    } as never)
  }

  it('同来源、同文件夹、同内容才复用旧行', () => {
    seedWithMd5('asset_first', 'MD5-AAA')

    const found = findExistingAssetRow(db, {
      isNetworkMode: false,
      fileMd5: 'MD5-AAA',
      folderKey: 'ALL',
      originPath: 'D:/source/a.png',
      verifiedLocalAssets: [getAssetDataByKey(db, 'asset_first')!]
    })

    // 旧实现：MD5 只用来复用文件路径，assetKey 照旧发新的 —— 导入 5 万文件
    // 中途崩掉再来一遍，库里就是第二套完整记录
    expect(found?.assetKey).toBe('asset_first')
  })

  it('同内容不同源文件不能覆盖第一条资产记录', () => {
    seedWithMd5('asset_first', 'MD5-AAA')
    expect(
      findExistingAssetRow(db, {
        isNetworkMode: false,
        fileMd5: 'MD5-AAA',
        folderKey: 'ALL',
        originPath: 'D:/source/b.png',
        verifiedLocalAssets: [getAssetDataByKey(db, 'asset_first')!]
      })
    ).toBeUndefined()
  })

  it('同一个源文件导入到**不同**文件夹是正常用法，不能当成重复', () => {
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('folder_b', 'ALL', 'folder', 'B', '/B', '[]', 1, '[]', 0)`
    ).run()
    seedWithMd5('asset_in_all', 'MD5-AAA', 'ALL')

    expect(
      findExistingAssetRow(db, {
        isNetworkMode: false,
        fileMd5: 'MD5-AAA',
        folderKey: 'folder_b',
        verifiedLocalAssets: [getAssetDataByKey(db, 'asset_in_all')!]
      })
    ).toBeUndefined()
  })

  it('回收站里的同内容资产不算数', () => {
    seedWithMd5('asset_deleted', 'MD5-AAA')
    db.prepare(`UPDATE assetData SET isDelete = 1 WHERE assetKey = 'asset_deleted'`).run()

    expect(
      findExistingAssetRow(db, { isNetworkMode: false, fileMd5: 'MD5-AAA', folderKey: 'ALL' })
    ).toBeUndefined()
  })

  it('哈希算不出来时不去重（宁可新建也不能乱认）', () => {
    seedWithMd5('asset_first', 'MD5-AAA')

    expect(findExistingAssetRow(db, { isNetworkMode: false, folderKey: 'ALL' })).toBeUndefined()
    expect(findExistingAssetRow(db, { isNetworkMode: false, fileMd5: 'MD5-AAA' })).toBeUndefined()
  })

  it('网络库仍然按 originPath 判，不退到 MD5', () => {
    seedWithMd5('asset_by_md5', 'MD5-AAA')

    expect(
      findExistingAssetRow(db, {
        isNetworkMode: true,
        fileMd5: 'MD5-AAA',
        folderKey: 'ALL'
      })
    ).toBeUndefined()
  })
})
