/**
 * @vitest-environment node
 *
 * 资产库聚合统计。
 *
 * 这里最该守住的不是「数字算得对」，而是**数字加起来对得上**：
 * 分布只列前 N 个，剩下的必须以 otherCount 的形式回出去。少了它，
 * 调用方会把「前 12 类」当成「一共就这 12 类」念给用户听 —— 而且看不出错。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { initAssetFolderModel } from './assetFolder'
import { initAssetDataModel } from './assetData'
import { initAssetTagModel } from './assetTag'
import { initAssetFavoriteModel } from './assetFavorite'
import { getAssetLibraryOverview } from './assetStats'
import { countAssetsByCriteria } from './assetSearch'

let db: Database.Database

interface SeedAsset {
  key: string
  name: string
  folderKey: string
  type?: string
  ext?: string
  size?: number
  engine?: string
}

function insertAsset(asset: SeedAsset): void {
  db.prepare(
    `INSERT INTO assetData
       (assetKey, folderKey, assetName, assetType, fileExtension, size, engineVersion, folderName, isDelete)
     VALUES (@key, @folderKey, @name, @type, @ext, @size, @engine, @folderKey, 0)`
  ).run({
    key: asset.key,
    folderKey: asset.folderKey,
    name: asset.name,
    type: asset.type ?? 'StaticMesh',
    ext: asset.ext ?? 'uasset',
    size: asset.size ?? 1024,
    engine: asset.engine ?? '5.5'
  })
}

function insertFolder(folderKey: string, fullPath: string): void {
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES (?, 'ALL', 'folder', ?, ?, '[]', 1, '[]', 0)`
  ).run(folderKey, fullPath.split('/').pop(), fullPath)
}

beforeEach(() => {
  db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  initAssetTagModel(db)
  initAssetFavoriteModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()
  insertFolder('k_role', '/角色')
  insertFolder('k_role_tex', '/角色/贴图')
  insertFolder('k_env', '/场景')
})

describe('getAssetLibraryOverview', () => {
  it('总数和总大小按 SQL 算，不受列举条数影响', () => {
    for (let i = 0; i < 50; i += 1) {
      insertAsset({ key: `a${i}`, name: `SM_Rock_${i}`, folderKey: 'k_env', size: 100 })
    }

    const overview = getAssetLibraryOverview(db)

    expect(overview.total).toBe(50)
    expect(overview.totalSize).toBe(5000)
  })

  it('分布只列前 N 个，其余进 otherCount —— 桶里的数加上它等于总数', () => {
    // 20 种类型，每种 1 个
    for (let i = 0; i < 20; i += 1) {
      insertAsset({ key: `a${i}`, name: `A_${i}`, folderKey: 'k_env', type: `Type${i}` })
    }

    const overview = getAssetLibraryOverview(db, {}, { facetLimit: 5 })

    expect(overview.byType.buckets).toHaveLength(5)
    expect(overview.byType.otherKinds).toBe(15)
    const shown = overview.byType.buckets.reduce((sum, b) => sum + b.count, 0)
    expect(shown + overview.byType.otherCount).toBe(overview.total)
  })

  it('文件夹分布按顶层切，子文件夹的资产归到它的顶层祖先', () => {
    insertAsset({ key: 'a1', name: 'SM_Hero', folderKey: 'k_role' })
    insertAsset({ key: 'a2', name: 'T_Hero_D', folderKey: 'k_role_tex' })
    insertAsset({ key: 'a3', name: 'SM_Rock', folderKey: 'k_env' })

    const overview = getAssetLibraryOverview(db)
    const byFolder = Object.fromEntries(overview.byFolder.buckets.map((b) => [b.key, b.count]))

    expect(byFolder['角色']).toBe(2)
    expect(byFolder['场景']).toBe(1)
  })

  it('scopePath 让文件夹分布往下钻一层', () => {
    insertAsset({ key: 'a1', name: 'SM_Hero', folderKey: 'k_role' })
    insertAsset({ key: 'a2', name: 'T_Hero_D', folderKey: 'k_role_tex' })

    const overview = getAssetLibraryOverview(db, {}, { scopePath: '/角色' })
    const byFolder = Object.fromEntries(overview.byFolder.buckets.map((b) => [b.key, b.count]))

    // 直接躺在 /角色 下的那个归「(本级)」，在 /角色/贴图 下的归「贴图」
    expect(byFolder['(本级)']).toBe(1)
    expect(byFolder['贴图']).toBe(1)
  })

  it('统计跟着筛选条件走 —— 概览也能只看一个文件夹', () => {
    insertAsset({ key: 'a1', name: 'SM_Hero', folderKey: 'k_role' })
    insertAsset({ key: 'a2', name: 'T_Hero_D', folderKey: 'k_role_tex' })
    insertAsset({ key: 'a3', name: 'SM_Rock', folderKey: 'k_env' })

    const scoped = getAssetLibraryOverview(db, {
      folderKey: 'k_role',
      includeSubfolders: true
    })

    expect(scoped.total).toBe(2)
  })

  it('数得出没打标签的和收藏的', () => {
    insertAsset({ key: 'a1', name: 'SM_Hero', folderKey: 'k_role' })
    insertAsset({ key: 'a2', name: 'SM_Rock', folderKey: 'k_env' })
    db.prepare('INSERT INTO asset_tags (assetKey, tagId) VALUES (?, ?)').run('a1', 7)
    db.prepare('INSERT INTO asset_favorites (assetKey, itemType) VALUES (?, ?)').run('a1', 'asset')

    const overview = getAssetLibraryOverview(db)

    expect(overview.untaggedCount).toBe(1)
    expect(overview.favoriteCount).toBe(1)
    expect(overview.byTag.buckets).toEqual([{ key: '标签#7', count: 1, size: 1024 }])
  })

  it('标签有公共库时换成名字', () => {
    insertAsset({ key: 'a1', name: 'SM_Hero', folderKey: 'k_role' })
    db.prepare('INSERT INTO asset_tags (assetKey, tagId) VALUES (?, ?)').run('a1', 7)

    const publicDb = new Database(':memory:')
    publicDb.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT)')
    publicDb.prepare('INSERT INTO tags (id, name) VALUES (7, ?)').run('主角')

    const overview = getAssetLibraryOverview(db, {}, { publicDb })

    expect(overview.byTag.buckets[0].key).toBe('主角')
    publicDb.close()
  })

  it('最占地方的排在前面', () => {
    insertAsset({ key: 'a1', name: 'small', folderKey: 'k_env', size: 10 })
    insertAsset({ key: 'a2', name: 'huge', folderKey: 'k_env', size: 9_000_000 })

    const overview = getAssetLibraryOverview(db, {}, { largestLimit: 1 })

    expect(overview.largest).toHaveLength(1)
    expect(overview.largest[0].name).toBe('huge')
  })

  it('空库不炸，回全零', () => {
    const overview = getAssetLibraryOverview(db)

    expect(overview.total).toBe(0)
    expect(overview.byType.buckets).toEqual([])
    expect(overview.largest).toEqual([])
  })

  it('软删除的资产不进统计', () => {
    insertAsset({ key: 'a1', name: 'SM_Hero', folderKey: 'k_role' })
    insertAsset({ key: 'a2', name: 'SM_Gone', folderKey: 'k_role' })
    db.prepare('UPDATE assetData SET isDelete = 1 WHERE assetKey = ?').run('a2')

    expect(getAssetLibraryOverview(db).total).toBe(1)
  })
})

describe('countAssetsByCriteria', () => {
  it('数总数不把行读出来，结果和筛选条件一致', () => {
    insertAsset({ key: 'a1', name: 'SM_Hero', folderKey: 'k_role', type: 'StaticMesh' })
    insertAsset({ key: 'a2', name: 'T_Hero_D', folderKey: 'k_role', type: 'Texture2D' })
    insertAsset({ key: 'a3', name: 'SM_Rock', folderKey: 'k_env', type: 'StaticMesh' })

    expect(countAssetsByCriteria(db, {})).toBe(3)
    expect(countAssetsByCriteria(db, { assetTypes: ['StaticMesh'] })).toBe(2)
    expect(countAssetsByCriteria(db, { folderKey: 'k_env' })).toBe(1)
  })

  it('limit / offset 不影响总数', () => {
    for (let i = 0; i < 30; i += 1) {
      insertAsset({ key: `a${i}`, name: `A_${i}`, folderKey: 'k_env' })
    }

    expect(countAssetsByCriteria(db, { limit: 5, offset: 10 })).toBe(30)
  })
})
