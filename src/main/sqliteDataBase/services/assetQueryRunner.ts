/**
 * 资产库列表查询 + WAL 检查点：放到 worker 线程跑。
 *
 * 为什么要 worker 见 workers/assetQueryWorker.ts。这里负责：
 *
 * - **自己排队、一次只派一条**给 worker。这样排着没开始的查询可以作废：同一组
 *   （queryGroup，资产库列表就是一组）来了新查询，旧的还没开始就直接丢掉 —— 以前每敲一次键
 *   都会在 worker 里排一条完整查询，用户停手之后还要把它们挨个跑完才轮到最新那条。
 * - worker 起不来 / 崩了 / 打不开库文件 → 这一次在主进程里查（等于以前的行为）；
 *   连续失败三次就本次运行不再用它。
 * - **取消不是失败**：保管库要移动 / 切换 / 关闭、查询被同组新查询顶掉，都是「这条不要了」，
 *   绝不退回主进程重跑 —— 以前放手超时会把在途的慢查询拿到主进程再跑一遍，正好卡在切库的
 *   当口把界面冻住几秒。
 * - 放手（release）之后，旧连接上来的查询一律拒绝：切库 / 移库的那几百毫秒里列表刷新照样会
 *   发查询，worker 收到就会把老库文件重新打开、再攥 10 秒，移库删库就撞 EBUSY。
 * - WAL 检查点交给 worker：把 WAL 里的页抄回主库再刷盘，几十万行的库上要几百毫秒到一秒半，
 *   默认是提交时顺带在主线程上做的 —— 对账写入按 40 ms 切片也没用。现在 worker 里一条可写
 *   连接每秒做一次 PASSIVE 检查点，主连接的自动检查点调大到只当兜底（WATCHED_WAL_AUTOCHECKPOINT）。
 *   光靠 worker 定期追不够：WAL 只有「全部抄完之后的下一次写」才从头复用，主线程连续写的时候
 *   worker 永远差最后一点 —— 54 万行对账实测 WAL 长到 7 GB。所以大批量写入每写几百毫秒就停下来
 *   等 worker 当场追平一次（waitForWalCheckpoint，异步等，不占主线程）。
 *   worker 不在了就把自动检查点恢复成默认值。
 */
import { isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import createAssetQueryWorker from '../workers/assetQueryWorker?nodeWorker'
import type { AssetData } from '../models/assetData'
import {
  countAssetsByEngineVersion,
  searchAssetsByCriteria as searchInProcess,
  type AssetSearchCriteria
} from '../models/assetSearchCore'
import type { AssetQueryRequest, AssetQueryResponse } from './assetQueryProtocol'
import { WATCHED_WAL_AUTOCHECKPOINT } from '../vaultConnectionPragmas'

const MAX_WORKER_FAILURES = 3
/** 让 worker 放手最多等这么久，等不到就结束它（结束也要等它手上那条原生查询跑完） */
const RELEASE_TIMEOUT_MS = 3_000
/** SQLite 的默认自动检查点页数。检查点挪不去 worker 时恢复成它 */
const DEFAULT_WAL_AUTOCHECKPOINT = 1000

/** worker 这条路走不通（起不来、崩了、打不开库）—— 调用方据此退回主进程 */
export class WorkerUnavailableError extends Error {}
/** 这条查询不要了（被顶掉、库要关）—— 不重试、不退回主进程 */
export class QueryCancelledError extends Error {
  readonly cancelled = true
}

/** worker_threads.Worker 里用到的那几样，单测可以换成假的 */
export interface QueryWorkerLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (response: AssetQueryResponse) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  unref?(): void
  terminate(): Promise<number>
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

interface Job {
  id: number
  request: WithoutId<AssetQueryRequest>
  group?: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** worker 只认磁盘上的库文件；内存库、临时库（测试）一律在主进程查 */
export function fileBackedPath(db: Database.Database | null | undefined): string | null {
  const name = db?.name
  if (!name || name === ':memory:' || !isAbsolute(name)) return null
  return existsSync(name) ? name : null
}

export class AssetQueryRunner {
  private worker: QueryWorkerLike | null = null
  private nextId = 1
  private failures = 0
  private disabled = false
  private queue: Job[] = []
  private inFlight: Job | null = null
  /** 已经放手的主进程连接：再拿它来查一律拒绝，见文件头 */
  private retired = new WeakSet<Database.Database>()
  /** 检查点交给 worker 的主进程连接 → 库文件路径、worker 是否已经确认接手 */
  private walWatched = new Map<Database.Database, { path: string; handedOff: boolean }>()

  constructor(private readonly createWorker: () => QueryWorkerLike) {}

  // ─────────────────────── 查询 ───────────────────────

  /**
   * 资产库列表 / 筛选 / 搜索的那一页。worker 能用就在 worker 里查，否则主进程里查。
   * @param group 同一组的新查询会作废这一组里还没开始的旧查询（资产库列表传 'asset-list'）
   */
  search(
    db: Database.Database,
    criteria: AssetSearchCriteria,
    publicDb: Database.Database | null,
    group?: string
  ): Promise<AssetData[]> {
    return this.query('search', db, criteria, publicDb, group)
  }

  /** 筛选栏版本下拉的分面，和列表查询走同一条队列（一样可能是全库扫描） */
  engineFacet(
    db: Database.Database,
    criteria: AssetSearchCriteria,
    publicDb: Database.Database | null
  ): Promise<Array<{ value: string; n: number }>> {
    return this.query('engine-facet', db, criteria, publicDb)
  }

  private async query<T>(
    op: 'search' | 'engine-facet',
    db: Database.Database,
    criteria: AssetSearchCriteria,
    publicDb: Database.Database | null,
    group?: string
  ): Promise<T> {
    if (this.retired.has(db) || !db.open) {
      throw new QueryCancelledError('保管库连接已关闭')
    }
    const vaultDbPath = fileBackedPath(db)
    if (vaultDbPath && !this.disabled) {
      try {
        const rows = await this.enqueue<T>(
          {
            op,
            vaultDbPath,
            // 主连接开了内存映射（库在本机 userData 下）worker 才跟着开，见 vaultConnectionPragmas
            mmap: Number(db.pragma('mmap_size', { simple: true })) > 0,
            publicDbPath: fileBackedPath(publicDb),
            criteria
          },
          group
        )
        this.failures = 0
        return rows
      } catch (error) {
        if (!(error instanceof WorkerUnavailableError)) throw error
        console.warn('[资产查询] worker 不可用，这一次在主进程查询:', error.message)
      }
    }
    const inProcess = op === 'engine-facet' ? countAssetsByEngineVersion : searchInProcess
    return inProcess(db, criteria, { publicDb }) as T
  }

  // ─────────────────────── 放手 / 关闭 ───────────────────────

  /**
   * 这个主进程连接要关了（切库 / 移库 / 关库）：worker 放开手上所有库文件，之后再拿这个
   * 连接来查一律拒绝。worker 正忙着一条长查询、迟迟不回的话结束它 —— 在途的那条按「取消」
   * 处理，不退回主进程重跑。
   */
  async release(db?: Database.Database | null): Promise<void> {
    if (db) {
      this.retired.add(db)
      this.stopWatchingLocally(db)
    }
    // 排着还没开始的查询都不要了（它们查的是要关的库，或者马上会被新查询顶掉）
    this.cancelQueued(
      (job) => job.request.op === 'search' || job.request.op === 'engine-facet',
      '保管库正在切换或关闭'
    )
    const target = this.worker
    if (!target) return

    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        this.enqueue<null>({ op: 'release' }),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('release timeout')), RELEASE_TIMEOUT_MS)
        })
      ])
    } catch {
      if (this.worker === target) {
        this.worker = null
        this.failAll(new QueryCancelledError('worker 被结束以释放库文件'))
        // terminate 打断不了正在跑的原生查询，要等它跑完 worker 才真正退出、句柄才关
        await target.terminate().catch(() => undefined)
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
    // worker 刚把所有连接都关了，还开着的库重新交给它做检查点
    for (const [watchedDb, entry] of this.walWatched) {
      entry.handedOff = false
      if (watchedDb.open) this.sendWatch(watchedDb, entry.path)
    }
  }

  /** 应用退出时调用 */
  async shutdown(): Promise<void> {
    const target = this.worker
    this.worker = null
    this.failAll(new QueryCancelledError('应用正在退出'))
    for (const db of [...this.walWatched.keys()]) this.stopWatchingLocally(db)
    if (target) await target.terminate().catch(() => undefined)
  }

  // ─────────────────────── WAL 检查点 ───────────────────────

  /** 把这个连接的 WAL 检查点交给 worker（主进程这边的自动检查点调大到只当兜底） */
  startWalCheckpointing(db: Database.Database): void {
    const path = fileBackedPath(db)
    if (!path || this.disabled || this.walWatched.has(db)) return
    this.walWatched.set(db, { path, handedOff: false })
    this.sendWatch(db, path)
  }

  /** 连接要关之前调用：worker 关掉它那条检查点连接，主进程这边恢复自动检查点 */
  async stopWalCheckpointing(db: Database.Database): Promise<void> {
    const entry = this.walWatched.get(db)
    if (!entry) return
    this.stopWatchingLocally(db)
    if (!this.worker) return
    await this.enqueue<null>({ op: 'unwatch-wal', path: entry.path }).catch(() => undefined)
  }

  /**
   * 大批量写入每写几百毫秒调一次：worker 当场做一次检查点，等它做完再接着写。
   *
   * 等的这一会儿主连接不写，worker 能把 WAL 全部抄完，下一次写就从 WAL 开头复用 —— 不这样，
   * 连续写入时 WAL 一直追不平、一直往后长（见文件头）。异步等，主线程照常处理界面和 IPC。
   * 检查点没交给 worker（测试库、worker 不可用）就什么都不做，主连接的自动检查点照常管。
   */
  async waitForWalCheckpoint(db: Database.Database): Promise<void> {
    const entry = this.walWatched.get(db)
    if (!entry?.handedOff || !this.worker) return
    await this.enqueue<unknown>({ op: 'checkpoint-wal', path: entry.path }).catch(() => undefined)
  }

  private sendWatch(db: Database.Database, path: string): void {
    this.enqueue<null>({ op: 'watch-wal', path })
      .then(() => {
        // worker 确认接手之后才调大主进程的自动检查点，中间不留没人做检查点的空档
        const entry = this.walWatched.get(db)
        if (entry?.path !== path || !db.open) return
        db.pragma(`wal_autocheckpoint = ${WATCHED_WAL_AUTOCHECKPOINT}`)
        entry.handedOff = true
      })
      .catch(() => this.stopWatchingLocally(db))
  }

  private stopWatchingLocally(db: Database.Database): void {
    if (!this.walWatched.delete(db)) return
    try {
      if (db.open) db.pragma(`wal_autocheckpoint = ${DEFAULT_WAL_AUTOCHECKPOINT}`)
    } catch {
      // 连接正在关，恢复不了也无所谓
    }
  }

  // ─────────────────────── 派发 ───────────────────────

  private enqueue<T>(request: WithoutId<AssetQueryRequest>, group?: string): Promise<T> {
    if (!this.ensureWorker()) {
      return Promise.reject(new WorkerUnavailableError('worker 不可用'))
    }
    if (group) {
      this.cancelQueued((job) => job.group === group, '被同一列表的新查询取代')
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        request,
        group,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.dispatch()
    })
  }

  private dispatch(): void {
    if (this.inFlight || this.queue.length === 0 || !this.worker) return
    const job = this.queue.shift()!
    this.inFlight = job
    try {
      this.worker.postMessage({ ...job.request, id: job.id })
    } catch (error) {
      this.inFlight = null
      job.reject(new WorkerUnavailableError(error instanceof Error ? error.message : String(error)))
      this.dispatch()
    }
  }

  private onMessage(response: AssetQueryResponse): void {
    const job = this.inFlight
    if (!job || job.id !== response.id) return
    this.inFlight = null
    if (response.ok) {
      job.resolve(response.data)
    } else if (response.code?.startsWith('SQLITE_CANTOPEN') || response.code === 'SQLITE_NOTADB') {
      // 库文件打不开是 worker 这条路的问题，不是查询的问题
      job.reject(new WorkerUnavailableError(response.error))
    } else {
      const error = new Error(response.error) as Error & { code?: string }
      error.code = response.code
      job.reject(error)
    }
    this.dispatch()
  }

  private cancelQueued(match: (job: Job) => boolean, reason: string): void {
    const kept: Job[] = []
    for (const job of this.queue) {
      if (match(job)) job.reject(new QueryCancelledError(reason))
      else kept.push(job)
    }
    this.queue = kept
  }

  private failAll(error: Error): void {
    const jobs = this.inFlight ? [this.inFlight, ...this.queue] : [...this.queue]
    this.inFlight = null
    this.queue = []
    for (const job of jobs) job.reject(error)
  }

  private onWorkerGone(reason: string): void {
    this.worker = null
    this.failures += 1
    if (this.failures >= MAX_WORKER_FAILURES && !this.disabled) {
      this.disabled = true
      console.warn(`[资产查询] worker 连续失败 ${this.failures} 次，本次运行改在主进程查询`)
    }
    // 检查点没人做了：恢复主进程的自动检查点，否则 WAL 会一直长下去
    for (const db of [...this.walWatched.keys()]) this.stopWatchingLocally(db)
    this.failAll(new WorkerUnavailableError(reason))
  }

  private ensureWorker(): QueryWorkerLike | null {
    if (this.disabled) return null
    if (this.worker) return this.worker
    try {
      const spawned = this.createWorker()
      spawned.on('message', (response) => {
        if (this.worker === spawned) this.onMessage(response)
      })
      spawned.on('error', (error) => {
        console.warn('[资产查询] worker 出错:', error)
        if (this.worker === spawned) this.onWorkerGone(error.message)
      })
      spawned.on('exit', (code) => {
        if (this.worker === spawned) this.onWorkerGone(`worker 退出 (code ${code})`)
      })
      // worker 没活干时不拖住进程退出
      spawned.unref?.()
      this.worker = spawned
      return spawned
    } catch (error) {
      console.warn('[资产查询] worker 启动失败，改在主进程查询:', error)
      this.onWorkerGone(error instanceof Error ? error.message : String(error))
      return null
    }
  }
}

const runner = new AssetQueryRunner(() => createAssetQueryWorker({}))

export function searchAssetsOffMainThread(
  db: Database.Database,
  criteria: AssetSearchCriteria,
  publicDb: Database.Database | null,
  group?: string
): Promise<AssetData[]> {
  return runner.search(db, criteria, publicDb, group)
}

export function engineFacetOffMainThread(
  db: Database.Database,
  criteria: AssetSearchCriteria,
  publicDb: Database.Database | null
): Promise<Array<{ value: string; n: number }>> {
  return runner.engineFacet(db, criteria, publicDb)
}

/** 保管库连接要关 / 库文件要动之前调用，见 AssetQueryRunner.release */
export function releaseAssetQueryConnections(db?: Database.Database | null): Promise<void> {
  return runner.release(db)
}

export function shutdownAssetQueryWorker(): Promise<void> {
  return runner.shutdown()
}

export function startWalCheckpointing(db: Database.Database): void {
  runner.startWalCheckpointing(db)
}

export function stopWalCheckpointing(db: Database.Database): Promise<void> {
  return runner.stopWalCheckpointing(db)
}

export function waitForWalCheckpoint(db: Database.Database): Promise<void> {
  return runner.waitForWalCheckpoint(db)
}
