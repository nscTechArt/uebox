import path from 'path'
import { promises as nodeFsPromises } from 'fs'

/**
 * HTTP 服务器保管库（`networkPath` 是 http(s) 的那种）的下载侧。
 *
 * 这类库的源文件在另一台机器上：服务端可能跑在 Mac、客户端在 Windows，
 * `originPath` 是对方的本地路径，客户端根本访问不到，只能一条 HTTP 请求拿一个文件。
 * 于是有两件事和本地库 / SMB 库完全不同：
 *
 * - 拿一个文件要一次网络往返。串行下 500 个动画，时间全花在延迟上，带宽闲着 ——
 *   所以下载要有并发池（`HttpDownloadPool`），和拷贝池是一个道理。
 * - 「这个资产是不是已经在工程里了」如果非得先把文件下下来才能判断，重复导入一个
 *   文件夹就得把整包白下一遍 —— 所以查重只能看资产记录（`httpVaultTargetPath`）。
 */

export type HttpVaultTarget = {
  /** 形如 `http://192.168.31.210:18900`，不带路径 */
  baseUrl: string
  /** 服务端那侧的保管库 ID，从 networkPath 的路径段取 */
  vaultId: string
}

/** 只用到资产记录里跟「文件叫什么、放哪、多大」有关的几个字段 */
export type HttpVaultAssetRef = {
  filePath?: string
  softPath?: string
  /** 用来识别上次写了一半的文件；老数据里可能没有 */
  fileSize?: number
}

/**
 * 保管库是不是 HTTP 服务器库；是的话顺手把 baseUrl 和 vaultId 拆出来。
 *
 * 拆不出 vaultId 的按「不是」处理：没有 vaultId 拼出来的下载地址必然 404，
 * 与其发一轮请求再失败，不如让上层走原来那条 originPath 的路自己报错。
 */
export const resolveHttpVaultTarget = (
  vault: { vaultType?: string; networkPath?: string } | null | undefined
): HttpVaultTarget | null => {
  if (vault?.vaultType !== 'network') return null

  const networkPath = String(vault.networkPath || '')
  if (!networkPath.startsWith('http://') && !networkPath.startsWith('https://')) return null

  try {
    const url = new URL(networkPath)
    const vaultId = url.pathname.replace(/^\//, '')
    if (!vaultId) return null
    return { baseUrl: `${url.protocol}//${url.host}`, vaultId }
  } catch {
    return null
  }
}

/**
 * 资产在服务器保管库里的相对路径，也就是下载地址里的那一段。
 *
 * 兼容旧数据：早期 RemoteImportService 没重写 `filePath`，库里存的是**客户端本地**
 * 的绝对路径。那种记录只剩文件名可用，退回拿文件名去服务器根上碰运气。
 */
export const httpVaultRelativePath = (asset: HttpVaultAssetRef): string => {
  const raw = String(asset.filePath || '')
  if (!raw) return ''

  const isAbsoluteWindows = /^[A-Za-z]:[\\/]/.test(raw)
  const isAbsoluteUnix = raw.startsWith('/') && !raw.startsWith('/Game')
  return isAbsoluteWindows || isAbsoluteUnix ? path.basename(raw) : raw
}

/**
 * 资产落到工程 Content 下的目标路径 —— 只看资产记录，不碰源文件。
 *
 * 目录由 `softPath` 决定、文件名由 `filePath` 决定，两个都在库里躺着。
 * 这正是查重可以排在下载**前面**的原因：判断「已经导过了」不需要知道源文件
 * 在哪、多大、存不存在。
 *
 * 注意不能拿下载下来的临时文件的名字去算：临时文件名带唯一序号前缀，
 * 用它查重永远查不中，等于每次都重新导一遍。
 */
export const httpVaultTargetPath = (
  contentBase: string,
  asset: HttpVaultAssetRef
): string | null => {
  const softPath = String(asset.softPath || '')
  if (!softPath) return null

  const fileName = path.basename(httpVaultRelativePath(asset))
  if (!fileName) return null

  const relative = softPath.replace(/^\/Game\/?/, '')
  const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
  return dir ? path.join(contentBase, dir, fileName) : path.join(contentBase, fileName)
}

/** 一个软路径在目标工程里可能落成的几条路径（不知道是 .uasset 还是 .umap，两个都试） */
const httpVaultDependencyTargets = (contentBase: string, softPath: string): string[] => {
  const relative = String(softPath || '').replace(/^\/Game\/?/, '')
  if (!relative) return []
  return ['.uasset', '.umap'].map((ext) => path.join(contentBase, relative + ext))
}

/** 按软路径回查资产记录，用来往下走依赖链 */
export type HttpVaultAssetLookup = (
  softPath: string
) => (HttpVaultAssetRef & { imports?: unknown }) | null | undefined

export type HttpVaultImportedProbe = {
  /** 默认取磁盘 stat，测试里可以替换 */
  stat?: (target: string) => Promise<{ size: number }>
  /**
   * 资产记录里的**直接依赖**软路径。
   *
   * 必须一起查：只看主文件在不在的话，「上次导到一半被中止 —— 主文件写了、依赖没写」
   * 会被判成已存在，重试永远补不回来。
   */
  dependencySoftPaths?: string[]
  /**
   * 按软路径回查资产记录。给了它就能沿着依赖链一路往下验，
   * 不给就只验一层（老调用方的行为）。
   */
  lookupBySoftPath?: HttpVaultAssetLookup
  /**
   * 读**目标工程里那个包**的真实依赖（解析 .uasset 二进制）。
   *
   * 为什么不能只信数据库：库里的 imports 是扫描时收集的，本来就可能漏
   * （`collectReferences` 会跳过没有路径的 objectName），这一点代码里早有注释。
   * 拿一份可能漏记的清单去证明「导全了」，逻辑上不成立。
   *
   * 好在要验的文件已经在本地目标工程里了 —— 直接读它，那才是权威。
   * 返回 `null` 表示解析不出来：那就**不敢**下「已导全」的结论。
   */
  readImportsOfTarget?: (target: string) => Promise<string[] | null>
  /** 依赖链最多走多少个节点，防止畸形图把这一步拖死 */
  maxNodes?: number
}

const DEFAULT_MAX_DEPENDENCY_NODES = 512

/** 资产记录里的 imports 可能是 JSON 字符串，也可能已经是数组 */
const readImports = (imports: unknown): string[] => {
  if (!imports) return []
  try {
    const arr = typeof imports === 'string' ? JSON.parse(imports) : imports
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && x.startsWith('/Game'))
  } catch {
    return []
  }
}

/**
 * 目标工程里已经**完整地**有这个资产了吗。
 *
 * 「完整」有四层，缺一不可：
 * - 主文件在，而且长度和资产记录里的 `fileSize` 对得上 —— `fs.copyFile` 不是原子操作，
 *   中断会留下半截文件，光看「文件存在」会把它当成已导入
 * - **整条依赖链**都在，不是只看一层。模型 → 材质 → 贴图，贴图缺了照样是残的
 * - 链上每个节点同样要比长度
 * - 依赖清单以**磁盘上那个包的二进制**为准，不以数据库记录为准。库里的 imports
 *   可能漏记，拿漏记的清单证明「导全了」是循环论证
 *
 * 全程只查本地文件，一个网络请求都不发 —— 这正是它必须排在下载前面的原因。
 */
export const httpVaultAssetAlreadyImported = async (
  contentBase: string,
  asset: HttpVaultAssetRef,
  probe: HttpVaultImportedProbe = {}
): Promise<boolean> => {
  const statFile = probe.stat ?? ((target: string) => nodeFsPromises.stat(target))
  const lookup = probe.lookupBySoftPath
  let budget = probe.maxNodes ?? DEFAULT_MAX_DEPENDENCY_NODES

  /** 目标在不在、长度对不对。`expectedSize <= 0` 表示记录里没有长度，只能认「在」 */
  const intact = async (target: string, expectedSize: number): Promise<boolean> => {
    try {
      const stat = await statFile(target)
      return expectedSize > 0 ? stat.size === expectedSize : true
    } catch {
      return false
    }
  }

  const mainTarget = httpVaultTargetPath(contentBase, asset)
  if (!mainTarget) return false
  if (!(await intact(mainTarget, Number(asset.fileSize || 0)))) return false

  /**
   * 一个已经落地的包的真实依赖。
   *
   * 优先读磁盘上那个包；读不出来（没给解析器、或解析失败）就返回 null，
   * 由调用处按「无法确认」处理 —— 退回数据库记录等于又把不可靠的东西当证据。
   */
  const importsOfTarget = async (target: string): Promise<string[] | null> => {
    if (!probe.readImportsOfTarget) return null
    try {
      return await probe.readImportsOfTarget(target)
    } catch {
      return null
    }
  }

  const rootImports = probe.readImportsOfTarget
    ? await importsOfTarget(mainTarget)
    : (probe.dependencySoftPaths ?? readImports((asset as { imports?: unknown }).imports))

  // 连主包自己的依赖都读不出来，就没有资格说「已导全」
  if (rootImports === null) return false

  const visited = new Set<string>()
  const queue = [...rootImports]

  while (queue.length > 0) {
    const softPath = queue.shift() as string
    if (!softPath || visited.has(softPath)) continue
    visited.add(softPath)

    if (--budget < 0) {
      // 依赖链大到走不完，不敢说「已导入」—— 宁可多导一次，也不要留个残的
      console.warn(`[httpVaultDownload] 依赖链超出检查预算，按未导入处理: ${softPath}`)
      return false
    }

    const depAsset = lookup?.(softPath) ?? null

    // 有记录就用记录里的文件名和长度；没记录就只能按软路径猜扩展名、且比不出长度
    const candidates = depAsset
      ? [httpVaultTargetPath(contentBase, depAsset)].filter((t): t is string => Boolean(t))
      : httpVaultDependencyTargets(contentBase, softPath)
    if (candidates.length === 0) continue

    const expectedSize = Number(depAsset?.fileSize || 0)
    let landed: string | null = null
    for (const candidate of candidates) {
      if (await intact(candidate, expectedSize)) {
        landed = candidate
        break
      }
    }
    if (!landed) return false

    if (probe.readImportsOfTarget) {
      const deeper = await importsOfTarget(landed)
      if (deeper === null) return false
      queue.push(...deeper)
    } else if (depAsset) {
      queue.push(...readImports(depAsset.imports))
    }
  }

  return true
}

/** 下一个文件，返回它落在本地的临时路径 */
export type HttpDownloadFn = (relativeFilePath: string) => Promise<string>

export type HttpDownloadStats = {
  /** 排过队的文件数（已去重） */
  queued: number
  completed: number
  failed: number
}

export interface HttpDownloadPoolOptions {
  /** 同时下几个文件 */
  concurrency?: number
  download: HttpDownloadFn
}

type DownloadSlot = {
  relativePath: string
  promise: Promise<string>
  resolve: (localPath: string) => void
  reject: (error: Error) => void
  started: boolean
}

/**
 * 带并发和去重的下载池。
 *
 * 和 `PackageCopyQueue` 是一对：规划循环串行地一个资产一个资产往下走，真正耗时的
 * IO 都甩到池子里并发做。区别在于拷贝是「排进去就不用管了」，下载排进去之后规划
 * 还要**等这个文件**才能继续解析依赖 —— 所以这里每个任务都带一个 promise。
 *
 * 两条规则：
 * - 按相对路径去重。几百个资产共用一张贴图时，它只该下一次。
 * - `fetch` 插队。预取是按批次顺序排的，而规划循环真正卡在哪个文件上只有它自己知道；
 *   规划开口要的那个文件如果还老实排在队尾，等于白预取。
 */
export class HttpDownloadPool {
  private readonly concurrency: number
  private readonly download: HttpDownloadFn

  private readonly queue: DownloadSlot[] = []
  private readonly slots = new Map<string, DownloadSlot>()
  private readonly workers = new Set<Promise<void>>()
  /** 已经落到临时目录的文件，收尾时要删掉 */
  private readonly downloaded: string[] = []

  private activeWorkers = 0
  private cancelledFlag = false

  private readonly statsInternal: HttpDownloadStats = { queued: 0, completed: 0, failed: 0 }

  constructor(options: HttpDownloadPoolOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 4)
    this.download = options.download
  }

  /**
   * 预排一个文件，不等它下完。
   *
   * @returns 是否真的入队。已经排过或已在下的返回 false（已去重）
   */
  prefetch(relativePath: string): boolean {
    if (this.cancelledFlag || !relativePath) return false
    if (this.slots.has(relativePath)) return false

    const slot = this.createSlot(relativePath)
    // 预取的下载没人 await，失败了不挂个处理函数会变成 unhandledRejection 把进程带走
    slot.promise.catch(() => {})
    this.queue.push(slot)
    this.pump()
    return true
  }

  /** 要这个文件的本地路径。没排过就插队立刻开始，排过就等它 */
  fetch(relativePath: string): Promise<string> {
    if (!relativePath) return Promise.reject(new Error('下载路径为空'))

    const existing = this.slots.get(relativePath)
    if (existing) {
      if (!existing.started) this.promote(existing)
      return existing.promise
    }

    if (this.cancelledFlag) return Promise.reject(new Error('下载已取消'))

    const slot = this.createSlot(relativePath)
    this.queue.unshift(slot)
    this.pump()
    return slot.promise
  }

  /** 等池子里的活全部做完（取消之后是等正在下的那几个收尾） */
  async drain(): Promise<void> {
    for (;;) {
      this.pump()
      if (this.workers.size === 0) {
        // worker 退出和从 workers 里摘掉之间隔着一个微任务，这里再泵一次，
        // 正好卡在那个缝里排进来的活才不会没人认领（同 PackageCopyQueue.drain）
        if (this.queue.length === 0 || this.cancelledFlag) return
        continue
      }
      await Promise.all(Array.from(this.workers))
    }
  }

  /** 停在当前这几个文件之后。还排着队的直接拒掉，否则等它的规划会永远挂在那 */
  cancel(): void {
    this.cancelledFlag = true
    const pending = this.queue.splice(0, this.queue.length)
    for (const slot of pending) {
      this.slots.delete(slot.relativePath)
      slot.reject(new Error('下载已取消'))
    }
  }

  get isCancelled(): boolean {
    return this.cancelledFlag
  }

  get stats(): HttpDownloadStats {
    return { ...this.statsInternal }
  }

  /** 已下到本地的临时文件，交给调用方收尾删除 */
  downloadedFiles(): string[] {
    return [...this.downloaded]
  }

  private createSlot(relativePath: string): DownloadSlot {
    let resolve: (localPath: string) => void = () => {}
    let reject: (error: Error) => void = () => {}
    const promise = new Promise<string>((res, rej) => {
      resolve = res
      reject = rej
    })

    const slot: DownloadSlot = { relativePath, promise, resolve, reject, started: false }
    this.slots.set(relativePath, slot)
    this.statsInternal.queued++
    return slot
  }

  private promote(slot: DownloadSlot): void {
    const index = this.queue.indexOf(slot)
    if (index <= 0) return
    this.queue.splice(index, 1)
    this.queue.unshift(slot)
  }

  private pump(): void {
    while (!this.cancelledFlag && this.activeWorkers < this.concurrency && this.queue.length > 0) {
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
      while (!this.cancelledFlag) {
        const slot = this.queue.shift()
        if (!slot) break
        await this.downloadOne(slot)
      }
    } finally {
      this.activeWorkers--
    }
  }

  private async downloadOne(slot: DownloadSlot): Promise<void> {
    slot.started = true
    try {
      const localPath = await this.download(slot.relativePath)
      this.downloaded.push(localPath)
      this.statsInternal.completed++
      slot.resolve(localPath)
    } catch (error) {
      this.statsInternal.failed++
      slot.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
