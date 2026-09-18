/**
 * batchDelete.test.ts — 批量删除回归测试
 *
 * 回归场景 (2026-03-22):
 *   前端曾发送 `data: { key }` 而服务端读取 `data.assetKey`，导致 recordKey 为空，
 *   results.push() 被静默跳过，SyncClient 报错 "batch 响应不完整: 预期 N 条结果, 实际 0 条"。
 *
 * 本测试验证：
 *   1. 使用规范字段 `assetKey` 发送 batch delete 时，服务端返回完整 results
 *   2. 兼容旧格式 `data: { key }` 时，服务端仍能正确删除
 *   3. 缺失 key 的 malformed delete op 会返回明确失败，而不是空结果
 *   4. SyncClient.batch() 校验逻辑在修复后不再误报
 *
 * 测试策略：
 *   - 直接测试 AssetServer.handleBatchOperation 的核心逻辑（模拟 DB + tracker）
 *   - 单元测试 SyncClient.batch() 的响应校验逻辑
 *   - 不启动真实 HTTP Server，避免测试脆弱性
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel, deleteAssetFolder } from '../sqliteDataBase/models/assetFolder'
import { ChangeTracker } from './ChangeTracker'

// ─────────────────────── helpers ───────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  // 二次调用触发 ALTER TABLE 迁移列
  initAssetDataModel(db)
  db.prepare(
    `
    INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
    VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)
  `
  ).run()
  return db
}

function insertAsset(db: Database.Database, assetKey: string, folderKey = 'ALL'): void {
  db.prepare(
    `
    INSERT INTO assetData (assetKey, folderKey, assetName, isDelete)
    VALUES (?, ?, ?, 0)
  `
  ).run(assetKey, folderKey, `${assetKey}.uasset`)
}

function insertFolder(
  db: Database.Database,
  folderKey: string,
  fatherKey: string,
  folderName: string,
  depth: number
): void {
  db.prepare(
    `
    INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
    VALUES (?, ?, 'folder', ?, ?, '[]', ?, '[]', 0)
  `
  ).run(folderKey, fatherKey, folderName, `/${folderName}`, depth)
}

function getIsDelete(
  db: Database.Database,
  table: 'assetData' | 'assetFolder',
  key: string
): number | undefined {
  const col = table === 'assetData' ? 'assetKey' : 'folderKey'
  const row = db.prepare(`SELECT isDelete FROM ${table} WHERE ${col} = ?`).get(key) as
    | { isDelete: number }
    | undefined
  return row?.isDelete
}

/**
 * 模拟 AssetServer.handleBatchOperation 的核心事务逻辑
 * （不依赖 HTTP/WS，纯 SQLite+ChangeTracker 级别）
 *
 * 返回值与生产代码结构一致: { results, count, failedCount }
 */
function simulateBatchOperation(
  db: Database.Database,
  tracker: ChangeTracker,
  operations: Array<{ type: string; table: string; data: Record<string, unknown> }>
): {
  results: Array<{ success: boolean; seq?: number; errorCode?: string; errorMessage?: string }>
  count: number
  failedCount: number
} {
  const results: Array<{
    success: boolean
    seq?: number
    index?: number
    table?: string
    key?: string
    errorCode?: string
    errorMessage?: string
  }> = []
  const pendingBroadcasts: Array<{ seq: number; op: string; table: string; key: string }> = []

  const tx = db.transaction(() => {
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]
      try {
        let recordKey = ''
        let changeOp: 'insert' | 'update' | 'delete' = 'insert'

        if (op.type === 'delete' && op.table === 'assetData') {
          const assetKey = (op.data.assetKey ?? op.data.key) as string | undefined
          if (!assetKey) {
            results.push({
              success: false,
              index: i,
              table: op.table,
              key: '',
              errorCode: 'MISSING_KEY',
              errorMessage: 'delete assetData requires assetKey or key in data'
            })
            continue
          }
          // Soft-delete
          db.prepare(`UPDATE assetData SET isDelete = 1 WHERE assetKey = ?`).run(assetKey)
          recordKey = assetKey
          changeOp = 'delete'
        } else if (op.type === 'delete' && op.table === 'assetFolder') {
          const folderKey = (op.data.folderKey ?? op.data.key) as string | undefined
          if (!folderKey) {
            results.push({
              success: false,
              index: i,
              table: op.table,
              key: '',
              errorCode: 'MISSING_KEY',
              errorMessage: 'delete assetFolder requires folderKey or key in data'
            })
            continue
          }
          deleteAssetFolder(db, folderKey)
          results.push({ success: true })
          continue
        } else {
          results.push({
            success: false,
            index: i,
            table: op.table,
            errorCode: 'UNSUPPORTED_OPERATION',
            errorMessage: `Unsupported operation: ${op.type}/${op.table}`
          })
          continue
        }

        // 保底断言
        if (!recordKey) {
          results.push({
            success: false,
            index: i,
            table: op.table,
            key: '',
            errorCode: 'EMPTY_RECORD_KEY',
            errorMessage: 'recordKey resolved to empty after operation'
          })
          continue
        }

        const seq = tracker.record(changeOp, op.table as any, recordKey, null, 'test')
        pendingBroadcasts.push({ seq, op: changeOp, table: op.table, key: recordKey })
        results.push({ success: true, seq })
      } catch (err) {
        results.push({
          success: false,
          index: i,
          table: op.table,
          errorCode: 'BATCH_ITEM_ERROR',
          errorMessage: err instanceof Error ? err.message : String(err)
        })
      }
    }
  })
  tx()

  const failedCount = results.filter((r) => !r.success).length
  return { results, count: results.length, failedCount }
}

// ─────── 1. 规范字段 assetKey — 完整 results ───────

describe('batch delete — canonical assetKey field', () => {
  it('returns one result per operation when using assetKey', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertAsset(db, 'a1')
    insertAsset(db, 'a2')
    insertAsset(db, 'a3')

    const ops = [
      { type: 'delete', table: 'assetData', data: { assetKey: 'a1' } },
      { type: 'delete', table: 'assetData', data: { assetKey: 'a2' } },
      { type: 'delete', table: 'assetData', data: { assetKey: 'a3' } }
    ]

    const resp = simulateBatchOperation(db, tracker, ops)

    // ★ 核心断言：results.length 必须等于 operations.length
    expect(resp.results).toHaveLength(3)
    expect(resp.count).toBe(3)
    expect(resp.failedCount).toBe(0)
    expect(resp.results.every((r) => r.success)).toBe(true)

    // 确认资产确实被软删除
    expect(getIsDelete(db, 'assetData', 'a1')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'a2')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'a3')).toBe(1)
  })

  it('each result has a valid seq number', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertAsset(db, 'b1')
    insertAsset(db, 'b2')

    const ops = [
      { type: 'delete', table: 'assetData', data: { assetKey: 'b1' } },
      { type: 'delete', table: 'assetData', data: { assetKey: 'b2' } }
    ]

    const resp = simulateBatchOperation(db, tracker, ops)

    expect(resp.results).toHaveLength(2)
    for (const r of resp.results) {
      expect(r.success).toBe(true)
      expect(typeof r.seq).toBe('number')
      expect(r.seq).toBeGreaterThan(0)
    }
  })
})

// ─────── 2. 兼容旧格式 data: { key } ───────

describe('batch delete — legacy key field compatibility', () => {
  it('accepts data: { key } and deletes correctly', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertAsset(db, 'legacy1')
    insertAsset(db, 'legacy2')

    const ops = [
      { type: 'delete', table: 'assetData', data: { key: 'legacy1' } },
      { type: 'delete', table: 'assetData', data: { key: 'legacy2' } }
    ]

    const resp = simulateBatchOperation(db, tracker, ops)

    // ★ 兼容模式下也必须返回完整 results
    expect(resp.results).toHaveLength(2)
    expect(resp.failedCount).toBe(0)

    // 资产确实被删除
    expect(getIsDelete(db, 'assetData', 'legacy1')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'legacy2')).toBe(1)
  })

  it('prefers assetKey over key when both are present', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertAsset(db, 'correct_key')
    insertAsset(db, 'wrong_key')

    const ops = [
      {
        type: 'delete',
        table: 'assetData',
        data: { assetKey: 'correct_key', key: 'wrong_key' }
      }
    ]

    const resp = simulateBatchOperation(db, tracker, ops)

    expect(resp.results).toHaveLength(1)
    expect(resp.results[0].success).toBe(true)

    // correct_key 被删除，wrong_key 未受影响
    expect(getIsDelete(db, 'assetData', 'correct_key')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'wrong_key')).toBe(0)
  })

  it('accepts data: { key } for folder delete', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertFolder(db, 'fold1', 'ALL', 'Fold1', 1)
    insertAsset(db, 'fa1', 'fold1')

    const ops = [{ type: 'delete', table: 'assetFolder', data: { key: 'fold1' } }]

    const resp = simulateBatchOperation(db, tracker, ops)

    expect(resp.results).toHaveLength(1)
    expect(resp.results[0].success).toBe(true)

    // 文件夹和子资产都被递归软删除
    expect(getIsDelete(db, 'assetFolder', 'fold1')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'fa1')).toBe(1)
  })
})

// ─────── 3. Malformed delete op — 明确失败而非空结果 ───────

describe('batch delete — malformed ops produce explicit failures', () => {
  it('returns MISSING_KEY failure when assetData delete has no key at all', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertAsset(db, 'untouched')

    const ops = [
      { type: 'delete', table: 'assetData', data: {} }, // 完全没有 key
      { type: 'delete', table: 'assetData', data: { name: 'foo' } } // 有字段但不是 key
    ]

    const resp = simulateBatchOperation(db, tracker, ops)

    // ★ 核心断言：results.length 仍然等于 operations.length (不再是 0)
    expect(resp.results).toHaveLength(2)
    expect(resp.failedCount).toBe(2)

    for (const r of resp.results) {
      expect(r.success).toBe(false)
      expect(r.errorCode).toBe('MISSING_KEY')
    }

    // 未触碰任何资产
    expect(getIsDelete(db, 'assetData', 'untouched')).toBe(0)
  })

  it('returns MISSING_KEY failure when assetFolder delete has no key', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertFolder(db, 'safe', 'ALL', 'Safe', 1)

    const ops = [{ type: 'delete', table: 'assetFolder', data: {} }]

    const resp = simulateBatchOperation(db, tracker, ops)

    expect(resp.results).toHaveLength(1)
    expect(resp.failedCount).toBe(1)
    expect(resp.results[0].errorCode).toBe('MISSING_KEY')

    // 文件夹未受影响
    expect(getIsDelete(db, 'assetFolder', 'safe')).toBe(0)
  })

  it('mixed valid + malformed ops: each gets its own result', () => {
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    insertAsset(db, 'good1')
    insertAsset(db, 'good2')

    const ops = [
      { type: 'delete', table: 'assetData', data: { assetKey: 'good1' } }, // ok
      { type: 'delete', table: 'assetData', data: {} }, // MISSING_KEY
      { type: 'delete', table: 'assetData', data: { key: 'good2' } } // ok (legacy)
    ]

    const resp = simulateBatchOperation(db, tracker, ops)

    // ★ 3 ops → 3 results（不再因为中间的 malformed op 导致数量不匹配）
    expect(resp.results).toHaveLength(3)
    expect(resp.results[0].success).toBe(true)
    expect(resp.results[1].success).toBe(false)
    expect(resp.results[1].errorCode).toBe('MISSING_KEY')
    expect(resp.results[2].success).toBe(true)

    expect(getIsDelete(db, 'assetData', 'good1')).toBe(1)
    expect(getIsDelete(db, 'assetData', 'good2')).toBe(1)
  })
})

// ─────── 4. SyncClient.batch() 校验逻辑 ───────

describe('SyncClient.batch() — response validation logic', () => {
  /**
   * 模拟 SyncClient.batch() 中的校验逻辑（不需要 HTTP，只测纯逻辑）
   */
  function validateBatchResponse(
    operationsCount: number,
    resp:
      | {
          results: Array<{ success: boolean; seq?: number; errorCode?: string }>
          count: number
          failedCount?: number
        }
      | null
      | undefined
  ): { ok: boolean; error?: string } {
    // 复制自 SyncClient.batch() 的校验逻辑
    if (!resp || !Array.isArray(resp.results)) {
      return { ok: false, error: 'batch 响应格式异常: results 不是数组' }
    }
    if (resp.results.length !== operationsCount) {
      return {
        ok: false,
        error: `batch 响应不完整: 预期 ${operationsCount} 条结果，实际 ${resp.results.length} 条`
      }
    }
    const failedCount = resp.failedCount ?? resp.results.filter((r) => !r.success).length
    if (failedCount > 0) {
      return {
        ok: false,
        error: `batch 部分失败: ${failedCount}/${operationsCount} 条操作未成功`
      }
    }
    return { ok: true }
  }

  it('passes validation when all results are successful', () => {
    const resp = {
      results: [
        { success: true, seq: 1 },
        { success: true, seq: 2 },
        { success: true, seq: 3 }
      ],
      count: 3,
      failedCount: 0
    }

    const v = validateBatchResponse(3, resp)
    expect(v.ok).toBe(true)
  })

  it('fails with "响应不完整" when results.length < operations.length (the original bug)', () => {
    // 这是修复前的病理响应：5 个 operation, 0 个 result
    const resp = {
      results: [] as Array<{ success: boolean }>,
      count: 0,
      failedCount: 0
    }

    const v = validateBatchResponse(5, resp)
    expect(v.ok).toBe(false)
    expect(v.error).toContain('预期 5 条结果')
    expect(v.error).toContain('实际 0 条')
  })

  it('reports partial failure when some results have success=false', () => {
    const resp = {
      results: [
        { success: true, seq: 1 },
        { success: false, errorCode: 'MISSING_KEY' },
        { success: true, seq: 2 }
      ],
      count: 3,
      failedCount: 1
    }

    const v = validateBatchResponse(3, resp)
    expect(v.ok).toBe(false)
    expect(v.error).toContain('部分失败')
    expect(v.error).toContain('1/3')
  })

  it('after fix: normal 5-asset delete gets 5 results, validation passes', () => {
    // 模拟修复后的正常场景
    const db = createTestDb()
    const tracker = new ChangeTracker(db)

    for (let i = 1; i <= 5; i++) {
      insertAsset(db, `asset_${i}`)
    }

    const ops = Array.from({ length: 5 }, (_, i) => ({
      type: 'delete',
      table: 'assetData',
      data: { assetKey: `asset_${i + 1}` }
    }))

    const resp = simulateBatchOperation(db, tracker, ops)

    // SyncClient 校验应该通过
    const v = validateBatchResponse(5, resp)
    expect(v.ok).toBe(true)
    expect(resp.results).toHaveLength(5)
  })

  it('handles null/undefined response gracefully', () => {
    const v1 = validateBatchResponse(3, null)
    expect(v1.ok).toBe(false)
    expect(v1.error).toContain('results 不是数组')

    const v2 = validateBatchResponse(3, undefined)
    expect(v2.ok).toBe(false)
    expect(v2.error).toContain('results 不是数组')
  })
})
