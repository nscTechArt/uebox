/**
 * 升级路径回归：老保管库（还没有 `deletedAt` 列）也必须连得上。
 *
 * 2026-09-17 的线上事故就卡在这儿：用户装完新版，**每一个网络库**都是
 * 「资产服务器连接失败：no such column: deletedAt」，一个都连不上。
 *
 * 链条是这样的 ——
 *   1. `deletedAt` 只加进了 models/*.ts 那两份迁移清单，而它们挂在从来没人调用的
 *      `initVaultModels` 上（vaultSchema.test.ts 开头讲的就是这件事）；
 *   2. 老保管库的表早就建好了，`CREATE TABLE IF NOT EXISTS` 对它们不生效，列没补上；
 *   3. SyncClient 的 `prepareStatements()` 无条件 prepare 一句带 `deletedAt` 的 UPDATE，
 *      better-sqlite3 在 prepare 当场编译 SQL，直接抛；
 *   4. 而 prepareStatements 在**构造函数**里，异常一路冒到 `startV2NetworkService`
 *      的 try —— 整个库判定离线。
 *
 * 门禁当时全绿，是因为所有测试都在**新建的空库**上跑：新库走 CREATE TABLE，列天生就在。
 * 没有任何一条覆盖「拿一个老库升上来」。这个文件补的就是那条路。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// 取消 tests/setup.ts 里对 better-sqlite3 的全局 mock —— 这里要真的编译 SQL
vi.unmock('better-sqlite3')

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { SyncClient } from './SyncClient'

/**
 * 老保管库的表结构 —— 故意**不带** `deletedAt`。
 *
 * 这不是臆造的形状：`deletedAt` 是后加的列，在它之前建的库就长这样，
 * 而用户手上绝大多数库都是在它之前建的。
 */
function createOldVaultDb(dir: string): Database.Database {
  const db = new Database(join(dir, 'vault-data.db'))
  db.exec(`
    CREATE TABLE assetFolder (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderKey TEXT NOT NULL UNIQUE,
      fatherKey TEXT,
      img TEXT,
      type TEXT NOT NULL,
      folderName TEXT NOT NULL,
      fullPath TEXT,
      pathArray TEXT,
      depth INTEGER DEFAULT 0,
      ancestorKeys TEXT,
      isDelete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE assetData (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assetKey TEXT NOT NULL UNIQUE,
      folderKey TEXT NOT NULL,
      assetName TEXT NOT NULL,
      isDelete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    INSERT INTO assetFolder (folderKey, type, folderName) VALUES ('ALL', 'system', 'ALL');
    INSERT INTO assetFolder (folderKey, fatherKey, type, folderName)
      VALUES ('f1', 'ALL', 'folder', '旧文件夹');
    INSERT INTO assetData (assetKey, folderKey, assetName) VALUES ('a1', 'f1', '旧资产.uasset');
  `)
  return db
}

/** 补上迁移之后的样子 —— 和 VaultManager.initializeVaultDatabase 补的是同一列 */
function migrateDeletedAt(db: Database.Database): void {
  db.exec(`ALTER TABLE assetData ADD COLUMN deletedAt TEXT`)
  db.exec(`ALTER TABLE assetFolder ADD COLUMN deletedAt TEXT`)
}

const config = {
  serverUrl: 'http://127.0.0.1:18900',
  vaultId: 'remote-vault',
  clientId: 'test-client',
  hostname: 'test-host'
}

/**
 * 走主机推下来的「删除」那条真实路径。
 *
 * 用的就是 prepareStatements 拼出来的那两句软删除 —— 事故正是在 prepare 它们的时候
 * 炸的，所以这里必须真跑它们，不能另写一句 SQL 糊弄过去。
 */
function applyRemoteDelete(
  client: SyncClient,
  tableName: 'assetData' | 'assetFolder',
  recordKey: string
): void {
  ;(client as unknown as { applySingleChange: (change: unknown) => void }).applySingleChange({
    seq: 1,
    op: 'delete',
    tableName,
    recordKey,
    payload: null
  })
}

let tmpDir: string
let db: Database.Database

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'old-vault-'))
})

afterEach(() => {
  try {
    db?.close()
  } catch {
    /* 已经关了就算了 */
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('老保管库升级路径', () => {
  it('缺 deletedAt 列时，建 SyncClient 不许抛 —— 抛了整个库就离线', () => {
    db = createOldVaultDb(tmpDir)
    expect(db.prepare('PRAGMA table_info(assetFolder)').all()).not.toContainEqual(
      expect.objectContaining({ name: 'deletedAt' })
    )

    // 事故复现点：这一行在修之前抛 `no such column: deletedAt`
    expect(() => new SyncClient(db, config)).not.toThrow()
  })

  it('缺列时软删除照样能用，只是不记删除时刻', () => {
    db = createOldVaultDb(tmpDir)
    const client = new SyncClient(db, config)

    // 走真实的软删除语句（prepareStatements 按真实列拼出来的那两句）
    applyRemoteDelete(client, 'assetFolder', 'f1')
    applyRemoteDelete(client, 'assetData', 'a1')

    expect(db.prepare(`SELECT isDelete FROM assetFolder WHERE folderKey = 'f1'`).get()).toEqual({
      isDelete: 1
    })
    expect(db.prepare(`SELECT isDelete FROM assetData WHERE assetKey = 'a1'`).get()).toEqual({
      isDelete: 1
    })
  })

  it('补上列之后，删除时刻要真的写进去 —— 「最近删除」靠它排序', () => {
    db = createOldVaultDb(tmpDir)
    migrateDeletedAt(db)
    const client = new SyncClient(db, config)

    applyRemoteDelete(client, 'assetFolder', 'f1')
    applyRemoteDelete(client, 'assetData', 'a1')

    const folder = db
      .prepare(`SELECT isDelete, deletedAt FROM assetFolder WHERE folderKey = 'f1'`)
      .get() as { isDelete: number; deletedAt: string | null }
    const asset = db
      .prepare(`SELECT isDelete, deletedAt FROM assetData WHERE assetKey = 'a1'`)
      .get() as { isDelete: number; deletedAt: string | null }

    expect(folder.isDelete).toBe(1)
    expect(folder.deletedAt).toBeTruthy()
    expect(asset.isDelete).toBe(1)
    expect(asset.deletedAt).toBeTruthy()
  })
})
