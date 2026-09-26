/**
 * 看过的页的缓存（设计 2.1 第 3、4 条）。
 *
 * 每页带着取回时的 `{generation, epoch}`。在线时只有代号与库的当前代号一致才算有效；
 * 库的代号往前走时，**没受影响的页原地改标到新代号**（仍然有效），受影响的页作废 ——
 * 这就是"只重取可见且受影响的那几页"：渲染层对可见窗口重新要一遍，没受影响的直接命中。
 *
 * 离线时不看代号，给看过的最后一版并标成 stale。磁盘层只在离线兜底时读，
 * 在线路径只走内存（内存有字节上限，按最近使用淘汰）。
 *
 * 这不是行同步：从不对账，丢了就重取。
 */
import type { DiskLru } from './diskLru'

export interface PageScope {
  /** 列表 / 分面的范围文件夹；null 表示不知道（按受影响处理） */
  dir: number | null
  /** 该文件夹的路径（知道的话）；用于按路径判断祖先关系 */
  path: string | null
  /** 递归视图、子文件夹列表（计数随子树变）都算 recursive */
  recursive: boolean
  /** 搜索结果：任何变化都可能影响排名，一律受影响 */
  search: boolean
}

export interface DirtySet {
  dirIds: number[]
  paths: string[]
  /** paths 下整棵子树都可能变了（服务端事件的 broad） */
  subtree?: boolean
}

export interface PageEntry<T> {
  generation: number
  epoch: number
  scope: PageScope
  storedAt: number
  bytes: number
  data: T
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/** 一页是否受这批脏文件夹影响（纯函数，测试直接调） */
export function scopeAffected(scope: PageScope, dirty: DirtySet): boolean {
  if (scope.search) return true
  if (scope.dir !== null && dirty.dirIds.includes(scope.dir)) return true
  if (dirty.paths.length > 0) {
    if (scope.path === null) return true
    const base = normalizePath(scope.path)
    for (const raw of dirty.paths) {
      const path = normalizePath(raw)
      if (path === base) return true
      if (scope.recursive && (base === '' || path.startsWith(`${base}/`))) return true
      if (dirty.subtree && (path === '' || base.startsWith(`${path}/`))) return true
    }
  }
  // 只给了文件夹 id、没有路径：递归视图无法判断祖先关系，保守地算受影响
  if (dirty.paths.length === 0 && dirty.dirIds.length > 0 && scope.recursive) return true
  return false
}

interface Held {
  library: string
  key: string
  entry: PageEntry<unknown>
}

export class PageCache {
  private readonly memory = new Map<string, Held>()
  private memoryBytes = 0
  private readonly maxMemoryBytes: number
  private readonly disk: DiskLru | null
  /** 还没落盘的写：离线读同一页时先等它写完，免得刚看过的页读不到 */
  private readonly writes = new Map<string, Promise<void>>()

  constructor(options: { maxMemoryBytes: number; disk?: DiskLru | null }) {
    this.maxMemoryBytes = options.maxMemoryBytes
    this.disk = options.disk ?? null
  }

  private id(library: string, key: string): string {
    return `${library}\u0000${key}`
  }

  /** 在线读：只认代号和纪元都对得上的 */
  getFresh<T>(
    library: string,
    key: string,
    generation: number,
    epoch: number
  ): PageEntry<T> | null {
    const id = this.id(library, key)
    const held = this.memory.get(id)
    if (!held) return null
    if (held.entry.generation !== generation || held.entry.epoch !== epoch) return null
    // 最近使用：挪到 Map 末尾
    this.memory.delete(id)
    this.memory.set(id, held)
    return held.entry as PageEntry<T>
  }

  /** 离线读：内存里有就给内存的，否则去磁盘找看过的最后一版 */
  async getAny<T>(library: string, key: string): Promise<PageEntry<T> | null> {
    const held = this.memory.get(this.id(library, key))
    if (held) return held.entry as PageEntry<T>
    if (!this.disk) return null
    const id = this.id(library, key)
    await this.writes.get(id)
    const raw = await this.disk.get(id)
    if (!raw) return null
    try {
      return JSON.parse(raw.toString('utf8')) as PageEntry<T>
    } catch {
      return null
    }
  }

  put<T>(library: string, key: string, entry: Omit<PageEntry<T>, 'bytes' | 'storedAt'>): void {
    const text = JSON.stringify({ ...entry, storedAt: Date.now(), bytes: 0 })
    const full: PageEntry<T> = { ...entry, storedAt: Date.now(), bytes: text.length * 2 }
    const id = this.id(library, key)
    const previous = this.memory.get(id)
    if (previous) {
      this.memoryBytes -= previous.entry.bytes
      this.memory.delete(id)
    }
    this.memory.set(id, { library, key, entry: full as PageEntry<unknown> })
    this.memoryBytes += full.bytes
    while (this.memoryBytes > this.maxMemoryBytes && this.memory.size > 1) {
      const oldest = this.memory.keys().next().value as string
      const dropped = this.memory.get(oldest)
      this.memory.delete(oldest)
      if (dropped) this.memoryBytes -= dropped.entry.bytes
    }
    if (this.disk) {
      const write = this.disk
        .put(id, Buffer.from(text, 'utf8'))
        .catch(() => undefined)
        .finally(() => {
          if (this.writes.get(id) === write) this.writes.delete(id)
        })
      this.writes.set(id, write)
    }
  }

  /**
   * 库前进到新代号：受影响的页作废，其余改标新代号。
   * dirty 为 'all' 时整库作废（纪元变了、收到 reset、或者不知道哪里变了）。
   * 返回作废了几页（测试和日志用）。
   */
  advance(library: string, dirty: DirtySet | 'all', generation: number, epoch: number): number {
    let dropped = 0
    for (const [id, held] of this.memory) {
      if (held.library !== library) continue
      const entry = held.entry
      // 已经是按新代号取回的页（响应比通知先到），不用动
      if (entry.epoch === epoch && entry.generation >= generation) continue
      const affected = dirty === 'all' || entry.epoch !== epoch || scopeAffected(entry.scope, dirty)
      if (affected) {
        this.memory.delete(id)
        this.memoryBytes -= entry.bytes
        dropped += 1
      } else {
        entry.generation = generation
      }
    }
    return dropped
  }

  /** 代号不变，只丢掉受影响的页（本机刚写过、注释事件） */
  drop(library: string, dirty: DirtySet | 'all'): number {
    let dropped = 0
    for (const [id, held] of this.memory) {
      if (held.library !== library) continue
      if (dirty === 'all' || scopeAffected(held.entry.scope, dirty)) {
        this.memory.delete(id)
        this.memoryBytes -= held.entry.bytes
        dropped += 1
      }
    }
    return dropped
  }

  dropLibrary(library: string): void {
    this.advance(library, 'all', Number.POSITIVE_INFINITY, -1)
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.memory.size, bytes: this.memoryBytes }
  }
}
