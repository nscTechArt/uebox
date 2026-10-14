/**
 * 资产库列表查询 worker —— 慢查询只会慢，不会把整个软件卡死。
 *
 * better-sqlite3 是同步 API，以前所有查询都在主进程里跑：主进程同时是 IPC 枢纽和
 * 窗口事件循环，一条要几秒的查询（52 万行的库上按类型筛、按时间排、关键词 LIKE）
 * 跑完之前，窗口拖不动、按钮点不了、别的 IPC 全在排队 —— 用户看到的就是「卡死」。
 * 过去的修法是一条一条地给慢查询补索引，补一个冒一个。
 *
 * 这里把资产库的列表查询挪到 worker 线程，用自己的**只读**连接读同一个库文件
 * （WAL 模式下读写互不阻塞）。主进程照常写，界面照常响应；查询再慢也只是这一次
 * 列表晚一点出来。
 *
 * 连接空闲一会儿就关：Windows 上开着的句柄会挡住保管库的移动、删除、恢复备份。
 * 主进程在这些操作之前还会显式让这里放手（release）。
 */
import { parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { searchAssetsByCriteria, type AssetSearchCriteria } from '../models/assetSearchCore'
import type { AssetQueryRequest, AssetQueryResponse } from '../services/assetQueryProtocol'
import { VAULT_DB_MMAP_SIZE } from '../vaultConnectionPragmas'

/** 多久没有查询就关掉连接 */
const IDLE_CLOSE_MS = 10_000

interface OpenDb {
  path: string
  db: Database.Database
}

let vaultDb: OpenDb | null = null
let publicDb: OpenDb | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function openReadonly(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  // 排序用的临时 B 树放内存、读页走内存映射（理由见 VaultManager.initializeVaultDatabase）
  db.pragma('temp_store = MEMORY')
  db.pragma(`mmap_size = ${VAULT_DB_MMAP_SIZE}`)
  return db
}

function ensure(current: OpenDb | null, path: string): OpenDb {
  if (current && current.path === path && current.db.open) return current
  if (current) closeQuietly(current)
  return { path, db: openReadonly(path) }
}

function closeQuietly(entry: OpenDb | null): void {
  if (!entry) return
  try {
    entry.db.close()
  } catch {
    // 关不掉也不影响下一次重新打开
  }
}

function releaseAll(): void {
  closeQuietly(vaultDb)
  closeQuietly(publicDb)
  vaultDb = null
  publicDb = null
}

function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(releaseAll, IDLE_CLOSE_MS)
}

function runSearch(
  vaultDbPath: string,
  publicDbPath: string | null,
  criteria: AssetSearchCriteria
): unknown[] {
  vaultDb = ensure(vaultDb, vaultDbPath)
  let pub: Database.Database | null = null
  if (publicDbPath) {
    try {
      publicDb = ensure(publicDb, publicDbPath)
      pub = publicDb.db
    } catch {
      // 公共库打不开只影响「关键词顺带匹配标签名」，资产照常搜
      pub = null
    }
  }
  return searchAssetsByCriteria(vaultDb.db, criteria, { publicDb: pub })
}

parentPort?.on('message', (request: AssetQueryRequest) => {
  let response: AssetQueryResponse
  try {
    if (request.op === 'release') {
      releaseAll()
      response = { id: request.id, ok: true, data: null }
    } else {
      const data = runSearch(request.vaultDbPath, request.publicDbPath, request.criteria)
      response = { id: request.id, ok: true, data }
      armIdleClose()
    }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: unknown })?.code as string | undefined
    }
    armIdleClose()
  }
  parentPort?.postMessage(response)
})
