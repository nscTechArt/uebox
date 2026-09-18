import type Database from 'better-sqlite3'

import type { AssetServer } from './AssetServer'
import type { ChangeOp, TrackedTable } from './SyncProtocol'

/**
 * rowSnapshot — change_log 记录与 WebSocket 广播的**唯一入口**。
 *
 * 硬规则：写进 change_log / 广播出去的 payload 必须是「整行快照」。
 *
 * 为什么：对端应用变更时做的是 upsert，payload 里没出现的列会被写成
 * NULL / ''。于是主机上一次「只改了 folderKey」的拖动，会把所有客户端上这个
 * 资产的 assetName / filePath / imgLocalPath / tags / note 全部抹掉 ——
 * 资产变成一张打不开的空壳卡片。文件夹侧更严重：fatherKey 被抹掉之后
 * 整棵子树从目录树上消失。
 *
 * 为什么要做成「唯一入口」而不是在每个调用点补一行重读：
 * 那是纪律，而纪律已经被打破过四次（NetworkSyncBridge 两处、
 * networkVaultV2、crud）。取消调用点的自由度，以后新写的路径想广播就只能走
 * 这里，payload 由它内部产生，漏不掉。
 */

/** 表 → 主键列。只有登记在这里的表允许整行读取，表名不会来自外部输入 */
const KEY_COLUMN: Partial<Record<TrackedTable, 'assetKey' | 'folderKey'>> = {
  assetData: 'assetKey',
  assetFolder: 'folderKey'
}

/**
 * 读取整行快照。
 *
 * ⚠️ **不过滤 isDelete**。models 里的 getAssetDataByKey / getAssetFolderByKey
 * 都带 `AND isDelete = 0`，用它们重读会导致「软删除」和「回收站恢复」这两种
 * update 读不到行，于是又退回局部 payload —— AssetServer 里那个看起来「已经
 * 做对了」的重读先例，正是栽在这一点上。
 */
export function readRowSnapshot(
  db: Database.Database,
  tableName: TrackedTable,
  recordKey: string
): Record<string, unknown> | null {
  const keyColumn = KEY_COLUMN[tableName]
  if (!keyColumn || !recordKey) return null
  try {
    const row = db.prepare(`SELECT * FROM ${tableName} WHERE ${keyColumn} = ?`).get(recordKey) as
      | Record<string, unknown>
      | undefined
    return row ?? null
  } catch (err) {
    console.warn(`[rowSnapshot] 读取整行失败 ${tableName}/${recordKey}:`, err)
    return null
  }
}

export interface RecordAndBroadcastInput {
  server: AssetServer
  vaultId: string
  op: ChangeOp
  tableName: TrackedTable
  recordKey: string
  /** 整行读不到时的兜底 payload（行已被物理删除等）；仅 insert/update 使用 */
  fallbackPayload?: Record<string, unknown> | null
  /** 变更来源标识，默认 'server' */
  clientId?: string
  /** 显式指定 DB；缺省用 VaultEntry.db */
  db?: Database.Database
}

/**
 * 记录一条变更并广播 —— payload 永远是重新读出来的整行。
 *
 * @returns 新 seq；vault 未注册时返回 0（调用方据此判断「没记上」）
 */
export function recordAndBroadcast(input: RecordAndBroadcastInput): number {
  const { server, vaultId, op, tableName, recordKey } = input
  const entry = server.getVaultEntry(vaultId)
  if (!entry) return 0

  let payload: Record<string, unknown> | null = null
  if (op !== 'delete') {
    payload =
      readRowSnapshot(input.db ?? entry.db, tableName, recordKey) ?? input.fallbackPayload ?? null
  }

  const seq = entry.tracker.record(op, tableName, recordKey, payload, input.clientId ?? 'server')
  server.broadcastChange(vaultId, seq, op, tableName, recordKey, payload)
  return seq
}
