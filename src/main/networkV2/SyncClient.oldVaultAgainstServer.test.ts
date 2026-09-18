// @vitest-environment node
/**
 * 真连一台资产服务器，把「老保管库升上来」这条路走完。
 *
 * 同目录的 SyncClient.oldVaultUpgrade.test.ts 只证明了「建 SyncClient 不抛」。那还不够 ——
 * 事故的完整形状是「客户端连不上服务器」，光构造函数不抛不等于同步真的能跑通，尤其是
 * 服务端那张 `assetFolder` 表**也没有** `deletedAt`（asset-server-standalone 的
 * models/assetFolder.ts 只迁移了 `color`）。两边都缺这一列的时候会怎样，只有真跑一次才知道。
 *
 * 跑之前要有一台服务器：
 *   cd H:/UnrealAgent/asset-server-standalone && node dist/main.js --config config.test.json
 * 没有就自动跳过 —— 门禁机器上不该依赖外部进程。
 */
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('better-sqlite3')

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { SyncClient } from './SyncClient'

const SERVER_URL = 'http://127.0.0.1:19900'
const REMOTE_VAULT_ID = 'vault_1773048136055_868d9fb1'
const API_KEY = 'test-owner-key'

let serverUp = false

beforeAll(async () => {
  try {
    const resp = await fetch(`${SERVER_URL}/api/vaults`, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(2000)
    })
    serverUp = resp.ok
  } catch {
    serverUp = false
  }
})

/** 老保管库：两张表都没有 deletedAt */
function createOldVaultDb(dir: string): Database.Database {
  const db = new Database(join(dir, 'vault-data.db'))
  db.exec(`
    CREATE TABLE assetFolder (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderKey TEXT NOT NULL UNIQUE,
      fatherKey TEXT, img TEXT, type TEXT NOT NULL, folderName TEXT NOT NULL,
      fullPath TEXT, pathArray TEXT, depth INTEGER DEFAULT 0, ancestorKeys TEXT,
      isDelete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE assetData (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assetKey TEXT NOT NULL UNIQUE, folderKey TEXT NOT NULL, assetName TEXT NOT NULL,
      filePath TEXT, fileSize INTEGER, fileExtension TEXT, modifiedTime TEXT,
      processorType TEXT, assetType TEXT, engineVersion TEXT,
      isDelete INTEGER NOT NULL DEFAULT 0, isDependency INTEGER DEFAULT 0,
      classKey TEXT, name TEXT, originPath TEXT, ext TEXT, folderName TEXT, softPath TEXT,
      assetClass TEXT, className TEXT, classNameCn TEXT, classColor TEXT, imports TEXT,
      imgLocalPath TEXT, customPoster TEXT, size INTEGER, assetConfig TEXT,
      assetConfigPath TEXT, fileMd5 TEXT, note TEXT, tags TEXT, color TEXT, pluginInfo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO assetFolder (folderKey, type, folderName) VALUES ('ALL', 'system', 'ALL');
  `)
  return db
}

let tmpDir: string
let db: Database.Database
let client: SyncClient | undefined

afterEach(() => {
  try {
    client?.stop()
  } catch {
    /* 没起来就算了 */
  }
  client = undefined
  try {
    db?.close()
  } catch {
    /* 已经关了 */
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

describe('老保管库 + 真服务器', () => {
  it('两边都缺 deletedAt 时，照样能连上并拉到数据', async () => {
    if (!serverUp) {
      console.warn('[skip] 没有本地资产服务器（127.0.0.1:19900），跳过真连测试')
      return
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'old-vault-net-'))
    db = createOldVaultDb(tmpDir)

    const folderCols = db.prepare('PRAGMA table_info(assetFolder)').all() as { name: string }[]
    expect(folderCols.map((c) => c.name)).not.toContain('deletedAt')

    client = new SyncClient(db, {
      serverUrl: SERVER_URL,
      vaultId: REMOTE_VAULT_ID,
      clientId: 'old-vault-upgrade-probe',
      hostname: 'test-host',
      apiKey: API_KEY
    })

    // 这就是 startClientDirect 的 API-Only 模式走的那条路
    await expect(client.pullChanges()).resolves.not.toThrow()

    // 真的把服务器上的东西写进来了 —— 不是「没抛就算过」
    const folders = db.prepare('SELECT COUNT(*) AS n FROM assetFolder').get() as { n: number }
    expect(folders.n).toBeGreaterThan(1)
  }, 30_000)
})
