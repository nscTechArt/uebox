/**
 * 网络资产库在客户规模（54 万资产）下的压测：全量对账 + 资产库筛选。
 *
 * 用一个按旧 asset-server-standalone 语义实现的假服务端（/full-data 按 rowid 游标分页，
 * 行是 `SELECT rowid AS _rowid, *` 整行）喂给 SyncClient，量这些机器事实：
 *   - 全量对账总耗时、峰值堆内存 / RSS、主线程最长一次被占用多久（界面卡顿的上限）
 *   - 第二轮对账（数据没变）：耗时、有没有把行标成「搜索索引要重建」
 *   - 中途停掉再续：是不是从断点接着拉
 *   - 资产库常见筛选在这个规模下单次查询多久
 *   - （可选）旧实现跑同一份数据的峰值内存与最长卡顿，堆上限按 Electron 主进程的 4 GB
 *
 * 用法（进程自动降到最低优先级，跑完删掉临时库）：
 *   node node_modules/jiti/lib/jiti-cli.mjs scripts/bench/network-vault-scale.ts                # 新实现 + 查询
 *   node node_modules/jiti/lib/jiti-cli.mjs scripts/bench/network-vault-scale.ts -- --legacy    # 再加跑旧实现对照
 *   环境变量 BENCH_ASSETS=100000 可以改规模
 *
 * 不进门禁：一轮要几分钟、要几个 GB 磁盘，只在动了同步 / 查询路径时手动跑。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { setPriority, constants as osConstants, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SCRIPT), '..', '..')
const NATIVE_BINDING = execFileSync(
  process.execPath,
  [join(ROOT, 'scripts', 'better-sqlite3-abi.mjs'), 'path', 'node'],
  { encoding: 'utf8' }
)
  .trim()
  .split(/\r?\n/)
  .pop()!
const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
type DB = import('better-sqlite3').Database

function openDb(path: string, options: { readonly?: boolean } = {}): DB {
  const db = new BetterSqlite3(path, { ...options, nativeBinding: NATIVE_BINDING })
  if (!options.readonly) {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('temp_store = MEMORY')
    db.pragma('mmap_size = 2147418112')
  }
  return db
}

const ASSETS = Number(process.env.BENCH_ASSETS || 539_004)
const FOLDERS = 3_000
/**
 * 别放在系统临时目录：Windows 上杀毒软件对 %TEMP% 下文件的每次读写盯得格外紧，
 * 实测同样一次全表读，临时目录下的系统调用开销是保管库所在的 AppData 下的几十倍，
 * 测出来的数字会严重偏悲观。默认放 %LOCALAPPDATA%，可用 BENCH_DIR 指定。
 */
const WORK_DIR =
  process.env.BENCH_DIR ||
  join(process.env.LOCALAPPDATA || join(homedir(), '.cache'), 'uebox-network-vault-bench')
const SOURCE_DB = join(WORK_DIR, `server-${ASSETS}.db`)
const PORT = 19_871
const VAULT_ID = 'bench-vault'

// ─────────────────────────── 假服务端 ───────────────────────────

/** 子进程里跑：服务端的 CPU 不该算进客户端的卡顿 */
function runServer(dbPath: string, port: number): void {
  const db = openDb(dbPath, { readonly: true })
  const stmtCache = new Map<string, import('better-sqlite3').Statement>()
  const prepare = (sql: string): import('better-sqlite3').Statement => {
    let stmt = stmtCache.get(sql)
    if (!stmt) {
      stmt = db.prepare(sql)
      stmtCache.set(sql, stmt)
    }
    return stmt
  }
  const totals = new Map<string, number>()
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(text)
  }
  createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const sub = url.pathname.replace(`/api/vaults/${VAULT_ID}`, '')
    if (sub === '/full-data') {
      const type = url.searchParams.get('type')
      const table = type === 'folders' ? 'assetFolder' : 'assetData'
      const cursor = Number(url.searchParams.get('cursor') || 0)
      const limit = Math.min(Number(url.searchParams.get('limit') || 2000), 5000)
      const maxRowid =
        cursor === 0
          ? (
              prepare(
                `SELECT COALESCE(MAX(rowid), 0) AS m FROM ${table} WHERE isDelete = 0`
              ).get() as { m: number }
            ).m
          : Number(url.searchParams.get('maxRowid') || 0)
      const rows = prepare(
        `SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ? AND rowid <= ? AND isDelete = 0 ORDER BY rowid LIMIT ?`
      ).all(cursor, maxRowid, limit) as Array<{ _rowid: number }>
      const key = `${table}:${maxRowid}`
      if (!totals.has(key)) {
        totals.set(
          key,
          (
            prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE isDelete = 0 AND rowid <= ?`).get(
              maxRowid
            ) as { c: number }
          ).c
        )
      }
      const next = rows.length ? rows[rows.length - 1]._rowid : cursor
      send(res, 200, {
        success: true,
        data: {
          rows,
          type,
          cursor: next,
          hasMore: rows.length === limit && next < maxRowid,
          total: totals.get(key),
          snapshotMaxRowid: maxRowid,
          snapshotSeq: 100
        }
      })
      return
    }
    if (sub === '/sync') {
      send(res, 200, {
        success: true,
        data: { changes: [], latestSeq: 100, fullSyncRequired: false }
      })
      return
    }
    if (sub === '/checksum') {
      const assetCount = (
        prepare(`SELECT COUNT(*) AS c FROM assetData WHERE isDelete = 0`).get() as { c: number }
      ).c
      const folderCount = (
        prepare(`SELECT COUNT(*) AS c FROM assetFolder WHERE isDelete = 0`).get() as { c: number }
      ).c
      send(res, 200, { success: true, data: { assetCount, folderCount, latestSeq: 100 } })
      return
    }
    send(res, 404, { success: false, error: 'not found' })
  }).listen(port, '127.0.0.1', () => process.send?.('ready'))
}

// ─────────────────────────── 造数据 ───────────────────────────

const EXT_MIX: Array<[string, string | null, number]> = [
  ['uasset', 'uasset', 0.86],
  ['png', null, 0.05],
  ['fbx', null, 0.03],
  ['umap', 'umap', 0.01],
  ['wav', null, 0.004],
  ['mp3', null, 0.001],
  ['mp4', null, 0.005],
  ['json', null, 0.04]
]

function pickExt(r: number): [string, string | null] {
  let acc = 0
  for (const [fe, ext, share] of EXT_MIX) {
    acc += share
    if (r < acc) return [fe, ext]
  }
  return ['uasset', 'uasset']
}

async function buildSourceDb(): Promise<void> {
  if (existsSync(SOURCE_DB)) {
    console.log(`复用已生成的服务端库: ${SOURCE_DB}`)
    return
  }
  const { initAssetFolderModel } = await import('../../src/main/sqliteDataBase/models/assetFolder')
  const { initAssetDataModel } = await import('../../src/main/sqliteDataBase/models/assetData')
  const started = performance.now()
  const db = openDb(SOURCE_DB)
  initAssetFolderModel(db as never)
  initAssetDataModel(db as never)
  // 服务端的库里真有「父文件夹不在了」的资产，造几行出来
  db.pragma('foreign_keys = OFF')
  const folder = db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES (?, ?, 'folder', ?, ?, '[]', ?, '[]', 0)`
  )
  const asset = db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, filePath, fileSize, fileExtension, ext, modifiedTime,
       assetType, className, classNameCn, softPath, originPath, folderName, imports, assetConfig, imgLocalPath,
       engineVersion, isDelete, isDependency)
     VALUES (@assetKey, @folderKey, @assetName, @filePath, @fileSize, @fileExtension, @ext, @modifiedTime,
       @assetType, @className, @classNameCn, @softPath, @originPath, @folderName, @imports, @assetConfig, @imgLocalPath,
       @engineVersion, 0, @isDependency)`
  )
  let seed = 42
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  db.transaction(() => {
    folder.run('ALL', null, 'ALL', '/', 0)
    for (let i = 0; i < FOLDERS; i += 1) {
      const depth = i < 100 ? 1 : 2
      const father = depth === 1 ? 'ALL' : `f${i % 100}`
      folder.run(
        `f${i}`,
        father,
        `数字门_${i}`,
        depth === 1 ? `/数字门_${i}` : `/数字门_${i % 100}/子目录_${i}`,
        depth
      )
    }
  })()
  const BATCH = 20_000
  for (let start = 0; start < ASSETS; start += BATCH) {
    db.transaction(() => {
      for (let i = start; i < Math.min(start + BATCH, ASSETS); i += 1) {
        const [fe, ext] = pickExt(rand())
        const name = `SM_Prop_${i.toString(36)}_${Math.floor(rand() * 1e6)}`
        const imports = JSON.stringify(
          Array.from(
            { length: 8 + Math.floor(rand() * 8) },
            (_, k) => `/Game/Shared/Materials/M_Base_${(i + k) % 5000}`
          )
        )
        asset.run({
          // 真实库里的 key 是随机的（uuid / 时间戳+随机串），插入落在索引的各处；
          // 按序号递增的 key 会让插入总是追加在末尾，测出来偏乐观
          assetKey: randomUUID(),
          // 3 行缺名字、2 行父文件夹不存在：旧实现会因此无限对账 / 整轮回滚
          folderKey:
            i === 7 || i === 70_007 ? `missing_folder_${i}` : `f${100 + (i % (FOLDERS - 100))}`,
          assetName: i === 11 || i === 22_222 || i === 333_333 ? '' : `${name}.${fe}`,
          filePath: `\\\\nas\\assets\\数字门_${i % 100}\\子目录_${i % FOLDERS}\\${name}.${fe}`,
          fileSize: Math.floor(rand() * 50_000_000),
          fileExtension: fe,
          ext,
          modifiedTime: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
          assetType: fe === 'uasset' ? 'StaticMesh' : fe,
          className: fe === 'uasset' ? 'StaticMesh' : null,
          classNameCn: fe === 'uasset' ? '静态网格体' : null,
          softPath: `/Game/Props/数字门_${i % 100}/${name}`,
          originPath: `D:\\Projects\\ZRR\\Content\\Props\\${name}.${fe}`,
          folderName: `子目录_${i % FOLDERS}`,
          imports,
          assetConfig: JSON.stringify({
            lod: 3,
            nanite: rand() > 0.5,
            collision: 'Complex',
            tags: ['prop', 'env']
          }),
          imgLocalPath: `thumb_${i.toString(36)}.png`,
          engineVersion: '5.3',
          isDependency: rand() < 0.3 ? 1 : 0
        })
      }
    })()
    process.stdout.write(`\r造服务端数据 ${Math.min(start + BATCH, ASSETS)}/${ASSETS}`)
  }
  db.exec('ANALYZE')
  db.close()
  console.log(`\n服务端库生成完毕，用时 ${((performance.now() - started) / 1000).toFixed(1)} s`)
}

// ─────────────────────────── 客户端测量 ───────────────────────────

interface Measured {
  seconds: number
  cpuSeconds: number
  peakHeapMB: number
  peakRssMB: number
  maxBlockMs: number
}

/**
 * 和应用里一样：WAL 检查点由另一个线程做（应用里是资产查询 worker，见 assetQueryRunner）——
 * 每秒一次 PASSIVE，SyncClient 每写几百毫秒还会叫它当场追平一次（waitForWalCheckpoint）；
 * 主连接的自动检查点调大到只当兜底。不这样测，每次提交顺带的检查点（几十万行的库上几百毫秒
 * 到一秒多）会算进主线程卡顿，测出来的就不是应用的真实行为。
 */
function startCheckpointer(dbPath: string): {
  worker: Worker
  waitForWalCheckpoint: () => Promise<void>
} {
  const worker = new Worker(
    `
    const { workerData, parentPort } = require('node:worker_threads')
    const Database = require(workerData.bs)
    const db = new Database(workerData.path, { nativeBinding: workerData.nb })
    db.pragma('busy_timeout = 0')
    const checkpoint = () => { try { db.pragma('wal_checkpoint(PASSIVE)') } catch {} }
    setInterval(checkpoint, 1000)
    parentPort.on('message', (id) => { checkpoint(); parentPort.postMessage(id) })
  `,
    {
      eval: true,
      workerData: { path: dbPath, nb: NATIVE_BINDING, bs: require.resolve('better-sqlite3') }
    }
  )
  worker.unref()
  let nextId = 0
  const pending = new Map<number, () => void>()
  worker.on('message', (id: number) => {
    pending.get(id)?.()
    pending.delete(id)
  })
  const waitForWalCheckpoint = (): Promise<void> =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      worker.postMessage(id)
    })
  return { worker, waitForWalCheckpoint }
}

/** 测量期间顺带盯着的 WAL 文件（报峰值大小）：WAL 一直追不平时它会长到几个 GB */
let watchedWalPath: string | null = null

/**
 * 主线程上单次超过 SLOW_CALL_MS 的 SQL 语句 / 事务 / exec，按耗时记下来。
 * 「最长一次卡顿」偏高时靠它看是谁 —— 机器忙的时候手工挨条计时不可信。
 * 只记本进程（客户端）；服务端在子进程里。
 */
const SLOW_CALL_MS = 100
let slowCalls: { ms: number; cpuMs: number; what: string }[] = []

/** 本线程（主线程）用掉的 CPU 毫秒数：机器忙时墙钟会把「CPU 被别人抢走」也算成卡顿，它不会 */
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage()
  return (user + system) / 1000
}

function callerOf(stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').slice(1)
  const frame = frames.find((line) => /src[\\/]/.test(line) && !/better-sqlite3/.test(line))
  return (frame ?? frames[1] ?? '')
    .trim()
    .replace(/^at /, '')
    .replace(/\(.*[\\/](src[\\/].*)\)/, '($1)')
}

/** 跑一次 call，超过 SLOW_CALL_MS 就连同 what() 记进 slowCalls */
function timed<T>(call: () => T, what: () => string): T {
  const started = performance.now()
  const cpuStarted = threadCpuMs()
  try {
    return call()
  } finally {
    const ms = performance.now() - started
    if (ms >= SLOW_CALL_MS) slowCalls.push({ ms, cpuMs: threadCpuMs() - cpuStarted, what: what() })
  }
}

const oneLine = (sql: unknown, max: number): string =>
  String(sql).replace(/\s+/g, ' ').trim().slice(0, max)

function traceSlowSqlCalls(): void {
  type Method = (...args: unknown[]) => unknown
  const probe = new BetterSqlite3(':memory:', { nativeBinding: NATIVE_BINDING })
  const stmtProto = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Record<string, Method>
  probe.close()
  for (const method of ['run', 'get', 'all']) {
    const original = stmtProto[method]
    stmtProto[method] = function (this: { source: string }, ...args: unknown[]): unknown {
      return timed(
        () => original.apply(this, args),
        () => oneLine(this.source, 100)
      )
    }
  }
  const dbProto = BetterSqlite3.prototype as unknown as Record<string, Method>
  const originalExec = dbProto.exec
  dbProto.exec = function (this: unknown, ...args: unknown[]): unknown {
    return timed(
      () => originalExec.apply(this, args),
      () => `exec ${oneLine(args[0], 80)}`
    )
  }
  const originalTransaction = dbProto.transaction
  dbProto.transaction = function (this: unknown, fn: unknown): unknown {
    const tx = originalTransaction.call(this, fn) as Method & Record<string, unknown>
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      return timed(
        () => tx.apply(this, args),
        () => `事务 ← ${callerOf(new Error().stack)}`
      )
    }
    return Object.assign(wrapped, {
      default: tx.default,
      deferred: tx.deferred,
      immediate: tx.immediate,
      exclusive: tx.exclusive
    })
  }
}

async function measure(label: string, run: () => Promise<void>): Promise<Measured> {
  global.gc?.()
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  let peakHeap = 0
  let peakRss = 0
  let peakWal = 0
  const sampler = setInterval(() => {
    const m = process.memoryUsage()
    peakHeap = Math.max(peakHeap, m.heapUsed)
    peakRss = Math.max(peakRss, m.rss)
    if (watchedWalPath && existsSync(watchedWalPath)) {
      peakWal = Math.max(peakWal, statSync(watchedWalPath).size)
    }
  }, 100)
  slowCalls = []
  const started = performance.now()
  const cpuStarted = process.cpuUsage()
  let failure: unknown = null
  try {
    await run()
  } catch (error) {
    // 失败也要把内存 / 卡顿报出来：旧实现就是在最后那个大事务里失败的
    failure = error
  } finally {
    clearInterval(sampler)
    histogram.disable()
  }
  const cpu = process.cpuUsage(cpuStarted)
  const result: Measured = {
    seconds: (performance.now() - started) / 1000,
    cpuSeconds: (cpu.user + cpu.system) / 1e6,
    peakHeapMB: peakHeap / 2 ** 20,
    peakRssMB: peakRss / 2 ** 20,
    maxBlockMs: histogram.max / 1e6
  }
  console.log(
    `\n[${label}] 墙钟 ${result.seconds.toFixed(1)} s / CPU ${result.cpuSeconds.toFixed(1)} s | ` +
      `峰值堆 ${result.peakHeapMB.toFixed(0)} MB | 峰值 RSS ${result.peakRssMB.toFixed(0)} MB | ` +
      `主线程最长一次卡顿 ${result.maxBlockMs.toFixed(0)} ms` +
      (peakWal > 0 ? ` | WAL 峰值 ${(peakWal / 2 ** 20).toFixed(0)} MB` : '')
  )
  const slowest = [...slowCalls].sort((a, b) => b.ms - a.ms).slice(0, 5)
  for (const call of slowest)
    console.log(`    慢调用 ${call.ms.toFixed(0).padStart(5)} ms  ${call.what}`)
  if (failure) throw failure
  return result
}

async function freshClientDb(path: string): Promise<DB> {
  rmSync(path, { force: true })
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  // 和应用打开保管库时同一套表结构（VaultManager → applyVaultSchema），外加全文索引的触发器
  const { applyVaultSchema } = await import('../../src/main/sqliteDataBase/vaultSchema')
  const { initAssetSearchIndexModel } = await import(
    '../../src/main/sqliteDataBase/models/assetSearchIndex'
  )
  const db = openDb(path)
  db.pragma('foreign_keys = ON')
  applyVaultSchema(db as never)
  initAssetSearchIndexModel(db as never)
  return db
}

type ClientCtor = new (
  db: never,
  config: Record<string, unknown>
) => {
  stop(): void
  on(event: string, listener: (...args: never[]) => void): unknown
}

function newClient(
  Ctor: ClientCtor,
  db: DB,
  waitForWalCheckpoint?: () => Promise<void>
): InstanceType<ClientCtor> {
  return new Ctor(db as never, {
    serverUrl: `http://127.0.0.1:${PORT}`,
    vaultId: VAULT_ID,
    clientId: 'bench',
    hostname: 'bench',
    waitForWalCheckpoint
  })
}

const reconcileOf = (client: unknown): Promise<void> =>
  (client as { reconcileSync: () => Promise<void> }).reconcileSync()

const count = (db: DB, sql: string): number => (db.prepare(sql).get() as { c: number }).c

async function benchCurrent(): Promise<void> {
  traceSlowSqlCalls()
  const { SyncClient } = await import('../../src/main/networkV2/SyncClient')
  const Ctor = SyncClient as unknown as ClientCtor
  const clientPath = join(WORK_DIR, 'client-current.db')
  const db = await freshClientDb(clientPath)
  const { WATCHED_WAL_AUTOCHECKPOINT } = await import(
    '../../src/main/sqliteDataBase/vaultConnectionPragmas'
  )
  db.pragma(`wal_autocheckpoint = ${WATCHED_WAL_AUTOCHECKPOINT}`)
  const checkpointer = startCheckpointer(clientPath)
  const wait = checkpointer.waitForWalCheckpoint
  watchedWalPath = `${clientPath}-wal`

  let lastPhase = ''
  const progress = (stats: { phase: string }): void => {
    if (stats.phase !== lastPhase && !/\d/.test(stats.phase)) console.log(`  · ${stats.phase}`)
    lastPhase = stats.phase
  }

  // 1. 首次全量
  let client = newClient(Ctor, db, wait)
  client.on('sync-progress', progress as never)
  await measure('新实现 · 首次全量对账', () => reconcileOf(client))
  console.log(
    `  本地活资产 ${count(db, `SELECT COUNT(*) c FROM assetData WHERE isDelete = 0`)}，` +
      `服务端坏行跳过：见上方日志`
  )

  // 2. 数据没变再来一轮：不该改写任何行
  // 不能把 updated_at 统一改成一个值来做对照：那样全库同一个时间，后面「按修改时间排」
  // 要在 54 万行的并列里再按名字排，测出来的查询耗时是假的。改为记下这一刻，事后数比它新的
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const round2Start = (db.prepare(`SELECT datetime('now','localtime') AS t`).get() as { t: string })
    .t
  db.exec(`DELETE FROM assetSearchDirty`)
  await measure('新实现 · 第二轮对账（数据没变）', () => reconcileOf(client))
  console.log(
    `  第二轮被改写的行: ${count(db, `SELECT COUNT(*) c FROM assetData WHERE updated_at >= '${round2Start}'`)}，` +
      `被标记「搜索索引要重建」的行: ${count(db, `SELECT COUNT(*) c FROM assetSearchDirty`)}（都应为 0）`
  )

  // 3. 中途停掉再续
  db.exec(`DELETE FROM sync_reconcile`)
  db.exec(`DELETE FROM sync_reconcile_seen`)
  client.stop()
  client = newClient(Ctor, db, wait)
  let stopAt = 0
  client.on('sync-progress', ((stats: { current: number; total: number; phase: string }) => {
    if (
      stats.phase.startsWith('正在同步资产') &&
      stats.total > 0 &&
      stats.current > stats.total * 0.4 &&
      !stopAt
    ) {
      stopAt = stats.current
      client.stop()
    }
  }) as never)
  await reconcileOf(client).catch(() => undefined)
  const checkpoint = db.prepare(`SELECT phase, fetched FROM sync_reconcile`).get() as {
    phase: string
    fetched: number
  }
  console.log(`\n[续传] 在 ${stopAt} 行处停掉，断点: ${JSON.stringify(checkpoint)}`)
  client = newClient(Ctor, db, wait)
  const requested: string[] = []
  const realGet = (
    client as unknown as { httpGet: (p: string, t?: number) => Promise<unknown> }
  ).httpGet.bind(client)
  ;(client as unknown as { httpGet: unknown }).httpGet = (p: string, t?: number) => {
    requested.push(p)
    return realGet(p, t)
  }
  await measure('新实现 · 从断点续传', () => reconcileOf(client))
  const firstAssetPage = requested.find((p) => p.includes('type=assets')) ?? ''
  console.log(`  续传后第一页请求: ${firstAssetPage.replace(/.*full-data\?/, '')}`)
  client.stop()

  watchedWalPath = null
  await benchQueries(db)
  await checkpointer.worker.terminate()
  db.close()
}

async function benchQueries(db: DB): Promise<void> {
  const { searchAssetsByCriteria } = await import(
    '../../src/main/sqliteDataBase/models/assetSearchCore'
  )
  const time = (label: string, criteria: Record<string, unknown>): void => {
    let bestCpu = Infinity
    let rows: unknown[] = []
    for (let i = 0; i < 3; i += 1) {
      const cpu = process.cpuUsage()
      rows = searchAssetsByCriteria(db as never, {
        folderKey: 'ALL',
        includeSubfolders: true,
        limit: 50,
        offset: 0,
        ...criteria
      })
      const used = process.cpuUsage(cpu)
      bestCpu = Math.min(bestCpu, (used.user + used.system) / 1000)
    }
    console.log(
      `  ${label.padEnd(30)} CPU ${bestCpu.toFixed(0).padStart(6)} ms  (${rows.length} 行)`
    )
  }
  db.exec('ANALYZE')
  console.log('\n[查询] ALL 目录、一页 50 条（主线程同步执行时的耗时）')
  const audio = { fileExtensions: ['wav', 'mp3', 'ogg', 'flac'] }
  time('音频 · 按修改时间倒序', { ...audio, sortBy: 'modifiedTime', sortOrder: 'desc' })
  time('音频 · 按名称', { ...audio, sortBy: 'assetName', sortOrder: 'asc' })
  time('音频 · 第 20 页', { ...audio, sortBy: 'modifiedTime', sortOrder: 'desc', offset: 950 })
  time('贴图(png) · 按修改时间', {
    fileExtensions: ['png', 'jpg', 'tga'],
    sortBy: 'modifiedTime',
    sortOrder: 'desc'
  })
  time('不筛选 · 按修改时间倒序', { sortBy: 'modifiedTime', sortOrder: 'desc' })
  time('不筛选 · 按名称', { sortBy: 'assetName', sortOrder: 'asc' })
  time('大小 > 40MB · 按修改时间', {
    sizeRange: { min: 40_000_000 },
    sortBy: 'modifiedTime',
    sortOrder: 'desc'
  })
  const warn = console.warn
  console.warn = () => undefined // 没有公共库，标签匹配那段会报一句，不影响计时
  time('关键词 LIKE（索引未就绪时的退路）', {
    keyword: 'Prop_1a',
    sortBy: 'modifiedTime',
    sortOrder: 'desc'
  })
  console.warn = warn

  db.exec('DROP INDEX IF EXISTS idx_assetData_ext')
  console.log('  —— 去掉 idx_assetData_ext（即修复前的索引）——')
  time('音频 · 按修改时间倒序（修复前索引）', {
    ...audio,
    sortBy: 'modifiedTime',
    sortOrder: 'desc'
  })
  db.exec('CREATE INDEX IF NOT EXISTS idx_assetData_ext ON assetData(ext)')
}

// ─────────────────────────── 旧实现对照 ───────────────────────────

async function benchLegacy(): Promise<void> {
  // 放在仓库里（jiti 才会转译它、才解析得到 ws / better-sqlite3），跑完就删
  const legacyFile = join(ROOT, 'scripts', 'bench', '.legacy-SyncClient.ts')
  const source = execFileSync('git', ['show', 'v1.0.8:src/main/networkV2/SyncClient.ts'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  writeFileSync(
    legacyFile,
    source.replace("from './SyncProtocol'", "from '../../src/main/networkV2/SyncProtocol'")
  )

  let SyncClient: unknown
  try {
    ;({ SyncClient } = await import(/* @vite-ignore */ legacyFile))
  } finally {
    rmSync(legacyFile, { force: true })
  }
  const db = await freshClientDb(join(WORK_DIR, 'client-legacy.db'))
  watchedWalPath = join(WORK_DIR, 'client-legacy.db-wal')
  const client = newClient(SyncClient as unknown as ClientCtor, db)
  ;(client as unknown as { flushOutbox: unknown }).flushOutbox = async () => ({
    flushed: 0,
    failed: 0
  })
  try {
    await measure('旧实现（v1.0.8）· 首次全量对账', () => reconcileOf(client))
  } catch (error) {
    console.log(`\n[旧实现] 对账失败: ${error instanceof Error ? error.message : error}`)
  }
  console.log(`  本地活资产 ${count(db, `SELECT COUNT(*) c FROM assetData WHERE isDelete = 0`)}`)
  client.stop()
  db.close()
}

// ─────────────────────────── 入口 ───────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--' && resolve(arg) !== SCRIPT)
  if (args[0] === 'server') {
    runServer(args[1], Number(args[2]))
    return
  }
  try {
    setPriority(osConstants.priority.PRIORITY_LOW)
  } catch {
    // 降不了就算了
  }
  mkdirSync(WORK_DIR, { recursive: true })
  await buildSourceDb()

  const server = spawn(
    process.execPath,
    [process.argv[1], SCRIPT, 'server', SOURCE_DB, String(PORT)],
    {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    }
  )
  await new Promise<void>((resolveReady, reject) => {
    server.once('message', () => resolveReady())
    server.once('exit', (code) => reject(new Error(`假服务端退出 ${code}`)))
  })

  try {
    if (args.includes('--legacy-only')) {
      await benchLegacy()
    } else {
      await benchCurrent()
      if (args.includes('--legacy')) await benchLegacy()
    }
  } finally {
    server.kill()
    if (!args.includes('--keep')) {
      for (const name of ['client-current.db', 'client-legacy.db']) {
        for (const suffix of ['', '-wal', '-shm'])
          rmSync(join(WORK_DIR, name + suffix), { force: true })
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
