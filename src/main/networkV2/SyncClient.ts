/**
 * SyncClient — Client 端同步客户端
 *
 * 团队成员的 Electron App 使用此模块连接到资产机 Server，负责：
 * 1. 读取 `.vault` 服务发现文件获取 Server 地址
 * 2. 首次连接时全量拉取数据到本地 SQLite 缓存
 * 3. 增量拉取 change_log 补齐差异
 * 4. WebSocket 长连接接收实时变更推送
 * 5. 指数退避重连
 * 6. 定时校验 checksum
 */
import { WebSocket } from 'ws'
import * as http from 'http'
import * as https from 'https'
import { createReadStream, statSync } from 'fs'
import Database from 'better-sqlite3'
import { EventEmitter } from 'events'
import type {
  ChangeLogEntry,
  ChangeOp,
  SyncResponse,
  ChecksumResponse,
  TrackedTable,
  WsServerMessage,
  ApiResponse
} from './SyncProtocol'

// ─────────────────────────── 配置 ───────────────────────────

export interface SyncClientConfig {
  /** Server HTTP base URL, e.g. http://192.168.1.100:18900 */
  serverUrl: string
  /** Vault ID */
  vaultId: string
  /** 本客户端唯一标识 */
  clientId: string
  /** 本机 hostname */
  hostname: string
  /** 校验间隔（ms），默认 30 分钟 */
  checksumIntervalMs?: number
  /** HTTP 请求超时（ms） */
  httpTimeoutMs?: number
  /** Standalone server admin KEY used by temporary KEY-only write mode. */
  apiKey?: string
}

type SyncClientRuntimeConfig = SyncClientConfig &
  Required<Pick<SyncClientConfig, 'checksumIntervalMs' | 'httpTimeoutMs'>>

// ─────────────────────────── 事件 ───────────────────────────

export interface SyncClientEvents {
  /** 连接状态变化 */
  status: (status: 'connected' | 'disconnected' | 'syncing' | 'error') => void
  /** 收到实时变更 */
  change: (entry: {
    seq: number
    op: string
    tableName: string
    recordKey: string
    payload: string | null
  }) => void
  /** 同步进度 */
  'sync-progress': (stats: { phase: string; current: number; total: number }) => void
  /** 全量同步完成 */
  'full-sync-done': (stats: { assets: number; folders: number }) => void
  /** 增量同步完成 */
  'incremental-sync-done': (stats: { applied: number }) => void
  /** 错误 */
  error: (err: Error) => void
  /** 服务端要求访问码，或访问码不正确 —— UI 应提示用户填码 */
  'auth-required': (info: { statusCode: number; errorCode?: string }) => void
}

/** UI 上「要填码」和「码填错了」是两句不同的话，别混成一句「同步失败」 */
export type AuthRequiredStatus = 'authRequired' | 'authInvalid'

export function authStatusOf(info: { statusCode: number; errorCode?: string }): AuthRequiredStatus {
  if (info.errorCode === 'AUTH_INVALID') return 'authInvalid'
  if (info.errorCode === 'AUTH_REQUIRED') return 'authRequired'
  // 403 = 码认出来了但权限不够，不是「没填码」
  return info.statusCode === 403 ? 'authInvalid' : 'authRequired'
}

interface FullDataPageResponse {
  rows: Record<string, unknown>[]
  type: 'folders' | 'assets'
  cursor: number
  hasMore: boolean
  total: number
  snapshotMaxRowid: number
  snapshotSeq: number
}

// ─────────────────────── 局部安全写入的元数据 ───────────────────────

/**
 * 允许被同步写入的列白名单。
 *
 * payload 来自网络，`Object.keys()` 直接拼进 SQL 是注入面，必须走白名单。
 */
const ASSET_SYNC_COLUMNS = [
  'assetKey',
  'folderKey',
  'assetName',
  'filePath',
  'fileSize',
  'fileExtension',
  'modifiedTime',
  'processorType',
  'assetType',
  'engineVersion',
  'isDelete',
  // 删除时间：不同步的话，别的机器上「最近删除」只能退回 updated_at 排序，
  // 而「恢复这一次删的东西」也认不出是哪一批（见 models/assetData.deletionStamp）
  'deletedAt',
  'isDependency',
  'classKey',
  'name',
  'originPath',
  'ext',
  'folderName',
  'softPath',
  'assetClass',
  'className',
  'classNameCn',
  'classColor',
  'imports',
  'imgLocalPath',
  'customPoster',
  'size',
  'assetConfig',
  'assetConfigPath',
  'fileMd5',
  'note',
  'tags',
  'color',
  'pluginInfo'
] as const

/** 被 stop() 换掉之后主动放弃全量同步用的哨兵 —— 不是故障 */
const SYNC_ABORTED_BY_STOP = 'SYNC_ABORTED_BY_STOP'

const FOLDER_SYNC_COLUMNS = [
  'folderKey',
  'fatherKey',
  'img',
  'type',
  'folderName',
  'fullPath',
  'pathArray',
  'depth',
  'ancestorKeys',
  'color',
  'isDelete',
  'deletedAt'
] as const

/**
 * NOT NULL 列 + 身份列：payload 给了 null / '' 时**不覆盖**。
 *
 * 既防 NOT NULL 约束炸掉整个事务，也顺手挡住旧版本 Client/Server 用 '' 填空
 * 之后回传导致的二次抹名。
 */
const PROTECTED_SYNC_COLUMNS: Record<'assetData' | 'assetFolder', ReadonlySet<string>> = {
  assetData: new Set(['assetKey', 'folderKey', 'assetName', 'isDelete', 'isDependency']),
  assetFolder: new Set(['folderKey', 'type', 'folderName', 'isDelete'])
}

interface SyncTableSpec {
  keyColumn: 'assetKey' | 'folderKey'
  /** 只有这些列都「有实值」时，才允许拿 payload 凭空建行 */
  requiredColumns: readonly string[]
  /** 建行时补齐的默认值 */
  insertDefaults: Record<string, unknown>
}

const TABLE_SPEC: Record<'assetData' | 'assetFolder', SyncTableSpec> = {
  assetData: {
    keyColumn: 'assetKey',
    requiredColumns: ['assetKey', 'folderKey', 'assetName'],
    insertDefaults: { isDelete: 0, isDependency: 0 }
  },
  assetFolder: {
    keyColumn: 'folderKey',
    requiredColumns: ['folderKey', 'type', 'folderName'],
    insertDefaults: { type: 'folder', depth: 0, isDelete: 0 }
  }
}

// ─────────────────────── 待推送队列的类型 ───────────────────────

interface OutboxRow {
  id: number
  op: ChangeOp
  table_name: TrackedTable
  record_key: string
  payload: string | null
  /** sending = 正在推送。这个状态挡住 enqueueOutbox 往在途行上合并新改动 */
  state: 'pending' | 'sending' | 'dead'
  attempts: number
}

export interface OutboxEntryInput {
  op: ChangeOp
  tableName: TrackedTable
  recordKey: string
  /**
   * insert 存整行；update 存**增量列**。
   *
   * 为什么 update 不存整行：服务端做的是局部 UPDATE，存整行反而会把同事在
   * 这段时间里改的字段一起盖回去。
   */
  payload: Record<string, unknown> | null
}

/** 统一规整绑定值，避免 undefined / Date / 对象直接进 better-sqlite3 */
function normalizeBindValue(value: unknown): number | string | bigint | Buffer | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return value as number | string | bigint | Buffer
}

// ─────────────────────────── Client ───────────────────────────

export class SyncClient extends EventEmitter {
  private config: SyncClientRuntimeConfig
  private localDb: Database.Database
  private ws: WebSocket | null = null
  private lastSeq = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private checksumTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempt = 0
  private _isConnected = false
  /** 上一次失败是因为访问码不对/缺失 —— 据此把重连退避拉长到固定 60s */
  private _authFailed = false
  private _isStopped = false
  private pullChangesPromise: Promise<void> | null = null

  // 预编译 SQL
  private stmtDeleteAsset!: Database.Statement
  private stmtDeleteFolder!: Database.Statement
  private stmtGetSyncState!: Database.Statement
  private stmtSetSyncState!: Database.Statement

  /** 实际存在于本地库的同步列（白名单 ∩ 真实表结构） */
  private assetColumns: string[] = []
  private folderColumns: string[] = []
  /** 动态 SQL 的预编译缓存（列组合有限，命中率极高） */
  private stmtCache = new Map<string, Database.Statement>()
  /** 本轮遇到的「本地没有这行」的局部更新，事务提交后集中修复 */
  private missingRowBuffer: Array<{ tableName: 'assetData' | 'assetFolder'; recordKey: string }> =
    []

  private static readonly OUTBOX_MAX_ATTEMPTS = 8
  private flushPromise: Promise<{ flushed: number; failed: number }> | null = null
  private outboxTimer: ReturnType<typeof setInterval> | null = null
  /** 最近一次本地写的时间戳，用于对账时保护「快照拍完之后才写进去」的行 */
  private recentWrites = new Map<string, number>()
  /** 连续多少次校验不一致才允许升级到对账同步 */
  private static readonly CHECKSUM_MISMATCH_THRESHOLD = 2
  private checksumMismatchStreak = 0
  private static readonly REPAIR_DEBOUNCE_MS = 3_000
  private pendingRepairs = new Map<
    string,
    { tableName: 'assetData' | 'assetFolder'; recordKey: string }
  >()
  private repairTimer: ReturnType<typeof setTimeout> | null = null

  constructor(localDb: Database.Database, config: SyncClientConfig) {
    super()
    this.localDb = localDb
    this.config = {
      checksumIntervalMs: 30 * 60 * 1000,
      httpTimeoutMs: 10_000,
      ...config
    }
    this.initSyncStateTable()
    this.initOutboxTable()
    this.resolveSyncColumns()
    this.prepareStatements()
    this.loadSyncState()
  }

  // ─────────────────────── 待推送队列（BUG B） ───────────────────────

  /**
   * 入队一条待推送变更，同一条记录的连续变更会合并。
   *
   * @returns 入队后的待推送条数（供 UI 显示「N 条待同步」）
   */
  enqueueOutbox(entry: OutboxEntryInput): number {
    const scope = this.getSyncStateKey()
    const now = Date.now()

    this.localDb.transaction(() => {
      const existing = this.localDb
        .prepare(
          `SELECT id, op, payload FROM sync_outbox
           WHERE scope = ? AND table_name = ? AND record_key = ? AND state = 'pending'
           ORDER BY id`
        )
        .all(scope, entry.tableName, entry.recordKey) as Array<{
        id: number
        op: ChangeOp
        payload: string | null
      }>

      const drop = this.localDb.prepare(`DELETE FROM sync_outbox WHERE id = ?`)
      const insert = this.localDb.prepare(
        `INSERT INTO sync_outbox (scope, op, table_name, record_key, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )

      if (entry.op === 'delete') {
        // 只有当这条记录排队的**第一个**操作就是 insert，服务端才真的不知道它。
        // 用 some() 判断会误伤 [delete, insert] 这种链：头上那个 delete 对应的是
        // 服务端**已有**的记录，整链丢弃 = 服务端那行永远删不掉，
        // 下一次对账再把它 upsert 回来 —— 表现为「删了又回来」。
        const serverNeverKnew = existing[0]?.op === 'insert'
        for (const row of existing) drop.run(row.id)
        if (serverNeverKnew) return
        insert.run(scope, 'delete', entry.tableName, entry.recordKey, null, now, now)
        return
      }

      const head = existing[0]
      if (head && head.op !== 'delete') {
        // 合并进已有条目并保留原 op（insert 优先），避免「先 update 后 insert」的错序
        const merged = {
          ...(head.payload ? (JSON.parse(head.payload) as Record<string, unknown>) : {}),
          ...(entry.payload ?? {})
        }
        for (const row of existing.slice(1)) drop.run(row.id)
        this.localDb
          .prepare(`UPDATE sync_outbox SET payload = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(merged), now, head.id)
        return
      }

      // head 是 delete（本地删了又重建）→ 追加，保持 delete → insert 的因果顺序
      insert.run(
        scope,
        entry.op,
        entry.tableName,
        entry.recordKey,
        entry.payload ? JSON.stringify(entry.payload) : null,
        now,
        now
      )
    })()

    this.markLocalWrite(entry.tableName, entry.recordKey)
    return this.pendingPushCount
  }

  /** 待推送条数（供 UI 显示「N 条待同步」）。在途的那一行也还没落到服务端，一并算上 */
  get pendingPushCount(): number {
    return (
      this.localDb
        .prepare(
          `SELECT COUNT(*) AS c FROM sync_outbox
           WHERE scope = ? AND state IN ('pending', 'sending')`
        )
        .get(this.getSyncStateKey()) as { c: number }
    ).c
  }

  /**
   * 某张表里「有未推送变更」的 recordKey。
   *
   * 故意**不过滤 state**：死信行同样代表本地独有数据，对账时必须一并保护。
   */
  private getPendingRecordKeys(tableName: TrackedTable, op?: ChangeOp): Set<string> {
    const sql = op
      ? `SELECT DISTINCT record_key AS recordKey FROM sync_outbox
         WHERE scope = ? AND table_name = ? AND op = ?`
      : `SELECT DISTINCT record_key AS recordKey FROM sync_outbox
         WHERE scope = ? AND table_name = ?`
    const args = op ? [this.getSyncStateKey(), tableName, op] : [this.getSyncStateKey(), tableName]
    const rows = this.prepareCached(sql).all(...args) as { recordKey: string }[]
    return new Set(rows.map((row) => row.recordKey))
  }

  /** 记一笔本地写，用于保护「快照拍完之后才写进去」的行 */
  markLocalWrite(tableName: TrackedTable, recordKey: string): void {
    const now = Date.now()
    this.recentWrites.set(`${tableName}:${recordKey}`, now)
    if (this.recentWrites.size > 5000) {
      for (const [key, ts] of this.recentWrites) {
        if (now - ts > 10 * 60_000) this.recentWrites.delete(key)
      }
    }
  }

  /** 4xx（除 401/403/408/429）视为不可重试：重放多少次都不会成功 */
  private static isNonRetryable(err: unknown): boolean {
    const statusCode =
      typeof err === 'object' && err && 'statusCode' in err
        ? Number((err as { statusCode?: unknown }).statusCode)
        : NaN
    if (!Number.isFinite(statusCode)) return false
    if (statusCode === 401 || statusCode === 403 || statusCode === 408 || statusCode === 429) {
      return false
    }
    return statusCode >= 400 && statusCode < 500
  }

  private static isConflictError(err: unknown): boolean {
    const statusCode =
      typeof err === 'object' && err && 'statusCode' in err
        ? Number((err as { statusCode?: unknown }).statusCode)
        : NaN
    if (statusCode === 409) return true
    const message = err instanceof Error ? err.message : String(err)
    return /UNIQUE constraint failed|already exists/i.test(message)
  }

  /** 把待推送队列刷到 Server；失败的留在队列里，不丢 */
  async flushOutbox(): Promise<{ flushed: number; failed: number }> {
    if (this.flushPromise) return this.flushPromise
    this.flushPromise = this.doFlushOutbox()
    try {
      return await this.flushPromise
    } finally {
      this.flushPromise = null
    }
  }

  private async doFlushOutbox(): Promise<{ flushed: number; failed: number }> {
    let flushed = 0
    let failed = 0

    for (;;) {
      if (this._isStopped) break
      const row = this.localDb
        .prepare(
          `SELECT id, op, table_name, record_key, payload, state, attempts
           FROM sync_outbox WHERE scope = ? AND state = 'pending' ORDER BY id LIMIT 1`
        )
        .get(this.getSyncStateKey()) as OutboxRow | undefined
      if (!row) break

      // 发送前把这一行标成在途。
      //
      // 关键在于 enqueueOutbox 只会合并 state='pending' 的行：不打这个标记的话，
      // 慢推送（写超时上限 30s）在途中用户又改了同一条记录，新改动会被合并进
      // **同一个 id**，然后推送成功后的 `DELETE WHERE id = ?` 把它一起删掉 ——
      // 这次编辑永远上不了服务器，下一次对账还会被服务端的旧值盖回来。
      // 标成在途之后，并发的编辑会另起一行，排在这一行后面推。
      this.localDb
        .prepare(`UPDATE sync_outbox SET state = 'sending', updated_at = ? WHERE id = ?`)
        .run(Date.now(), row.id)

      try {
        await this.sendOutboxEntry(row)
        this.localDb.prepare(`DELETE FROM sync_outbox WHERE id = ?`).run(row.id)
        flushed += 1
      } catch (err) {
        failed += 1
        const message = err instanceof Error ? err.message : String(err)
        const attempts = row.attempts + 1
        const dead = attempts >= SyncClient.OUTBOX_MAX_ATTEMPTS || SyncClient.isNonRetryable(err)
        this.localDb
          .prepare(
            `UPDATE sync_outbox SET attempts = ?, last_error = ?, state = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(attempts, message, dead ? 'dead' : 'pending', Date.now(), row.id)

        if (dead) {
          // 死信不丢、不删，只是不再挡住队列；它仍然算「本地独有数据」，
          // 对账时照样受保护（getPendingRecordKeys 故意不过滤 state）
          this.emit('outbox-blocked', {
            op: row.op,
            tableName: row.table_name,
            recordKey: row.record_key,
            error: message
          })
          continue
        }
        // 可重试的失败 → 停在这里，保住因果顺序（insert 必须先于 update 落地）
        break
      }
    }

    if (flushed > 0) {
      console.log(`[SyncClient] 待推送队列已刷出 ${flushed} 条，剩余 ${this.pendingPushCount} 条`)
    }
    return { flushed, failed }
  }

  private async sendOutboxEntry(row: OutboxRow): Promise<void> {
    const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {}

    if (row.table_name === 'assetData') {
      if (row.op === 'delete') {
        await this.deleteAsset(row.record_key)
        return
      }
      if (row.op === 'insert') {
        try {
          await this.createAsset(payload)
        } catch (err) {
          // 推送超时后本地重排了，但服务端其实已经建好 → 降级成 update，避免死信
          if (!SyncClient.isConflictError(err)) throw err
          await this.updateAsset(row.record_key, payload)
        }
        return
      }
      await this.updateAsset(row.record_key, payload)
      return
    }

    if (row.op === 'delete') {
      await this.deleteFolder(row.record_key)
      return
    }
    if (row.op === 'insert') {
      try {
        await this.createFolder(payload)
      } catch (err) {
        if (!SyncClient.isConflictError(err)) throw err
        await this.updateFolder(row.record_key, payload)
      }
      return
    }
    await this.updateFolder(row.record_key, payload)
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  /** 远端 Vault ID（SyncClient 连接的 Server 端 vaultId） */
  get remoteVaultId(): string {
    return this.config.vaultId
  }

  get serverUrl(): string {
    return this.config.serverUrl
  }

  setStandaloneApiKey(apiKey?: string): void {
    this.config.apiKey = apiKey?.trim() || undefined
    // 用户刚填对码时立刻退出「认证失败」退避，不用等 60s
    this._authFailed = false
  }

  // ─────────────────────────── 初始化 ───────────────────────────

  private initSyncStateTable(): void {
    this.localDb.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        vault_id    TEXT PRIMARY KEY,
        last_seq    INTEGER DEFAULT 0,
        last_sync   INTEGER DEFAULT 0
      );
    `)
  }

  /**
   * 待推送队列。
   *
   * 建在 SQLite 里而不是 JSON 文件：进程崩溃 / 多写并发下 JSON 文件不安全，
   * 而 better-sqlite3 本来就在依赖里。
   *
   * （v1 的 smb/NetworkVaultSync 里有一套 pending_queue.json，但它属于
   * Manifest/Journal 体系，与 networkV2 的 change_log + seq 模型不兼容，
   * 而且全仓库没有任何调用点 —— 是死代码，不复活。）
   */
  private initOutboxTable(): void {
    this.localDb.exec(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        scope       TEXT    NOT NULL,
        op          TEXT    NOT NULL,
        table_name  TEXT    NOT NULL,
        record_key  TEXT    NOT NULL,
        payload     TEXT,
        state       TEXT    NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_scope ON sync_outbox(scope, state, id);
      CREATE INDEX IF NOT EXISTS idx_outbox_record ON sync_outbox(scope, table_name, record_key);
    `)

    this.recoverInFlightOutbox()
  }

  /**
   * 把「在途」的行放回队列。
   *
   * 进程在推送途中被杀掉时，那一行会永远停在 'sending' 上，谁也不会再碰它 ——
   * 等于一条静默丢失的本地改动。重推可能把同一条送两次，但推送本来就是
   * 至少一次语义（冲突会降级成 update），重推是安全的。
   */
  private recoverInFlightOutbox(): void {
    this.localDb.prepare(`UPDATE sync_outbox SET state = 'pending' WHERE state = 'sending'`).run()
  }

  private prepareStatements(): void {
    // 注意：这里**不再**有「写所有列」的整行 UPSERT。
    // 那种语句配上局部 payload，会把 payload 里没出现的列全部写成 NULL/''，
    // 于是主机一次「只改 folderKey」的拖动就能抹掉所有客户端上这个资产的
    // 名字、路径、缩略图、标签。改用 applyRowUpsert 按 payload 实际出现的键
    // 动态构造 UPDATE / INSERT，见下方。

    /**
     * deletedAt 一并写上：「最近删除」按它排序，不写的话对端删的东西
     * 在这台机器上排不出「最近」（退回 updated_at 只是兜底）。
     *
     * 但**不能写死**。这两句原来是硬拼 `deletedAt` 的，碰上还没补这一列的老保管库，
     * better-sqlite3 在 prepare 当场就抛 `no such column: deletedAt` —— 而这里是
     * 构造函数，异常一路冒到 startV2NetworkService，结果是用户升级后
     * **所有网络库全部离线**。列迁移已经补进 VaultManager 了，这里再挡一道：
     * 少一列最多是排序退回 updated_at，不该让整个库连不上。
     */
    const softDelete = (table: 'assetData' | 'assetFolder', keyColumn: string): string => {
      const columns = table === 'assetData' ? this.assetColumns : this.folderColumns
      const stampDeletedAt = columns.includes('deletedAt')
        ? `deletedAt = COALESCE(deletedAt, datetime('now','localtime')),`
        : ''
      return `
        UPDATE ${table}
        SET isDelete = 1, ${stampDeletedAt}
            updated_at = datetime('now','localtime')
        WHERE ${keyColumn} = ?
      `
    }

    this.stmtDeleteAsset = this.localDb.prepare(softDelete('assetData', 'assetKey'))
    this.stmtDeleteFolder = this.localDb.prepare(softDelete('assetFolder', 'folderKey'))

    this.stmtGetSyncState = this.localDb.prepare(`
      SELECT last_seq FROM sync_state WHERE vault_id = ?
    `)

    this.stmtSetSyncState = this.localDb.prepare(`
      INSERT INTO sync_state (vault_id, last_seq, last_sync) VALUES (?, ?, ?)
      ON CONFLICT(vault_id) DO UPDATE SET last_seq = excluded.last_seq, last_sync = excluded.last_sync
    `)
  }

  private loadSyncState(): void {
    const row = this.stmtGetSyncState.get(this.getSyncStateKey()) as
      | { last_seq: number }
      | undefined
    this.lastSeq = row?.last_seq || 0
  }

  /** 写入指定 seq 到 sync_state 表（用于事务内部，此时 this.lastSeq 尚未更新） */
  private saveSyncStateWithSeq(seq: number): void {
    this.stmtSetSyncState.run(this.getSyncStateKey(), seq, Date.now())
  }

  private getSyncStateKey(): string {
    return this.config.vaultId
  }

  // ─────────────────────────── 连接 ───────────────────────────

  /** 启动同步 — 增量拉取 + WS 实时连接 */
  async start(): Promise<void> {
    this._isStopped = false
    this.emit('status', 'syncing')
    // stop() 可能正好卡在某一行的推送途中，那行会留在 'sending' 上。
    // 重新 start 时没人会再碰它 —— 除非在这里把它放回队列。
    this.recoverInFlightOutbox()

    try {
      // 0. 先把上次离线期间攒下的本地改动推上去，再拉 —— 否则对账会看到
      //    「本地多出一批服务端没有的行」，白白进入保护/软删的判断
      await this.flushOutbox().catch(() => undefined)

      // 1. 增量或全量同步
      await this.pullChanges()

      // 如果在 pullChanges 期间被 stop()，不继续建连和定时器
      if (this._isStopped) return

      // 2. 建立 WS 连接
      this.connectWs()

      // 3. 定时校验
      this.checksumTimer = setInterval(() => {
        if (this._isStopped) return // 二次防护
        this.verifyChecksum().catch((err) => {
          console.warn('[SyncClient] 校验失败:', err.message)
        })
      }, this.config.checksumIntervalMs)

      // 4. 队列非空时定期重试（队列空时几乎零成本）
      this.outboxTimer = setInterval(() => {
        if (this._isStopped || !this._isConnected) return
        if (this.pendingPushCount === 0) return
        this.flushOutbox().catch(() => undefined)
      }, 60_000)
    } catch (err) {
      if (this._isStopped) return // 被 stop() 后不再触发重连
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      this.emit('status', 'error')
      this.scheduleReconnect()
    }
  }

  /** 停止同步 */
  stop(): void {
    this._isStopped = true
    if (this.ws) {
      this.ws.close(1000, 'client_stop')
      this.ws = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.checksumTimer) {
      clearInterval(this.checksumTimer)
      this.checksumTimer = null
    }
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer)
      this.outboxTimer = null
    }
    if (this.repairTimer) {
      clearTimeout(this.repairTimer)
      this.repairTimer = null
    }
    this.reconnectAttempt = 0
    this._isConnected = false
    this.emit('status', 'disconnected')
  }

  // ─────────────────────────── 数据同步 ───────────────────────────

  async pullChanges(): Promise<void> {
    if (this.pullChangesPromise) {
      return this.pullChangesPromise
    }

    this.pullChangesPromise = this.doPullChanges()
    try {
      await this.pullChangesPromise
    } catch (err) {
      // 自己被 stop() 换掉而主动放弃的，不是故障，别往上抛成「同步失败」
      if (err instanceof Error && err.message === SYNC_ABORTED_BY_STOP) {
        console.log('[SyncClient] 全量同步已被 stop() 中止（这个客户端已经被换掉）')
        return
      }
      throw err
    } finally {
      this.pullChangesPromise = null
    }
  }

  private async doPullChanges(): Promise<void> {
    // 首次同步 (lastSeq=0) 时，直接走全量同步
    // 全量同步从 assetData/assetFolder 表直接读取，不依赖 change_log
    // 这解决了 change_log 为空（如文件扫描直接写入 SQLite）的情况
    if (this.lastSeq === 0) {
      console.log('[SyncClient] 首次同步 (lastSeq=0)，执行全量同步')
      await this.reconcileSync()
      return
    }

    const resp = await this.httpGet<SyncResponse>(
      `/api/vaults/${this.config.vaultId}/sync?since=${this.lastSeq}`
    )

    if (resp.fullSyncRequired) {
      console.log('[SyncClient] 需要全量同步 (change_log 已过期)')
      await this.reconcileSync()
      return
    }

    if (resp.changes.length > 0) {
      try {
        this.applyChanges(resp.changes)
      } catch (err) {
        console.warn('[SyncClient] 增量同步应用失败，回退到全量同步:', err)
        await this.reconcileSync()
        return
      }
      console.log(
        `[SyncClient] 增量同步：应用了 ${resp.changes.length} 条变更 (seq: ${this.lastSeq})`
      )
      this.emit('incremental-sync-done', { applied: resp.changes.length })
    }
  }

  /**
   * 全量同步 — 原子化实现
   *
   * 1. 先从服务端拉取全部数据到内存（folders + assets）
   *    如果任何 HTTP 请求失败，异常直接向上抛，本地 DB 不会被触碰。
   * 2. 所有数据拉取成功后，在一个同步事务内执行：清空旧表 → 插入 ALL → 插入 folders(depth升序) → 插入 assets → 更新 lastSeq
   *    如果事务内任何一步失败，SQLite 自动回滚，旧缓存保持不变。
   */
  /**
   * 全量对账同步 —— **非破坏性**。
   *
   * 与旧的 fullSync 的根本区别：不再 `DELETE FROM assetData / assetFolder` 再
   * 灌回。旧实现会把「只存在于本地、还没推上去」的记录连根拔掉，而由于推送
   * 失败是静默的，用户以为保存成功了，下一次 checksum 抖动就永久丢数据。
   *
   * 新流程：
   *   0. 先把待推送队列刷出去 —— 本地独有数据尽量先变成服务端数据
   *   1. 拉取服务端快照到内存（HTTP 失败直接上抛，本地库不被触碰）
   *   2. 一个事务里：upsert 快照每一行（局部安全）→ 差集回收 → 写 sync_state
   *
   * 差集回收只做**软删除**，永不物理删除：
   *   - 服务端快照只返回 isDelete=0 的行，物理删本地行会顺手清空本地回收站；
   *   - 服务端 purge 掉的行在本地留个软删幽灵，远好过误删活数据。
   * 且跳过「保护集」：outbox 里还有未推送变更的记录、快照拍摄之后才写入的记录，
   * 以及它们的祖先链。
   *
   * 重命名（fullSync → reconcileSync）是刻意的：语义从「删光重灌」变成「对账」，
   * 留着旧名字会误导下一个读代码的人。
   */
  private async reconcileSync(): Promise<void> {
    this.emit('sync-progress', { phase: '正在下载数据...', current: 0, total: 0 })

    // ── Phase 0: 先把本地欠账推上去 ──
    await this.flushOutbox().catch((err) => {
      console.warn('[SyncClient] 对账前刷新待推送队列失败:', err)
      return undefined
    })
    const snapshotTakenAt = Date.now()

    const PAGE_SIZE = 2000

    /**
     * 被 stop() 换掉之后就别再拉了。
     *
     * `startClientDirect` 每次都会先 `existingClient.stop()` 再建新的，但 stop() 只关了
     * WebSocket 和几个定时器，**动不了正在跑的全量拉取**。于是切一次库就多一条还在
     * 下载的旧链路：用户看到两条「正在下载资产 (216000/219489)」「(218000/219489)」
     * 并排转圈，两份二十多万行的数据同时压在内存里，机器越跑越慢。
     *
     * 这里每翻一页看一眼，被停掉就把这一轮整个放弃 —— 半截数据绝不能往库里写。
     */
    const abortIfStopped = (): void => {
      if (this._isStopped) {
        throw new Error(SYNC_ABORTED_BY_STOP)
      }
    }

    // ── Phase 1: 拉取所有数据到内存（不触碰本地 DB）──
    const allFolderRows: Record<string, unknown>[] = []
    let snapshotSeq = 0
    let snapshotMaxRowid = 0
    {
      let cursor = 0
      let total = 0
      let hasMore = true
      while (hasMore) {
        const params = new URLSearchParams({
          type: 'folders',
          cursor: String(cursor),
          limit: String(PAGE_SIZE)
        })
        if (cursor > 0) {
          params.set('snapshotSeq', String(snapshotSeq))
          params.set('maxRowid', String(snapshotMaxRowid))
        }
        abortIfStopped()
        const page = await this.httpGet<FullDataPageResponse>(
          `/api/vaults/${this.config.vaultId}/full-data?${params.toString()}`,
          120_000
        )
        abortIfStopped()
        if (cursor === 0) {
          total = page.total
          snapshotMaxRowid = page.snapshotMaxRowid
          snapshotSeq = page.snapshotSeq
          console.log(`[SyncClient] 全量拉取 folders: total=${total}, snapshotSeq=${snapshotSeq}`)
        }
        allFolderRows.push(...page.rows)
        this.emit('sync-progress', {
          phase: `正在下载文件夹 (${allFolderRows.length}/${total})`,
          current: allFolderRows.length,
          total
        })
        cursor = page.cursor
        hasMore = page.hasMore
      }
    }

    const allAssetRows: Record<string, unknown>[] = []
    {
      let cursor = 0
      let total = 0
      let assetMaxRowid = 0
      let hasMore = true
      while (hasMore) {
        const params = new URLSearchParams({
          type: 'assets',
          cursor: String(cursor),
          limit: String(PAGE_SIZE)
        })
        if (cursor === 0) {
          // 首页：只传 snapshotSeq 让服务端复用同一时间点，maxRowid 由服务端按 assetData 表计算
          params.set('snapshotSeq', String(snapshotSeq))
        } else {
          // 后续页：传回服务端上一页返回的 assetData 表 maxRowid
          params.set('snapshotSeq', String(snapshotSeq))
          params.set('maxRowid', String(assetMaxRowid))
        }
        abortIfStopped()
        const page = await this.httpGet<FullDataPageResponse>(
          `/api/vaults/${this.config.vaultId}/full-data?${params.toString()}`,
          120_000
        )
        abortIfStopped()
        if (cursor === 0) {
          total = page.total
          assetMaxRowid = page.snapshotMaxRowid // 服务端按 assetData 表计算的 maxRowid
          console.log(
            `[SyncClient] 全量拉取 assets: total=${total} (snapshotSeq=${snapshotSeq}, maxRowid=${assetMaxRowid})`
          )
        }
        allAssetRows.push(...page.rows)
        this.emit('sync-progress', {
          phase: `正在下载资产 (${allAssetRows.length}/${total})`,
          current: allFolderRows.length + allAssetRows.length,
          total: allFolderRows.length + total
        })
        cursor = page.cursor
        hasMore = page.hasMore
      }
    }

    // 按 depth 升序排列 folders，保证父先于子插入
    allFolderRows.sort((a, b) => ((a.depth as number) || 0) - ((b.depth as number) || 0))

    console.log(
      `[SyncClient] 数据拉取完成，开始原子写入: ${allFolderRows.length} 文件夹, ${allAssetRows.length} 资产`
    )

    /**
     * 下载完了要**改口**，别让进度停在 99% 装死。
     *
     * 下面这一整段（算保护集 + 一个事务里写二十多万行）一条进度都不发。二十多万行
     * 的库跑下来是好几分钟，而界面上最后一条消息还是「正在下载资产 (218000/219489)
     * 99%」—— 用户看到的就是卡住了，只能去杀进程，而杀在事务中间等于白下一遍。
     *
     * 这里换成一条没有百分比的「正在写入」：写入阶段拿不到细粒度进度（都在一个
     * 事务里），但至少要让人知道它换阶段了、还活着、别去动它。
     */
    this.emit('sync-progress', {
      phase: `正在写入本地库 (${allAssetRows.length} 个资产，请不要关闭)`,
      current: 0,
      total: 0
    })

    const serverAssetKeys = new Set(
      allAssetRows.map((row) => String(row.assetKey ?? '')).filter(Boolean)
    )
    const serverFolderKeys = new Set(
      allFolderRows.map((row) => String(row.folderKey ?? '')).filter(Boolean)
    )
    // 两个集合、两种用途，别混：
    //  · 窄集 = 这一行自己有未推送的改动（或快照拍完之后才写过）→ **不许被服务端快照覆盖**
    //  · 宽集 = 窄集 ∪ 受保护资产所在文件夹 ∪ 祖先链 → **不许被差集软删**
    // 宽集不能拿来挡覆盖：某个子孙有未推送改动，不该让同事对这个父文件夹的改名下不来。
    const protectedAssetKeys = this.buildProtectedKeys('assetData', snapshotTakenAt)
    const locallyChangedFolderKeys = this.buildProtectedKeys('assetFolder', snapshotTakenAt)
    const protectedFolderKeys = this.buildProtectedFolderKeys(
      locallyChangedFolderKeys,
      protectedAssetKeys
    )

    let softDeletedAssets = 0
    let softDeletedFolders = 0
    let keptLocalRows = 0

    // ── Phase 2: 原子事务写入（失败则回滚，旧数据不受影响）──
    const tx = this.localDb.transaction(() => {
      // ⚠️ 这里以前是 `DELETE FROM assetData` + `DELETE FROM assetFolder`。
      // 那两句会把「只存在于本地、还没推上去」的记录连根拔掉 —— 配上静默的
      // 推送失败，就是「界面说保存成功，过一会儿数据自己消失」。
      // 现在改成 upsert + 差集软删，永不物理删除。

      // 插入 ALL 根文件夹
      this.localDb
        .prepare(
          `INSERT OR IGNORE INTO assetFolder (folderKey, type, folderName, fullPath, pathArray, depth, isDelete)
           VALUES ('ALL', 'folder', '全部资产', '/', '[]', 0, 0)`
        )
        .run()

      // 插入 folders（已按 depth 排序，FK 始终满足）
      for (const row of allFolderRows) {
        const folderKey = String(row.folderKey ?? '')
        // 本地这行还有没推上去的改动 —— 服务端快照是它改之前的样子，
        // 盖下去等于把用户刚做的编辑静默回滚，把他刚删的东西复活。
        // 等这条改动推成功、离开队列之后，下一轮对账自然就一致了。
        if (folderKey && locallyChangedFolderKeys.has(folderKey)) {
          keptLocalRows += 1
          continue
        }
        this.applyRowUpsert('assetFolder', row)
      }

      // 插入 assets
      for (const row of allAssetRows) {
        const assetKey = String(row.assetKey ?? '')
        if (assetKey && protectedAssetKeys.has(assetKey)) {
          keptLocalRows += 1
          continue
        }
        this.applyRowUpsert('assetData', row)
      }

      // ── 差集回收：服务端快照里没有的活行 → 软删除（受保护的跳过）──
      const localAssets = this.localDb
        .prepare(`SELECT assetKey FROM assetData WHERE isDelete = 0`)
        .all() as { assetKey: string }[]
      for (const { assetKey } of localAssets) {
        if (serverAssetKeys.has(assetKey) || protectedAssetKeys.has(assetKey)) continue
        this.stmtDeleteAsset.run(assetKey)
        softDeletedAssets += 1
      }

      // 文件夹从深到浅，避免中间态出现「父没了子还在」
      const localFolders = this.localDb
        .prepare(
          `SELECT folderKey FROM assetFolder
           WHERE isDelete = 0 AND folderKey <> 'ALL' ORDER BY depth DESC`
        )
        .all() as { folderKey: string }[]
      for (const { folderKey } of localFolders) {
        if (serverFolderKeys.has(folderKey) || protectedFolderKeys.has(folderKey)) continue
        this.stmtDeleteFolder.run(folderKey)
        softDeletedFolders += 1
      }

      // saveSyncState 写入 sync_state 表（属于事务内的 DB 操作）
      this.saveSyncStateWithSeq(snapshotSeq)
    })
    tx()

    // ✅ tx() 成功返回后才更新内存中的 lastSeq
    // 如果 tx() 抛出异常，下面这行不会执行，内存状态不受影响
    this.lastSeq = snapshotSeq
    this.scheduleMissingRowRepair()

    console.log(
      `[SyncClient] 对账同步完成: ${allAssetRows.length} 资产, ${allFolderRows.length} 文件夹 ` +
        `(软删 ${softDeletedAssets} 资产 / ${softDeletedFolders} 文件夹，` +
        `保留本地未推送 ${keptLocalRows} 行，` +
        `保护 ${protectedAssetKeys.size} 资产 / ${protectedFolderKeys.size} 文件夹，snapshotSeq=${this.lastSeq})`
    )
    this.emit('full-sync-done', { assets: allAssetRows.length, folders: allFolderRows.length })
  }

  /** 待推送 + 快照拍摄后新写入的 recordKey，对账时一律不动 */
  private buildProtectedKeys(tableName: TrackedTable, snapshotTakenAt: number): Set<string> {
    const keys = this.getPendingRecordKeys(tableName)
    for (const [compound, ts] of this.recentWrites) {
      if (ts < snapshotTakenAt) continue
      const separator = compound.indexOf(':')
      if (separator < 0) continue
      if (compound.slice(0, separator) === tableName) keys.add(compound.slice(separator + 1))
    }
    return keys
  }

  /**
   * 文件夹保护集 = 自身待推送的文件夹
   *                ∪ 受保护资产所在的文件夹
   *                ∪ 以上所有节点的祖先链
   *
   * 少了祖先链，父文件夹被软删会让整棵子树在目录树上消失。
   */
  private buildProtectedFolderKeys(
    locallyChangedFolderKeys: ReadonlySet<string>,
    protectedAssetKeys: ReadonlySet<string>
  ): Set<string> {
    const keys = new Set(locallyChangedFolderKeys)

    const folderOfAsset = this.localDb.prepare(`SELECT folderKey FROM assetData WHERE assetKey = ?`)
    for (const assetKey of protectedAssetKeys) {
      const row = folderOfAsset.get(assetKey) as { folderKey?: string } | undefined
      if (row?.folderKey) keys.add(row.folderKey)
    }

    const parentOf = this.localDb.prepare(`SELECT fatherKey FROM assetFolder WHERE folderKey = ?`)
    for (const key of [...keys]) {
      let cursor: string | undefined = key
      let guard = 0
      while (cursor && cursor !== 'ALL' && guard++ < 512) {
        const row = parentOf.get(cursor) as { fatherKey?: string | null } | undefined
        const father = row?.fatherKey || undefined
        if (!father || keys.has(father)) break
        keys.add(father)
        cursor = father
      }
    }
    return keys
  }

  /**
   * 局部更新命中了本地没有的行 —— 不能凭局部 payload 造行，改为退回一次对账把
   * 整行取回来。
   *
   * 为什么不做「按 key 取单行」的精细路径：修复之后服务端一律广播整行，
   * 局部 payload 基本只会来自尚未升级的旧服务端，触发频率很低；而对账现在
   * 已经是无损的（只 upsert + 软删，且保护本地独有数据），退回它不再危险。
   * 用一条便宜的路径换掉一个额外的网络接口，是划算的。
   */
  private scheduleMissingRowRepair(): void {
    if (this.missingRowBuffer.length === 0) return
    for (const item of this.missingRowBuffer.splice(0)) {
      this.pendingRepairs.set(`${item.tableName}:${item.recordKey}`, item)
    }
    if (this.repairTimer || this._isStopped) return

    this.repairTimer = setTimeout(() => {
      this.repairTimer = null
      const batch = [...this.pendingRepairs.values()]
      this.pendingRepairs.clear()
      this.repairMissingRows(batch).catch((err) => {
        console.warn('[SyncClient] 缺行修复失败:', err instanceof Error ? err.message : String(err))
      })
    }, SyncClient.REPAIR_DEBOUNCE_MS)
  }

  private async repairMissingRows(
    batch: Array<{ tableName: 'assetData' | 'assetFolder'; recordKey: string }>
  ): Promise<void> {
    if (this._isStopped || batch.length === 0) return

    console.warn(`[SyncClient] ${batch.length} 条局部更新命中了本地不存在的行，退回对账同步补齐`)
    await this.reconcileSync()
  }

  /**
   * 应用增量变更到本地 SQLite — 强一致性
   *
   * 排序策略：folder upsert (depth↑) → asset upsert → asset delete → folder delete (depth↓)
   * FK 失败的行延迟到第二轮重试。
   * 如果任何 change 最终无法应用，整个事务回滚并向上抛异常。
   * lastSeq 仅在全部成功时才更新。
   */
  private applyChanges(changes: ChangeLogEntry[]): void {
    // 排序: folder upserts (shallow first) → asset upserts → asset deletes → folder deletes (deep first)
    const sorted = [...changes].sort((a, b) => {
      const order = (c: ChangeLogEntry) => {
        if (c.tableName === 'assetFolder') return c.op === 'delete' ? 30 : 0
        if (c.tableName === 'assetData') return c.op === 'delete' ? 20 : 10
        return 40
      }
      const diff = order(a) - order(b)
      if (diff !== 0) return diff
      if (a.tableName === 'assetFolder' && b.tableName === 'assetFolder') {
        const dA = this.parseDepth(a)
        const dB = this.parseDepth(b)
        if (a.op === 'delete') return dB - dA
        return dA - dB
      }
      return a.seq - b.seq
    })

    const tx = this.localDb.transaction(() => {
      const deferred: ChangeLogEntry[] = []

      // 第一轮：正常应用，FK 失败的延迟
      for (const change of sorted) {
        try {
          this.applySingleChange(change)
        } catch (err) {
          if (this.isForeignKeyError(err)) {
            deferred.push(change)
          } else {
            // 非 FK 错误：直接抛出，事务回滚
            throw err
          }
        }
      }

      // 第二轮：重试 deferred（父行此时应已存在）
      // 任何一条失败即抛出，事务回滚，lastSeq 不推进
      for (const change of deferred) {
        this.applySingleChange(change) // 失败自然抛出
      }

      // 全部成功才写 sync_state 表
      let maxSeq = this.lastSeq
      for (const change of changes) {
        maxSeq = Math.max(maxSeq, change.seq)
      }
      this.saveSyncStateWithSeq(maxSeq)
    })
    tx()

    // ✅ tx() 成功返回后才更新内存中的 lastSeq
    let maxSeq = this.lastSeq
    for (const change of changes) {
      maxSeq = Math.max(maxSeq, change.seq)
    }
    this.lastSeq = maxSeq
  }

  private applySingleChange(change: ChangeLogEntry): void {
    const data = change.payload ? (JSON.parse(change.payload) as Record<string, unknown>) : null

    if (change.tableName === 'assetData') {
      if (change.op === 'delete') {
        this.stmtDeleteAsset.run(change.recordKey)
        return
      }
      if (!data) return
      // recordKey 兜底：即使 payload 里没带主键也能定位到行
      this.applyRowUpsert('assetData', { assetKey: change.recordKey, ...data })
      return
    }

    if (change.tableName === 'assetFolder') {
      if (change.op === 'delete') {
        this.stmtDeleteFolder.run(change.recordKey)
        return
      }
      if (!data) return
      this.applyRowUpsert('assetFolder', { folderKey: change.recordKey, ...data })
    }
  }

  private parseDepth(change: ChangeLogEntry): number {
    if (change.payload) {
      try {
        const parsed = JSON.parse(change.payload) as { depth?: unknown }
        if (typeof parsed.depth === 'number') return parsed.depth
      } catch {
        // 落到下面的本地查询
      }
    }
    // 局部 payload 不带 depth 时，用本地已有的 depth 参与排序 ——
    // 否则所有局部文件夹变更都塌成 depth=0，父子应用顺序被打乱会触发 FK 报错
    try {
      const row = this.localDb
        .prepare(`SELECT depth FROM assetFolder WHERE folderKey = ?`)
        .get(change.recordKey) as { depth?: number } | undefined
      return typeof row?.depth === 'number' ? row.depth : 0
    } catch {
      return 0
    }
  }

  private isForeignKeyError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const msg = 'message' in err ? String((err as any).message) : ''
    return msg.includes('FOREIGN KEY constraint failed')
  }

  // ───────────────── 局部安全写入（BUG A 的客户端护栏） ─────────────────

  /** 实际存在于本地库的同步列（白名单 ∩ 真实表结构，兼容尚未迁移的老库） */
  private resolveSyncColumns(): void {
    const columnsOf = (table: 'assetData' | 'assetFolder'): Set<string> => {
      const rows = this.localDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      return new Set(rows.map((row) => row.name))
    }
    const assetActual = columnsOf('assetData')
    const folderActual = columnsOf('assetFolder')
    this.assetColumns = ASSET_SYNC_COLUMNS.filter((col) => assetActual.has(col))
    this.folderColumns = FOLDER_SYNC_COLUMNS.filter((col) => folderActual.has(col))
  }

  private prepareCached(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql)
    if (!stmt) {
      // 列组合有限，命中率极高；上限只是防病态输入把缓存撑爆
      if (this.stmtCache.size > 200) this.stmtCache.clear()
      stmt = this.localDb.prepare(sql)
      this.stmtCache.set(sql, stmt)
    }
    return stmt
  }

  /**
   * 局部安全的 upsert —— 只写 payload 里真实出现的列。
   *
   * - 行已存在                    → UPDATE 出现的列，其余列原样保留
   * - 行不存在且 payload 足够完整  → INSERT
   * - 行不存在且 payload 是局部的  → **不凭空造行**，登记待修复
   *
   * 为什么不造行：拿 `{assetKey, tags}` 造出来的行 assetName='' / folderKey='ALL'，
   * 在界面上就是一张无名白卡 —— 等于把「字段被抹」换成「凭空多出脏数据」。
   */
  private applyRowUpsert(
    tableName: 'assetData' | 'assetFolder',
    row: Record<string, unknown>
  ): 'updated' | 'inserted' | 'missing' {
    const spec = TABLE_SPEC[tableName]
    const allowed = tableName === 'assetData' ? this.assetColumns : this.folderColumns
    const protectedCols = PROTECTED_SYNC_COLUMNS[tableName]
    const keyColumn = spec.keyColumn

    const recordKey = row[keyColumn]
    if (typeof recordKey !== 'string' || !recordKey) return 'missing'

    // undefined = 「本次没给这一列」；null/'' 落在受保护列上时同样视为没给，
    // 既防 NOT NULL 约束炸掉整个事务，也挡住旧版本用 '' 填空后回传导致的二次抹名
    const columns = allowed.filter((col) => {
      if (col === keyColumn) return false
      const value = row[col]
      if (value === undefined) return false
      if (protectedCols.has(col) && (value === null || value === '')) return false
      return true
    })

    const params: Record<string, unknown> = { [keyColumn]: recordKey }
    for (const col of columns) params[col] = normalizeBindValue(row[col])

    if (columns.length > 0) {
      const setClause = columns.map((col) => `${col} = @${col}`).join(', ')
      const result = this.prepareCached(
        `UPDATE ${tableName} SET ${setClause}, updated_at = datetime('now','localtime')
         WHERE ${keyColumn} = @${keyColumn}`
      ).run(params)
      // SQLite 的 UPDATE changes 统计 WHERE 命中的行数，命中即 >0，
      // 所以 changes === 0 严格等价于「本地没有这行」
      if (result.changes > 0) return 'updated'
    } else {
      const hit = this.prepareCached(
        `SELECT 1 AS hit FROM ${tableName} WHERE ${keyColumn} = ?`
      ).get(recordKey)
      if (hit) return 'updated'
    }

    const complete = spec.requiredColumns.every((col) => {
      const value = row[col]
      return value !== undefined && value !== null && value !== ''
    })
    if (!complete) {
      this.missingRowBuffer.push({ tableName, recordKey })
      return 'missing'
    }

    const insertColumns = [keyColumn, ...columns]
    for (const [col, value] of Object.entries(spec.insertDefaults)) {
      if (col in params || !allowed.includes(col)) continue
      insertColumns.push(col)
      params[col] = value
    }

    this.prepareCached(
      `INSERT INTO ${tableName} (${insertColumns.join(', ')})
       VALUES (${insertColumns.map((col) => `@${col}`).join(', ')})`
    ).run(params)
    return 'inserted'
  }

  // ─────────────────────────── WebSocket ───────────────────────────

  private connectWs(): void {
    if (this._isStopped) return

    // 关闭已有连接，防止重复连接导致服务端 "重复 clientId" 循环
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'client_reconnect')
        }
      } catch {
        /* ignore */
      }
      this.ws = null
    }

    const wsUrl =
      this.config.serverUrl.replace(/^http/, 'ws') +
      `?vaultId=${encodeURIComponent(this.config.vaultId)}` +
      `&clientId=${encodeURIComponent(this.config.clientId)}` +
      `&hostname=${encodeURIComponent(this.config.hostname)}`

    // 资产库访问码**只走 header**，不进 query：query 会落到服务端日志
    // （AssetServer 就在 console.log WS 参数）、崩溃报告和进程列表里。
    // ws 在 Node 下支持自定义握手头，没必要将就。
    const wsHeaders: Record<string, string> = { ...this.getStandaloneApiKeyHeader() }

    this.ws =
      Object.keys(wsHeaders).length > 0
        ? new WebSocket(wsUrl, { headers: wsHeaders })
        : new WebSocket(wsUrl)

    // 握手被 401/403 拒绝时 ws 只抛一个含糊的 error，
    // 'unexpected-response' 才拿得到状态码。
    //
    // ⚠️ 装了这个监听器之后 ws 就**不会**再发 error/close 了，所以清理和重连
    // 必须在这里自己做完 —— 否则握手一被拒（主机刚轮换码、或同 NAT 下别人把
    // 限流刷到 429），这个连接就永久僵在那里，谁也不会把它拉起来。
    this.ws.on('unexpected-response', (_req, res) => {
      const statusCode = res.statusCode || 0
      console.warn(`[SyncClient] WS 握手被拒: HTTP ${statusCode}`)
      if (statusCode === 401 || statusCode === 403) {
        this._authFailed = true
        this.emit('auth-required', { statusCode })
      }
      res.resume()

      this._isConnected = false
      try {
        this.ws?.removeAllListeners()
        this.ws?.terminate()
      } catch {
        /* ignore */
      }
      this.ws = null
      this.emit('status', 'disconnected')
      this.scheduleReconnect()
    })

    this.ws.on('open', () => {
      this._authFailed = false
      this._isConnected = true
      this.reconnectAttempt = 0
      this.emit('status', 'connected')
      // 一恢复连接立刻补推离线期间攒下的改动
      this.flushOutbox().catch((err) => {
        console.warn('[SyncClient] 重连后刷新待推送队列失败:', err)
      })
      console.log(`[SyncClient] WS 已连接: ${this.config.serverUrl}`)
    })

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsServerMessage
        this.handleWsMessage(msg)
      } catch {
        // 忽略无效消息
      }
    })

    this.ws.on('close', (code, reason) => {
      this._isConnected = false
      this.emit('status', 'disconnected')
      console.log(`[SyncClient] WS 断开: code=${code} reason=${reason}`)
      // code 4000 = 服务端因重复 clientId 关闭旧连接，新连接已存在，不需要重连
      if (this._isStopped || code === 4000) return
      this.scheduleReconnect()
    })

    this.ws.on('error', (err) => {
      console.warn(`[SyncClient] WS 错误:`, err.message)
    })

    // 心跳（每 30 秒）
    const heartbeat = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'ping',
            clientId: this.config.clientId,
            lastSeq: this.lastSeq
          })
        )
      } else {
        clearInterval(heartbeat)
      }
    }, 30_000)
  }

  private handleWsMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'change': {
        // 实时应用单条变更
        const entry: ChangeLogEntry = {
          seq: msg.seq,
          op: msg.op,
          tableName: msg.tableName,
          recordKey: msg.recordKey,
          payload: msg.payload,
          clientId: msg.clientId,
          createdAt: Date.now()
        }
        try {
          this.applyChanges([entry])
        } catch (err) {
          console.warn('[SyncClient] WS 变更应用失败，补拉增量同步:', err)
          this.pullChanges().catch((pullErr) => {
            console.warn('[SyncClient] 补拉同步失败:', (pullErr as Error).message)
          })
        }
        this.emit('change', {
          seq: msg.seq,
          op: msg.op,
          tableName: msg.tableName,
          recordKey: msg.recordKey,
          payload: msg.payload
        })
        break
      }
      case 'pong': {
        // 检查是否落后
        if (msg.latestSeq > this.lastSeq + 100) {
          // 可能漏了消息，增量拉取补齐
          this.pullChanges().catch((err) => {
            console.warn('[SyncClient] 补齐拉取失败:', err.message)
          })
        }
        break
      }
    }
  }

  /** 指数退避重连（含随机抖动） */
  private scheduleReconnect(): void {
    if (this._isStopped) return

    // 访问码不对时退避到固定 60s：再快也只是刷服务端的限流计数器，
    // 而且真正的解法是用户去填码，不是重试
    const delays = [1000, 2000, 4000, 8000, 15000, 30000]
    const baseDelay = this._authFailed
      ? 60_000
      : delays[Math.min(this.reconnectAttempt, delays.length - 1)]
    const jitter = 0.5 + Math.random()
    const delay = Math.round(baseDelay * jitter)

    console.log(`[SyncClient] ${delay}ms 后重连 (第 ${this.reconnectAttempt + 1} 次)`)

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempt++
      try {
        await this.pullChanges()
        this.connectWs()
      } catch {
        this.scheduleReconnect()
      }
    }, delay)
  }

  // ─────────────────────────── 校验 ───────────────────────────

  /** 定期比对 Server checksum */
  /**
   * 定期比对 Server checksum。
   *
   * COUNT 不等**不是**重建的理由 —— 它至少有四种良性来源：
   *   1. 本地有未推送的新增（本地多）；
   *   2. 本地有软删除但服务端还没删（本地少）；
   *   3. 服务端刚写完、广播还在路上（本地少）；
   *   4. 客户端正好在增量应用中途（瞬时不等）。
   * 拿它触发一次破坏性重建，是「用核弹处理误报」。
   *
   * 三级升级：先扣掉已知偏差 → 增量拉取（便宜、无损）→ 连续两次仍不等才对账。
   * 而对账现在也已经是无损的，等于双保险。
   */
  private async verifyChecksum(): Promise<void> {
    const serverChecksum = await this.httpGet<ChecksumResponse>(
      `/api/vaults/${this.config.vaultId}/checksum`
    )

    await this.flushOutbox().catch(() => undefined)

    // 只扣 insert：pending 的 update 对应的行服务端本来就有，不该扣
    const localOnlyAssets = this.getPendingRecordKeys('assetData', 'insert').size
    const localOnlyFolders = this.getPendingRecordKeys('assetFolder', 'insert').size

    const localAssetCount = this.countLocalActive('assetData') - localOnlyAssets
    const localFolderCount = this.countLocalActive('assetFolder') - localOnlyFolders

    const countsMatch =
      localAssetCount === serverChecksum.assetCount &&
      localFolderCount === serverChecksum.folderCount
    const seqMatch = this.lastSeq >= serverChecksum.latestSeq - 10 // 容忍小偏差

    if (countsMatch && seqMatch) {
      this.checksumMismatchStreak = 0
      return
    }

    this.checksumMismatchStreak += 1
    console.warn(
      `[SyncClient] Checksum mismatch (${this.checksumMismatchStreak}/${SyncClient.CHECKSUM_MISMATCH_THRESHOLD}): ` +
        `local assets=${localAssetCount}, folders=${localFolderCount}, seq=${this.lastSeq}; ` +
        `server assets=${serverChecksum.assetCount}, folders=${serverChecksum.folderCount}, seq=${serverChecksum.latestSeq}`
    )

    if (this.checksumMismatchStreak < SyncClient.CHECKSUM_MISMATCH_THRESHOLD) {
      await this.pullChanges()
      return
    }

    this.checksumMismatchStreak = 0
    await this.reconcileSync()
  }

  private countLocalActive(tableName: 'assetData' | 'assetFolder'): number {
    return (
      this.localDb.prepare(`SELECT COUNT(*) AS c FROM ${tableName} WHERE isDelete = 0`).get() as {
        c: number
      }
    ).c
  }

  // ─────────────────────────── 写操作代理 ───────────────────────────

  /** 写操作超时：ARM NAS 上单条写入可能较慢，给 30s 余量 */
  private static readonly WRITE_TIMEOUT_MS = 30_000
  private static readonly MAINTENANCE_TIMEOUT_MS = 5 * 60_000

  /** 通过 Server 创建资产 */
  async createAsset(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.httpRequest(
      'POST',
      `/api/vaults/${this.config.vaultId}/assets`,
      data,
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  /** 通过 Server 更新资产 */
  async updateAsset(
    assetKey: string,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.httpRequest(
      'PUT',
      `/api/vaults/${this.config.vaultId}/assets/${encodeURIComponent(assetKey)}`,
      updates,
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  /** 通过 Server 删除资产 */
  async deleteAsset(assetKey: string): Promise<{
    assetKey: string
    mode?: 'move_to_trash' | 'metadata_only'
    sourceMissing?: boolean
  }> {
    return this.httpRequest(
      'DELETE',
      `/api/vaults/${this.config.vaultId}/assets/${encodeURIComponent(assetKey)}`,
      undefined,
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  /** 获取回收站中的资产 */
  async getDeletedAssets(
    page = 1,
    pageSize = 100
  ): Promise<{ list: Record<string, unknown>[]; total: number }> {
    return this.httpGet(
      `/api/vaults/${this.config.vaultId}/deleted-assets?page=${page}&pageSize=${pageSize}`
    )
  }

  /** 通过 Server 恢复回收站资产 */
  async restoreAsset(assetKey: string): Promise<{ assetKey: string; restoredFile?: boolean }> {
    return this.httpRequest(
      'POST',
      `/api/vaults/${this.config.vaultId}/assets/${encodeURIComponent(assetKey)}/restore`,
      undefined,
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  /** 通过 Server 彻底删除回收站资产 */
  async purgeAsset(assetKey: string): Promise<{ assetKey: string; deletedFile?: boolean }> {
    return this.httpRequest(
      'DELETE',
      `/api/vaults/${this.config.vaultId}/assets/${encodeURIComponent(assetKey)}/purge`,
      undefined,
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  async getThumbnailBackupStatus(): Promise<Record<string, unknown>> {
    return this.httpGet(
      `/api/vaults/${this.config.vaultId}/thumbnail-backup/status`,
      SyncClient.MAINTENANCE_TIMEOUT_MS
    )
  }

  async syncThumbnailBackup(): Promise<Record<string, unknown>> {
    return this.httpRequest(
      'POST',
      `/api/vaults/${this.config.vaultId}/thumbnail-backup/sync`,
      undefined,
      SyncClient.MAINTENANCE_TIMEOUT_MS
    )
  }

  async restoreThumbnailBackup(
    options: { overwrite?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    return this.httpRequest(
      'POST',
      `/api/vaults/${this.config.vaultId}/thumbnail-backup/restore`,
      options,
      SyncClient.MAINTENANCE_TIMEOUT_MS
    )
  }

  /** 通过 Server 创建文件夹 */
  async createFolder(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.httpRequest(
      'POST',
      `/api/vaults/${this.config.vaultId}/folders`,
      data,
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  /** 通过 Server 更新文件夹 */
  async updateFolder(
    folderKey: string,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.httpRequest(
      'PUT',
      `/api/vaults/${this.config.vaultId}/folders/${encodeURIComponent(folderKey)}`,
      updates,
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  /** 通过 Server 删除文件夹 */
  async deleteFolder(
    folderKey: string,
    options: { syncAfter?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    const response = await this.httpRequest<Record<string, unknown>>(
      'DELETE',
      `/api/vaults/${this.config.vaultId}/folders/${encodeURIComponent(folderKey)}`,
      undefined,
      SyncClient.WRITE_TIMEOUT_MS
    )
    if (options.syncAfter !== false) {
      await this.pullChanges()
    }
    return response
  }

  /** 通过 Server 搜索 */
  async search(query: string): Promise<Record<string, unknown>> {
    return this.httpGet(`/api/vaults/${this.config.vaultId}/search?q=${encodeURIComponent(query)}`)
  }

  /** 批量操作（动态超时 + 部分失败校验 + 结构化失败详情） */
  async batch(
    operations: Array<{ type: string; table: string; data: Record<string, unknown> }>
  ): Promise<{ results: Array<{ success: boolean; seq?: number }>; count: number }> {
    // 动态超时：基准 10s + 每条操作 250ms，上限 120s
    const dynamicTimeout = Math.min(120_000, 10_000 + operations.length * 250)
    const resp = await this.httpRequest<{
      results: Array<{
        success: boolean
        seq?: number
        index?: number
        table?: string
        key?: string
        errorCode?: string
        errorMessage?: string
      }>
      count: number
      failedCount?: number
      firstFailedIndex?: number
      requestId?: string
    }>('POST', `/api/vaults/${this.config.vaultId}/batch`, { operations }, dynamicTimeout)
    // 校验响应完整性
    if (!resp || !Array.isArray(resp.results)) {
      throw new Error('batch 响应格式异常: results 不是数组')
    }
    if (resp.results.length !== operations.length) {
      throw new Error(
        `batch 响应不完整: 预期 ${operations.length} 条结果，实际 ${resp.results.length} 条`
      )
    }
    // 校验每条操作结果，部分失败时抛结构化错误
    const failedCount = resp.failedCount ?? resp.results.filter((r) => !r.success).length
    if (failedCount > 0) {
      const err = new Error(`batch 部分失败: ${failedCount}/${operations.length} 条操作未成功`)
      ;(err as any).batchFailureDetails = {
        failedCount,
        firstFailedIndex: resp.firstFailedIndex ?? -1,
        requestId: resp.requestId ?? '',
        failedItems: resp.results.filter((r) => !r.success)
      }
      throw err
    }
    return resp
  }

  async uploadLocalFile(localFilePath: string, remoteRelativePath: string): Promise<void> {
    const encodedPath = remoteRelativePath
      .replace(/\\/g, '/')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')

    // 🚀 工业级改造：流式上传，不再将整个文件读入内存
    const fileStat = statSync(localFilePath)
    const fileSize = fileStat.size

    // 动态超时：最低 30s，按 5MB/s 基线计算大文件超时
    const dynamicTimeoutMs = Math.max(
      30_000,
      Math.ceil(fileSize / (5 * 1024 * 1024)) * 1000 + 10_000
    )

    const fileStream = createReadStream(localFilePath)
    await this.httpUploadStream(
      `/api/vaults/${this.config.vaultId}/files/${encodedPath}`,
      fileStream,
      fileSize,
      dynamicTimeoutMs
    )
  }

  // ─────────────────────────── FileWatcher 租约控制 ───────────────────────────

  /** 暂停远端 FileWatcher，返回租约 token（需通过 renewFileWatcherLease 续租） */
  async pauseFileWatcher(): Promise<string> {
    const resp = await this.httpRequest<{ success: boolean; data?: { token: string } }>(
      'POST',
      `/api/vaults/${this.config.vaultId}/file-watcher/pause`,
      {},
      SyncClient.WRITE_TIMEOUT_MS
    )
    const token = (resp as any)?.data?.token || (resp as any)?.token
    if (!token) throw new Error('pauseFileWatcher: 服务端未返回 token')
    return token
  }

  /** 续租指定 token（在 TTL 到期前调用以保持暂停） */
  async renewFileWatcherLease(token: string): Promise<void> {
    await this.httpRequest(
      'POST',
      `/api/vaults/${this.config.vaultId}/file-watcher/renew`,
      { token },
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  /** 释放指定 token，所有 token 释放后 FileWatcher 自动恢复 */
  async resumeFileWatcher(token: string): Promise<void> {
    await this.httpRequest(
      'POST',
      `/api/vaults/${this.config.vaultId}/file-watcher/resume`,
      { token },
      SyncClient.WRITE_TIMEOUT_MS
    )
  }

  // ─────────────────────────── HTTP 工具 ───────────────────────────

  private httpGet<T = unknown>(path: string, timeoutMs?: number): Promise<T> {
    return this.httpRequest<T>('GET', path, undefined, timeoutMs)
  }

  /**
   * 🚀 流式上传 — 零内存拷贝
   * 使用 ReadStream.pipe(req) 直接从磁盘流到网络
   * @param urlPath  API 路径
   * @param stream   文件可读流
   * @param contentLength 文件字节数（用于 Content-Length 头）
   * @param timeoutMs 动态超时（根据文件大小自动计算）
   */
  private httpUploadStream(
    urlPath: string,
    stream: import('fs').ReadStream,
    contentLength: number,
    timeoutMs: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this.config.serverUrl)
      const isHttps = url.protocol === 'https:'
      const lib = isHttps ? https : http

      const options: http.RequestOptions = {
        method: 'PUT',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': contentLength,
          'X-Client-Id': encodeURIComponent(this.config.clientId),
          ...this.getStandaloneApiKeyHeader('PUT')
        },
        timeout: timeoutMs
      }

      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf-8')
            const json = raw ? (JSON.parse(raw) as ApiResponse) : { success: true }
            if (json.success) {
              resolve()
            } else {
              reject(new Error(json.error || `HTTP ${res.statusCode}`))
            }
          } catch (err) {
            reject(err)
          }
        })
      })

      req.on('error', (err) => {
        stream.destroy()
        reject(err)
      })
      req.on('timeout', () => {
        stream.destroy()
        req.destroy()
        reject(
          new Error(
            `Upload timeout (${Math.round(timeoutMs / 1000)}s) for ${Math.round(contentLength / 1024 / 1024)}MB file`
          )
        )
      })

      // 🚀 核心：流式 pipe，磁盘 → 网络，不经过 Buffer 中转
      stream.pipe(req)
      stream.on('error', (err) => {
        req.destroy()
        reject(err)
      })
    })
  }

  private httpRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    return this.sendHttpRequest<T>(method, path, body, timeoutMs)
  }

  private sendHttpRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.config.serverUrl)
      const isHttps = url.protocol === 'https:'
      const lib = isHttps ? https : http

      const bodyStr = body ? JSON.stringify(body) : undefined
      const options: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': encodeURIComponent(this.config.clientId),
          ...this.getStandaloneApiKeyHeader(method),
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
        },
        timeout: timeoutMs || this.config.httpTimeoutMs
      }

      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf-8')
            const json = JSON.parse(raw) as ApiResponse<T> & { errorCode?: string }
            if (json.success) {
              resolve(json.data as T)
            } else {
              const err = new Error(json.error || `HTTP ${res.statusCode}`)
              ;(err as any).statusCode = res.statusCode
              ;(err as Error & { errorCode?: string }).errorCode = json.errorCode
              // 访问码缺失/不对：冒泡给 UI，引导用户去填码，
              // 而不是让用户对着一个含糊的「同步失败」猜
              if (res.statusCode === 401 || json.errorCode === 'AUTH_INVALID') {
                this._authFailed = true
                this.emit('auth-required', {
                  statusCode: res.statusCode || 401,
                  errorCode: json.errorCode
                })
              }
              reject(err)
            }
          } catch (err) {
            reject(err)
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('HTTP timeout'))
      })
      if (bodyStr) req.write(bodyStr)
      req.end()
    })
  }

  /**
   * 资产库访问码。
   *
   * v3 变更：**GET 也要发**。原来只在写请求上发，是因为服务端从来没验证过读；
   * 现在读也要凭据，不发就是 401。
   *
   * 参数保留只为兼容调用点，不再参与判断。
   */
  private getStandaloneApiKeyHeader(_method?: string): Record<string, string> {
    void _method
    const apiKey = this.config.apiKey?.trim()
    return apiKey ? { 'X-API-Key': apiKey } : {}
  }
}
