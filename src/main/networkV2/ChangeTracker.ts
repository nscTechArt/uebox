/**
 * ChangeTracker — 变更日志管理器
 *
 * 负责：
 * 1. 初始化 change_log / sync_clients 表
 * 2. 记录每次写操作到 change_log
 * 3. 定期清理过期日志
 * 4. 提供增量拉取接口
 */
import Database from 'better-sqlite3'
import type {
  ChangeLogEntry,
  ChangeOp,
  TrackedTable,
  ChecksumResponse,
  SyncClientInfo
} from './SyncProtocol'

export class ChangeTracker {
  private db: Database.Database
  private maxEntries: number

  // 预编译 SQL 语句（性能关键路径）
  private stmtInsert!: Database.Statement
  private stmtGetSince!: Database.Statement
  private stmtGetLatestSeq!: Database.Statement
  private stmtMinSeq!: Database.Statement

  constructor(db: Database.Database, maxEntries = 100_000) {
    this.db = db
    this.maxEntries = maxEntries
    this.initTables()
    this.prepareStatements()
  }

  // ─────────────────────────── 初始化 ───────────────────────────

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS change_log (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        op          TEXT    NOT NULL,
        table_name  TEXT    NOT NULL,
        record_key  TEXT    NOT NULL,
        payload     TEXT,
        client_id   TEXT    NOT NULL DEFAULT 'server',
        created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_cl_seq ON change_log(seq);
      CREATE INDEX IF NOT EXISTS idx_cl_created ON change_log(created_at);

      CREATE TABLE IF NOT EXISTS sync_clients (
        client_id   TEXT PRIMARY KEY,
        hostname    TEXT,
        last_seq    INTEGER DEFAULT 0,
        last_seen   INTEGER,
        ip          TEXT
      );
    `)
  }

  private prepareStatements(): void {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO change_log (op, table_name, record_key, payload, client_id)
      VALUES (?, ?, ?, ?, ?)
    `)

    this.stmtGetSince = this.db.prepare(`
      SELECT seq, op, table_name AS tableName, record_key AS recordKey,
             payload, client_id AS clientId, created_at AS createdAt
      FROM change_log
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `)

    this.stmtGetLatestSeq = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS latestSeq FROM change_log
    `)

    this.stmtMinSeq = this.db.prepare(`
      SELECT COALESCE(MIN(seq), 0) AS minSeq FROM change_log
    `)
  }

  // ─────────────────────────── 写入 ───────────────────────────

  /**
   * 记录一条变更
   * @returns 新创建的 seq
   */
  record(
    op: ChangeOp,
    tableName: TrackedTable,
    recordKey: string,
    payload: Record<string, unknown> | null,
    clientId = 'server'
  ): number {
    const payloadStr = payload ? JSON.stringify(payload) : null
    const result = this.stmtInsert.run(op, tableName, recordKey, payloadStr, clientId)
    return Number(result.lastInsertRowid)
  }

  /**
   * 批量记录变更（在事务内）
   * @returns 最后一条的 seq
   */
  recordBatch(
    entries: Array<{
      op: ChangeOp
      tableName: TrackedTable
      recordKey: string
      payload: Record<string, unknown> | null
      clientId?: string
    }>
  ): number {
    let lastSeq = 0
    const tx = this.db.transaction(() => {
      for (const entry of entries) {
        const payloadStr = entry.payload ? JSON.stringify(entry.payload) : null
        const result = this.stmtInsert.run(
          entry.op,
          entry.tableName,
          entry.recordKey,
          payloadStr,
          entry.clientId || 'server'
        )
        lastSeq = Number(result.lastInsertRowid)
      }
    })
    tx()
    return lastSeq
  }

  // ─────────────────────────── 读取 ───────────────────────────

  /**
   * 获取指定 seq 之后的变更列表
   * @param sinceSeq 起始 seq（不包含）
   * @param limit 最大返回条数
   */
  getChangesSince(sinceSeq: number, limit = 5000): ChangeLogEntry[] {
    return this.stmtGetSince.all(sinceSeq, limit) as ChangeLogEntry[]
  }

  /** 获取当前最新 seq */
  getLatestSeq(): number {
    const row = this.stmtGetLatestSeq.get() as { latestSeq: number }
    return row.latestSeq
  }

  /** 获取当前最小 seq（用于判断 Client 是否落后太多） */
  getMinSeq(): number {
    const row = this.stmtMinSeq.get() as { minSeq: number }
    return row.minSeq
  }

  /**
   * 检查 Client 是否需要全量同步
   * 如果 Client 的 lastSeq < 当前最小 seq，说明其历史已被清理
   */
  isFullSyncRequired(clientLastSeq: number): boolean {
    if (clientLastSeq === 0) return true
    return clientLastSeq < this.getMinSeq()
  }

  /** 获取校验摘要（用于 Client 定期校验） */
  getChecksum(): ChecksumResponse {
    const assetCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM assetData WHERE isDelete = 0').get() as {
        c: number
      }
    ).c

    const folderCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM assetFolder WHERE isDelete = 0').get() as {
        c: number
      }
    ).c

    return {
      assetCount,
      folderCount,
      latestSeq: this.getLatestSeq()
    }
  }

  // ─────────────────────────── Client 注册 ───────────────────────────

  /** 注册或更新 Client */
  upsertClient(clientId: string, hostname: string, ip: string, lastSeq: number): void {
    this.db
      .prepare(
        `
      INSERT INTO sync_clients (client_id, hostname, last_seq, last_seen, ip)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        hostname = excluded.hostname,
        last_seq = excluded.last_seq,
        last_seen = excluded.last_seen,
        ip = excluded.ip
    `
      )
      .run(clientId, hostname, lastSeq, Date.now(), ip)
  }

  /** 更新 Client 的 lastSeq */
  updateClientSeq(clientId: string, lastSeq: number): void {
    this.db
      .prepare(
        `
      UPDATE sync_clients SET last_seq = ?, last_seen = ? WHERE client_id = ?
    `
      )
      .run(lastSeq, Date.now(), clientId)
  }

  /** 获取所有已注册 Client */
  getAllClients(): SyncClientInfo[] {
    return this.db.prepare(`SELECT * FROM sync_clients`).all() as SyncClientInfo[]
  }

  // ─────────────────────────── 清理 ───────────────────────────

  /**
   * 清理过期的 change_log 条目
   * 只保留最近 maxEntries 条，但不删除任何 Client 还需要的条目
   */
  cleanup(): { deleted: number } {
    const latestSeq = this.getLatestSeq()
    if (latestSeq <= this.maxEntries) return { deleted: 0 }

    // 找到所有活跃 Client 的最小 lastSeq
    const minClientSeq = (
      this.db
        .prepare(
          `
        SELECT COALESCE(MIN(last_seq), 0) AS minSeq
        FROM sync_clients
        WHERE last_seen > ?
      `
        )
        .get(Date.now() - 7 * 24 * 3600 * 1000) as { minSeq: number }
    ).minSeq

    // 安全删除边界 = max(latestSeq - maxEntries, 但不低于活跃 Client 的最小 seq)
    const safeDeleteBelow = Math.min(latestSeq - this.maxEntries, minClientSeq)
    if (safeDeleteBelow <= 0) return { deleted: 0 }

    const result = this.db
      .prepare(
        `
      DELETE FROM change_log WHERE seq < ?
    `
      )
      .run(safeDeleteBelow)

    if (result.changes > 0) {
      console.log(`[ChangeTracker] 清理了 ${result.changes} 条过期日志 (seq < ${safeDeleteBelow})`)
    }

    return { deleted: result.changes }
  }

  /**
   * 清理超过 7 天未活跃的 Client 注册信息
   */
  cleanupStaleClients(): { deleted: number } {
    const threshold = Date.now() - 7 * 24 * 3600 * 1000
    const result = this.db
      .prepare(
        `
      DELETE FROM sync_clients WHERE last_seen < ?
    `
      )
      .run(threshold)

    if (result.changes > 0) {
      console.log(`[ChangeTracker] 清理了 ${result.changes} 个过期客户端注册`)
    }

    return { deleted: result.changes }
  }
}
