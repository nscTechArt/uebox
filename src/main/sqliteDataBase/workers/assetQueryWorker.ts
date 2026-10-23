/**
 * 资产库查询 worker —— 慢查询只会慢，不会把整个软件卡死。
 *
 * better-sqlite3 是同步 API，以前所有查询都在主进程里跑：主进程同时是 IPC 枢纽和
 * 窗口事件循环，一条要几秒的查询（52 万行的库上按类型筛、按时间排、关键词 LIKE）
 * 跑完之前，窗口拖不动、按钮点不了、别的 IPC 全在排队 —— 用户看到的就是「卡死」。
 * 过去的修法是一条一条地给慢查询补索引，补一个冒一个。
 *
 * 这里干两件事，都不在主线程上：
 * - 资产库的列表查询：用自己的**只读**连接读同一个库文件（WAL 模式下读写互不阻塞）。
 * - WAL 检查点：每秒对每个托管的库做一次 PASSIVE 检查点（不等任何读写，能抄多少抄多少），
 *   大批量写入的一方还会隔一会儿叫这里当场做一次（checkpoint-wal）。见 assetQueryRunner 文件头。
 *
 * 读连接空闲一会儿就关：Windows 上开着的句柄会挡住保管库的移动、删除、恢复备份。
 * 主进程在这些操作之前还会显式让这里放手（release）。
 */
import { parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { countAssetsByEngineVersion, searchAssetsByCriteria } from '../models/assetSearchCore'
import type { AssetQueryRequest, AssetQueryResponse } from '../services/assetQueryProtocol'
import { applyVaultConnectionPragmas } from '../vaultConnectionPragmas'

/** 多久没有查询就关掉读连接 */
const IDLE_CLOSE_MS = 10_000
/** 多久做一次 PASSIVE 检查点 */
const CHECKPOINT_INTERVAL_MS = 1_000

interface OpenDb {
  path: string
  db: Database.Database
}

let vaultDb: OpenDb | null = null
let publicDb: OpenDb | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
const walWatchers = new Map<
  string,
  { db: Database.Database; timer: ReturnType<typeof setInterval> }
>()

function openReadonly(path: string, mmap: boolean): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  applyVaultConnectionPragmas(db, { readonly: true, mmap })
  return db
}

function ensure(current: OpenDb | null, path: string, mmap: boolean): OpenDb {
  if (current && current.path === path && current.db.open) return current
  if (current) closeQuietly(current.db)
  return { path, db: openReadonly(path, mmap) }
}

function closeQuietly(db: Database.Database | null | undefined): void {
  if (!db) return
  try {
    db.close()
  } catch {
    // 关不掉也不影响下一次重新打开
  }
}

function closeReaders(): void {
  closeQuietly(vaultDb?.db)
  closeQuietly(publicDb?.db)
  vaultDb = null
  publicDb = null
}

function unwatch(path: string): void {
  const watcher = walWatchers.get(path)
  if (!watcher) return
  clearInterval(watcher.timer)
  walWatchers.delete(path)
  closeQuietly(watcher.db)
}

function checkpoint(db: Database.Database): { log: number; checkpointed: number } | null {
  try {
    return db.pragma('wal_checkpoint(PASSIVE)')[0] as { log: number; checkpointed: number }
  } catch {
    // 忙就下一秒再来；PASSIVE 本来就不等锁
    return null
  }
}

function watch(path: string): void {
  if (walWatchers.has(path)) return
  const db = new Database(path, { fileMustExist: true })
  db.pragma('busy_timeout = 0')
  const timer = setInterval(() => checkpoint(db), CHECKPOINT_INTERVAL_MS)
  walWatchers.set(path, { db, timer })
}

function releaseAll(): void {
  closeReaders()
  for (const path of [...walWatchers.keys()]) unwatch(path)
}

function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(closeReaders, IDLE_CLOSE_MS)
}

function runSearch(
  request: Extract<AssetQueryRequest, { op: 'search' | 'engine-facet' }>
): unknown[] {
  vaultDb = ensure(vaultDb, request.vaultDbPath, request.mmap)
  let pub: Database.Database | null = null
  if (request.publicDbPath) {
    try {
      // 公共库不做内存映射：恢复备份要原地覆盖这个文件，被映射着的文件在 Windows 上覆盖不了
      publicDb = ensure(publicDb, request.publicDbPath, false)
      pub = publicDb.db
    } catch {
      // 公共库打不开只影响「关键词顺带匹配标签名」，资产照常搜
      pub = null
    }
  }
  const query = request.op === 'engine-facet' ? countAssetsByEngineVersion : searchAssetsByCriteria
  return query(vaultDb.db, request.criteria, { publicDb: pub })
}

function handle(request: AssetQueryRequest): unknown {
  switch (request.op) {
    case 'search':
    case 'engine-facet':
      return runSearch(request)
    case 'release':
      releaseAll()
      return null
    case 'watch-wal':
      watch(request.path)
      return null
    case 'unwatch-wal':
      unwatch(request.path)
      return null
    case 'checkpoint-wal': {
      const watcher = walWatchers.get(request.path)
      return watcher ? checkpoint(watcher.db) : null
    }
  }
}

parentPort?.on('message', (request: AssetQueryRequest) => {
  let response: AssetQueryResponse
  try {
    response = { id: request.id, ok: true, data: handle(request) }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: unknown })?.code as string | undefined
    }
  }
  if (request.op === 'search' || request.op === 'engine-facet') armIdleClose()
  parentPort?.postMessage(response)
})
