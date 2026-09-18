import path from 'path'
import { promises as nodeFsPromises } from 'fs'

/**
 * 只用到这两个操作，而且都是**异步**的。
 *
 * 原来用的是 `existsSync` / `readdirSync`：兜底的模糊搜索会同步递归扫盘，跑在
 * Electron 主进程上，保管库大一点整个窗口就不响应输入了 —— 那就是用户说的「卡死」。
 * 换成异步之后每一步都让出事件循环，扫盘期间界面照样能动，取消请求也进得来。
 *
 * 抽成接口是为了测试里能塞一份假的文件系统，不必在磁盘上摆出一整棵 UE 目录树。
 */
export interface SoftPathResolverFs {
  exists: (p: string) => Promise<boolean>
  readdir: (
    p: string
  ) => Promise<Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>>
}

/** 既不是 ASCII 也不是常规汉字 —— 多半是编码解错了 */
const looksMisencoded = (text: string): boolean => {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x7f) continue
    if (code >= 0x4e00 && code <= 0x9fff) continue
    return true
  }
  return false
}

/**
 * 修复中文编码问题 - 处理 UTF-16 编码（与 UnrealAssetProcessor 一致）
 */
export const fixChineseEncoding = (text: unknown): string => {
  if (!text || typeof text !== 'string') return text as string
  try {
    // 空字节是 UTF-16 的特征
    const NUL = String.fromCharCode(0)
    if (text.includes(NUL)) {
      return Buffer.from(text, 'binary').toString('utf16le').split(NUL).join('')
    }
    if (looksMisencoded(text)) {
      return Buffer.from(text, 'latin1').toString('utf8')
    }
    return text
  } catch {
    return text
  }
}

const normalizePackageLikeSuffix = (suffix: string): string => {
  const segments = suffix.split('/').filter(Boolean)
  if (segments.length >= 2 && segments[segments.length - 1] === segments[segments.length - 2]) {
    segments.splice(segments.length - 2, 1)
  }
  return segments.join('/')
}

/**
 * 从磁盘路径反推 UE 软路径（`/Game/...`）
 */
export const deriveSoftPathFromRealPath = (realPath: string): string => {
  if (!realPath || typeof realPath !== 'string') return ''

  // 这里拿到的是**文件系统路径**，Node 早就解好码了，不需要也不能再「修」一次：
  // `fixChineseEncoding` 把「非 ASCII 且非常用汉字」一律当乱码，
  // `T_Café` / 日文假名 / 韩文都会被改坏，导致软路径对不上、依赖找不到
  const normalizedPath = realPath.replace(/\\/g, '/')
  const withoutExt = normalizedPath.replace(/\.[^./]+$/, '')
  const markers = ['/Content/', '/Game/']

  for (const marker of markers) {
    const markerIndex = withoutExt.lastIndexOf(marker)
    if (markerIndex === -1) continue

    const rawSuffix = withoutExt.slice(markerIndex + marker.length).replace(/^\/+/, '')
    const suffix = normalizePackageLikeSuffix(rawSuffix)
    if (!suffix) continue

    return marker === '/Content/' ? `/Game/${suffix}` : `/${suffix}`
  }

  return ''
}

/**
 * 一个资产所属「素材包」的根。
 *
 * 缓存必须按它分组，不能只按软路径 —— 两个素材包里各有一个 `/Game/Chars/SK_Hero`
 * 是完全正常的事，只按软路径缓存会让第二个包拿到第一个包的文件（评审第 3 条）。
 *
 * 定义：从资产所在目录往上找最近的 `Content` / `Game` 目录；找不到就退回资产自己的
 * 目录。退回的那种情况缓存分得更细，命中率低一点，但不会串包。
 */
export const derivePackRoot = (realPath: string): string => {
  let currentDir = path.dirname(realPath)
  const root = path.parse(realPath).root
  let depth = 0
  const MAX_DEPTH = 12

  while (currentDir && currentDir !== root && depth < MAX_DEPTH) {
    const base = path.basename(currentDir).toLowerCase()
    if (base === 'content' || base === 'game') return currentDir
    currentDir = path.dirname(currentDir)
    depth++
  }

  return path.dirname(realPath)
}

export interface SoftPathResolverOptions {
  fs?: SoftPathResolverFs
  enableCache?: boolean
  /**
   * 整个解析器生命周期内，模糊搜索一共能看多少个目录项。
   *
   * 注意这是**总预算**而不是每次搜索的额度：一次导入里有 300 个找不到的依赖，
   * 每个都给 20000 的额度就等于没有上限（评审指出的那一条）。用光之后模糊搜索
   * 整体停用，只报一次警告 —— 慢慢搜出正确答案和拖着用户等，我们选前者要不起。
   */
  maxScanEntries?: number
  /** 每看多少个目录项让出一次事件循环，保证扫盘期间界面还能动 */
  yieldEvery?: number
  /** 返回 true 时正在进行的扫描立刻收手 */
  isCancelled?: () => boolean
}

const DEFAULT_MAX_SCAN_ENTRIES = 50000
const DEFAULT_YIELD_EVERY = 512

type DirEntry = { isDirectory: () => boolean; isFile: () => boolean; name: string }

const nodeFsAdapter: SoftPathResolverFs = {
  exists: async (p) => {
    try {
      await nodeFsPromises.access(p)
      return true
    } catch {
      return false
    }
  },
  readdir: (p) => nodeFsPromises.readdir(p, { withFileTypes: true }) as Promise<DirEntry[]>
}

/**
 * 把 UE 软路径（`/Game/A/B`）解析成磁盘上的真实文件路径。
 *
 * 一次导入会话共用一个实例：缓存（尤其是**找不到**的否定缓存）跨资产复用，
 * 是文件夹批量导入不慢的关键。缓存一律按「素材包根 + 软路径」分组，见 {@link derivePackRoot}。
 */
export class SoftPathResolver {
  private readonly fsImpl: SoftPathResolverFs
  private readonly enableCache: boolean
  private readonly yieldEvery: number
  private readonly isCancelled: () => boolean

  /** 整个解析器共用的扫描预算 */
  private scanBudget: number
  private budgetExhaustedReported = false
  /** 距离下一次让出事件循环还能看多少个目录项 */
  private untilYield: number

  /** 三元组（主软路径 + 子软路径 + 主磁盘路径）→ 结果，沿用原有语义 */
  private readonly pathCache = new Map<string, string>()
  /** 「素材包根 + 子软路径」→ 已经确认存在的磁盘路径 */
  private readonly verifiedByPackAndSoftPath = new Map<string, string>()
  /** 「素材包根 + 子软路径」→ 模糊搜索已经扑空过，再遇到直接跳过那次递归扫盘 */
  private readonly scanMisses = new Set<string>()
  /** 目录列表缓存：多次模糊搜索会反复走同一批目录 */
  private readonly dirCache = new Map<string, DirEntry[]>()

  constructor(options: SoftPathResolverOptions = {}) {
    this.fsImpl = options.fs ?? nodeFsAdapter
    this.enableCache = options.enableCache ?? true
    this.scanBudget = options.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES
    this.yieldEvery = Math.max(1, options.yieldEvery ?? DEFAULT_YIELD_EVERY)
    this.untilYield = this.yieldEvery
    this.isCancelled = options.isCancelled ?? ((): boolean => false)
  }

  /**
   * @param mainAssetSoftPath 主资产的软路径
   * @param subAssetSoftPath 要解析的依赖软路径
   * @param mainRealPath 主资产在磁盘上的路径，作为向上搜索的起点
   * @returns 磁盘路径；解析不出来时返回按命名规则拼出来的路径（可能并不存在），
   *          完全失败才返回 null —— 沿用调用方原有的容错约定
   */
  async resolve(
    mainAssetSoftPath: string,
    subAssetSoftPath: string,
    mainRealPath: string
  ): Promise<string | null> {
    if (mainAssetSoftPath === subAssetSoftPath) {
      return mainRealPath
    }

    const cacheKey = `${mainAssetSoftPath}:${subAssetSoftPath}:${mainRealPath}`
    if (this.enableCache && this.pathCache.has(cacheKey)) {
      return this.pathCache.get(cacheKey)!
    }

    // 同一个素材包里，同一个软路径只会对应一个文件。上一个资产已经确认过的结果直接复用，
    // 省掉下面那趟逐级向上的 exists —— 500 个动画共用一副骨骼时，省掉的是几万次系统调用。
    // 键里带上素材包根，跨包不会串（评审第 3 条）。
    const packKey = `${derivePackRoot(mainRealPath)}|${subAssetSoftPath}`
    if (this.enableCache) {
      const verified = this.verifiedByPackAndSoftPath.get(packKey)
      if (verified && (await this.fsImpl.exists(verified))) {
        this.pathCache.set(cacheKey, verified)
        return verified
      }
    }

    // 提取依赖资产相对于 /Game/ 的路径，例如 /Game/A/B -> A/B
    const subRelative = subAssetSoftPath.replace(/^\/Game\//, '')
    // 假设依赖资产与主资产同后缀（通常是 .uasset）
    const mainExt = path.extname(mainRealPath)
    const subPathWithExt = subRelative + mainExt
    const subPathWithExtMap = subRelative + '.umap'

    try {
      // 策略 1: 向上搜索 Content Root（最可靠）
      // 从主资产所在目录开始逐级向上，看能否拼出依赖资产路径
      let currentDir = path.dirname(mainRealPath)
      const root = path.parse(mainRealPath).root

      let depth = 0
      const MAX_SEARCH_DEPTH = 10

      while (currentDir !== root && depth < MAX_SEARCH_DEPTH) {
        const tryPath = path.join(currentDir, subPathWithExt)
        const tryPathMap = path.join(currentDir, subPathWithExtMap)

        if (await this.fsImpl.exists(tryPath)) {
          this.remember(cacheKey, packKey, tryPath)
          return tryPath
        }

        if (await this.fsImpl.exists(tryPathMap)) {
          this.remember(cacheKey, packKey, tryPathMap)
          return tryPathMap
        }

        currentDir = path.dirname(currentDir)
        depth++
      }

      // 策略 2: 原有的字符串匹配逻辑（作为回退）

      // 提取主资源路径信息
      const mainRelative = mainAssetSoftPath.replace(/^\/Game\//, '')
      const mainLastSlash = mainRelative.lastIndexOf('/')
      const mainDirs = mainLastSlash === -1 ? [] : mainRelative.slice(0, mainLastSlash).split('/')
      const mainFileName =
        mainLastSlash === -1 ? mainRelative : mainRelative.slice(mainLastSlash + 1)

      // 提取子资源路径信息
      const subRelativeParts = subAssetSoftPath.replace(/^\/Game\//, '')
      const subLastSlash = subRelativeParts.lastIndexOf('/')
      const subDirs = subLastSlash === -1 ? [] : subRelativeParts.slice(0, subLastSlash).split('/')
      const subFileName =
        subLastSlash === -1 ? subRelativeParts : subRelativeParts.slice(subLastSlash + 1)

      // 解析真实路径
      const realParts = mainRealPath.split(/[\\/]/)
      const realFileWithExt = realParts.pop()
      if (!realFileWithExt) return null

      const realExt = realFileWithExt.slice(realFileWithExt.lastIndexOf('.'))
      const realFileName = realFileWithExt.slice(0, realFileWithExt.lastIndexOf('.'))

      // 智能路径匹配逻辑
      let newParts: string[]
      if (
        realFileName === mainFileName &&
        (mainDirs.length === 0 ||
          realParts.slice(-mainDirs.length).join('/') === mainDirs.join('/'))
      ) {
        // 根据主资源目录长度调整切片位置
        const sliceEnd = mainDirs.length > 0 ? -mainDirs.length : undefined
        newParts = [...realParts.slice(0, sliceEnd), ...subDirs, subFileName + realExt]
      } else {
        // 仅替换文件名
        newParts = [...realParts, subFileName + realExt]
      }

      const newPath = newParts.join(path.sep)

      // 替换后缀名为 .uasset
      const parsed = path.parse(newPath)
      const result = path.format({
        dir: parsed.dir,
        name: parsed.name,
        ext: '.uasset'
      })

      if (await this.fsImpl.exists(result)) {
        this.remember(cacheKey, packKey, result)
        return result
      }

      // 策略 3: 模糊搜索。这一步会递归扫盘，只在前两步都落空时才跑，
      // 而且同一个包里同一个软路径扑空过一次就不再重来。
      if (!this.scanMisses.has(packKey)) {
        const fuzzyMatchedPath = await this.findSimilarAssetPath(
          mainRealPath,
          subAssetSoftPath,
          realExt
        )
        if (fuzzyMatchedPath) {
          this.remember(cacheKey, packKey, fuzzyMatchedPath)
          console.log(
            `[SoftPathResolver] 模糊匹配依赖成功: ${subAssetSoftPath} -> ${fuzzyMatchedPath}`
          )
          return fuzzyMatchedPath
        }
        if (this.enableCache) {
          this.scanMisses.add(packKey)
        }
      }

      // 缓存结果（这里的 result 未必真实存在，沿用原有约定交给调用方 access 判断）
      if (this.enableCache) {
        this.pathCache.set(cacheKey, result)
      }

      return result
    } catch (error) {
      console.warn(
        `[SoftPathResolver] 路径转换失败: ${mainAssetSoftPath} -> ${subAssetSoftPath}`,
        error
      )
      return null
    }
  }

  /** 清空全部缓存 */
  clear(): void {
    this.pathCache.clear()
    this.verifiedByPackAndSoftPath.clear()
    this.scanMisses.clear()
    this.dirCache.clear()
  }

  /** 缓存条目数，仅用于统计上报 */
  get size(): number {
    return this.pathCache.size + this.verifiedByPackAndSoftPath.size + this.scanMisses.size
  }

  /** 还剩多少扫描预算，测试和诊断用 */
  get remainingScanBudget(): number {
    return this.scanBudget
  }

  private remember(cacheKey: string, packKey: string, resolvedPath: string): void {
    if (!this.enableCache) return
    this.pathCache.set(cacheKey, resolvedPath)
    this.verifiedByPackAndSoftPath.set(packKey, resolvedPath)
  }

  /** 扣一格预算，顺便决定要不要让出事件循环 */
  private async spendBudget(): Promise<boolean> {
    if (this.scanBudget <= 0) return false
    this.scanBudget--

    this.untilYield--
    if (this.untilYield <= 0) {
      this.untilYield = this.yieldEvery
      await new Promise((resolve) => setImmediate(resolve))
    }
    return true
  }

  private async findSimilarAssetPath(
    mainRealPath: string,
    subAssetSoftPath: string,
    realExt: string
  ): Promise<string | null> {
    if (this.scanBudget <= 0) {
      if (!this.budgetExhaustedReported) {
        this.budgetExhaustedReported = true
        console.warn('[SoftPathResolver] 模糊搜索的总扫描预算已用完，本次导入不再扫盘找依赖')
      }
      return null
    }

    const requestedBaseName = path.basename(subAssetSoftPath).replace(/\.[^./]+$/, '')
    if (!requestedBaseName) return null

    const requestedFileNames = Array.from(
      new Set(
        [
          `${requestedBaseName}.uasset`,
          `${requestedBaseName}.umap`,
          realExt ? `${requestedBaseName}${realExt}` : ''
        ].filter(Boolean)
      )
    )

    const searchRoots: string[] = []
    let currentDir = path.dirname(mainRealPath)
    const root = path.parse(currentDir).root

    while (currentDir && currentDir !== root) {
      searchRoots.push(currentDir)
      const base = path.basename(currentDir).toLowerCase()
      if (base === 'game' || base === 'content') break
      currentDir = path.dirname(currentDir)
    }

    const candidates = new Set<string>()
    const maxDepthByRoot = (rootPath: string): number => {
      const base = path.basename(rootPath).toLowerCase()
      if (base === 'game' || base === 'content') return 8
      if (base === 'mspresets') return 4
      return 3
    }

    for (const rootPath of searchRoots) {
      const matches = await this.collectMatchingFiles(
        rootPath,
        requestedFileNames,
        maxDepthByRoot(rootPath)
      )
      for (const match of matches) {
        candidates.add(match)
      }
      if (candidates.size > 0 && path.basename(rootPath).toLowerCase() !== 'game') {
        break
      }
      if (this.scanBudget <= 0 || this.isCancelled()) break
    }

    if (candidates.size === 0) {
      return null
    }

    const candidateList = Array.from(candidates)
    const safeCandidates = candidateList.filter((candidatePath) =>
      this.isSafeFuzzyCandidate(subAssetSoftPath, candidatePath)
    )

    if (safeCandidates.length === 0) {
      const sampledCandidates = candidateList
        .slice(0, 5)
        .map((candidatePath) => deriveSoftPathFromRealPath(candidatePath) || candidatePath)
        .join(', ')
      console.warn(
        `[SoftPathResolver] 拒绝不安全的模糊匹配: ${subAssetSoftPath}; candidates=${sampledCandidates}`
      )
      return null
    }

    return this.pickBestCandidate(safeCandidates, mainRealPath, subAssetSoftPath)
  }

  private async readDirCached(dirPath: string): Promise<DirEntry[]> {
    if (this.enableCache) {
      const cached = this.dirCache.get(dirPath)
      if (cached) return cached
    }

    let entries: DirEntry[] = []
    try {
      entries = await this.fsImpl.readdir(dirPath)
    } catch {
      entries = []
    }
    if (this.enableCache) this.dirCache.set(dirPath, entries)
    return entries
  }

  private async collectMatchingFiles(
    rootPath: string,
    targetFileNames: string[],
    maxDepth: number
  ): Promise<string[]> {
    const results: string[] = []
    const targetNameSet = new Set(targetFileNames.map((name) => name.toLowerCase()))

    const walk = async (currentPath: string, depth: number): Promise<void> => {
      if (depth > maxDepth || this.scanBudget <= 0 || this.isCancelled()) return

      const entries = await this.readDirCached(currentPath)

      for (const entry of entries) {
        if (this.isCancelled()) return
        if (!(await this.spendBudget())) return

        const nextPath = path.join(currentPath, entry.name)
        if (entry.isFile()) {
          if (targetNameSet.has(entry.name.toLowerCase())) {
            results.push(nextPath)
          }
          continue
        }

        if (entry.isDirectory()) {
          await walk(nextPath, depth + 1)
        }
      }
    }

    await walk(rootPath, 0)
    return results
  }

  private pickBestCandidate(
    candidates: string[],
    mainRealPath: string,
    subAssetSoftPath: string
  ): string | null {
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]

    const normalizeTokens = (value: string): string[] =>
      value
        .replace(/\\/g, '/')
        .replace(/\.[^./]+$/, '')
        .split('/')
        .filter(Boolean)
        .map((segment) => segment.toLowerCase())

    const targetTokens = new Set(normalizeTokens(subAssetSoftPath.replace(/^\/Game\//, '')))
    const mainTokens = new Set(normalizeTokens(deriveSoftPathFromRealPath(mainRealPath)))

    const scoreCandidate = (candidatePath: string): number => {
      const candidateTokens = normalizeTokens(deriveSoftPathFromRealPath(candidatePath))
      let score = 0

      for (const token of candidateTokens) {
        if (targetTokens.has(token)) score += 3
        if (mainTokens.has(token)) score += 1
      }

      score -= candidateTokens.length * 0.1
      score -= candidatePath.length * 0.0001
      return score
    }

    return candidates
      .slice()
      .sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || a.length - b.length)[0]
  }

  private isSafeFuzzyCandidate(targetSoftPath: string, candidatePath: string): boolean {
    const candidateSoftPath = deriveSoftPathFromRealPath(candidatePath)
    if (!candidateSoftPath) {
      return false
    }

    return (
      this.normalizeSoftPathForMatch(candidateSoftPath) ===
      this.normalizeSoftPathForMatch(targetSoftPath)
    )
  }

  private normalizeSoftPathForMatch(softPath: string): string {
    const normalized = softPath
      .replace(/\\/g, '/')
      .replace(/\.[^./]+$/, '')
      .replace(/^\/+/, '/')
      .replace(/\/+/g, '/')

    const segments = normalized.split('/').filter(Boolean)
    const collapsed: string[] = []

    for (const segment of segments) {
      if (collapsed[collapsed.length - 1]?.toLowerCase() === segment.toLowerCase()) {
        continue
      }
      collapsed.push(segment)
    }

    return `/${collapsed.join('/')}`.toLowerCase()
  }
}
