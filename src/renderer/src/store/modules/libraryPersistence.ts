/**
 * 蓝图库 / 材质库的持久化底座。
 *
 * 两个库以前各自把整库 `JSON.stringify` 后写进 localStorage。localStorage 只有几 MB，
 * 写满就抛 `QuotaExceededError`，而存盘是二十多个用户操作的最后一步 —— 结果是
 * 「库一大就什么都干不了」。现在改写公共数据库里的 `library_store_*` 两张表。
 *
 * 这一层要解决的是**接缝问题**：SQLite 只能走异步 IPC，而两个 store 里的
 * `persistState()` 被到处同步调用。所以：
 *
 * - **写**：`persist()` 仍然是同步的，只标脏并排一次防抖落盘。落盘时只发**变动的行**，
 *   不再整库重写。IPC 失败时保留上一份快照，下一次落盘会把这些行原样重试。
 * - **读**：`ready` 是一个 Promise。路由在进入两个库之前 await 它（见 `mainRoutes.ts`），
 *   所以界面看到的仍然是「打开页面时数据已经在」，组件代码不需要改。
 * - **迁移**：老用户 localStorage 里那份在首次读取时一次性搬进 SQLite。数据和
 *   「已迁移」标记在同一个事务里，确认落库之后才删 localStorage —— 中途崩了下次重来。
 */

import type { Ref } from 'vue'

import {
  libraryStoreAPI,
  type LibraryName,
  type LibraryRecordKind,
  type LibraryStoreRecord
} from '@renderer/api/libraryStore'

/** 落盘防抖：连续操作只写一次 */
const FLUSH_DEBOUNCE_MS = 200
/** 防抖上限：持续不断的操作（比如连着拖节点）也至少每 1s 落一次盘 */
const FLUSH_MAX_WAIT_MS = 1000

/** 行键的分隔符。kind 只有 'entry' / 'collection'，不含冒号，所以按首个冒号切一定切得对。 */
const KEY_SEPARATOR = ':'

export interface LibrarySnapshot<TEntry, TCollection> {
  entries: TEntry[]
  collections: TCollection[]
  ui: Record<string, unknown>
}

export interface LibraryPersistence {
  /** 首次读取（含迁移）完成。路由守卫和测试 await 它 */
  ready: Promise<void>
  /** 同步调用，只标脏；真正落盘是防抖之后的事 */
  persist(): void
  /** 立刻把待写的东西落盘 */
  flush(): Promise<void>
  /**
   * 把磁盘上**某一条**并进内存。
   *
   * 接住**不经过这个 store 的写入** —— 片段仓库的 `blueprint_library_save`
   * 是主进程工具直接写包目录的，渲染层这边完全不知情。没有这个方法的话，
   * 用户会看到「AI 说存好了，库列表里没有」。
   *
   * **不是整库重读。** 整库重读会在两个窗口里丢掉用户正在编辑的内容：
   * 扫盘期间的编辑会被磁盘那份盖掉，以及 flush 失败了还照读。
   * 只并一条就没有这两个问题。
   *
   * 可选：SQLite 版（`createLibraryPersistence`）没有这个概念，不实现。
   */
  mergeEntryFromDisk?(entryId: string): Promise<boolean>
  /**
   * 落盘状态，给界面用。
   *
   * 存在的理由：写盘失败原来只有一行 `console.warn`。用户在资产库切了保管库
   * （条目的路径属于上一个库，主进程一律拒绝），或者在资源管理器里把包目录改了名，
   * 此后他的每一次编辑都「看起来成功」，关掉应用就没了 —— 界面上没有任何迹象。
   *
   * 可选：SQLite 版没有这个概念，不实现。
   */
  saveState?: LibrarySaveState
}

/**
 * 落盘状态，界面拿到的形状。
 *
 * store 从 pinia 出来时 ref 已经被解包了，所以组件那边看到的是普通值 ——
 * 这个类型就是给组件用的，不要拿 `LibrarySaveState` 去标注 prop。
 */
export interface LibrarySaveStateView {
  status: 'idle' | 'saving' | 'error'
  lastError: string
  failedCount: number
  retry(): Promise<void>
}

/** 落盘状态。`error` 表示有东西没写进去，界面必须说出来并给重试 */
export interface LibrarySaveState {
  /** `'saving'` 只在真的在写的时候为真，用来避免「刚点重试就说失败」 */
  status: Ref<'idle' | 'saving' | 'error'>
  /** 最近一次失败的原因，原样给用户看（多半是路径不对/权限） */
  lastError: Ref<string>
  /** 有多少条没写进去 */
  failedCount: Ref<number>
  /** 再试一次。成功后 status 回到 idle */
  retry(): Promise<void>
}

function recordKey(kind: LibraryRecordKind, id: string): string {
  return `${kind}${KEY_SEPARATOR}${id}`
}

/** 快照里存的是「顺序 + 内容」，任一变了都要重写这一行 */
function recordFingerprint(record: LibraryStoreRecord): string {
  return `${record.sortIndex}${KEY_SEPARATOR}${record.data}`
}

/**
 * 把内存里的两个数组拍平成待写的行。顺序用 sortIndex 保留。
 */
export function buildLibraryRecords<
  TEntry extends { id: string },
  TCollection extends { id: string }
>(snapshot: LibrarySnapshot<TEntry, TCollection>): LibraryStoreRecord[] {
  const records: LibraryStoreRecord[] = []
  snapshot.entries.forEach((entry, index) => {
    records.push({ kind: 'entry', id: entry.id, data: JSON.stringify(entry), sortIndex: index })
  })
  snapshot.collections.forEach((collection, index) => {
    records.push({
      kind: 'collection',
      id: collection.id,
      data: JSON.stringify(collection),
      sortIndex: index
    })
  })
  return records
}

export interface LibraryRecordsDiff {
  upserts: LibraryStoreRecord[]
  deletes: Array<{ kind: LibraryRecordKind; id: string }>
  /** 这次落盘成功后应当记住的新快照 */
  next: Map<string, string>
}

/**
 * 对比上一次落盘的快照，算出这次要写哪些行、删哪些行。
 *
 * 这是「不再整库重写」的关键：改一个名字只发一行，而不是把几十兆图表重新序列化一遍。
 */
export function diffLibraryRecords(
  previous: Map<string, string>,
  next: LibraryStoreRecord[]
): LibraryRecordsDiff {
  const nextSnapshot = new Map<string, string>()
  const upserts: LibraryStoreRecord[] = []

  for (const record of next) {
    const key = recordKey(record.kind, record.id)
    const fingerprint = recordFingerprint(record)
    nextSnapshot.set(key, fingerprint)
    if (previous.get(key) !== fingerprint) {
      upserts.push(record)
    }
  }

  const deletes: Array<{ kind: LibraryRecordKind; id: string }> = []
  for (const key of previous.keys()) {
    if (nextSnapshot.has(key)) continue
    const separator = key.indexOf(KEY_SEPARATOR)
    deletes.push({
      kind: key.slice(0, separator) as LibraryRecordKind,
      id: key.slice(separator + 1)
    })
  }

  return { upserts, deletes, next: nextSnapshot }
}

function parseRecords<TEntry, TCollection>(
  records: LibraryStoreRecord[]
): { entries: TEntry[]; collections: TCollection[] } {
  const entries: TEntry[] = []
  const collections: TCollection[] = []
  for (const record of records) {
    let parsed: unknown
    try {
      parsed = JSON.parse(record.data)
    } catch {
      // 单条坏了不该让整个库打不开，跳过它
      console.warn('[LibraryStore] 记录 JSON 解析失败，已跳过:', record.kind, record.id)
      continue
    }
    if (record.kind === 'entry') entries.push(parsed as TEntry)
    else collections.push(parsed as TCollection)
  }
  return { entries, collections }
}

function parseUi(ui: string | null): Record<string, unknown> {
  if (!ui) return {}
  try {
    const parsed = JSON.parse(ui)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    console.warn('[LibraryStore] 界面偏好 JSON 解析失败，回落到默认值')
    return {}
  }
}

export interface CreateLibraryPersistenceOptions<
  TEntry extends { id: string },
  TCollection extends { id: string }
> {
  library: LibraryName
  /** 老版本写在 localStorage 里的键名，迁移完会被删掉 */
  legacyKey: string
  /** 把 localStorage 里那份旧结构翻译成通用快照 */
  parseLegacy: (raw: Record<string, unknown>) => LibrarySnapshot<TEntry, TCollection>
  /** 读当前内存状态 */
  getSnapshot: () => LibrarySnapshot<TEntry, TCollection>
  /** 把读到的快照写回内存状态 */
  applySnapshot: (snapshot: LibrarySnapshot<TEntry, TCollection>) => void
}

export function createLibraryPersistence<
  TEntry extends { id: string },
  TCollection extends { id: string }
>(options: CreateLibraryPersistenceOptions<TEntry, TCollection>): LibraryPersistence {
  const { library, legacyKey, parseLegacy, getSnapshot, applySnapshot } = options

  /** 上一次成功落盘的行指纹 */
  let flushed = new Map<string, string>()
  let flushedUi: string | null = null

  let dirty = false
  let hydrated = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> = Promise.resolve()

  function readLegacy(): LibrarySnapshot<TEntry, TCollection> | null {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(legacyKey)
    } catch {
      return null
    }
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      return parseLegacy(parsed as Record<string, unknown>)
    } catch (error) {
      console.warn(`[LibraryStore] 旧 localStorage 数据解析失败（${legacyKey}）:`, error)
      return null
    }
  }

  /** 记住这份快照就是「已落盘」的状态，之后的 diff 以它为基准 */
  function seedFlushed(snapshot: LibrarySnapshot<TEntry, TCollection>): void {
    flushed = new Map()
    for (const record of buildLibraryRecords(snapshot)) {
      flushed.set(recordKey(record.kind, record.id), recordFingerprint(record))
    }
    flushedUi = JSON.stringify(snapshot.ui)
  }

  async function hydrate(): Promise<void> {
    try {
      const loaded = await libraryStoreAPI.load(library)

      // 还没迁移过就先看 localStorage 里有没有旧数据。没有 preload 时（浏览器调试、
      // 单元测试）loaded 是 null，同样走这条路，只是不写库。
      if (!loaded || !loaded.migratedFromLocal) {
        const legacy = readLegacy()
        if (legacy) {
          const migrated = await libraryStoreAPI.migrate(library, {
            records: buildLibraryRecords(legacy),
            ui: JSON.stringify(legacy.ui)
          })
          // 只有确认落库了才删旧数据，否则下次启动还能原样重来
          if (migrated) {
            try {
              localStorage.removeItem(legacyKey)
            } catch {
              // 删不掉不影响正确性，SQLite 那边的标记已经置位了
            }
          }
          applySnapshot(legacy)
          seedFlushed(legacy)
          return
        }
      }

      if (!loaded) return

      const { entries, collections } = parseRecords<TEntry, TCollection>(loaded.records)
      const snapshot = { entries, collections, ui: parseUi(loaded.ui) }
      applySnapshot(snapshot)
      seedFlushed(snapshot)
    } catch (error) {
      // 读不出来就当空库开，不要把整个页面卡死在这里
      console.warn(`[LibraryStore] 读取失败（${library}）:`, error)
    } finally {
      hydrated = true
    }
  }

  function clearTimers(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer)
      maxWaitTimer = null
    }
  }

  async function writeOnce(): Promise<void> {
    // 还没读完就写，等于把空的内存状态盖到库上
    if (!hydrated || !dirty) return
    dirty = false

    const snapshot = getSnapshot()
    const records = buildLibraryRecords(snapshot)
    const diff = diffLibraryRecords(flushed, records)
    const ui = JSON.stringify(snapshot.ui)
    const uiChanged = ui !== flushedUi

    if (!diff.upserts.length && !diff.deletes.length && !uiChanged) return

    try {
      await libraryStoreAPI.save(library, {
        upserts: diff.upserts,
        deletes: diff.deletes,
        ...(uiChanged ? { ui } : {})
      })
      flushed = diff.next
      flushedUi = ui
    } catch (error) {
      // 存盘失败不能把用户的操作一起带走 —— 保留旧快照，下次落盘会把这批行重试一遍。
      dirty = true
      console.warn(`[LibraryStore] 存盘失败（${library}）:`, error)
    }
  }

  function flush(): Promise<void> {
    clearTimers()
    inFlight = inFlight.then(writeOnce, writeOnce)
    return inFlight
  }

  function persist(): void {
    dirty = true
    // 还没读完就先别排落盘，等 hydrate 完成后统一补一次
    if (!hydrated) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null
        void flush()
      }, FLUSH_MAX_WAIT_MS)
    }
  }

  const ready = hydrate().then(() => {
    // 读取期间用户可能已经动过（比如刚灌进去的示例数据），补一次落盘
    if (dirty) persist()
  })

  // 关窗前把最后 200ms 的改动尽量送出去
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      void flush()
    })
  }

  return { ready, persist, flush }
}
