/**
 * @vitest-environment node
 *
 * 文件夹名 → folderKey 的解析。
 *
 * 关键的一条是**同名不猜**：素材库里两个「Textures」很常见，猜错的后果是
 * 资产被搬到另一个文件夹，而且不会有任何报错告诉用户。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createAssetFolder,
  initAssetFolderModel
} from '../../../../sqliteDataBase/models/assetFolder'
import { resolveFolder } from './folderLookup'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  initAssetFolderModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()
  createAssetFolder(db, {
    folderKey: 'k_role',
    fatherKey: 'ALL',
    type: 'folder',
    folderName: '角色'
  })
  createAssetFolder(db, {
    folderKey: 'k_tree',
    fatherKey: 'ALL',
    type: 'folder',
    folderName: 'Trees'
  })
})

describe('resolveFolder', () => {
  it('folderKey 直接命中', () => {
    expect(resolveFolder(db, 'k_tree').folderKey).toBe('k_tree')
  })

  it('完整路径命中，带不带开头的斜杠都行', () => {
    expect(resolveFolder(db, '/角色').folderKey).toBe('k_role')
    expect(resolveFolder(db, '角色').folderKey).toBe('k_role')
  })

  it('名字大小写不敏感', () => {
    expect(resolveFolder(db, 'trees').folderKey).toBe('k_tree')
  })

  it('ALL 是根，不用查表', () => {
    expect(resolveFolder(db, 'ALL').folderKey).toBe('ALL')
  })

  it('重名时给完整路径就能精确指定', () => {
    createAssetFolder(db, {
      folderKey: 'k_tree2',
      fatherKey: 'k_role',
      type: 'folder',
      folderName: 'Trees'
    })

    expect(resolveFolder(db, '/角色/Trees').folderKey).toBe('k_tree2')
    expect(resolveFolder(db, '/Trees').folderKey).toBe('k_tree')
  })

  it('同名文件夹不猜，把候选列出来让人选', () => {
    createAssetFolder(db, {
      folderKey: 'k_tree2',
      fatherKey: 'k_role',
      type: 'folder',
      folderName: 'Trees'
    })

    const r = resolveFolder(db, 'Trees')

    expect(r.folderKey).toBeUndefined()
    expect(r.error).toContain('2 个')
    expect(r.error).toContain('k_tree2')
  })

  it('找不到时告诉调用方下一步怎么办', () => {
    const r = resolveFolder(db, '不存在的目录')
    expect(r.error).toContain('create_folders')
  })

  it('空字符串直接报错，不当成根目录', () => {
    expect(resolveFolder(db, '  ').error).toBeTruthy()
  })
})
