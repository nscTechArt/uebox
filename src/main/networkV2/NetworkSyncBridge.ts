/**
 * NetworkSyncBridge — 网络同步桥接层
 *
 * 在标准 db:* IPC 处理器中调用，实现"本地写入 + 远程推送"双写模式。
 *
 * 架构：
 *   Renderer → db:assetFolder:create → 本地 SQLite 写入
 *                                     → NetworkSyncBridge.pushFolderCreate()
 *                                       → VaultServiceManager.getClient()
 *                                         → SyncClient.createFolder() → NAS HTTP API
 *                                           → NAS DB 写入 + ChangeTracker + WebSocket 广播
 *                                             → 其他 Client 实时收到变更
 *
 * 设计原则：
 * 1. 本地写入是主路径，远程推送是异步附加操作
 * 2. 远程推送失败不影响本地操作（fail-open）
 * 3. NAS 定时扫描作为兜底，确保最终一致性
 * 4. Server 模式用户的写入也通过嵌入式 AssetServer 的 ChangeTracker 记录
 */

import { VaultServiceManager } from '../networkV2/VaultServiceManager'
import { getAppWindows } from '../appWindows'
import { recordAndBroadcast } from './rowSnapshot'
import type { SyncClient } from './SyncClient'
import type { ChangeOp, TrackedTable } from './SyncProtocol'
import { getDatabaseManager } from '../sqliteDataBase/index'
import { VaultType } from '../sqliteDataBase/VaultManager'

/** 广播资产变更到盒子自己的渲染窗口（供 Server 模式使用，不含 Agent 浏览器） */
function broadcastToRenderer(channel: string, payload: unknown): void {
  for (const win of getAppWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/**
 * 获取当前 vault 的网络同步上下文
 * @returns null 如果当前 vault 不是网络库或未连接
 */
interface NetworkContext {
  vaultId: string
  role: 'server' | 'client' | 'none'
  vaultType: string
}

function getNetworkContext(): NetworkContext | null {
  try {
    const databaseManager = getDatabaseManager()
    const currentVault = databaseManager.getCurrentVault()
    if (!currentVault || currentVault.vaultType !== VaultType.NETWORK) {
      return null
    }

    const vsm = VaultServiceManager.getInstance()
    const role = vsm.getRole(currentVault.id)
    if (role === 'none') return null

    return { vaultId: currentVault.id, role, vaultType: currentVault.vaultType }
  } catch {
    return null
  }
}

/**
 * 推送结果 —— 必须一路带回 IPC，让渲染层能诚实地告诉用户
 * 「这条改动还没上服务器」。
 *
 * 以前这些函数是 fire-and-forget：未连接直接 return，推送失败只 console.warn，
 * 调用方还统一加 `.catch(() => {})`。于是界面显示保存成功，而数据只在本地；
 * 下一次全量同步的 `DELETE FROM` 一来就永久消失。
 */
export interface PushResult {
  status: 'skipped' | 'pushed' | 'recorded' | 'queued' | 'failed'
  reason?: 'offline' | 'push_failed'
  /** 原始错误信息，仅供日志与「详情」展开 */
  error?: string
  /** queued 时本地待推送条数 */
  pendingCount?: number
}

/** 交互式写入的推送上限：超过就转入队列，不让 UI 卡在 30s 的写超时上 */
const PUSH_DEADLINE_MS = 5_000

function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PUSH_DEADLINE_EXCEEDED')), PUSH_DEADLINE_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Client 角色推送。
 *
 * 与旧实现的区别：
 * 1. 未连接时**不再直接 return**，而是入队 —— 离线写不再凭空消失；
 * 2. 失败不再只 console.warn，而是返回 queued + 原因码，由 IPC 透给渲染层；
 * 3. 超过 PUSH_DEADLINE_MS 也转入队列。重放是幂等的（update/delete 天然幂等，
 *    insert 冲突时在 sendOutboxEntry 里降级成 update）。
 */
async function pushViaClient(
  ctx: NetworkContext,
  op: ChangeOp,
  tableName: TrackedTable,
  recordKey: string,
  payload: Record<string, unknown> | null,
  send: (client: SyncClient) => Promise<unknown>
): Promise<PushResult> {
  const client = VaultServiceManager.getInstance().getClient(ctx.vaultId)
  if (!client) return { status: 'skipped' }

  if (!client.isConnected) {
    const pendingCount = client.enqueueOutbox({ op, tableName, recordKey, payload })
    console.warn(`[NetworkSyncBridge] 远端未连接，已入队: ${tableName}/${recordKey}`)
    return { status: 'queued', reason: 'offline', pendingCount }
  }

  try {
    await withDeadline(send(client))
    client.markLocalWrite(tableName, recordKey)
    return { status: 'pushed' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const pendingCount = client.enqueueOutbox({ op, tableName, recordKey, payload })
    console.warn(`[NetworkSyncBridge] 推送失败已入队 (${tableName}/${recordKey}):`, message)
    return { status: 'queued', reason: 'push_failed', error: message, pendingCount }
  }
}

// ─────────────────────── 文件夹同步 ───────────────────────

/** 推送文件夹创建到远端 */
export async function pushFolderCreate(folderData: Record<string, unknown>): Promise<PushResult> {
  const ctx = getNetworkContext()
  if (!ctx) return { status: 'skipped' }

  const vsm = VaultServiceManager.getInstance()

  if (ctx.role === 'client') {
    return pushViaClient(
      ctx,
      'insert',
      'assetFolder',
      folderData.folderKey as string,
      folderData,
      (client) => client.createFolder(folderData)
    )
  }

  if (ctx.role === 'server') {
    // Server 模式 → 通过嵌入式 AssetServer 的 ChangeTracker 记录 + 广播
    const server = vsm.getServer()
    if (server) {
      try {
        const entry = server.getVaultEntry(ctx.vaultId)
        if (entry) {
          const seq = entry.tracker.record(
            'insert',
            'assetFolder',
            folderData.folderKey as string,
            folderData,
            'local'
          )
          server.broadcastChange(
            ctx.vaultId,
            seq,
            'insert',
            'assetFolder',
            folderData.folderKey as string,
            folderData
          )
          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId: ctx.vaultId,
            op: 'insert',
            tableName: 'assetFolder',
            recordKey: folderData.folderKey
          })
          console.log('[NetworkSyncBridge] ✓ 文件夹已记录到 ChangeTracker:', folderData.folderKey)
        }
      } catch (err) {
        console.warn('[NetworkSyncBridge] 文件夹 ChangeTracker 记录失败:', err)
      }
    }
  }

  // server 分支走到这里说明已记录并广播（或服务未就绪，视为跳过）
  return { status: 'recorded' }
}

/** 推送文件夹更新到远端 */
export async function pushFolderUpdate(
  folderKey: string,
  updates: Record<string, unknown>
): Promise<PushResult> {
  const ctx = getNetworkContext()
  if (!ctx) return { status: 'skipped' }

  const vsm = VaultServiceManager.getInstance()

  if (ctx.role === 'client') {
    return pushViaClient(ctx, 'update', 'assetFolder', folderKey, updates, (client) =>
      client.updateFolder(folderKey, updates)
    )
  }

  if (ctx.role === 'server') {
    const server = vsm.getServer()
    if (server) {
      try {
        const entry = server.getVaultEntry(ctx.vaultId)
        if (entry) {
          // payload 由 recordAndBroadcast 内部**重读整行**产生 —— 直接把局部
          // updates 当整行发出去，会让对端 upsert 把没带的列写成 NULL/''，
          // 资产名/路径/缩略图/标签在所有客户端被抹掉。updates 只作兜底。
          const seq = recordAndBroadcast({
            server,
            vaultId: ctx.vaultId,
            op: 'update',
            tableName: 'assetFolder',
            recordKey: folderKey,
            fallbackPayload: updates,
            clientId: 'local',
            db: entry.db
          })
          if (seq === 0) return { status: 'skipped' }
          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId: ctx.vaultId,
            op: 'update',
            tableName: 'assetFolder',
            recordKey: folderKey
          })
        }
      } catch (err) {
        console.warn('[NetworkSyncBridge] 文件夹更新 ChangeTracker 失败:', err)
      }
    }
  }

  // server 分支走到这里说明已记录并广播（或服务未就绪，视为跳过）
  return { status: 'recorded' }
}

/** 推送文件夹删除到远端 */
export async function pushFolderDelete(folderKey: string): Promise<PushResult> {
  const ctx = getNetworkContext()
  if (!ctx) return { status: 'skipped' }

  const vsm = VaultServiceManager.getInstance()

  if (ctx.role === 'client') {
    return pushViaClient(ctx, 'delete', 'assetFolder', folderKey, null, (client) =>
      client.deleteFolder(folderKey)
    )
  }

  if (ctx.role === 'server') {
    const server = vsm.getServer()
    if (server) {
      try {
        const entry = server.getVaultEntry(ctx.vaultId)
        if (entry) {
          const seq = entry.tracker.record('delete', 'assetFolder', folderKey, null, 'local')
          server.broadcastChange(ctx.vaultId, seq, 'delete', 'assetFolder', folderKey, null)
          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId: ctx.vaultId,
            op: 'delete',
            tableName: 'assetFolder',
            recordKey: folderKey
          })
        }
      } catch (err) {
        console.warn('[NetworkSyncBridge] 文件夹删除 ChangeTracker 失败:', err)
      }
    }
  }

  // server 分支走到这里说明已记录并广播（或服务未就绪，视为跳过）
  return { status: 'recorded' }
}

// ─────────────────────── 资产同步 ───────────────────────

/** 推送资产创建到远端 */
export async function pushAssetCreate(assetData: Record<string, unknown>): Promise<PushResult> {
  const ctx = getNetworkContext()
  if (!ctx) return { status: 'skipped' }

  const vsm = VaultServiceManager.getInstance()

  if (ctx.role === 'client') {
    return pushViaClient(
      ctx,
      'insert',
      'assetData',
      assetData.assetKey as string,
      assetData,
      (client) => client.createAsset(assetData)
    )
  }

  if (ctx.role === 'server') {
    const server = vsm.getServer()
    if (server) {
      try {
        const entry = server.getVaultEntry(ctx.vaultId)
        if (entry) {
          const seq = entry.tracker.record(
            'insert',
            'assetData',
            assetData.assetKey as string,
            assetData,
            'local'
          )
          server.broadcastChange(
            ctx.vaultId,
            seq,
            'insert',
            'assetData',
            assetData.assetKey as string,
            assetData
          )
          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId: ctx.vaultId,
            op: 'insert',
            tableName: 'assetData',
            recordKey: assetData.assetKey
          })
        }
      } catch (err) {
        console.warn('[NetworkSyncBridge] 资产 ChangeTracker 记录失败:', err)
      }
    }
  }

  // server 分支走到这里说明已记录并广播（或服务未就绪，视为跳过）
  return { status: 'recorded' }
}

/** 推送资产更新到远端 */
export async function pushAssetUpdate(
  assetKey: string,
  updates: Record<string, unknown>
): Promise<PushResult> {
  const ctx = getNetworkContext()
  if (!ctx) return { status: 'skipped' }

  const vsm = VaultServiceManager.getInstance()

  if (ctx.role === 'client') {
    return pushViaClient(ctx, 'update', 'assetData', assetKey, updates, (client) =>
      client.updateAsset(assetKey, updates)
    )
  }

  if (ctx.role === 'server') {
    const server = vsm.getServer()
    if (server) {
      try {
        const entry = server.getVaultEntry(ctx.vaultId)
        if (entry) {
          // payload 由 recordAndBroadcast 内部**重读整行**产生 —— 直接把局部
          // updates 当整行发出去，会让对端 upsert 把没带的列写成 NULL/''，
          // 资产名/路径/缩略图/标签在所有客户端被抹掉。updates 只作兜底。
          const seq = recordAndBroadcast({
            server,
            vaultId: ctx.vaultId,
            op: 'update',
            tableName: 'assetData',
            recordKey: assetKey,
            fallbackPayload: updates,
            clientId: 'local',
            db: entry.db
          })
          if (seq === 0) return { status: 'skipped' }
          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId: ctx.vaultId,
            op: 'update',
            tableName: 'assetData',
            recordKey: assetKey
          })
        }
      } catch (err) {
        console.warn('[NetworkSyncBridge] 资产更新 ChangeTracker 失败:', err)
      }
    }
  }

  // server 分支走到这里说明已记录并广播（或服务未就绪，视为跳过）
  return { status: 'recorded' }
}

/** 推送资产删除到远端 */
export async function pushAssetDelete(assetKey: string): Promise<PushResult> {
  const ctx = getNetworkContext()
  if (!ctx) return { status: 'skipped' }

  const vsm = VaultServiceManager.getInstance()

  if (ctx.role === 'client') {
    return pushViaClient(ctx, 'delete', 'assetData', assetKey, null, (client) =>
      client.deleteAsset(assetKey)
    )
  }

  if (ctx.role === 'server') {
    const server = vsm.getServer()
    if (server) {
      try {
        const entry = server.getVaultEntry(ctx.vaultId)
        if (entry) {
          const seq = entry.tracker.record('delete', 'assetData', assetKey, null, 'local')
          server.broadcastChange(ctx.vaultId, seq, 'delete', 'assetData', assetKey, null)
          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId: ctx.vaultId,
            op: 'delete',
            tableName: 'assetData',
            recordKey: assetKey
          })
        }
      } catch (err) {
        console.warn('[NetworkSyncBridge] 资产删除 ChangeTracker 失败:', err)
      }
    }
  }

  // server 分支走到这里说明已记录并广播（或服务未就绪，视为跳过）
  return { status: 'recorded' }
}

// ─────────────────────── 批量操作 ───────────────────────

export interface BatchOperation {
  type: ChangeOp
  table: TrackedTable
  data: Record<string, unknown>
}

function recordKeyOf(op: BatchOperation): string {
  return String((op.table === 'assetData' ? op.data.assetKey : op.data.folderKey) ?? '')
}

/**
 * 推送批量操作到远端。
 *
 * 语义与单条推送对齐（以前不是）：
 *  · client 离线或推送失败 → **逐条入队**，而不是抛异常让调用方 warn 掉。
 *    以前那样等于多选删除在客户端上只删本地，同事全然不知，
 *    下一次对账再把服务端还活着的行盖回来 —— 表现为「删了又回来」。
 *  · server 角色 → 走 recordAndBroadcast **重读整行**。以前直接把调用方给的
 *    局部 data 广播出去，对端 upsert 会把没带的列写成 NULL/''，
 *    正是单条路径上已经修过的那个「局部更新当整行广播」。
 */
export async function pushBatchOperations(operations: BatchOperation[]): Promise<PushResult> {
  const ctx = getNetworkContext()
  if (!ctx || operations.length === 0) return { status: 'skipped' }

  const vsm = VaultServiceManager.getInstance()

  if (ctx.role === 'client') {
    const client = vsm.getClient(ctx.vaultId)
    if (!client) return { status: 'skipped' }

    const enqueueAll = (): number => {
      let pendingCount = 0
      for (const op of operations) {
        const recordKey = recordKeyOf(op)
        if (!recordKey) continue
        pendingCount = client.enqueueOutbox({
          op: op.type,
          tableName: op.table,
          recordKey,
          payload: op.type === 'delete' ? null : op.data
        })
      }
      return pendingCount
    }

    if (!client.isConnected) {
      const pendingCount = enqueueAll()
      console.warn(`[NetworkSyncBridge] 远端未连接，批量操作已入队: ${operations.length} 条`)
      return { status: 'queued', reason: 'offline', pendingCount }
    }

    try {
      await withDeadline(client.batch(operations))
      for (const op of operations) {
        const recordKey = recordKeyOf(op)
        if (recordKey) client.markLocalWrite(op.table, recordKey)
      }
      console.log('[NetworkSyncBridge] ✓ 批量操作已推送:', operations.length, '条')
      return { status: 'pushed' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const pendingCount = enqueueAll()
      console.warn('[NetworkSyncBridge] 批量推送失败已入队:', message)
      return { status: 'queued', reason: 'push_failed', error: message, pendingCount }
    }
  }

  if (ctx.role === 'server') {
    const server = vsm.getServer()
    const entry = server?.getVaultEntry(ctx.vaultId)
    if (!server || !entry) return { status: 'skipped' }

    for (const op of operations) {
      try {
        const recordKey = recordKeyOf(op)
        if (!recordKey) continue
        recordAndBroadcast({
          server,
          vaultId: ctx.vaultId,
          op: op.type,
          tableName: op.table,
          recordKey,
          fallbackPayload: op.type === 'delete' ? null : op.data,
          clientId: 'local',
          db: entry.db
        })
      } catch (err) {
        console.warn('[NetworkSyncBridge] 批量操作 ChangeTracker 失败:', err)
      }
    }
    broadcastToRenderer('asset:changed', {
      source: 'networkV2',
      vaultId: ctx.vaultId,
      op: 'batch',
      tableName: 'mixed',
      recordKey: `batch_${operations.length}`
    })
  }

  return { status: 'recorded' }
}
