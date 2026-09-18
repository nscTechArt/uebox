/**
 * 网络库文件夹的物理路径。
 *
 * 红灯用例是「父文件夹软删」那条：原实现往上递归时用的是带 `AND isDelete = 0`
 * 的查询，父文件夹一旦是软删状态，递归返回空串、路径塌缩成只剩当前文件夹名，
 * 于是 `join(networkPath, "Mesh")` 指向网络根目录下的同名目录 —— 后台任务对它
 * `rm -rf`。父软删、子活跃在网络库里完全可能：SyncClient 处理远端删除时只置
 * 被点名的那个 folderKey，不递归子孙。
 */
import Database from 'better-sqlite3'
import { join } from 'path'

import { beforeEach, describe, expect, it } from 'vitest'

import { initAssetDataModel } from '../models/assetData'
import { initAssetFolderModel } from '../models/assetFolder'
import {
  buildNetworkFolderRelPath,
  resolveNetworkFolderPath,
  resolveNetworkFolderPathByName
} from './networkFolderPath'

const NETWORK = join('//nas', 'vault')

let db: Database.Database

const addFolder = (
  folderKey: string,
  folderName: string,
  fatherKey: string | null,
  isDelete = 0
): void => {
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES (?, ?, 'folder', ?, ?, '[]', 1, '[]', ?)`
  ).run(folderKey, fatherKey, folderName, `/${folderName}`, isDelete)
}

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

describe('buildNetworkFolderRelPath', () => {
  it('拼出完整层级', () => {
    addFolder('props', 'Props', 'ALL')
    addFolder('mesh', 'Mesh', 'props')

    expect(buildNetworkFolderRelPath(db, 'mesh')).toBe('Props/Mesh')
  })

  it('父文件夹软删时路径**不能**塌缩 —— 那个目录在磁盘上还在', () => {
    addFolder('props', 'Props', 'ALL', 1) // 父已软删
    addFolder('mesh', 'Mesh', 'props', 0) // 子还活着

    // 旧实现返回 'Mesh' → join(networkPath, 'Mesh') → rm -rf 网络根下的同名目录
    expect(buildNetworkFolderRelPath(db, 'mesh')).toBe('Props/Mesh')
  })

  it('父链断了就返回 null，不返回半截路径', () => {
    // 外键会拦住这种脏数据，但同步/手改库都可能造出来，所以要能扛
    db.pragma('foreign_keys = OFF')
    addFolder('orphan', 'Orphan', 'missing_parent')
    db.pragma('foreign_keys = ON')

    expect(buildNetworkFolderRelPath(db, 'orphan')).toBeNull()
  })

  it('成环返回 null，不死循环', () => {
    addFolder('x', 'X', 'ALL')
    addFolder('y', 'Y', 'x')
    db.prepare(`UPDATE assetFolder SET fatherKey = 'y' WHERE folderKey = 'x'`).run()

    expect(buildNetworkFolderRelPath(db, 'x')).toBeNull()
  })

  it('ALL 与空 key 一律 null', () => {
    expect(buildNetworkFolderRelPath(db, 'ALL')).toBeNull()
    expect(buildNetworkFolderRelPath(db, '')).toBeNull()
  })

  it('文件夹名为空或是 .. 时拒绝', () => {
    addFolder('bad', '..', 'ALL')
    addFolder('blank', '   ', 'ALL')

    expect(buildNetworkFolderRelPath(db, 'bad')).toBeNull()
    expect(buildNetworkFolderRelPath(db, 'blank')).toBeNull()
  })
})

describe('resolveNetworkFolderPath', () => {
  it('拼成网络库根目录下的绝对路径', () => {
    addFolder('props', 'Props', 'ALL')

    expect(resolveNetworkFolderPath(db, 'props', NETWORK)).toBe(join(NETWORK, 'Props'))
  })

  it('没有网络路径时返回 null', () => {
    addFolder('props', 'Props', 'ALL')

    expect(resolveNetworkFolderPath(db, 'props', null)).toBeNull()
  })

  it('文件夹名里藏路径分隔符 → 拒绝', () => {
    // UNC 根会把多余的 .. 吃掉，拼完看起来「没爬出去」，
    // 但落点已经不是原来那个目录了 —— 所以在拼之前就拦
    addFolder('evil', '../../Windows', 'ALL')
    addFolder('evil2', 'a/b', 'ALL')

    expect(resolveNetworkFolderPath(db, 'evil', NETWORK)).toBeNull()
    expect(resolveNetworkFolderPath(db, 'evil2', NETWORK)).toBeNull()
  })
})

describe('resolveNetworkFolderPathByName', () => {
  it('重命名用旧名字拼旧路径（数据库里已经是新名字了）', () => {
    addFolder('props', 'Props', 'ALL')

    expect(resolveNetworkFolderPathByName(db, 'props', '旧名字', NETWORK)).toBe(
      join(NETWORK, 'Props', '旧名字')
    )
  })

  it('根级文件夹直接落在网络库根下', () => {
    expect(resolveNetworkFolderPathByName(db, 'ALL', 'Props', NETWORK)).toBe(join(NETWORK, 'Props'))
    expect(resolveNetworkFolderPathByName(db, null, 'Props', NETWORK)).toBe(join(NETWORK, 'Props'))
  })

  it('父链断了返回 null，而不是当成根级', () => {
    expect(resolveNetworkFolderPathByName(db, 'missing_parent', 'Props', NETWORK)).toBeNull()
  })
})
