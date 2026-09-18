import path from 'path'
import { promises as nodeFsPromises } from 'fs'

/**
 * 队列只用到这三个操作，抽成接口是为了测试里能塞一份假的文件系统 ——
 * 并发、重试、去重这些逻辑不该为了跑测试就去磁盘上摆 30G 素材。
 */
export interface PackageCopyQueueFs {
  stat: (p: string) => Promise<{ size: number }>
  mkdir: (dir: string) => Promise<void>
  copyFile: (source: string, target: string) => Promise<void>
}

const defaultFs: PackageCopyQueueFs = {
  stat: async (p) => {
    const s = await nodeFsPromises.stat(p)
    return { size: s.size }
  },
  mkdir: async (dir) => {
    await nodeFsPromises.mkdir(dir, { recursive: true })
  },
  /**
   * 用 `fs.copyFile` 而不是 createReadStream().pipe(createWriteStream())。
   *
   * 前者在 Windows 上走 CopyFileEx、在 Linux 上走 copy_file_range，字节不经过
   * JS 堆；后者每个 chunk 都要在用户态搬一趟。30G 素材包上这个差距是分钟级的。
   */
  copyFile: (source, target) => nodeFsPromises.copyFile(source, target)
}

/** 文件被引擎或杀软占着时的典型错误码，这几种才值得重试 */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

const isRetryable = (error: unknown): boolean =>
  RETRYABLE_CODES.has(String((error as NodeJS.ErrnoException)?.code || ''))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface CopyFileWithRetryOptions {
  fs?: PackageCopyQueueFs
  maxRetries?: number
  retryDelayMs?: (attempt: number) => number
}

/**
 * 拷一个文件，遇到「文件被占用」类错误退避重试。
 */
export const copyFileWithRetry = async (
  source: string,
  target: string,
  options: CopyFileWithRetryOptions = {}
): Promise<void> => {
  const fsImpl = options.fs ?? defaultFs
  const maxRetries = options.maxRetries ?? 8
  const delayFor = options.retryDelayMs ?? ((attempt: number) => Math.min(1000, 100 * attempt))

  let attempt = 0
  for (;;) {
    try {
      await fsImpl.copyFile(source, target)
      return
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) throw error
      attempt++
      await sleep(delayFor(attempt))
    }
  }
}

export type PackageCopyTask = {
  source: string
  target: string
  /** 只用于回报，允许为空（依赖资产没有 assetKey） */
  assetKey: string
  /** 源文件字节数，用于算进度；不知道就传 0 */
  size: number
}

export type PackageCopyStats = {
  /** 入队的文件数（已去重） */
  queued: number
  copied: number
  failed: number
  bytesTotal: number
  bytesCopied: number
}

export type PackageCopyFailure = {
  source: string
  target: string
  error: string
}

/**
 * 两个**不同的源**要往同一个目标位置写。
 *
 * 典型场景是两个素材包里有同一条软路径（比如各有一个 `/Game/Chars/SK_Hero`），
 * 它们算出来的目标路径一模一样。队列只会写先到的那个 —— 这本身是对的（并发下
 * 两个 writer 写同一个文件就是数据损坏），但**必须报出来**，否则用户拿到的工程里
 * 有一个包的资产被静默换成了另一个包的。
 */
export type PackageCopyConflict = {
  target: string
  keptSource: string
  rejectedSource: string
}

export interface PackageCopyQueueOptions {
  /** 同时拷几个文件 */
  concurrency?: number
  maxRetries?: number
  fs?: PackageCopyQueueFs
  retryDelayMs?: (attempt: number) => number
  /** 每拷完一个文件回调一次，调用方自己节流 */
  onProgress?: (stats: PackageCopyStats) => void
  /**
   * 目标文件系统区不区分大小写。默认按平台猜（Windows / macOS 不区分）。
   * 测试里显式指定，别让用例的结论跟着跑在哪台机器上变。
   */
  caseInsensitiveTargets?: boolean
}

/** Windows 和 macOS 默认都是不区分大小写的文件系统 */
const platformIsCaseInsensitive = (): boolean =>
  process.platform === 'win32' || process.platform === 'darwin'

/**
 * 把目标路径归一成「同一个文件就得到同一个键」。
 *
 * `Chars/Shared.uasset` 和 `chars/shared.uasset` 在 Windows 上是同一个文件，
 * 按原样当两个键的话，去重、冲突保护、失败归属三样全部落空 —— B 会静默覆盖 A。
 */
const normalizeTargetKey = (target: string, caseInsensitive: boolean): string => {
  const unified = target.split('\\').join('/')
  return caseInsensitive ? unified.toLowerCase() : unified
}

/**
 * 带并发和去重的文件拷贝队列。
 *
 * 为什么要有这个东西：一次导入几千个资产，串行拷贝把磁盘队列深度压在 1，
 * NVMe 和 SMB 共享的吞吐都发挥不出来（SMB 尤其：每个文件一次往返，延迟主导）。
 * 同时，规划（解析依赖、算目标路径）和拷贝可以流水线并行 —— 规划边算边入队，
 * 队列后台就开始搬，两边不用互相等。
 *
 * 按**目标路径**去重是必须的，不只是省事：几千个动画共用一副骨骼时，同一个目标
 * 文件会被反复要求写入，并发下两个 writer 同时开同一个文件就是数据损坏。
 */
export class PackageCopyQueue {
  private readonly concurrency: number
  private readonly maxRetries: number
  private readonly fsImpl: PackageCopyQueueFs
  private readonly retryDelayMs?: (attempt: number) => number
  private readonly onProgress?: (stats: PackageCopyStats) => void

  private readonly caseInsensitive: boolean

  private readonly pending: PackageCopyTask[] = []
  /** 已经排过队的目标（归一化后的键），用来去重 */
  private readonly seenTargets = new Set<string>()
  /** 已经建过的目录，省掉每个文件一次 mkdir */
  private readonly ensuredDirs = new Set<string>()
  private readonly workers = new Set<Promise<void>>()
  private readonly failures: PackageCopyFailure[] = []
  private readonly conflicts: PackageCopyConflict[] = []
  /** 已经报过的「目标 + 被拒来源」，同一件事不重复报 */
  private readonly reportedConflicts = new Set<string>()
  /** 归一化后的目标键 → 先到的那个源，用来识别冲突 */
  private readonly targetSources = new Map<string, string>()

  private activeWorkers = 0
  private cancelled = false

  private readonly statsInternal: PackageCopyStats = {
    queued: 0,
    copied: 0,
    failed: 0,
    bytesTotal: 0,
    bytesCopied: 0
  }

  constructor(options: PackageCopyQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 4)
    this.maxRetries = options.maxRetries ?? 8
    this.fsImpl = options.fs ?? defaultFs
    this.retryDelayMs = options.retryDelayMs
    this.onProgress = options.onProgress
    this.caseInsensitive = options.caseInsensitiveTargets ?? platformIsCaseInsensitive()
  }

  /** 外面（比如失败归属）要和队列用同一套目标标识，才不会各归各的 */
  targetKey(target: string): string {
    return normalizeTargetKey(target, this.caseInsensitive)
  }

  /**
   * 认领「这个源要往这个目标写」，但不排队。
   *
   * 为什么要单独有这一步：调用方在入队**之前**会先判断「目标已经有了就跳过」。
   * 只在 `enqueue` 里查冲突的话，第二个包的文件恰好和第一个包一样大时会先被跳过，
   * 根本走不到冲突检查 —— 于是 B 包的资产被 A 包的静默顶替，一条警告都没有。
   *
   * **认领是有约束力的**：先到的那个源拥有这个目标，后来的不许写。只记警告不拦住的话，
   * 会出现「警告说保留了 A、文件里躺的是 B」这种警告和事实相反的局面。
   *
   * @returns `source` 是不是这个目标的归属者（自己刚认领的，或者本来就是自己的）
   */
  claimTarget(source: string, target: string): boolean {
    const key = this.targetKey(target)
    const keptSource = this.targetSources.get(key)
    if (keptSource === undefined) {
      this.targetSources.set(key, source)
      return true
    }
    if (keptSource === source) return true

    // 换了个源就是两个素材包撞到同一个目标位置了。
    // 同一对「目标 + 被拒来源」只报一次：调用方会先 claimTarget 再 enqueue，
    // 不去重的话同一件事会重复报两遍。
    const conflictId = `${key}|${source}`
    if (!this.reportedConflicts.has(conflictId)) {
      this.reportedConflicts.add(conflictId)
      this.conflicts.push({ target, keptSource, rejectedSource: source })
    }
    return false
  }

  /**
   * @returns 是否真的入队。目标已被别的源认领、或已经排过队时返回 false
   */
  enqueue(task: PackageCopyTask): boolean {
    if (this.cancelled) return false

    // 认领不到就是别人的目标，不许覆盖
    if (!this.claimTarget(task.source, task.target)) return false
    const key = this.targetKey(task.target)
    if (this.seenTargets.has(key)) return false

    this.seenTargets.add(key)
    this.pending.push(task)
    this.statsInternal.queued++
    this.statsInternal.bytesTotal += Math.max(0, task.size)
    this.pump()
    return true
  }

  /**
   * 等到队列里的活全部做完。
   *
   * 每轮都要重新 `pump` 一次，不能只在进入时泵一遍：worker 发现队列空了就会退出，
   * 而它退出和从 `workers` 里摘掉之间隔着一个微任务 —— 正好卡在这个缝里入队的活，
   * 会既没有 worker 认领、也不会被这一轮的 `Promise.all` 等到。并发 1 的时候尤其容易撞上。
   */
  async drain(): Promise<void> {
    for (;;) {
      this.pump()
      if (this.workers.size === 0) {
        // 到这一步说明所有 worker 都已收尾（activeWorkers 归零），
        // 还有活的话上面那次 pump 一定拉得起新 worker，不会空转
        if (this.pending.length === 0 || this.cancelled) return
        continue
      }
      await Promise.all(Array.from(this.workers))
    }
  }

  /** 停在当前这个文件之后，剩下的不做了 */
  cancel(): void {
    this.cancelled = true
    this.pending.length = 0
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  get stats(): PackageCopyStats {
    return { ...this.statsInternal }
  }

  getFailures(): PackageCopyFailure[] {
    return [...this.failures]
  }

  /** 被目标路径去重挡掉的、来源不同的那些 */
  getConflicts(): PackageCopyConflict[] {
    return [...this.conflicts]
  }

  private pump(): void {
    while (!this.cancelled && this.activeWorkers < this.concurrency && this.pending.length > 0) {
      const worker = this.runWorker()
      this.workers.add(worker)
      void worker.finally(() => {
        this.workers.delete(worker)
      })
    }
  }

  private async runWorker(): Promise<void> {
    this.activeWorkers++
    try {
      while (!this.cancelled) {
        const task = this.pending.shift()
        if (!task) break
        await this.copyOne(task)
      }
    } finally {
      this.activeWorkers--
    }
  }

  private async copyOne(task: PackageCopyTask): Promise<void> {
    try {
      const dir = path.dirname(task.target)
      const dirKey = this.targetKey(dir)
      if (!this.ensuredDirs.has(dirKey)) {
        await this.fsImpl.mkdir(dir)
        this.ensuredDirs.add(dirKey)
      }

      await copyFileWithRetry(task.source, task.target, {
        fs: this.fsImpl,
        maxRetries: this.maxRetries,
        retryDelayMs: this.retryDelayMs
      })

      this.statsInternal.copied++
      this.statsInternal.bytesCopied += Math.max(0, task.size)
    } catch (error) {
      this.statsInternal.failed++
      this.failures.push({
        source: task.source,
        target: task.target,
        error: String(error instanceof Error ? error.message : error)
      })
    }

    this.onProgress?.(this.stats)
  }
}
