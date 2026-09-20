// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.unmock('better-sqlite3')

import Database from 'better-sqlite3'

import { initAssetDataModel } from '../../models/assetData'
import { initAssetFolderModel } from '../../models/assetFolder'
import { buildRemoteImportFilePath, findActiveRemoteAssetByPath } from './remoteImportPath'

describe('remote import path helpers', () => {
  it('builds the same remote path for folder-session uploads', () => {
    const remotePath = buildRemoteImportFilePath(
      { path: 'D:\\Projects\\角色\\日本病人01\\基础动画\\Idle.uasset', name: 'Idle.uasset' },
      'D:\\Projects\\角色\\日本病人01',
      '角色'
    )

    expect(remotePath).toBe('角色/日本病人01/基础动画/Idle.uasset')
  })

  it('builds target-scoped paths for single-file uploads', () => {
    const remotePath = buildRemoteImportFilePath(
      { path: 'D:\\Exports\\Idle.uasset', name: 'Idle.uasset' },
      'ALL',
      '角色/日本病人01/基础动画'
    )

    expect(remotePath).toBe('角色/日本病人01/基础动画/Idle.uasset')
  })

  it('finds an existing active asset by normalized remote path', () => {
    const row = { assetKey: 'asset_existing', filePath: '角色\\日本病人01\\基础动画\\Idle.uasset' }
    const observed: unknown[][] = []
    const db = {
      prepare: () => ({
        get: (...args: unknown[]) => {
          observed.push(args)
          return row
        }
      })
    }

    expect(findActiveRemoteAssetByPath(db as any, '角色/日本病人01/基础动画/Idle.uasset')).toBe(row)
    expect(observed[0]).toEqual([
      '角色/日本病人01/基础动画/Idle.uasset',
      '角色\\日本病人01\\基础动画\\Idle.uasset',
      '角色/日本病人01/基础动画/Idle.uasset',
      '角色\\日本病人01\\基础动画\\Idle.uasset'
    ])
  })

  /**
   * 回归：这条查询以前是 `filePath IN (..) OR originPath IN (..)`。库里没有统计信息时
   * 规划器会选 idx_assetData_isDelete（两值列）整表扫，52 万行的远端镜像上每个文件 4 秒。
   * 这里盯住执行计划：两条分支必须各走自己的复合索引，谁都不准碰 isDelete 单列索引。
   */
  it('never falls back to the isDelete index on a real schema (no ANALYZE)', () => {
    const db = new Database(':memory:')
    initAssetFolderModel(db)
    initAssetDataModel(db)
    db.exec(
      `INSERT OR IGNORE INTO assetFolder (folderKey, fatherKey, type, folderName) VALUES ('ALL', NULL, 'system', 'ALL')`
    )
    const insert = db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, filePath, originPath, isDelete, updated_at)
       VALUES (?, 'ALL', ?, ?, ?, ?, ?)`
    )
    insert.run(
      'asset_old',
      'Idle',
      '角色/日本病人01/基础动画/Idle.uasset',
      'D:\\src\\Idle.uasset',
      0,
      '2026-01-01 00:00:00'
    )
    insert.run(
      'asset_new',
      'Idle',
      'D:\\src\\Idle.uasset',
      '角色\\日本病人01\\基础动画\\Idle.uasset',
      0,
      '2026-02-01 00:00:00'
    )
    insert.run(
      'asset_deleted',
      'Idle',
      '角色/日本病人01/基础动画/Idle.uasset',
      null,
      1,
      '2026-03-01 00:00:00'
    )

    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM (
             SELECT * FROM assetData WHERE isDelete = 0 AND filePath IN (?, ?)
             UNION ALL
             SELECT * FROM assetData WHERE isDelete = 0 AND originPath IN (?, ?)
           ) ORDER BY updated_at DESC, id DESC LIMIT 1`
        )
        .all('a', 'b', 'a', 'b') as { detail: string }[]
    ).map((row) => row.detail)
    expect(plan.some((line) => line.includes('idx_assetData_filePath_isDelete'))).toBe(true)
    expect(plan.some((line) => line.includes('idx_assetData_originPath_isDelete'))).toBe(true)
    expect(plan.some((line) => /\bidx_assetData_isDelete\b/.test(line))).toBe(false)

    // 语义不变：两侧都能命中、软删的不算、多条命中取 updated_at 最新的那条
    const hit = findActiveRemoteAssetByPath(db, '角色/日本病人01/基础动画/Idle.uasset')
    expect(hit?.assetKey).toBe('asset_new')
    expect(findActiveRemoteAssetByPath(db, '角色/不存在/Missing.uasset')).toBeUndefined()
    db.close()
  })
})
