/**
 * 磁盘上的有上限缓存（缩略图、看过的页）。
 *
 * 设计要点（设计文档 2.1 / 2.3）：
 *
 * - **键直接映射到路径，读不查任何数据库**：`<root>/<键的前两位>/<键>`。缩略图的键
 *   是内容哈希 + 变体，内容一变哈希就变，所以永远不需要失效。
 * - **上限是真的上限**：写入时累加总字节数；超过上限就从一个分片目录开始按修改
 *   时间淘汰最旧的，直到回到水位线以下。每次只读一个分片目录（总量的 1/256），
 *   所以淘汰的代价与缓存总量无关，不会在主线程上出现"扫全盘"的长任务。
 * - **命中时刷新修改时间**（节流到每个键每小时一次），近似 LRU。
 * - 总字节数记在 `state.json` 里，启动时读它，不扫目录；这个数只是近似值，
 *   偏大只会让淘汰早一点，偏小会在下一轮淘汰时按实际文件大小纠正。
 *
 * 这是缓存：随时可以整个删掉，删了只是重新下载。
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface DiskLruOptions {
  root: string
  maxBytes: number
  /** 淘汰到上限的这个比例以下 */
  lowWatermark?: number
  now?: () => number
}

interface State {
  totalBytes: number
  shardCursor: number
}

const SHARDS = 256
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

/** 非十六进制的键（页缓存的查询串）先哈希一下，保证能当文件名 */
export function cacheKeyOf(input: string): string {
  return /^[0-9a-f]{16,128}(?:-[a-z0-9]{1,16})?$/.test(input)
    ? input
    : createHash('sha256').update(input).digest('hex')
}

export class DiskLru {
  private readonly root: string
  private readonly maxBytes: number
  private readonly lowWatermark: number
  private readonly now: () => number
  private state: State | null = null
  private loading: Promise<State> | null = null
  private evicting: Promise<void> | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private readonly touched = new Map<string, number>()

  constructor(options: DiskLruOptions) {
    this.root = options.root
    this.maxBytes = options.maxBytes
    this.lowWatermark = options.lowWatermark ?? 0.9
    this.now = options.now ?? Date.now
  }

  pathFor(key: string): string {
    const safe = cacheKeyOf(key)
    return join(this.root, safe.slice(0, 2), safe)
  }

  private async load(): Promise<State> {
    if (this.state) return this.state
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await fs.readFile(join(this.root, 'state.json'), 'utf8')
          const parsed = JSON.parse(raw) as Partial<State>
          this.state = {
            totalBytes: Math.max(0, Number(parsed.totalBytes) || 0),
            shardCursor: Math.max(0, Number(parsed.shardCursor) || 0) % SHARDS
          }
        } catch {
          this.state = { totalBytes: 0, shardCursor: 0 }
        }
        return this.state
      })()
    }
    return await this.loading
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, 2000)
    this.persistTimer.unref?.()
  }

  async persistNow(): Promise<void> {
    if (!this.state) return
    await fs.mkdir(this.root, { recursive: true })
    await fs.writeFile(join(this.root, 'state.json'), JSON.stringify(this.state))
  }

  /** 读一项；不在就回 null。命中会（节流地）刷新修改时间 */
  async get(key: string): Promise<Buffer | null> {
    const path = this.pathFor(key)
    try {
      const data = await fs.readFile(path)
      this.touch(key, path)
      return data
    } catch {
      return null
    }
  }

  /** 只要路径（协议处理器直接把文件交给 Chromium） */
  async has(key: string): Promise<string | null> {
    const path = this.pathFor(key)
    try {
      await fs.access(path)
      this.touch(key, path)
      return path
    } catch {
      return null
    }
  }

  private touch(key: string, path: string): void {
    const now = this.now()
    const last = this.touched.get(key) ?? 0
    if (now - last < TOUCH_INTERVAL_MS) return
    this.touched.set(key, now)
    if (this.touched.size > 50_000) this.touched.clear()
    const when = new Date(now)
    void fs.utimes(path, when, when).catch(() => undefined)
  }

  async put(key: string, data: Buffer): Promise<void> {
    const state = await this.load()
    const path = this.pathFor(key)
    await fs.mkdir(join(path, '..'), { recursive: true })
    let previous = 0
    try {
      previous = (await fs.stat(path)).size
    } catch {
      previous = 0
    }
    // 先写临时文件再改名：读的人永远看不到半个文件
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await fs.writeFile(temp, data)
    await fs.rename(temp, path).catch(async (error) => {
      await fs.rm(temp, { force: true })
      throw error
    })
    state.totalBytes = Math.max(0, state.totalBytes - previous + data.length)
    this.schedulePersist()
    if (state.totalBytes > this.maxBytes) void this.evict()
  }

  async delete(key: string): Promise<void> {
    const state = await this.load()
    const path = this.pathFor(key)
    try {
      const size = (await fs.stat(path)).size
      await fs.rm(path, { force: true })
      state.totalBytes = Math.max(0, state.totalBytes - size)
      this.schedulePersist()
    } catch {
      // 本来就没有
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true })
    this.state = { totalBytes: 0, shardCursor: 0 }
    this.loading = null
    this.touched.clear()
  }

  async totalBytes(): Promise<number> {
    return (await this.load()).totalBytes
  }

  private async shardEntries(
    shard: number
  ): Promise<Array<{ path: string; size: number; mtime: number }>> {
    const dir = join(this.root, shard.toString(16).padStart(2, '0'))
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const entries: Array<{ path: string; size: number; mtime: number }> = []
    for (const name of names) {
      if (name.endsWith('.tmp')) continue
      try {
        const stat = await fs.stat(join(dir, name))
        entries.push({ path: join(dir, name), size: stat.size, mtime: stat.mtimeMs })
      } catch {
        // 被并发删掉了
      }
    }
    return entries
  }

  /**
   * 淘汰到水位线以下。并发调用合并成一次。
   *
   * 近似全局 LRU，但每次只读有限几个分片：先从最多 16 个分片里抽样修改时间，
   * 按"要让出的比例"定一个时间线，再逐个分片删掉比这条线旧的；抽样估得不准、
   * 一圈下来还超，就用全部抽过的分片重新定线再来一轮。
   */
  async evict(): Promise<void> {
    const target = this.maxBytes * this.lowWatermark
    // 正在淘汰的那一轮可能开始得比最近几次写入早：等它完了再看一眼，还超就再来
    while (this.evicting) {
      await this.evicting
      if ((await this.load()).totalBytes <= target) return
    }
    this.evicting = (async () => {
      const state = await this.load()
      for (let round = 0; round < 3 && state.totalBytes > target; round += 1) {
        const sampleShards = round === 0 ? 16 : SHARDS
        const sample: Array<{ size: number; mtime: number }> = []
        for (let offset = 0; offset < sampleShards; offset += 1) {
          sample.push(...(await this.shardEntries((state.shardCursor + offset) % SHARDS)))
        }
        if (sample.length === 0) break
        sample.sort((a, b) => a.mtime - b.mtime)
        const sampleBytes = sample.reduce((sum, entry) => sum + entry.size, 0)
        const share = Math.min(1, (state.totalBytes - target) / Math.max(1, state.totalBytes))
        let accumulated = 0
        let cutoff = sample[sample.length - 1].mtime
        for (const entry of sample) {
          accumulated += entry.size
          cutoff = entry.mtime
          if (accumulated >= share * sampleBytes) break
        }
        for (let visited = 0; visited < SHARDS && state.totalBytes > target; visited += 1) {
          const shard = state.shardCursor
          state.shardCursor = (state.shardCursor + 1) % SHARDS
          const entries = (await this.shardEntries(shard)).sort((a, b) => a.mtime - b.mtime)
          for (const entry of entries) {
            if (state.totalBytes <= target || entry.mtime > cutoff) break
            await fs.rm(entry.path, { force: true }).catch(() => undefined)
            state.totalBytes = Math.max(0, state.totalBytes - entry.size)
          }
        }
      }
      this.schedulePersist()
    })()
    try {
      await this.evicting
    } finally {
      this.evicting = null
    }
  }

  /** 按实际文件重算总量（设置页"清理缓存"之后、或怀疑计数漂移时用；按分片逐个异步读） */
  async recount(): Promise<number> {
    const state = await this.load()
    let total = 0
    for (let index = 0; index < SHARDS; index += 1) {
      const dir = join(this.root, index.toString(16).padStart(2, '0'))
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        try {
          total += (await fs.stat(join(dir, name))).size
        } catch {
          // ignore
        }
      }
    }
    state.totalBytes = total
    await this.persistNow()
    return total
  }
}
