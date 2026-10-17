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
import { refreshPlannerStatsIfStale } from '../sqliteDataBase/plannerStats'
import { AdaptiveSliceSizer } from './adaptiveSlice'
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
  /**
   * 等 worker 把本地库的 WAL 追平一次（应用里是 assetQueryRunner.waitForWalCheckpoint）。
   * 大批量写入每写 WAL_SYNC_EVERY_MS 调一次，见 pauseBetweenWrites。不给就不等。
   */
  waitForWalCheckpoint?: () => Promise<void>
}

type SyncClientRuntimeConfig = SyncClientConfig &
  Required<Pick<SyncClientConfig, 'checksumIntervalMs' | 'httpTimeoutMs'>>

// ─────────────────────────── 事件 ───────────────────────────

export interface SyncClientEvents {
  /** 连接状态变化 */
  status: (status: 'connected' | 'disconnected' | 'syncing' | 'error') => void
  /** 收到实时变更（一批变更合成一条时 op = 'batch'，count = 条数） */
  change: (entry: {
    seq: number
    op: string
    tableName: string
    recordKey: string
    payload: string | null
    count?: number
  }) => void
  /** 同步进度。phaseKey 给界面取双语文案，phase 是给日志看的中文 */
  'sync-progress': (stats: {
    phase: string
    phaseKey?: SyncPhaseKey
    current: number
    total: number
  }) => void
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

// ─────────────────────── 全量对账的分页参数 ───────────────────────

/** 一页的行数。服务端上限 5000；2000 行一页的写入事务在 50 ms 量级，两页之间界面照常响应 */
const RECONCILE_PAGE_SIZE = 2000
const RECONCILE_PAGE_TIMEOUT_MS = 120_000
/** 断点超过这么久就不续了，见 canResumeReconcile */
const RECONCILE_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 差集回收 / 清理「见过的集合」每块处理的行数 */
const RECONCILE_SWEEP_CHUNK = 10_000
/** 一次同步写入最多占主线程多久，写满就提交、让出事件循环（见 writeAssetPage） */
const WRITE_SLICE_BUDGET_MS = 40
/** 大批量写入累计写满这么久，就停下来等 worker 把 WAL 追平一次（见 pauseBetweenWrites） */
const WAL_SYNC_EVERY_MS = 300
/** 缺行修复一次最多按 key 单取这么多行；更多的交给定期校验 */
const REPAIR_MAX_ROWS = 200
/** 实时变更攒批：凑够这么多条或等这么久就写一次 */
const WS_CHANGE_BATCH_MAX = 200
const WS_CHANGE_BATCH_DELAY_MS = 30

interface ReconcileCheckpoint {
  scope: string
  serverUrl: string
  snapshotSeq: number
  /** folders → assets → sweep → done */
  phase: 'folders' | 'assets' | 'sweep' | 'done'
  assetCursor: number
  assetMaxRowid: number
  assetTotal: number
  fetched: number
  /** 服务端给了、本地存不下而跳过的行数（校验时要扣掉，否则永远对不上） */
  skippedAssets: number
  skippedFolders: number
  /**
   * 这一轮开始时本地两张表的最大 rowid。差集只扫这个范围内的行：之后才写进本地的
   * （用户新建、实时推送来的）不可能出现在这一轮的快照里，扫到就会被误删。
   */
  localAssetMaxRowid: number
  localFolderMaxRowid: number
  startedAt: number
  updatedAt: number
}

/** 同步进度事件里的阶段代号，界面按它取双语文案（phase 只留给日志） */
export type SyncPhaseKey = 'preparing' | 'folders' | 'assets' | 'sweep'

/** 让出事件循环：把排队的 IPC、界面事件、WebSocket 消息先处理掉再继续 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

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

/**
 * 扩展名的两列统一写成「小写、不带点」。
 *
 * 旧 asset-server-standalone 扫描入库的是 path.extname 的结果，**带点**（'.wav'、'.WAV'），
 * 以前同步原样抄进本地库；本机导入写的是 'wav'。读的地方 —— 类型下拉
 * （getDistinctAssetTypes 的 ext = 'uasset'）、统计分桶、详情面板的 ext === 'uasset' ——
 * 全按后者比，带点的行在这些地方统统对不上。在写入口一处规整，读的地方不用各自兜。
 * 已经带点落了库的老行由 vaultSchema.normalizeStoredExtensions 一次性迁掉。
 */
const EXTENSION_COLUMNS: ReadonlySet<string> = new Set(['ext', 'fileExtension'])

function normalizeExtensionValue(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/^\./, '').toLowerCase() : value
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
  private reconcilePromise: Promise<void> | null = null
  /** 实时变更攒批，见 flushWsChanges */
  private wsChangeBuffer: ChangeLogEntry[] = []
  private wsFlushTimer: ReturnType<typeof setTimeout> | null = null
  /** 上一轮对账跳过的行数（服务端有、本地存不下），校验时扣掉 */
  private lastReconcileSkips = { assets: 0, folders: 0 }
  /** 对账之后增量里又跳过的（新建的行挂在本地没有的文件夹下），同样计入校验 */
  private incrementalSkips = { assets: 0, folders: 0 }
  /**
   * 正在跑的那一轮对账（run_id = 它的 startedAt）。这期间本地写的、实时推来的行都记成
   * 「这一轮见过」：差集不会误删它们，快照页也不会拿旧值把它们盖回去。
   */
  private activeRunId: number | null = null
  /** 大批增量正在分片写入：实时变更先攒着，等它写完再按顺序落（见 applyChangesInSlices） */
  private applyingSlices = false
  /** 正在分片写的那一批；下一批要等它写完 */
  private slicedApply: Promise<void> | null = null
  /** 一次同步写入写几行：按上一片「写 + 提交」的实际耗时调，见 adaptiveSlice.ts */
  // 从小处起步、按实测翻倍往上调：一开始就写 200 行，大库上第一片就要卡大半秒
  private sliceSizer = new AdaptiveSliceSizer(WRITE_SLICE_BUDGET_MS, 10, 2000, 20)
  /** 距上次等 WAL 追平，主连接累计写了多少毫秒 */
  private writeMsSinceWalSync = 0
  /** 正在等 worker 把 WAL 追平：这期间实时变更先攒着，不插进来写 */
  private waitingForWal = false

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
    this.initReconcileTables()
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
    // 对账正在跑：记成这一轮见过，差集就不会把它当「服务端没有」软删掉。
    // 只靠下面的时间戳不够 —— 差集用的保护集是开扫前算好的，扫的途中写的进不去
    this.markSeenForActiveRun(tableName, recordKey)
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
   * 全量对账的断点和「这一轮见过哪些行」。
   *
   * 以前对账是「先把服务端几十万行全拉进内存，最后一个事务写进去」：内存跟着库的
   * 大小涨（52 万行就是几个 GB，主进程直接爆掉），而且进度只在最后一刻落盘 ——
   * 崩在 70% 等于白下，重启从 0 开始，再崩在 70%。
   *
   * 现在每一页拉下来就写进去，同时在这两张表里记下「拉到哪了」「见过谁」。
   * 断网、崩溃、被换掉之后从断点接着拉；最后用「见过的集合」做差集软删。
   */
  private initReconcileTables(): void {
    this.localDb.exec(`
      CREATE TABLE IF NOT EXISTS sync_reconcile (
        scope            TEXT PRIMARY KEY,
        server_url       TEXT    NOT NULL,
        snapshot_seq     INTEGER NOT NULL DEFAULT 0,
        phase            TEXT    NOT NULL,
        asset_cursor     INTEGER NOT NULL DEFAULT 0,
        asset_max_rowid  INTEGER NOT NULL DEFAULT 0,
        asset_total      INTEGER NOT NULL DEFAULT 0,
        fetched          INTEGER NOT NULL DEFAULT 0,
        skipped_assets   INTEGER NOT NULL DEFAULT 0,
        skipped_folders  INTEGER NOT NULL DEFAULT 0,
        local_asset_max_rowid  INTEGER NOT NULL DEFAULT 0,
        local_folder_max_rowid INTEGER NOT NULL DEFAULT 0,
        started_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      -- run_id = 这一轮对账的 started_at。换客户端时旧实例可能还在清理它那一轮的记录，
      -- 按轮次隔开，两轮的「见过」互不干扰（否则新一轮会把刚记下的被旧实例删掉，
      -- 差集时当成「服务端没有」软删掉）
      CREATE TABLE IF NOT EXISTS sync_reconcile_seen (
        scope       TEXT    NOT NULL,
        run_id      INTEGER NOT NULL,
        table_name  TEXT    NOT NULL,
        record_key  TEXT    NOT NULL,
        PRIMARY KEY (scope, run_id, table_name, record_key)
      ) WITHOUT ROWID;
    `)
    // 断点表早期没有这两列，补上（CREATE TABLE IF NOT EXISTS 对已有的表不生效）
    const columns = new Set(
      (this.localDb.prepare(`PRAGMA table_info(sync_reconcile)`).all() as { name: string }[]).map(
        (row) => row.name
      )
    )
    for (const column of ['local_asset_max_rowid', 'local_folder_max_rowid']) {
      if (!columns.has(column)) {
        this.localDb.exec(
          `ALTER TABLE sync_reconcile ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`
        )
      }
    }
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

    const checkpoint = this.loadReconcileCheckpoint()
    if (checkpoint?.phase === 'done') {
      this.lastReconcileSkips = {
        assets: checkpoint.skippedAssets,
        folders: checkpoint.skippedFolders
      }
    }
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

      // 3. 定时校验 + 待推送队列重试
      this.ensurePeriodicTimers()
    } catch (err) {
      if (this._isStopped) return // 被 stop() 后不再触发重连
      const error = err instanceof Error ? err : new Error(String(err))
      console.warn('[SyncClient] 启动同步失败，稍后重试:', error.message)
      // EventEmitter 的 'error' 没人监听时会**原地抛出**。这里以前无条件 emit，
      // 而全仓没有一处监听它 —— 于是下面两行永远走不到：一次超时之后这个客户端
      // 不重连、不报状态，就这么死着，直到用户重启软件（重启又从头全量下载）。
      if (this.listenerCount('error') > 0) this.emit('error', error)
      this.emit('status', 'error')
      this.scheduleReconnect()
    }
  }

  /**
   * 定时校验和待推送队列的定期重试。重复调用无副作用。
   *
   * 启动失败后靠重连恢复的客户端也要走到这里 —— 以前只有 start() 成功那条路建这两个
   * 定时器，首次同步超时、之后重连成功的客户端整场都没有校验，也不再重试推送失败的改动。
   */
  private ensurePeriodicTimers(): void {
    if (this._isStopped) return
    if (!this.checksumTimer) {
      this.checksumTimer = setInterval(() => {
        if (this._isStopped) return // 二次防护
        this.verifyChecksum().catch((err) => {
          console.warn('[SyncClient] 校验失败:', err.message)
        })
      }, this.config.checksumIntervalMs)
    }
    if (!this.outboxTimer) {
      // 队列非空时定期重试（队列空时几乎零成本）
      this.outboxTimer = setInterval(() => {
        if (this._isStopped || !this._isConnected) return
        if (this.pendingPushCount === 0) return
        this.flushOutbox().catch(() => undefined)
      }, 60_000)
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
    if (this.wsFlushTimer) {
      clearTimeout(this.wsFlushTimer)
      this.wsFlushTimer = null
    }
    // 没写进去的实时变更直接丢掉：lastSeq 没前进，下次连上从同一个 seq 补拉
    this.wsChangeBuffer = []
    this.reconnectAttempt = 0
    this._isConnected = false
    this.emit('status', 'disconnected')
  }

  // ─────────────────────────── 数据同步 ───────────────────────────

  async pullChanges(): Promise<void> {
    // 同一时刻只拉一轮，后来的等前面那轮。中止哨兵对每个等待者都要过滤 ——
    // 以前只有发起的那个调用会过滤，中途加入的（比如用户点「拉取同步」）拿到的是原始
    // promise，界面上直接弹出一句 SYNC_ABORTED_BY_STOP
    if (!this.pullChangesPromise) {
      this.pullChangesPromise = this.doPullChanges().finally(() => {
        this.pullChangesPromise = null
      })
    }
    try {
      await this.pullChangesPromise
    } catch (err) {
      // 自己被 stop() 换掉而主动放弃的，不是故障，别往上抛成「同步失败」
      if (err instanceof Error && err.message === SYNC_ABORTED_BY_STOP) {
        console.log('[SyncClient] 同步已被 stop() 中止（这个客户端已经被换掉）')
        return
      }
      throw err
    }
  }

  private async doPullChanges(): Promise<void> {
    // 从没对完过一轮就全量。全量从 assetData/assetFolder 表直接读，不依赖 change_log
    // （服务端的文件扫描、批量导入直接写库，不进 change_log）。
    //
    // 判据是「对完过没有」，不是 lastSeq === 0：服务端 change_log 为空时快照点就是 0，
    // 对完一轮 lastSeq 还是 0。以前按 lastSeq 判，这种库每次启动、每次重连都把整个库
    // 重新过一遍 —— 几十万行的库就是每次开软件都「正在同步资产」好几分钟。
    if (this.lastSeq === 0 && !this.hasFinishedReconcile()) {
      console.log('[SyncClient] 首次同步，执行全量同步')
      await this.reconcileSync()
      return
    }

    const resp = await this.httpGet<SyncResponse>(
      `/api/vaults/${this.config.vaultId}/sync?since=${this.lastSeq}`
    )

    if (resp.fullSyncRequired) {
      // 旧服务端上**每一次批量导入**都会走到这里（ImportSessionService 设
      // fullSyncRequiredSeq，导入的行不进 change_log）：别人导一次，所有人的客户端
      // 都要把整个库重新过一遍。这是协议的缺陷，客户端改不了它，只能让这一遍足够轻 ——
      // 分页落盘、没变的行不写、不卡界面，见 reconcileSync。
      console.log('[SyncClient] 需要全量同步 (change_log 已过期或服务端有批量导入)')
      await this.reconcileSync()
      return
    }

    if (resp.changes.length > 0) {
      try {
        await this.applyChangesInSlices(resp.changes)
      } catch (err) {
        if (err instanceof Error && err.message === SYNC_ABORTED_BY_STOP) throw err
        console.warn('[SyncClient] 增量同步应用失败，回退到全量同步:', err)
        await this.reconcileSync()
        return
      }
      console.log(
        `[SyncClient] 增量同步：应用了 ${resp.changes.length} 条变更 (seq: ${this.lastSeq})`
      )
      this.emit('incremental-sync-done', { applied: resp.changes.length })
      this.scheduleMissingRowRepair()
    }

    if (this.lastSeq === 0 && resp.latestSeq === 0) await this.reconcileIfCountsDiffer()
  }

  /** 这个库（同一台服务器）有没有完整对完过一轮 */
  private hasFinishedReconcile(): boolean {
    const checkpoint = this.loadReconcileCheckpoint()
    return checkpoint?.phase === 'done' && checkpoint.serverUrl === this.config.serverUrl
  }

  /**
   * 服务端 change_log 一直是空的库：扫描、批量导入进来的行既不会出现在增量里，也不会让
   * 服务端要求全量（它对 since=0 从不要求）。拿条数和服务端核对一次，对不上才全量 ——
   * 和定期校验同一个算法，只是不等它半小时后连错两次。
   */
  private async reconcileIfCountsDiffer(): Promise<void> {
    const server = await this.httpGet<ChecksumResponse>(
      `/api/vaults/${this.config.vaultId}/checksum`
    )
    const local = this.localCountsForChecksum()
    if (local.assets === server.assetCount && local.folders === server.folderCount) return
    console.log(
      `[SyncClient] 服务端没有变更日志，条数对不上（本地 ${local.assets}/${local.folders}，` +
        `服务端 ${server.assetCount}/${server.folderCount}），执行全量同步`
    )
    await this.reconcileSync()
  }

  /**
   * 对账写下的是 snapshotSeq 那一刻的服务端；拉取那几分钟里服务端又变了的，
   * 从 snapshotSeq 起补一次增量。**每一轮对账都在结尾调它**（runReconcile 里），
   * 不管是谁触发的 —— 以前只有拉取那条路补，校验触发的对账不补：期间实时推来的
   * 新行被差集扫掉，下一条实时变更又把 lastSeq 推过了这段空档，它们要等一小时后
   * 下一次校验才回来。
   *
   * 这里**只补增量，不再连环对账**：拉取期间又有人批量导入的话，服务端会再要一次
   * 全量 —— 那就交给心跳 / 重连按正常节奏去触发。在这里接着套一轮，导入频繁的库
   * 会永远停在「正在同步」里。
   */
  private async catchUpAfterReconcile(): Promise<void> {
    if (this._isStopped) return
    try {
      const resp = await this.httpGet<SyncResponse>(
        `/api/vaults/${this.config.vaultId}/sync?since=${this.lastSeq}`
      )
      if (resp.fullSyncRequired || resp.changes.length === 0) return
      await this.applyChangesInSlices(resp.changes)
      this.emit('incremental-sync-done', { applied: resp.changes.length })
      this.scheduleMissingRowRepair()
    } catch (err) {
      // 补不上不要紧：下一次心跳 / 重连会从同一个 seq 再补
      console.warn('[SyncClient] 对账后补增量失败:', err instanceof Error ? err.message : err)
    }
  }

  /**
   * 全量对账 —— 同一时刻只跑一轮。
   *
   * 两条路会触发它：拉取（首次 / 服务端要求 / 增量写不进去）、校验连续不一致。
   * 以前它们互不知道对方，两轮可以同时在跑，各自拉一遍几十万行。现在后来的直接等
   * 前面那一轮。
   */
  private reconcileSync(): Promise<void> {
    if (!this.reconcilePromise) {
      this.reconcilePromise = this.runReconcile().finally(() => {
        this.reconcilePromise = null
      })
    }
    return this.reconcilePromise
  }

  private emitProgress(phaseKey: SyncPhaseKey, phase: string, current = 0, total = 0): void {
    this.emit('sync-progress', { phase, phaseKey, current, total })
  }

  /**
   * 全量对账 —— **非破坏性、分页落盘、可断点续传**。
   *
   * 历史：
   *   - 最早是 `DELETE FROM` 两张表再灌回，会把本地还没推上去的记录连根拔掉；
   *     后来改成 upsert + 差集软删（reconcile），永不物理删除。
   *   - 但那一版仍是「先把服务端所有行拉进内存，最后一个事务写完」。52 万行的库
   *     就是几个 GB 的 JS 对象压在主进程里，加上一个跑好几分钟的同步事务 ——
   *     五十多万资产的库上表现为进度停在 70% 不动，然后软件崩掉；重启从 0 开始，再崩一次。
   *
   * 现在：
   *   1. 文件夹（几千个）照旧一次拉完、一个事务写入（要按深度排序，保证父先于子）。
   *   2. 资产一页一页来：每页按时间切片写入 + 记下「见过这些 key」+ 更新断点，片与片
   *      之间把事件循环让出去 —— 界面、IPC 照常响应。内存里永远只有一页。
   *   3. 全部拉完，按「见过的集合」分块做差集软删。
   *   4. 任何一步中断（断网、崩溃、被 stop 换掉），下次从断点继续，不从 0 开始。
   *   5. 结尾从 snapshotSeq 补一次增量（catchUpAfterReconcile）。
   *
   * 拉取要好几分钟，这期间本地和服务端都还在变。规则：
   *   - 这一轮开始之后**任何**写进本地的行（用户自己改的、实时推来的）都记成「这一轮
   *     见过」（markSeenForActiveRun）：差集不会把它当「服务端没有」软删掉；它所在的
   *     快照页晚到的话也不再拿旧值盖它（writeAssetPage 看「见过」标记跳过）。
   *   - 差集只扫这一轮**开始时**本地已有的行（localAssetMaxRowid），之后才进来的
   *     不可能出现在这一轮的快照里。
   *   - outbox 里还有未推送变更的行不被服务端覆盖也不被软删；文件夹额外保护受保护
   *     资产所在的祖先链。
   *
   * 服务端给的行如果本地存不下（缺名字 / 缺文件夹 / 父文件夹不在了），**跳过并计数**，
   * 不再让一行坏数据回滚整轮、也不再拿它触发下一轮对账 —— 以前这两条加起来就是
   * 「永远在全量同步」。跳过的数目记在断点表里，校验时扣掉，免得每小时又对一次账。
   */
  private async runReconcile(): Promise<void> {
    const scope = this.getSyncStateKey()
    const abortIfStopped = (): void => {
      // 被 stop() 换掉之后就别再拉了：startClientDirect 换客户端时只会 stop() 旧的，
      // 不加这一道，旧链路会继续在后台下载。断点已经落盘，新客户端会接着拉。
      if (this._isStopped) throw new Error(SYNC_ABORTED_BY_STOP)
    }

    this.emitProgress('preparing', '正在准备同步...')

    // ── 0. 先把本地欠账推上去 —— 本地独有数据尽量先变成服务端数据 ──
    await this.flushOutbox().catch((err) => {
      console.warn('[SyncClient] 对账前刷新待推送队列失败:', err)
      return undefined
    })
    abortIfStopped()

    let checkpoint = this.loadReconcileCheckpoint()
    if (checkpoint && this.canResumeReconcile(checkpoint)) {
      console.log(
        `[SyncClient] 接着上次中断的对账继续: 阶段=${checkpoint.phase}, ` +
          `已拉 ${checkpoint.fetched}/${checkpoint.assetTotal} 个资产`
      )
    } else {
      await this.clearReconcileSeen(scope, null)
      const now = Date.now()
      checkpoint = {
        scope,
        serverUrl: this.config.serverUrl,
        snapshotSeq: 0,
        phase: 'folders',
        assetCursor: 0,
        assetMaxRowid: 0,
        assetTotal: 0,
        fetched: 0,
        skippedAssets: 0,
        skippedFolders: 0,
        localAssetMaxRowid: this.localMaxRowid('assetData'),
        localFolderMaxRowid: this.localMaxRowid('assetFolder'),
        startedAt: now,
        updatedAt: now
      }
      this.saveReconcileCheckpoint(checkpoint)
    }
    const startedAt = checkpoint.startedAt

    this.activeRunId = startedAt
    try {
      // ── 1. 文件夹：数量小，一次拉完，按深度一个事务写入 ──
      if (checkpoint.phase === 'folders') {
        const { rows: folderRows, snapshotSeq } = await this.fetchFolderSnapshot(
          abortIfStopped,
          (fetched, total) => {
            this.emitProgress(
              'folders',
              `正在同步文件夹 (${fetched}/${total})`,
              fetched,
              Math.max(total, fetched)
            )
          }
        )
        const started = performance.now()
        checkpoint = this.writeFolderSnapshot(folderRows, {
          ...checkpoint,
          snapshotSeq,
          phase: 'assets',
          assetCursor: 0,
          assetMaxRowid: 0,
          assetTotal: 0,
          fetched: 0,
          skippedAssets: 0
        })
        this.writeMsSinceWalSync += performance.now() - started
        await this.pauseBetweenWrites()
      }

      // ── 2. 资产：一页一页拉，每页按时间切片写入，断点随页落盘 ──
      if (checkpoint.phase === 'assets') {
        let hasMore = true
        while (hasMore) {
          const cursor = checkpoint.assetCursor
          const params = new URLSearchParams({
            type: 'assets',
            cursor: String(cursor),
            limit: String(RECONCILE_PAGE_SIZE),
            // 首页只传 snapshotSeq，maxRowid 由服务端按 assetData 表算；后续页两个都传回去
            snapshotSeq: String(checkpoint.snapshotSeq)
          })
          if (cursor > 0) params.set('maxRowid', String(checkpoint.assetMaxRowid))

          abortIfStopped()
          const page = await this.httpGet<FullDataPageResponse>(
            `/api/vaults/${this.config.vaultId}/full-data?${params.toString()}`,
            RECONCILE_PAGE_TIMEOUT_MS
          )
          abortIfStopped()

          const assetMaxRowid = cursor === 0 ? page.snapshotMaxRowid : checkpoint.assetMaxRowid
          if (cursor === 0) {
            console.log(
              `[SyncClient] 对账 assets: total=${page.total} ` +
                `(snapshotSeq=${checkpoint.snapshotSeq}, maxRowid=${assetMaxRowid})`
            )
          }
          hasMore = page.hasMore
          checkpoint = await this.writeAssetPage(
            page.rows,
            {
              ...checkpoint,
              phase: hasMore ? 'assets' : 'sweep',
              assetCursor: page.cursor,
              assetMaxRowid,
              assetTotal: page.total || checkpoint.assetTotal,
              fetched: checkpoint.fetched + page.rows.length
            },
            abortIfStopped
          )
          this.emitProgress(
            'assets',
            `正在同步资产 (${checkpoint.fetched}/${checkpoint.assetTotal})`,
            checkpoint.fetched,
            Math.max(checkpoint.assetTotal, checkpoint.fetched)
          )
          // 两页之间把事件循环让出去：界面点击、IPC、WebSocket 心跳都在这里得到处理
          await this.pauseBetweenWrites()
        }
      }

      // ── 3. 差集软删：这一轮开始时本地已有、服务端这一轮没给的活行 → 软删（受保护的跳过）──
      if (checkpoint.phase !== 'sweep') {
        throw new Error(`[SyncClient] 对账断点处于未知阶段: ${checkpoint.phase}`)
      }
      // 下面几步都要把整张表 / 整个「见过的集合」读一遍，先让 WAL 追平（见 waitForWal）
      await this.waitForWal()
      const seenAssets = this.countReconcileSeen(scope, startedAt, 'assetData')
      if (checkpoint.fetched - checkpoint.skippedAssets > 0 && seenAssets === 0) {
        // 「见过的集合」丢了还照着它做差集，等于把整个库软删掉。宁可从头再来一轮
        this.deleteReconcileCheckpoint(scope)
        throw new Error('[SyncClient] 对账记录不完整，放弃本轮差集回收，下次从头对账')
      }

      const protectedAssetKeys = this.buildProtectedKeys('assetData', startedAt)
      const softDeletedAssets = await this.sweepUnseenAssets(
        scope,
        startedAt,
        protectedAssetKeys,
        checkpoint.localAssetMaxRowid,
        abortIfStopped
      )
      abortIfStopped()
      // 文件夹的保护集在资产扫完**之后**再算：资产那一遍要让出好几十次事件循环，
      // 开扫前算好的集合里没有扫的途中才写下的改动
      const protectedFolderKeys = this.buildProtectedFolderKeys(
        this.buildProtectedKeys('assetFolder', startedAt),
        this.buildProtectedKeys('assetData', startedAt)
      )
      const softDeletedFolders = this.sweepUnseenFolders(
        scope,
        startedAt,
        protectedFolderKeys,
        checkpoint.localFolderMaxRowid
      )
      const seenFolders = this.countReconcileSeen(scope, startedAt, 'assetFolder')

      const snapshotSeq = checkpoint.snapshotSeq
      const finished = { ...checkpoint, phase: 'done' as const, updatedAt: Date.now() }
      this.localDb.transaction(() => {
        this.saveSyncStateWithSeq(snapshotSeq)
        this.saveReconcileCheckpoint(finished)
      })()
      // 事务提交之后才动内存里的 lastSeq —— 提交失败时内存状态保持原样。
      // 这里故意把 lastSeq 退回 snapshotSeq：拉取期间实时推来的变更由结尾的补增量
      // 从这里起重放一遍（幂等），不重放的话中间没收到的那些就永远补不上了
      this.lastSeq = snapshotSeq
      this.lastReconcileSkips = {
        assets: finished.skippedAssets,
        folders: finished.skippedFolders
      }
      this.incrementalSkips = { assets: 0, folders: 0 }
      this.activeRunId = null

      await this.clearReconcileSeen(scope, startedAt)
      // 重算统计要把每个索引读一遍，同样先让 WAL 追平
      await this.waitForWal()
      await refreshPlannerStatsIfStale(this.localDb, {
        shouldStop: () => this._isStopped || !this.localDb.open
      })

      console.log(
        `[SyncClient] 对账同步完成: ${seenAssets} 资产, ${seenFolders} 文件夹 ` +
          `(软删 ${softDeletedAssets} 资产 / ${softDeletedFolders} 文件夹，` +
          `服务端行本地存不下而跳过 ${finished.skippedAssets} 资产 / ${finished.skippedFolders} 文件夹，` +
          `保护 ${protectedAssetKeys.size} 资产 / ${protectedFolderKeys.size} 文件夹，snapshotSeq=${this.lastSeq})`
      )
      this.emit('full-sync-done', { assets: seenAssets, folders: seenFolders })
    } finally {
      this.activeRunId = null
    }

    await this.catchUpAfterReconcile()
  }

  // ───────────────────── 对账：断点与分页写入 ─────────────────────

  private localMaxRowid(tableName: 'assetData' | 'assetFolder'): number {
    return (
      (
        this.localDb.prepare(`SELECT MAX(rowid) AS m FROM ${tableName}`).get() as {
          m: number | null
        }
      ).m ?? 0
    )
  }

  /**
   * 服务端的全部文件夹（几千个，一次拉完），按深度排好、父在子前。
   * 对账的文件夹阶段和「缺文件夹修复」共用。
   */
  private async fetchFolderSnapshot(
    abortIfStopped: () => void,
    onProgress?: (fetched: number, total: number) => void
  ): Promise<{ rows: Record<string, unknown>[]; snapshotSeq: number }> {
    const rows: Record<string, unknown>[] = []
    let cursor = 0
    let total = 0
    let maxRowid = 0
    let snapshotSeq = 0
    let hasMore = true
    while (hasMore) {
      const params = new URLSearchParams({
        type: 'folders',
        cursor: String(cursor),
        limit: String(RECONCILE_PAGE_SIZE)
      })
      if (cursor > 0) {
        params.set('snapshotSeq', String(snapshotSeq))
        params.set('maxRowid', String(maxRowid))
      }
      abortIfStopped()
      const page = await this.httpGet<FullDataPageResponse>(
        `/api/vaults/${this.config.vaultId}/full-data?${params.toString()}`,
        RECONCILE_PAGE_TIMEOUT_MS
      )
      abortIfStopped()
      if (cursor === 0) {
        total = page.total
        maxRowid = page.snapshotMaxRowid
        snapshotSeq = page.snapshotSeq
        console.log(`[SyncClient] 对账 folders: total=${total}, snapshotSeq=${snapshotSeq}`)
      }
      rows.push(...page.rows)
      onProgress?.(rows.length, total)
      cursor = page.cursor
      hasMore = page.hasMore
    }
    rows.sort((a, b) => ((a.depth as number) || 0) - ((b.depth as number) || 0))
    return { rows, snapshotSeq }
  }

  private loadReconcileCheckpoint(): ReconcileCheckpoint | null {
    const row = this.localDb
      .prepare(`SELECT * FROM sync_reconcile WHERE scope = ?`)
      .get(this.getSyncStateKey()) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      scope: String(row.scope),
      serverUrl: String(row.server_url),
      snapshotSeq: Number(row.snapshot_seq) || 0,
      phase: String(row.phase) as ReconcileCheckpoint['phase'],
      assetCursor: Number(row.asset_cursor) || 0,
      assetMaxRowid: Number(row.asset_max_rowid) || 0,
      assetTotal: Number(row.asset_total) || 0,
      fetched: Number(row.fetched) || 0,
      skippedAssets: Number(row.skipped_assets) || 0,
      skippedFolders: Number(row.skipped_folders) || 0,
      localAssetMaxRowid: Number(row.local_asset_max_rowid) || 0,
      localFolderMaxRowid: Number(row.local_folder_max_rowid) || 0,
      startedAt: Number(row.started_at) || 0,
      updatedAt: Number(row.updated_at) || 0
    }
  }

  /**
   * 断点能不能接着用。
   *
   * - 换了服务器地址的不接（同一个 vaultId 搬了家，rowid 对不上）。
   * - 断点之后本地已经吃进了更新的变更（lastSeq 越过了它的 snapshotSeq）的不接：
   *   老快照里没有那之后服务端新建的行，接着做完差集会把它们当「服务端没有」软删掉，
   *   结尾还要把 lastSeq 退回老 snapshotSeq。
   * - 太久的不接：续传完成后会从 snapshotSeq 补增量，服务端的 change_log 撑不了那么久的话
   *   只会再要一次全量，不如现在就从头来。
   */
  private canResumeReconcile(checkpoint: ReconcileCheckpoint): boolean {
    if (checkpoint.phase === 'done') return false
    if (checkpoint.serverUrl !== this.config.serverUrl) return false
    if (checkpoint.phase !== 'folders' && checkpoint.snapshotSeq < this.lastSeq) return false
    return Date.now() - checkpoint.updatedAt < RECONCILE_RESUME_MAX_AGE_MS
  }

  private saveReconcileCheckpoint(checkpoint: ReconcileCheckpoint): void {
    this.prepareCached(
      `INSERT INTO sync_reconcile (
         scope, server_url, snapshot_seq, phase, asset_cursor, asset_max_rowid, asset_total,
         fetched, skipped_assets, skipped_folders, local_asset_max_rowid, local_folder_max_rowid,
         started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         server_url = excluded.server_url, snapshot_seq = excluded.snapshot_seq,
         phase = excluded.phase, asset_cursor = excluded.asset_cursor,
         asset_max_rowid = excluded.asset_max_rowid, asset_total = excluded.asset_total,
         fetched = excluded.fetched, skipped_assets = excluded.skipped_assets,
         skipped_folders = excluded.skipped_folders,
         local_asset_max_rowid = excluded.local_asset_max_rowid,
         local_folder_max_rowid = excluded.local_folder_max_rowid,
         started_at = excluded.started_at, updated_at = excluded.updated_at`
    ).run(
      checkpoint.scope,
      checkpoint.serverUrl,
      checkpoint.snapshotSeq,
      checkpoint.phase,
      checkpoint.assetCursor,
      checkpoint.assetMaxRowid,
      checkpoint.assetTotal,
      checkpoint.fetched,
      checkpoint.skippedAssets,
      checkpoint.skippedFolders,
      checkpoint.localAssetMaxRowid,
      checkpoint.localFolderMaxRowid,
      checkpoint.startedAt,
      Date.now()
    )
  }

  private deleteReconcileCheckpoint(scope: string): void {
    this.localDb.prepare(`DELETE FROM sync_reconcile WHERE scope = ?`).run(scope)
  }

  /** @returns 这一轮之前**没**记过这一行（第一次见） */
  private markReconcileSeen(
    scope: string,
    runId: number,
    tableName: TrackedTable,
    recordKey: string
  ): boolean {
    return (
      this.prepareCached(
        `INSERT OR IGNORE INTO sync_reconcile_seen (scope, run_id, table_name, record_key)
         VALUES (?, ?, ?, ?)`
      ).run(scope, runId, tableName, recordKey).changes > 0
    )
  }

  /**
   * 对账进行中，把一行记成「这一轮见过」—— 本地写、实时推来的变更都走这里。
   * 见 runReconcile 的说明。
   */
  private markSeenForActiveRun(tableName: TrackedTable, recordKey: string): void {
    if (this.activeRunId === null || !recordKey) return
    try {
      this.markReconcileSeen(this.getSyncStateKey(), this.activeRunId, tableName, recordKey)
    } catch (err) {
      console.warn('[SyncClient] 记录对账期间的写入失败:', err)
    }
  }

  private countReconcileSeen(scope: string, runId: number, tableName: TrackedTable): number {
    return (
      this.prepareCached(
        `SELECT COUNT(*) AS c FROM sync_reconcile_seen
         WHERE scope = ? AND run_id = ? AND table_name = ?`
      ).get(scope, runId, tableName) as { c: number }
    ).c
  }

  /**
   * 分块删「见过的集合」：几十万行一句 DELETE 也要卡主进程一两秒。
   * runId = null 删这个库所有轮次的残留（开新一轮之前）；给了就只删那一轮。
   * 被 stop() 之后不再继续 —— 剩下的留给下一轮开头清。
   */
  private async clearReconcileSeen(scope: string, runId: number | null): Promise<void> {
    const deleteChunk = this.prepareCached(
      `DELETE FROM sync_reconcile_seen
       WHERE scope = ? AND (run_id, table_name, record_key) IN (
         SELECT run_id, table_name, record_key FROM sync_reconcile_seen
         WHERE scope = ? AND (? IS NULL OR run_id = ?) LIMIT ?
       )`
    )
    for (;;) {
      const started = performance.now()
      const { changes } = deleteChunk.run(scope, scope, runId, runId, RECONCILE_SWEEP_CHUNK)
      this.writeMsSinceWalSync += performance.now() - started
      if (changes < RECONCILE_SWEEP_CHUNK || this._isStopped) return
      await this.pauseBetweenWrites()
    }
  }

  /**
   * 服务端快照里的一行写进本地，返回「本地现在有没有这一行」。
   *
   * 存不下的（缺必填列、父文件夹不在、其他约束冲突）**只跳过这一行**：以前一行
   * 外键失败就回滚整个对账事务，下次再全量、再回滚，永远同步不完。
   * 约束冲突时本地若已有旧版本，那一行仍算「在」—— 校验计数靠这个返回值对齐。
   */
  private upsertSnapshotRow(
    tableName: 'assetData' | 'assetFolder',
    row: Record<string, unknown>
  ): boolean {
    try {
      return this.applyRowUpsert(tableName, row, { bufferMissing: false }) !== 'missing'
    } catch (err) {
      const code = (err as { code?: unknown })?.code
      if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) throw err
      const keyColumn = TABLE_SPEC[tableName].keyColumn
      return Boolean(
        this.prepareCached(`SELECT 1 AS hit FROM ${tableName} WHERE ${keyColumn} = ?`).get(
          row[keyColumn]
        )
      )
    }
  }

  private writeFolderSnapshot(
    rows: Record<string, unknown>[],
    next: ReconcileCheckpoint
  ): ReconcileCheckpoint {
    const scope = next.scope
    const locallyChanged = this.buildProtectedKeys('assetFolder', next.startedAt)
    let skipped = 0
    const skippedSample: string[] = []

    const result = this.localDb.transaction(() => {
      this.localDb
        .prepare(
          `INSERT OR IGNORE INTO assetFolder (folderKey, type, folderName, fullPath, pathArray, depth, isDelete)
           VALUES ('ALL', 'folder', '全部资产', '/', '[]', 0, 0)`
        )
        .run()

      for (const row of rows) {
        const folderKey = typeof row.folderKey === 'string' ? row.folderKey : ''
        if (!folderKey) {
          skipped += 1
          continue
        }
        // 这一轮里已经被更新的变更碰过（实时推来的、本地改的）：快照是它之前的样子，别盖回去
        if (!this.markReconcileSeen(scope, next.startedAt, 'assetFolder', folderKey)) continue
        // 本地这行还有没推上去的改动 —— 服务端快照是它改之前的样子，盖下去等于
        // 把用户刚做的编辑静默回滚。等改动推成功、离开队列，下一轮自然一致
        if (locallyChanged.has(folderKey)) continue
        if (!this.upsertSnapshotRow('assetFolder', row)) {
          skipped += 1
          if (skippedSample.length < 5) skippedSample.push(folderKey)
        }
      }

      const saved = { ...next, skippedFolders: skipped }
      this.saveReconcileCheckpoint(saved)
      return saved
    })()

    if (skipped > 0) {
      console.warn(
        `[SyncClient] 服务端有 ${skipped} 个文件夹本地存不下（缺字段或父文件夹不在），已跳过。例: ${skippedSample.join(', ')}`
      )
    }
    return result
  }

  /**
   * 一页写进本地 —— **按时间切片**，每片最多占主线程 WRITE_SLICE_BUDGET_MS。
   *
   * 一页 2000 行在空库里很快，可库一大（几十万行、十几个索引）每插一行要零点几到一毫秒：
   * 实测 54 万行的库上一页一个事务要 1.4 秒，最长 7.7 秒，界面跟着卡。行数和机器快慢
   * 都不可控，能控的只有「一口气占多久」：写满预算就提交、让出事件循环，再接着写。
   * （提交时的 WAL 检查点不在这个预算里，它被挪到了查询 worker，见 assetQueryRunner。）
   *
   * 断点只在整页写完的最后一片里前进。中途断掉的话这一页会整页重拉：已经写过的行
   * 「见过」标记还在，会被跳过 —— 它们比快照新的那部分由结尾的补增量重放。
   */
  private async writeAssetPage(
    rows: Record<string, unknown>[],
    next: ReconcileCheckpoint,
    abortIfStopped: () => void
  ): Promise<ReconcileCheckpoint> {
    const scope = next.scope
    // 每页重新取一次：几分钟的拉取过程中用户可能又改了东西
    const outboxKeys = this.getPendingRecordKeys('assetData')
    let skipped = 0
    const skippedSample: string[] = []
    let index = 0

    const writeSlice = this.localDb.transaction((maxRows: number): ReconcileCheckpoint | null => {
      const deadline = performance.now() + WRITE_SLICE_BUDGET_MS
      const end = Math.min(rows.length, index + maxRows)
      while (index < end) {
        const row = rows[index]
        index += 1
        const assetKey = typeof row.assetKey === 'string' ? row.assetKey : ''
        if (!assetKey) {
          skipped += 1
        } else if (this.markReconcileSeen(scope, next.startedAt, 'assetData', assetKey)) {
          // 第一次见 —— 没被这一轮里更新的变更碰过，才拿快照写它
          const isProtected =
            outboxKeys.has(assetKey) ||
            this.wroteLocallySince('assetData', assetKey, next.startedAt)
          if (!isProtected && !this.upsertSnapshotRow('assetData', row)) {
            skipped += 1
            if (skippedSample.length < 5) skippedSample.push(assetKey)
          }
        }
        if (performance.now() >= deadline) break
      }
      if (index < rows.length) return null
      const saved = { ...next, skippedAssets: next.skippedAssets + skipped }
      this.saveReconcileCheckpoint(saved)
      return saved
    })

    // 每片写几行由上一片「写 + 提交」的实际耗时决定（sliceSizer），行循环里的时间预算只是兜底
    const runSlice = (): ReconcileCheckpoint | null => {
      const before = index
      const started = performance.now()
      const result = writeSlice(this.sliceSizer.size)
      this.recordWrite(index - before, started)
      return result
    }
    let saved = runSlice()
    while (!saved) {
      await this.pauseBetweenWrites()
      abortIfStopped()
      saved = runSlice()
    }

    if (skipped > 0) {
      console.warn(
        `[SyncClient] 本页有 ${skipped} 个资产本地存不下（缺名字/缺文件夹，或所在文件夹不在），已跳过。例: ${skippedSample.join(', ')}`
      )
    }
    return saved
  }

  private wroteLocallySince(tableName: TrackedTable, recordKey: string, since: number): boolean {
    const ts = this.recentWrites.get(`${tableName}:${recordKey}`)
    return ts !== undefined && ts >= since
  }

  /**
   * 这一轮开始时本地已有（rowid ≤ maxRowid）、服务端这一轮没给的活资产 → 软删。
   * 按 rowid 分块，块与块之间让出事件循环。范围卡死在开始时的最大 rowid ——
   * 之后才写进本地的行不可能出现在这一轮的快照里，扫到就是误删。
   */
  private async sweepUnseenAssets(
    scope: string,
    runId: number,
    protectedAssetKeys: ReadonlySet<string>,
    maxRowid: number,
    abortIfStopped: () => void
  ): Promise<number> {
    const unseenInRange = this.prepareCached(
      `SELECT ad.assetKey AS assetKey FROM assetData ad
       WHERE ad.rowid > ? AND ad.rowid <= ? AND ad.isDelete = 0
         AND NOT EXISTS (
           SELECT 1 FROM sync_reconcile_seen s
           WHERE s.scope = ? AND s.run_id = ? AND s.table_name = 'assetData'
             AND s.record_key = ad.assetKey
         )`
    )
    const seenNow = this.prepareCached(
      `SELECT 1 FROM sync_reconcile_seen
       WHERE scope = ? AND run_id = ? AND table_name = 'assetData' AND record_key = ?`
    )
    let softDeleted = 0
    for (let lower = 0; lower < maxRowid; lower += RECONCILE_SWEEP_CHUNK) {
      // 被换掉的实例不许再删任何东西：新实例会从 sweep 阶段重做一遍
      abortIfStopped()
      const upper = Math.min(lower + RECONCILE_SWEEP_CHUNK, maxRowid)
      const candidates = (unseenInRange.all(lower, upper, scope, runId) as { assetKey: string }[])
        .map((row) => row.assetKey)
        .filter((assetKey) => !protectedAssetKeys.has(assetKey))
      // 一块里可能整块都要删（服务端清掉了一大片）：跟写入一样按 sliceSizer 切片提交。
      // 片与片之间实时变更 / 本地写入会插进来（它们会记进「见过的集合」），删之前再看一眼
      for (let start = 0; start < candidates.length; ) {
        const slice = candidates.slice(start, start + this.sliceSizer.size)
        start += slice.length
        const started = performance.now()
        this.localDb.transaction(() => {
          for (const assetKey of slice) {
            if (seenNow.get(scope, runId, assetKey)) continue
            this.stmtDeleteAsset.run(assetKey)
            softDeleted += 1
          }
        })()
        this.recordWrite(slice.length, started)
        if (start < candidates.length) {
          await this.pauseBetweenWrites()
          abortIfStopped()
        }
      }
      this.emitProgress('sweep', '正在核对本地资产', upper, maxRowid)
      await this.pauseBetweenWrites()
    }
    return softDeleted
  }

  /** 文件夹只有几千个，一个事务做完；从深到浅，避免中间态出现「父没了子还在」 */
  private sweepUnseenFolders(
    scope: string,
    runId: number,
    protectedFolderKeys: ReadonlySet<string>,
    maxRowid: number
  ): number {
    let softDeleted = 0
    this.localDb.transaction(() => {
      const unseen = this.localDb
        .prepare(
          `SELECT af.folderKey AS folderKey FROM assetFolder af
           WHERE af.isDelete = 0 AND af.folderKey <> 'ALL' AND af.rowid <= ?
             AND NOT EXISTS (
               SELECT 1 FROM sync_reconcile_seen s
               WHERE s.scope = ? AND s.run_id = ? AND s.table_name = 'assetFolder'
                 AND s.record_key = af.folderKey
             )
           ORDER BY af.depth DESC`
        )
        .all(maxRowid, scope, runId) as { folderKey: string }[]
      for (const { folderKey } of unseen) {
        if (protectedFolderKeys.has(folderKey)) continue
        this.stmtDeleteFolder.run(folderKey)
        softDeleted += 1
      }
    })()
    return softDeleted
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
   * 本地缺行的修复：局部更新命中了本地没有的行（不能凭局部 payload 造行），或者新建的行
   * 挂在本地没有的文件夹下。按需把整行取回来，**不升级成全量对账**。
   *
   * 这里以前是「退回一次全量对账」，理由是局部 payload 只来自没升级的旧服务端、
   * 很少见。但还有不少库跑在旧服务端上：每来一条局部更新就是一次几十万行的全量；
   * 更糟的是对账自己也往缺行缓冲里塞「服务端那行本身就缺字段」的行，对账一完
   * 3 秒后又一轮对账 —— 永远停不下来。
   *
   * 现在：
   * - 文件夹：服务端没有按 key 取文件夹的接口，但文件夹总共几千个，把全部文件夹拉一遍
   *   （和对账的文件夹阶段同一个函数），只补本地缺的那几个。
   * - 资产：按 key 单取（GET /assets/:key），一次最多 REPAIR_MAX_ROWS 行，更多的等定期校验。
   * 先补文件夹再补资产 —— 资产缺行常常就是因为它的文件夹不在。取回来仍然存不下的放弃。
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
    const abortIfStopped = (): void => {
      if (this._isStopped) throw new Error(SYNC_ABORTED_BY_STOP)
    }

    let repaired = 0
    const folderKeys = new Set(
      batch.filter((item) => item.tableName === 'assetFolder').map((item) => item.recordKey)
    )
    if (folderKeys.size > 0) {
      const { rows } = await this.fetchFolderSnapshot(abortIfStopped)
      const wanted = rows.filter((row) => {
        const key = typeof row.folderKey === 'string' ? row.folderKey : ''
        return folderKeys.has(key) || !this.localRowExists('assetFolder', key)
      })
      this.localDb.transaction(() => {
        // rows 已按深度排好，父在子前
        for (const row of wanted) if (this.upsertSnapshotRow('assetFolder', row)) repaired += 1
      })()
    }

    const assetKeys = batch
      .filter((item) => item.tableName === 'assetData')
      .map((item) => item.recordKey)
    if (assetKeys.length > REPAIR_MAX_ROWS) {
      console.warn(
        `[SyncClient] ${assetKeys.length} 个资产缺行，本轮只补前 ${REPAIR_MAX_ROWS} 个，其余等定期校验`
      )
    }
    for (const assetKey of assetKeys.slice(0, REPAIR_MAX_ROWS)) {
      if (this._isStopped) return
      try {
        const row = await this.httpGet<Record<string, unknown>>(
          `/api/vaults/${this.config.vaultId}/assets/${encodeURIComponent(assetKey)}`
        )
        if (row && this.upsertSnapshotRow('assetData', { ...row, assetKey })) repaired += 1
      } catch (err) {
        // 404 = 服务端也没有了；其他错误下一次校验再说。都不升级成全量
        console.warn(
          `[SyncClient] 单取资产 ${assetKey} 失败:`,
          err instanceof Error ? err.message : err
        )
      }
    }
    if (repaired > 0) {
      console.log(`[SyncClient] 缺行修复：补回 ${repaired} 行`)
      this.emit('incremental-sync-done', { applied: repaired })
    }
  }

  private localRowExists(tableName: 'assetData' | 'assetFolder', recordKey: string): boolean {
    if (!recordKey) return true
    const keyColumn = TABLE_SPEC[tableName].keyColumn
    return Boolean(
      this.prepareCached(`SELECT 1 AS hit FROM ${tableName} WHERE ${keyColumn} = ?`).get(recordKey)
    )
  }

  /**
   * 应用增量变更到本地 SQLite。
   *
   * 1. 同一条记录的多次变更先按 seq 合成一次（coalesceChanges），再按外键先后排序：
   *    folder upsert (depth↑) → asset upsert → asset delete → folder delete (depth↓)。
   * 2. 外键失败的延迟到第二轮重试；第二轮还失败（新建的行挂在本地没有的文件夹下）
   *    **只跳过那一条**，并把它和它的父文件夹登记去补（scheduleMissingRowRepair）。
   *    以前是整批回滚、退回一次全量对账 —— 服务端只要有一个「文件夹已经不在了」的资产，
   *    有人碰它一下，所有客户端就各自重下一遍全库；实时变更攒批之后还会连累同批的
   *    几百条好变更一起回滚。
   * 3. 其他错误整批回滚并上抛，lastSeq 不推进。
   *
   * advanceSeqTo = null：写完不推进 lastSeq（分片写入的中间片、对账进行中的实时变更、
   * 有空档的实时变更）。
   */
  private applyChanges(
    changes: ChangeLogEntry[],
    options: { presorted?: boolean; advanceSeqTo?: number | null } = {}
  ): void {
    const sorted = options.presorted ? changes : this.sortChanges(this.coalesceChanges(changes))
    const advance = options.advanceSeqTo !== null
    const targetSeq =
      options.advanceSeqTo ??
      changes.reduce((max, change) => Math.max(max, change.seq), this.lastSeq)
    const skippedSample: string[] = []

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

      // 第二轮：重试 deferred（父行此时应已存在）。还不行就只跳过这一条
      for (const change of deferred) {
        try {
          this.applySingleChange(change)
        } catch (err) {
          if (!this.isForeignKeyError(err)) throw err
          this.skipOrphanChange(change)
          if (skippedSample.length < 5)
            skippedSample.push(`${change.tableName}:${change.recordKey}`)
        }
      }

      // 全部写完才写 sync_state 表。持久化的值不能比内存里的小（别把已经越过的 seq 写回去）
      if (advance) this.saveSyncStateWithSeq(Math.max(this.lastSeq, targetSeq))
    })
    tx()

    // ✅ tx() 成功返回后才更新内存中的 lastSeq
    if (advance) this.lastSeq = Math.max(this.lastSeq, targetSeq)
    if (skippedSample.length > 0) {
      console.warn(
        `[SyncClient] 增量里有变更挂在本地不存在的文件夹下，已跳过并登记补齐。例: ${skippedSample.join(', ')}`
      )
    }
  }

  /** 外键第二轮仍失败的变更：跳过，登记补它的父文件夹和它自己；本地没有这一行的计入校验偏差 */
  private skipOrphanChange(change: ChangeLogEntry): void {
    if (change.tableName !== 'assetData' && change.tableName !== 'assetFolder') return
    let parentKey = ''
    try {
      const data = change.payload ? (JSON.parse(change.payload) as Record<string, unknown>) : {}
      const parent = change.tableName === 'assetData' ? data.folderKey : data.fatherKey
      parentKey = typeof parent === 'string' ? parent : ''
    } catch {
      // payload 解析不了就只补它自己
    }
    if (parentKey) this.missingRowBuffer.push({ tableName: 'assetFolder', recordKey: parentKey })
    this.missingRowBuffer.push({ tableName: change.tableName, recordKey: change.recordKey })
    if (!this.localRowExists(change.tableName, change.recordKey)) {
      if (change.tableName === 'assetData') this.incrementalSkips.assets += 1
      else this.incrementalSkips.folders += 1
    }
  }

  /**
   * 同一条记录在一批里的多次变更，按 seq 先后合成一次。
   *
   * sortChanges 为了外键先后把「资产新建/更新」排在「资产删除」前面、文件夹按深度排 ——
   * 同一条记录的两次变更被拆开重排的话，「删了又恢复」会变成「恢复了又删」，
   * 「移动两次」会停在第一次的位置。合成之后每条记录只剩一次，怎么排都不改结果：
   * 删除之后的新建/更新只保留删除之后的部分；连续的新建/更新把各次的列按先后叠起来。
   */
  private coalesceChanges(changes: ChangeLogEntry[]): ChangeLogEntry[] {
    const merged = new Map<string, ChangeLogEntry>()
    for (const change of [...changes].sort((a, b) => a.seq - b.seq)) {
      const key = `${change.tableName}:${change.recordKey}`
      const prev = merged.get(key)
      if (!prev || change.op === 'delete' || prev.op === 'delete') {
        merged.set(key, change)
        continue
      }
      try {
        const prevData = prev.payload ? (JSON.parse(prev.payload) as Record<string, unknown>) : {}
        const nextData = change.payload
          ? (JSON.parse(change.payload) as Record<string, unknown>)
          : {}
        merged.set(key, {
          ...change,
          op: prev.op === 'insert' ? 'insert' : change.op,
          payload: JSON.stringify({ ...prevData, ...nextData })
        })
      } catch {
        merged.set(key, change)
      }
    }
    return [...merged.values()]
  }

  /**
   * 一大批增量分片写：服务端一次最多给 5000 条，几十万行的库上一个事务写完要好几秒。
   * 片与片之间让出事件循环；lastSeq 只在最后一片写完时推进 —— 中途失败或被停掉，
   * 下次从原来的 seq 重拉，已经写进去的那几片重放一遍是幂等的。
   *
   * - 文件夹的新建/更新整批放第一片、文件夹删除整批放最后一片（文件夹只有几千个）：
   *   外键的先后在文件夹之间，切开的话父文件夹可能落进后面的片。
   * - 写的过程中实时变更先攒着（applyingSlices），写完再落：它们比这批新，夹在片与片之间
   *   写的话，后面的旧片会把它们盖回去；它还会把 lastSeq 推到这批前面去 —— 这批要是中途
   *   被停掉，剩下的就永远拉不回来了。
   */
  private async applyChangesInSlices(
    changes: ChangeLogEntry[],
    options: { advance?: boolean } = {}
  ): Promise<void> {
    // 同一时刻只有一批在分片写：拉取的一批和实时推来的一大批交错着写，旧的会把新的盖回去
    while (this.slicedApply) await this.slicedApply.catch(() => undefined)
    let release!: () => void
    this.slicedApply = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await this.applyChangesInSlicesExclusive(changes, options)
    } finally {
      this.slicedApply = null
      release()
    }
  }

  private async applyChangesInSlicesExclusive(
    changes: ChangeLogEntry[],
    options: { advance?: boolean }
  ): Promise<void> {
    const advance = options.advance !== false
    const finalSeqOf = (list: ChangeLogEntry[]): number =>
      list.reduce((max, change) => Math.max(max, change.seq), this.lastSeq)
    if (advance) {
      // 拉取发出去到回来之间，实时变更可能已经接着 lastSeq 往后写过了：lastSeq 及以前的
      // 都已经写进本地（lastSeq 只在接得上时才推进），再写一遍只会拿旧值盖新值
      const finalSeq = finalSeqOf(changes)
      changes = changes.filter((change) => change.seq > this.lastSeq)
      if (changes.length === 0) {
        if (finalSeq > this.lastSeq)
          this.applyChanges([], { presorted: true, advanceSeqTo: finalSeq })
        return
      }
    }
    if (changes.length <= this.sliceSizer.size) {
      this.timedApplyChanges(changes, advance ? {} : { advanceSeqTo: null })
      return
    }
    const sorted = this.sortChanges(this.coalesceChanges(changes))
    const finalSeq = finalSeqOf(changes)
    const folderUpserts = sorted.filter((c) => c.tableName === 'assetFolder' && c.op !== 'delete')
    const folderDeletes = sorted.filter((c) => c.tableName === 'assetFolder' && c.op === 'delete')
    const rest = sorted.filter((c) => c.tableName !== 'assetFolder')

    this.applyingSlices = true
    try {
      if (folderUpserts.length > 0) {
        this.timedApplyChanges(folderUpserts, { presorted: true, advanceSeqTo: null })
        await this.pauseBetweenWrites()
        if (this._isStopped) throw new Error(SYNC_ABORTED_BY_STOP)
      }
      let start = 0
      while (start < rest.length) {
        // 片的大小跟着上一片的实际耗时走（sliceSizer），见 adaptiveSlice.ts
        const slice = rest.slice(start, start + this.sliceSizer.size)
        start += slice.length
        const isLast = start >= rest.length && folderDeletes.length === 0
        this.timedApplyChanges(slice, {
          presorted: true,
          advanceSeqTo: isLast && advance ? finalSeq : null
        })
        if (!isLast) {
          await this.pauseBetweenWrites()
          if (this._isStopped) throw new Error(SYNC_ABORTED_BY_STOP)
        }
      }
      if (folderDeletes.length > 0) {
        this.timedApplyChanges(folderDeletes, {
          presorted: true,
          advanceSeqTo: advance ? finalSeq : null
        })
      } else if (rest.length === 0 && advance) {
        // 整批只有文件夹新建/更新：上面那一片没推进 seq，在这里补上
        this.applyChanges([], { presorted: true, advanceSeqTo: finalSeq })
      }
    } finally {
      this.applyingSlices = false
      if (this.wsChangeBuffer.length > 0 && !this._isStopped) this.scheduleWsFlush()
    }
  }

  /** applyChanges，顺带把「写 + 提交」花了多久记下来（见 recordWrite） */
  private timedApplyChanges(
    changes: ChangeLogEntry[],
    options: { presorted?: boolean; advanceSeqTo?: number | null } = {}
  ): void {
    const started = performance.now()
    this.applyChanges(changes, options)
    this.recordWrite(changes.length, started)
  }

  /** 一片写完：耗时报给 sliceSizer（定下一片写几行），也记进「距上次追平 WAL 写了多久」 */
  private recordWrite(rows: number, started: number): void {
    const elapsed = performance.now() - started
    this.sliceSizer.record(rows, elapsed)
    this.writeMsSinceWalSync += elapsed
  }

  /** 两片写入之间：让出事件循环；累计写满 WAL_SYNC_EVERY_MS 就先等 WAL 追平一次 */
  private async pauseBetweenWrites(): Promise<void> {
    if (this.writeMsSinceWalSync >= WAL_SYNC_EVERY_MS) await this.waitForWal()
    await yieldToEventLoop()
  }

  /**
   * 等 worker 把 WAL 追平一次（没给 waitForWalCheckpoint 就不等）。异步等，界面照常。
   *
   * 两个用处：
   * - 连续写入时：检查点在 worker 里做（见 assetQueryRunner），可主线程一直在写，worker 就
   *   永远差最后一点，WAL 只追加不复用 —— 54 万行对账实测长到 7 GB。停下来等这一会儿，
   *   worker 一次抄完，下一次写就从 WAL 开头复用。实测 WAL 稳定在几十 MB，总吞吐反而比
   *   每次提交在主线程上顺带检查点还高。
   * - 整表读之前：还在 WAL 里的页只能一页一次 ReadFile 地读（内存映射只覆盖主库文件），
   *   刚写完一大批时整表数一遍「见过的集合」要好几秒。追平之后新开的读直接走主库文件。
   */
  private async waitForWal(): Promise<void> {
    this.writeMsSinceWalSync = 0
    const wait = this.config.waitForWalCheckpoint
    if (!wait) return
    this.waitingForWal = true
    try {
      await wait()
    } catch {
      // 等不到就不等了：主连接的自动检查点还在兜底
    } finally {
      this.waitingForWal = false
    }
  }

  /** 排序: folder upserts (shallow first) → asset upserts → asset deletes → folder deletes (deep first) */
  private sortChanges(changes: ChangeLogEntry[]): ChangeLogEntry[] {
    const order = (c: ChangeLogEntry): number => {
      if (c.tableName === 'assetFolder') return c.op === 'delete' ? 30 : 0
      if (c.tableName === 'assetData') return c.op === 'delete' ? 20 : 10
      return 40
    }
    // 深度每条只算一次：比较函数里现算的话，每次比较都要解析一遍 JSON、查一次库
    const depth = new Map<ChangeLogEntry, number>()
    for (const change of changes) {
      if (change.tableName === 'assetFolder') depth.set(change, this.parseDepth(change))
    }
    return [...changes].sort((a, b) => {
      const diff = order(a) - order(b)
      if (diff !== 0) return diff
      if (a.tableName === 'assetFolder' && b.tableName === 'assetFolder') {
        const dA = depth.get(a) ?? 0
        const dB = depth.get(b) ?? 0
        if (a.op === 'delete') return dB - dA
        return dA - dB
      }
      return a.seq - b.seq
    })
  }

  private applySingleChange(change: ChangeLogEntry): void {
    const data = change.payload ? (JSON.parse(change.payload) as Record<string, unknown>) : null

    if (change.tableName === 'assetData') {
      if (change.op === 'delete') {
        this.stmtDeleteAsset.run(change.recordKey)
      } else {
        if (!data) return
        // recordKey 兜底：即使 payload 里没带主键也能定位到行
        const result = this.applyRowUpsert('assetData', { assetKey: change.recordKey, ...data })
        // 本地还没有这行、局部 payload 又造不出来：没写进去，就别记「见过」——
        // 记了的话它所在的快照页晚到时会被跳过，这一行就永远进不来了
        if (result === 'missing') return
      }
      // 对账进行中：这条比快照新，记成「这一轮见过」，见 runReconcile
      this.markSeenForActiveRun('assetData', change.recordKey)
      return
    }

    if (change.tableName === 'assetFolder') {
      if (change.op === 'delete') {
        this.stmtDeleteFolder.run(change.recordKey)
      } else {
        if (!data) return
        const result = this.applyRowUpsert('assetFolder', { folderKey: change.recordKey, ...data })
        if (result === 'missing') return
      }
      this.markSeenForActiveRun('assetFolder', change.recordKey)
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
   * 「只在值变了时才写」的 UPDATE，按列组合缓存。
   *
   * 列名拼起来当键，不拿整句 SQL 当键：整句有一千多字符（三十几列的 SET 加三十几个
   * IS NOT），对账时每行都要重新拼一遍、再哈希一遍，54 万行就是几秒的主线程 CPU。
   */
  private changedOnlyUpdate(
    tableName: 'assetData' | 'assetFolder',
    keyColumn: string,
    columns: string[]
  ): Database.Statement {
    const cacheKey = `upd:${tableName}:${columns.join(',')}`
    let stmt = this.stmtCache.get(cacheKey)
    if (!stmt) {
      if (this.stmtCache.size > 200) this.stmtCache.clear()
      const setClause = columns.map((col) => `${col} = @${col}`).join(', ')
      // 扩展名：本地还没迁移的老行是 '.wav'，传进来的已经规整成 'wav' —— 这算没变。
      // 不然迁移跑完之前赶上的那轮对账会把每一行带点的都重写一遍（刷 updated_at、触发重建索引），
      // 老行留给 normalizeStoredExtensions 去改，它不碰 updated_at
      const changedClause = columns
        .map((col) =>
          tableName === 'assetData' && EXTENSION_COLUMNS.has(col)
            ? `(${col} IS NOT @${col} AND ${col} IS NOT ('.' || @${col}))`
            : `${col} IS NOT @${col}`
        )
        .join(' OR ')
      stmt = this.localDb.prepare(
        `UPDATE ${tableName} SET ${setClause}, updated_at = datetime('now','localtime')
         WHERE ${keyColumn} = @${keyColumn} AND (${changedClause})`
      )
      this.stmtCache.set(cacheKey, stmt)
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
    row: Record<string, unknown>,
    options: { bufferMissing?: boolean } = {}
  ): 'updated' | 'unchanged' | 'inserted' | 'missing' {
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
    for (const col of columns) {
      const value =
        tableName === 'assetData' && EXTENSION_COLUMNS.has(col)
          ? normalizeExtensionValue(row[col])
          : row[col]
      params[col] = normalizeBindValue(value)
    }

    if (columns.length > 0) {
      /**
       * 值没变的行**不写**。
       *
       * 以前每次 UPDATE 都会落盘：对账一轮就是把几十万行整行重写一遍、十几个索引全部
       * 重排，而 assetData 上挂着 AFTER UPDATE 触发器 —— 每一行都被标成「搜索索引要重建」
       * （向量索引开着的话还要重新算向量）。重建完之前关键词搜索退回 LIKE 全表扫，
       * updated_at 也被刷成「同步的那一刻」，按修改时间排序整个乱掉。
       *
       * `IS NOT` 而不是 `<>`：两边有 NULL 时 `<>` 得 NULL，会把「NULL → 有值」当成没变。
       */
      const result = this.changedOnlyUpdate(tableName, keyColumn, columns).run(params)
      if (result.changes > 0) return 'updated'
    }
    // 没写成：要么本地没有这行，要么值全都一样
    const hit = this.prepareCached(`SELECT 1 AS hit FROM ${tableName} WHERE ${keyColumn} = ?`).get(
      recordKey
    )
    if (hit) return 'unchanged'

    const complete = spec.requiredColumns.every((col) => {
      const value = row[col]
      return value !== undefined && value !== null && value !== ''
    })
    if (!complete) {
      if (options.bufferMissing !== false) this.missingRowBuffer.push({ tableName, recordKey })
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

  private scheduleWsFlush(): void {
    if (this.wsFlushTimer || this._isStopped) return
    this.wsFlushTimer = setTimeout(() => this.flushWsChanges(), WS_CHANGE_BATCH_DELAY_MS)
  }

  /**
   * 把攒下的实时变更一次性写进本地，再往界面发**一条**汇总通知。
   *
   * 服务端是一行一条推过来的，批量操作（删一个大文件夹、扫描入库）就是几万条连发。
   * 以前每条一个事务 + 一次落盘 + 一条带整行 payload 的 IPC：十万条就是十万次提交，
   * 主进程被占满几十分钟，界面那边再被十万条消息淹掉。现在攒一小批（最多
   * WS_CHANGE_BATCH_MAX 条或 WS_CHANGE_BATCH_DELAY_MS）一个事务写完。
   *
   * 攒批带来三条规矩：
   * - 一批里同一条记录的多次变更按 seq 合成（applyChanges → coalesceChanges），
   *   不然「删了又恢复」会被外键排序拆开重排成「恢复了又删」。
   * - seq 不大于 lastSeq 的丢掉：那一段已经被增量拉取写过了，拉取写的可能是更新的样子。
   *   增量正在分片写入时整批先不落，等它写完（见 applyChangesInSlices）。
   * - 只有接得上（最小的 seq 紧挨着 lastSeq）且没有对账在跑时才推进 lastSeq。
   *   中间有空档就照样写，但 lastSeq 留在原地，发一次增量拉取把空档补上 —— 以前直接
   *   取最大值，对账刚把 lastSeq 退回快照点，下一条实时变更就把中间那段整个跳过去了。
   */
  private flushWsChanges(): void {
    if (this.wsFlushTimer) {
      clearTimeout(this.wsFlushTimer)
      this.wsFlushTimer = null
    }
    if (this._isStopped) {
      this.wsChangeBuffer = []
      return
    }
    if (this.applyingSlices || this.waitingForWal) {
      this.scheduleWsFlush()
      return
    }
    if (this.config.waitForWalCheckpoint && this.writeMsSinceWalSync >= WAL_SYNC_EVERY_MS) {
      // 实时变更连着来（同事在导入一大批）：跟分片写入一样，隔一会儿等 WAL 追平一次
      void this.pauseBetweenWrites().then(() => this.scheduleWsFlush())
      return
    }
    const batch = this.wsChangeBuffer.splice(0).filter((entry) => entry.seq > this.lastSeq)
    if (batch.length === 0) return

    const minSeq = batch.reduce((min, entry) => Math.min(min, entry.seq), Infinity)
    const contiguous = this.activeRunId === null && minSeq <= this.lastSeq + 1
    // 界面只关心「哪张表动了」：文件夹动了要刷目录树，其余只刷列表。
    // 单条时照旧带上这一条的详情。
    // 写完才发：分片写时立刻发，界面防抖 500ms 后读到的只有第一片，之后再没有通知来刷新
    const notify = (): void => {
      const last = batch[batch.length - 1]
      const touchedFolders = batch.some((entry) => entry.tableName === 'assetFolder')
      this.emit(
        'change',
        batch.length === 1
          ? {
              seq: last.seq,
              op: last.op,
              tableName: last.tableName,
              recordKey: last.recordKey,
              payload: last.payload
            }
          : {
              seq: Math.max(...batch.map((entry) => entry.seq)),
              op: 'batch',
              tableName: touchedFolders ? 'assetFolder' : 'assetData',
              recordKey: '',
              payload: null,
              count: batch.length
            }
      )
    }
    const afterApply = (): void => {
      notify()
      this.scheduleMissingRowRepair()
      if (!contiguous && this.activeRunId === null) {
        this.pullChanges().catch((pullErr) => {
          console.warn('[SyncClient] 补空档拉取失败:', (pullErr as Error).message)
        })
      }
    }
    const onFailure = (err: unknown): void => {
      if (err instanceof Error && err.message === SYNC_ABORTED_BY_STOP) return
      // 分片写到一半失败时前面几片已经落了，照样让界面刷一次
      notify()
      console.warn('[SyncClient] WS 变更应用失败，补拉增量同步:', err)
      this.pullChanges().catch((pullErr) => {
        console.warn('[SyncClient] 补拉同步失败:', (pullErr as Error).message)
      })
    }
    if (batch.length <= this.sliceSizer.size) {
      try {
        this.timedApplyChanges(batch, contiguous ? {} : { advanceSeqTo: null })
      } catch (err) {
        onFailure(err)
        return
      }
      afterApply()
    } else {
      // 一批太大（同事删了一个大文件夹）：分片写，写的过程中后面来的实时变更继续攒着
      this.applyChangesInSlices(batch, { advance: contiguous }).then(afterApply, onFailure)
    }
  }

  private handleWsMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'change': {
        this.wsChangeBuffer.push({
          seq: msg.seq,
          op: msg.op,
          tableName: msg.tableName,
          recordKey: msg.recordKey,
          payload: msg.payload,
          clientId: msg.clientId,
          createdAt: Date.now()
        })
        if (this.wsChangeBuffer.length >= WS_CHANGE_BATCH_MAX && !this.applyingSlices) {
          this.flushWsChanges()
        } else {
          this.scheduleWsFlush()
        }
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
        if (this._isStopped) return
        this.connectWs()
        // 启动失败、靠重连恢复的客户端也要有定时校验和推送重试
        this.ensurePeriodicTimers()
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

    const { assets: localAssetCount, folders: localFolderCount } = this.localCountsForChecksum()

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

  /** 和服务端 /checksum 比的本地条数 */
  private localCountsForChecksum(): { assets: number; folders: number } {
    // 只扣 insert：pending 的 update 对应的行服务端本来就有，不该扣
    const localOnlyAssets = this.getPendingRecordKeys('assetData', 'insert').size
    const localOnlyFolders = this.getPendingRecordKeys('assetFolder', 'insert').size
    // 上一轮对账里服务端给了、本地存不下的行（缺字段、父文件夹不在）要加回去：
    // 不加的话计数永远差这几行，每两次校验就升级成一次全量对账 —— 每小时一次
    return {
      assets:
        this.countLocalActive('assetData') -
        localOnlyAssets +
        this.lastReconcileSkips.assets +
        this.incrementalSkips.assets,
      folders:
        this.countLocalActive('assetFolder') -
        localOnlyFolders +
        this.lastReconcileSkips.folders +
        this.incrementalSkips.folders
    }
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
