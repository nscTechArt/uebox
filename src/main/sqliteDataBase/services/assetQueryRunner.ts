/**
 * 资产库列表查询：放到 worker 线程跑，worker 用不了时退回主进程。
 *
 * 为什么要 worker 见 workers/assetQueryWorker.ts。这里负责：
 * - 懒启动一个 worker，按 id 对应请求和回包；
 * - worker 起不来 / 崩了 / 打不开库文件 → 这一次在主进程里查（等于以前的行为，
 *   不会比以前更糟）；连续崩三次就本次运行不再用它，免得反复拉起；
 * - 保管库要移动、切换、关闭之前，让 worker 放开文件句柄（Windows 上开着的句柄
 *   会让移动和删除失败）。
 */
import { isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import type { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import createAssetQueryWorker from '../workers/assetQueryWorker?nodeWorker'
import type { AssetData } from '../models/assetData'
import {
  searchAssetsByCriteria as searchInProcess,
  type AssetSearchCriteria
} from '../models/assetSearchCore'
import type { AssetQueryRequest, AssetQueryResponse } from './assetQueryProtocol'

const MAX_WORKER_FAILURES = 3
/** 让 worker 放手最多等这么久，等不到就直接结束它 */
const RELEASE_TIMEOUT_MS = 3_000

/** 不是 SQL 写错了，而是 worker 这条路走不通 —— 调用方据此退回主进程 */
class WorkerUnavailableError extends Error {}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextId = 1
let failures = 0
let disabled = false
const pending = new Map<number, Pending>()

function failAllPending(reason: string): void {
  for (const entry of pending.values()) entry.reject(new WorkerUnavailableError(reason))
  pending.clear()
}

function onWorkerGone(reason: string): void {
  worker = null
  failures += 1
  if (failures >= MAX_WORKER_FAILURES && !disabled) {
    disabled = true
    console.warn(`[资产查询] worker 连续失败 ${failures} 次，本次运行改在主进程查询`)
  }
  failAllPending(reason)
}

function getWorker(): Worker | null {
  if (disabled) return null
  if (worker) return worker
  try {
    const spawned = createAssetQueryWorker({})
    spawned.on('message', (response: AssetQueryResponse) => {
      const entry = pending.get(response.id)
      if (!entry) return
      pending.delete(response.id)
      if (response.ok) {
        entry.resolve(response.data)
        return
      }
      // 库文件打不开（路径不对、被占用、不是数据库）是 worker 这条路的问题，不是查询的问题
      if (response.code?.startsWith('SQLITE_CANTOPEN') || response.code === 'SQLITE_NOTADB') {
        entry.reject(new WorkerUnavailableError(response.error))
        return
      }
      const error = new Error(response.error) as Error & { code?: string }
      error.code = response.code
      entry.reject(error)
    })
    spawned.on('error', (error) => {
      console.warn('[资产查询] worker 出错:', error)
      if (worker === spawned) onWorkerGone(error.message)
    })
    spawned.on('exit', (code) => {
      if (worker === spawned) onWorkerGone(`worker 退出 (code ${code})`)
    })
    // worker 没活干时不拖住进程退出
    spawned.unref()
    worker = spawned
    return worker
  } catch (error) {
    console.warn('[资产查询] worker 启动失败，改在主进程查询:', error)
    onWorkerGone(error instanceof Error ? error.message : String(error))
    return null
  }
}

/** 联合类型上的 Omit 要逐个分支做，否则只剩公共字段 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

function send<T>(request: WithoutId<AssetQueryRequest>): Promise<T> {
  const target = getWorker()
  if (!target) return Promise.reject(new WorkerUnavailableError('worker 不可用'))
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    try {
      target.postMessage({ ...request, id } as AssetQueryRequest)
    } catch (error) {
      pending.delete(id)
      reject(new WorkerUnavailableError(error instanceof Error ? error.message : String(error)))
    }
  })
}

/** worker 只认磁盘上的库文件；内存库、临时库（测试）一律在主进程查 */
function fileBackedPath(db: Database.Database | null | undefined): string | null {
  const name = db?.name
  if (!name || name === ':memory:' || !isAbsolute(name)) return null
  return existsSync(name) ? name : null
}

/**
 * 资产库列表 / 筛选 / 搜索的那一页。worker 能用就在 worker 里查，否则主进程里查。
 */
export async function searchAssetsOffMainThread(
  db: Database.Database,
  criteria: AssetSearchCriteria,
  publicDb: Database.Database | null
): Promise<AssetData[]> {
  const vaultDbPath = fileBackedPath(db)
  if (vaultDbPath && !disabled) {
    try {
      const rows = await send<AssetData[]>({
        op: 'search',
        vaultDbPath,
        publicDbPath: fileBackedPath(publicDb),
        criteria
      })
      failures = 0
      return rows
    } catch (error) {
      if (!(error instanceof WorkerUnavailableError)) throw error
      console.warn('[资产查询] worker 不可用，这一次在主进程查询:', error.message)
    }
  }
  return searchInProcess(db, criteria, { publicDb })
}

/**
 * 让 worker 关掉手上的库文件。保管库移动 / 切换 / 关闭之前调用。
 * worker 正忙着一条长查询、迟迟不回的话，直接结束它 —— 下次查询会重新拉起。
 */
export async function releaseAssetQueryConnections(): Promise<void> {
  const target = worker
  if (!target) return
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      send<null>({ op: 'release' }),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('release timeout')), RELEASE_TIMEOUT_MS)
      })
    ])
  } catch {
    if (worker === target) {
      worker = null
      failAllPending('worker 被结束以释放库文件')
      await target.terminate().catch(() => undefined)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 应用退出时调用 */
export async function shutdownAssetQueryWorker(): Promise<void> {
  const target = worker
  worker = null
  failAllPending('应用正在退出')
  if (target) await target.terminate().catch(() => undefined)
}
