/**
 * folderDeleteHelper.ts — 文件夹递归删除的共享逻辑
 *
 * 被 networkVaultV2.ts (IPC server 分支) 和 AssetServer.ts (HTTP 路由) 共用，
 * 确保两条路径的子树 change-log 传播语义完全一致。
 */
import Database from 'better-sqlite3'
import { ChangeTracker } from './ChangeTracker'
import type { ChangeOp, TrackedTable } from './SyncProtocol'

/**
 * 检查指定 folderKey 是否存在且未被软删除。
 * 在执行删除操作前应先调用此函数，避免对已删除/不存在的 folder 重复生成 change-log。
 */
export function isFolderActive(db: Database.Database, folderKey: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM assetFolder WHERE folderKey = ? AND isDelete = 0`)
    .get(folderKey) as { '1': number } | undefined
  return !!row
}

/**
 * 递归收集**活动**文件夹子树中所有 folderKey 和 assetKey。
 * 只收集 isDelete = 0 的节点，确保：
 *  - 不会为已删除的 folder/asset 生成重复 delete change
 *  - 重复删除不再产出 change-log 条目
 *
 * 在实际删除之前调用，用于为每个受影响的记录生成 delete change。
 */
export function collectFolderSubtreeKeys(
  db: Database.Database,
  rootFolderKey: string
): { folderKeys: string[]; assetKeys: string[] } {
  const folderRows = db
    .prepare(
      `
    WITH RECURSIVE folder_tree AS (
      SELECT folderKey FROM assetFolder WHERE folderKey = ? AND isDelete = 0
      UNION ALL
      SELECT af.folderKey FROM assetFolder af
      JOIN folder_tree ft ON af.fatherKey = ft.folderKey
      WHERE af.isDelete = 0
    )
    SELECT folderKey FROM folder_tree
  `
    )
    .all(rootFolderKey) as { folderKey: string }[]
  const folderKeys = folderRows.map((r) => r.folderKey)

  if (folderKeys.length === 0) return { folderKeys: [], assetKeys: [] }

  // 收集这些文件夹下所有未删除的资产
  const BATCH = 500
  const assetKeys: string[] = []
  for (let i = 0; i < folderKeys.length; i += BATCH) {
    const batch = folderKeys.slice(i, i + BATCH)
    const ph = batch.map(() => '?').join(',')
    const assetRows = db
      .prepare(`SELECT assetKey FROM assetData WHERE folderKey IN (${ph}) AND isDelete = 0`)
      .all(...batch) as { assetKey: string }[]
    assetKeys.push(...assetRows.map((r) => r.assetKey))
  }

  return { folderKeys, assetKeys }
}

/**
 * 为文件夹子树的所有 folder/asset 批量写入 delete change-log 条目。
 * @returns 最后一条 change 的 seq，如果没有条目则返回 0
 */
export function recordSubtreeDeletionChanges(
  tracker: ChangeTracker,
  folderKeys: string[],
  assetKeys: string[],
  clientId = 'server'
): number {
  const entries: Array<{
    op: ChangeOp
    tableName: TrackedTable
    recordKey: string
    payload: null
    clientId: string
  }> = []

  for (const ak of assetKeys) {
    entries.push({ op: 'delete', tableName: 'assetData', recordKey: ak, payload: null, clientId })
  }
  for (const fk of folderKeys) {
    entries.push({ op: 'delete', tableName: 'assetFolder', recordKey: fk, payload: null, clientId })
  }

  if (entries.length === 0) return 0
  return tracker.recordBatch(entries)
}
