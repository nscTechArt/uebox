/**
 * 最小可行测试：app_settings schema 迁移 + createVault 回滚
 *
 * 前提：需先执行 `node scripts/switch-better-sqlite3.js node` 将 native 模块切回系统 Node
 * 运行方式: npx vitest run src/main/sqliteDataBase/VaultManager.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 取消 tests/setup.ts 中对 better-sqlite3 的全局 mock，以使用真实的 native 模块
vi.unmock('better-sqlite3')

import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * 模拟 VaultManager 中的迁移逻辑，不依赖 Electron / app 模块
 */
function migrateAppSettingsTable(db: Database.Database): void {
  const migrations = [
    { name: 'type', type: "TEXT DEFAULT 'string'" },
    { name: 'created_at', type: "TEXT DEFAULT ''" },
    { name: 'updated_at', type: "TEXT DEFAULT ''" }
  ]

  type ColumnInfo = { name: string }
  const columns = db.prepare('PRAGMA table_info(app_settings)').all() as ColumnInfo[]
  const existingColumns = columns.map((col) => col.name)

  for (const col of migrations) {
    if (!existingColumns.includes(col.name)) {
      db.exec(`ALTER TABLE app_settings ADD COLUMN ${col.name} ${col.type}`)
    }
  }
}

describe('app_settings schema migration', () => {
  let db: Database.Database
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'))
    db = new Database(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should upgrade old 2-column app_settings to 5-column schema', () => {
    // 模拟 settings.ts 先创建的旧 schema（只有 key/value）
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `)
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(
      'some_old_setting',
      '"hello"'
    )

    // 执行迁移
    migrateAppSettingsTable(db)

    // 验证列已补齐
    type ColInfo = { name: string }
    const cols = db.prepare('PRAGMA table_info(app_settings)').all() as ColInfo[]
    const colNames = cols.map((c) => c.name)
    expect(colNames).toContain('type')
    expect(colNames).toContain('created_at')
    expect(colNames).toContain('updated_at')

    // 验证带新列的 INSERT 不再报错
    expect(() => {
      db.prepare(
        `
        INSERT INTO app_settings (key, value, type, created_at, updated_at)
        VALUES (?, ?, 'string', datetime('now', 'localtime'), datetime('now', 'localtime'))
      `
      ).run('network_v2_enabled:vault_123', 'true')
    }).not.toThrow()

    // 验证旧数据仍然可读
    const row = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('some_old_setting') as { value: string }
    expect(row.value).toBe('"hello"')
  })

  it('should be idempotent — migration on already-migrated table is a no-op', () => {
    // 表已经是 5 列 schema
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        type TEXT DEFAULT 'string',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      )
    `)

    // 迁移不会报错
    expect(() => migrateAppSettingsTable(db)).not.toThrow()
  })
})

describe('createVault transactional rollback', () => {
  let db: Database.Database
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'))
    db = new Database(join(tmpDir, 'test.db'))

    // 创建 vaults 表
    db.exec(`
      CREATE TABLE vaults (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        path TEXT NOT NULL,
        is_custom_location BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT FALSE,
        vault_type TEXT NOT NULL DEFAULT 'backup',
        icon TEXT DEFAULT 'database',
        sort_order INTEGER DEFAULT 0,
        asset_count INTEGER DEFAULT 0,
        total_size INTEGER DEFAULT 0,
        disk_info TEXT,
        network_path TEXT,
        requires_auth BOOLEAN DEFAULT FALSE,
        sync_status TEXT DEFAULT 'synced',
        last_sync_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      )
    `)

    // 模拟旧 schema 的 app_settings（没有 type/created_at/updated_at 列）
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should not leave residual vaults record when app_settings write fails', () => {
    const vaultId = 'vault_test_001'
    const vaultName = 'TestNASVault'

    // 在旧 schema 下，事务中的 setNetworkV2Enabled 会失败
    const createTransaction = db.transaction(() => {
      // insertVaultRecord
      db.prepare(
        `
        INSERT INTO vaults (id, name, path, vault_type, created_at, updated_at)
        VALUES (?, ?, ?, 'network', datetime('now','localtime'), datetime('now','localtime'))
      `
      ).run(vaultId, vaultName, '/fake/path')

      // setNetworkV2Enabled — 引用不存在的列，会抛异常
      db.prepare(
        `
        INSERT INTO app_settings (key, value, type, created_at, updated_at)
        VALUES (?, ?, 'string', datetime('now', 'localtime'), datetime('now', 'localtime'))
      `
      ).run(`network_v2_enabled:${vaultId}`, 'true')
    })

    // 事务应该失败
    expect(() => createTransaction()).toThrow()

    // 核心断言：vaults 表不应有残留记录
    const row = db.prepare('SELECT id FROM vaults WHERE id = ?').get(vaultId)
    expect(row).toBeUndefined()

    // 用户重试应该不会得到 UNIQUE constraint 错误
    expect(() => {
      db.prepare(
        `
        INSERT INTO vaults (id, name, path, vault_type, created_at, updated_at)
        VALUES (?, ?, ?, 'network', datetime('now','localtime'), datetime('now','localtime'))
      `
      ).run('vault_test_002', vaultName, '/fake/path2')
    }).not.toThrow()
  })

  it('should succeed after migration is applied', () => {
    // 先执行迁移
    migrateAppSettingsTable(db)

    const vaultId = 'vault_test_003'
    const vaultName = 'MigratedNASVault'

    const createTransaction = db.transaction(() => {
      db.prepare(
        `
        INSERT INTO vaults (id, name, path, vault_type, created_at, updated_at)
        VALUES (?, ?, ?, 'network', datetime('now','localtime'), datetime('now','localtime'))
      `
      ).run(vaultId, vaultName, '/fake/path')

      db.prepare(
        `
        INSERT INTO app_settings (key, value, type, created_at, updated_at)
        VALUES (?, ?, 'string', datetime('now', 'localtime'), datetime('now', 'localtime'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now', 'localtime')
      `
      ).run(`network_v2_enabled:${vaultId}`, 'true')
    })

    // 事务应该成功
    expect(() => createTransaction()).not.toThrow()

    // vaults 和 app_settings 都应有记录
    const vaultRow = db.prepare('SELECT id FROM vaults WHERE id = ?').get(vaultId) as { id: string }
    expect(vaultRow.id).toBe(vaultId)

    const settingRow = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(`network_v2_enabled:${vaultId}`) as { value: string }
    expect(settingRow.value).toBe('true')
  })
})
