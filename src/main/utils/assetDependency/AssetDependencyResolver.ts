import path from 'path'
import { promises as fs } from 'fs'
import { UnrealAssetProcessor } from '../fileProcessor/UnrealAssetProcessor'
import {
  SoftPathResolver,
  deriveSoftPathFromRealPath,
  fixChineseEncoding
} from './softPathResolver'

/**
 * 资产依赖信息接口
 */
export interface AssetDependencyInfo {
  assetKey: string
  softPath: string
  realPath: string
  originPath: string
  imports: string[]
  /** 只含硬引用；软引用缺失不该拦截导入，见 BackupAssetInfo.importsStrong */
  importsStrong?: string[]
  classKey: string
  name: string
  engineVersion?: string
  imgLocalPath?: string
}

/**
 * 依赖解析配置
 */
export interface DependencyResolverConfig {
  maxIterations?: number
  batchSize?: number
  enableCache?: boolean
  progressCallback?: (progress: DependencyProgress) => void
  enableCircularDependencyDetection?: boolean
  errorCallback?: (error: DependencyError) => void
  /**
   * 发现新资产时的回调函数
   * 用于流式处理资产，避免一次性返回所有数据导致内存溢出
   */
  onAssetFound?: (asset: AssetDependencyInfo) => Promise<void> | void
  /**
   * 多次 {@link AssetDependencyResolver.resolveDependencies} 之间保留已处理集合与路径缓存。
   *
   * 文件夹批量导入是一个资产一次调用：默认每次都清空，于是 500 个动画共用的那副骨骼
   * 会被重新解析、重新拷贝 500 遍。整批共用一个实例并打开这个开关，共享依赖只做一次。
   */
  persistStateAcrossRuns?: boolean
  /**
   * 返回 true 时，正在进行的依赖扫描立刻收手。
   *
   * 模糊搜索会递归扫盘，一次可能跑上好几秒。没有这个钩子的话，用户点了「中止导入」
   * 也得等它扫完才生效 —— 评审指出的那一条。
   */
  isCancelled?: () => boolean
}

/**
 * 依赖解析进度信息
 */
export interface DependencyProgress {
  currentIteration: number
  totalPaths: number
  processedPaths: number
  foundAssets: number
  stage: 'extracting' | 'resolving' | 'converting' | 'completed'
}

/**
 * 依赖解析错误信息
 */
export interface DependencyError {
  type: 'circular_dependency' | 'file_not_found' | 'parse_error' | 'unknown'
  message: string
  affectedPaths: string[]
  iteration?: number
}

/**
 * 超过这个数量就自动关掉循环依赖检测（依赖图会一直长，DFS 越跑越贵）。
 * 批量导入是一个资产一次调用，判不到这个阈值，得由调用方按整批规模自己关。
 */
export const AUTO_DISABLE_CIRCULAR_THRESHOLD = 50

/**
 * 资产依赖解析器
 * 基于assets-ultra.js的逻辑，使用TypeScript重新实现
 */
export class AssetDependencyResolver {
  private readonly config: Required<DependencyResolverConfig>
  private readonly processedPaths = new Set<string>()
  /** realPath → softPath，仅供 {@link getSoftPath} 使用 */
  private readonly softPathCache = new Map<string, string>()
  private readonly softPathResolver: SoftPathResolver
  private readonly dependencyGraph = new Map<string, Set<string>>()
  private readonly errors: DependencyError[] = []
  private readonly processor = new UnrealAssetProcessor() // 复用单一实例，避免每批次重新创建

  constructor(config: DependencyResolverConfig = {}) {
    this.config = {
      maxIterations: config.maxIterations ?? 100,
      batchSize: config.batchSize ?? 500,
      enableCache: config.enableCache ?? true,
      progressCallback: config.progressCallback ?? (() => {}),
      enableCircularDependencyDetection: config.enableCircularDependencyDetection ?? true,
      errorCallback: config.errorCallback ?? (() => {}),
      onAssetFound: config.onAssetFound ?? (() => {}),
      persistStateAcrossRuns: config.persistStateAcrossRuns ?? false,
      isCancelled: config.isCancelled ?? ((): boolean => false)
    }
    this.softPathResolver = new SoftPathResolver({
      enableCache: this.config.enableCache,
      isCancelled: this.config.isCancelled
    })
  }

  /**
   * 解析资产依赖关系
   * @param initialAssets 初始资产列表
   * @returns 包含所有依赖的完整资产列表（如果提供了 onAssetFound，此列表可能不完整以节省内存）
   */
  async resolveDependencies(initialAssets: AssetDependencyInfo[]): Promise<AssetDependencyInfo[]> {
    this.errors.length = 0

    if (!this.config.persistStateAcrossRuns) {
      this.processedPaths.clear()
      this.dependencyGraph.clear()

      if (this.config.enableCache) {
        this.softPathCache.clear()
        this.softPathResolver.clear()
      }
    }

    // 这里曾经有一条「初始资产超过 200 个就整个跳过递归依赖解析」的保护，理由是
    // 「需要的文件通常已经在初始列表里」加上防 OOM。两个理由都不成立：
    //
    // 一、那个假设跟下游是矛盾的。localBackupSession 对任何找不到的硬引用都判整组
    //    失败，而按素材包分别导入时跨包引用是常态 —— 导入 PolygonApocalypse 时它
    //    引用了 InfimaGames 里的物理材质，跳过解析就等于 338 个文件直接导不进去。
    // 二、OOM 说的是 allAssets 累积，可 onAssetFound 的默认值是 `() => {}`（truthy），
    //    useStreamMode 因此恒为真，allAssets 从来就不会累积。
    //
    // 代价也早就被下面那层过滤兜住了：已经在初始集合里的引用根本不会触发 resolve。
    // 实测整包 2607 个资产只产生 28 次 resolve、36 ms，换回 338 个文件能正常入库。
    // 真正的失控风险由 SoftPathResolver 的全局扫描预算和否定缓存挡着。

    // 🛡️ 内存优化：大批量时自动禁用循环依赖检测
    if (
      initialAssets.length > AUTO_DISABLE_CIRCULAR_THRESHOLD &&
      this.config.enableCircularDependencyDetection
    ) {
      console.log(
        `[AssetDependencyResolver] 初始资产数量 ${initialAssets.length} > ${AUTO_DISABLE_CIRCULAR_THRESHOLD}，自动禁用循环依赖检测以节省内存`
      )
      ;(this.config as Record<string, unknown>).enableCircularDependencyDetection = false
    }

    const useStreamMode = !!this.config.onAssetFound
    const allAssets: AssetDependencyInfo[] = useStreamMode ? [] : [...initialAssets]

    // 如果是流式模式，先处理初始资产的回调
    if (useStreamMode && this.config.onAssetFound) {
      for (const asset of initialAssets) {
        await this.config.onAssetFound(asset)
      }
    }

    const initialPaths = initialAssets.map((asset) => asset.originPath)

    // 标记初始路径为已处理
    initialPaths.forEach((path) => this.processedPaths.add(path))

    // 构建初始依赖图
    if (this.config.enableCircularDependencyDetection) {
      this.buildDependencyGraph(initialAssets)
    }

    this.reportProgress({
      currentIteration: 0,
      totalPaths: initialPaths.length,
      processedPaths: 0,
      foundAssets: initialAssets.length,
      stage: 'extracting'
    })

    // 提取初始依赖路径
    let currentDependencyPaths = await this.extractDependencyPaths(initialAssets)
    // 过滤掉已经处理过的路径
    currentDependencyPaths = currentDependencyPaths.filter((path) => !this.processedPaths.has(path))

    let iteration = 0
    let totalFoundAssets = initialAssets.length

    while (currentDependencyPaths.length > 0 && iteration < this.config.maxIterations) {
      iteration++

      // 在处理前再次去重（针对当前批次）
      currentDependencyPaths = [...new Set(currentDependencyPaths)]

      // 再次过滤已处理路径（双重保险）
      const pathsToProcess = currentDependencyPaths.filter((p) => !this.processedPaths.has(p))

      if (pathsToProcess.length === 0) {
        break
      }

      this.reportProgress({
        currentIteration: iteration,
        totalPaths: pathsToProcess.length,
        processedPaths: this.processedPaths.size,
        foundAssets: totalFoundAssets,
        stage: 'resolving'
      })

      console.log(
        `[AssetDependencyResolver] 处理依赖第 ${iteration} 轮，路径数: ${pathsToProcess.length}`
      )

      // 立即将本轮要处理的路径标记为已处理
      pathsToProcess.forEach((p) => this.processedPaths.add(p))

      // 检测循环依赖
      if (this.config.enableCircularDependencyDetection) {
        const circularDeps = this.detectCircularDependencies(pathsToProcess)
        if (circularDeps.length > 0) {
          this.handleError({
            type: 'circular_dependency',
            message: `检测到循环依赖: ${circularDeps.join(' -> ')}`,
            affectedPaths: circularDeps,
            iteration
          })
        }
      }

      try {
        // 解析当前批次的依赖
        const newAssets = await this.resolveDependencyBatch(pathsToProcess)

        // 更新统计
        totalFoundAssets += newAssets.length

        // 流式处理或累积
        if (useStreamMode && this.config.onAssetFound) {
          for (const asset of newAssets) {
            await this.config.onAssetFound(asset)
          }
          // 流式模式下，newAssets 不需要保留在内存中，可以被 GC
          // 但我们需要用它来提取下一轮的依赖路径
        } else {
          allAssets.push(...newAssets)
        }

        // 更新依赖图
        if (this.config.enableCircularDependencyDetection) {
          this.buildDependencyGraph(newAssets)
        }

        // 提取新资产的依赖路径
        const newDependencyPaths = await this.extractDependencyPaths(newAssets)
        // 过滤掉全局已处理过的路径
        currentDependencyPaths = newDependencyPaths.filter((path) => !this.processedPaths.has(path))

        // 显式释放 newAssets 引用（在流式模式下）
        if (useStreamMode) {
          // JS 引擎会自动回收局部变量 newAssets，但如果在闭包中引用则不会
          // 这里我们不需要做额外操作，只要不 push 到 allAssets 即可
        }
      } catch (error) {
        this.handleError({
          type: 'unknown',
          message: error instanceof Error ? error.message : String(error),
          affectedPaths: pathsToProcess,
          iteration
        })
        break
      }
    }

    if (iteration >= this.config.maxIterations) {
      const warningMsg = '达到最大循环次数，可能存在循环依赖'
      console.warn(`[AssetDependencyResolver] ${warningMsg}`)
      this.handleError({
        type: 'circular_dependency',
        message: warningMsg,
        affectedPaths: currentDependencyPaths
      })
    }

    this.reportProgress({
      currentIteration: iteration,
      totalPaths: 0,
      processedPaths: this.processedPaths.size,
      foundAssets: totalFoundAssets,
      stage: 'completed'
    })

    console.log(`[AssetDependencyResolver] 依赖解析完成，共处理 ${totalFoundAssets} 项资源`)
    if (this.errors.length > 0) {
      console.warn(`[AssetDependencyResolver] 解析过程中发生 ${this.errors.length} 个错误`)
    }

    // 流式模式下返回空数组，因为数据已经通过回调发出
    return useStreamMode ? [] : allAssets
  }

  /**
   * 从资产列表中提取依赖路径
   * @param assets 资产列表
   * @returns 依赖路径数组
   */
  private async extractDependencyPaths(assets: AssetDependencyInfo[]): Promise<string[]> {
    const realPathsSet = new Set<string>()
    const uassetAssets = assets.filter((asset) => asset.classKey === 'uasset')

    // 提取所有softPath并去重
    const softPathSet = new Set(uassetAssets.map((asset) => asset.softPath))
    const softPathsLookup = new Set(Array.from(softPathSet))

    for (const asset of uassetAssets) {
      if (!asset.imports || !Array.isArray(asset.imports)) continue

      for (const importPath of asset.imports) {
        // 跳过已存在的softPath
        if (!softPathsLookup.has(importPath)) {
          const realPath = await this.convertSoftPathToRealPath(
            asset.softPath,
            importPath,
            asset.originPath
          )
          if (realPath) {
            realPathsSet.add(realPath)
          }
        }
      }
    }

    return Array.from(realPathsSet)
  }

  /**
   * 将虚幻引擎软路径转换为真实文件路径
   * 增强版：支持向上搜索 Content Root
   */
  public async convertSoftPathToRealPath(
    mainAssetSoftPath: string,
    subAssetSoftPath: string,
    mainRealPath: string
  ): Promise<string | null> {
    return this.softPathResolver.resolve(mainAssetSoftPath, subAssetSoftPath, mainRealPath)
  }

  /**
   * 解析依赖批次
   * @param dependencyPaths 依赖路径列表
   * @returns 解析出的资产列表
   */
  private async resolveDependencyBatch(dependencyPaths: string[]): Promise<AssetDependencyInfo[]> {
    const resolvedAssets: AssetDependencyInfo[] = []

    // 分批处理以避免内存压力
    for (let i = 0; i < dependencyPaths.length; i += this.config.batchSize) {
      const batch = dependencyPaths.slice(i, i + this.config.batchSize)
      const batchAssets = await this.processBatch(batch)
      resolvedAssets.push(...batchAssets)

      this.reportProgress({
        currentIteration: 0,
        totalPaths: dependencyPaths.length,
        processedPaths: i + batch.length,
        foundAssets: resolvedAssets.length,
        stage: 'converting'
      })
    }

    return resolvedAssets
  }

  /**
   * 处理单个批次的路径
   * @param paths 路径列表
   * @returns 资产信息列表
   */
  private async processBatch(paths: string[]): Promise<AssetDependencyInfo[]> {
    const assets: AssetDependencyInfo[] = []

    // 复用实例级处理器，避免每批次创建新实例
    const processor = this.processor

    for (const filePath of paths) {
      try {
        // 检查文件是否存在
        await fs.access(filePath)

        let asset: AssetDependencyInfo

        if (processor) {
          // 使用真实的解析器获取元数据
          const metadata = await processor.processFile(filePath)

          // 解析 imports
          const asPathList = (value: unknown): string[] => {
            if (Array.isArray(value)) return value
            if (typeof value === 'string') {
              try {
                const parsed = JSON.parse(value)
                return Array.isArray(parsed) ? parsed : []
              } catch {
                return []
              }
            }
            return []
          }
          const imports = asPathList(metadata?.metadata?.imports)
          const importsStrong = asPathList(metadata?.metadata?.importsStrong)

          const basename = path.basename(filePath)

          // ⚠️ 关键修正：从 metadata._rawData 获取原始解析数据
          // 如果 _rawData 存在，则使用它；否则传入 null (回退到仅基于路径的推断)
          const rawData = metadata?.metadata?._rawData || null

          // 使用 getSoftPath 方法，传入正确的原始数据
          const inferredSoftPath = this.getSoftPath(rawData, basename, filePath)

          // 🛡️ 立即释放大型原始数据，仅保留 softPath/imports 等轻量信息
          if (metadata?.metadata?._rawData) {
            delete metadata.metadata._rawData
          }

          // 优先使用 processor 已经计算好的 softPath (metadata.softPath)，
          // 如果为空，则使用我们在 AssetDependencyResolver 中重新计算的 inferredSoftPath
          const finalSoftPath = metadata?.metadata?.softPath || inferredSoftPath

          asset = {
            assetKey:
              metadata?.metadata?.assetKey ||
              `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            softPath: finalSoftPath,
            realPath: filePath,
            originPath: filePath,
            imports: imports,
            importsStrong: importsStrong,
            classKey: metadata?.metadata?.classKey || 'uasset',
            name: metadata?.metadata?.name || path.basename(filePath, path.extname(filePath)),
            engineVersion: metadata?.metadata?.engineVersion,
            imgLocalPath:
              typeof metadata?.metadata?.imgLocalPath === 'string'
                ? metadata.metadata.imgLocalPath
                : undefined
          }
          assets.push(asset)
        }
      } catch (error) {
        // 不能只写日志：这条依赖没进工程，用户那边的资产就是残的。
        // 走 errorCallback 交给调用方，让它记进结果里（评审第 7 轮）
        this.handleError({
          type: 'file_not_found',
          message: `依赖文件不可读或解析失败: ${filePath}`,
          affectedPaths: [filePath]
        })
      }
    }

    return assets
  }

  /**
   * 生成软路径（与UnrealAssetProcessor.ts保持一致）
   * @param result 解析后的资产元数据
   * @param basename 文件名（带扩展名）
   * @param realPath 真实物理路径
   * @returns 软路径 (如 /Game/Path/To/Asset)
   */
  private getSoftPath(result: any, basename: string, realPath: string): string {
    // 缓存键用文件真实路径，理由同 UnrealAssetProcessor.getSoftPath：
    // UE5 的包不带 Guid，「Guid_文件名」会退化成 `undefined_<文件名>`，
    // 同名资产互相串路径。
    const cacheKey = realPath || `${result?.header?.Guid}_${basename}`
    const endsWith = '/' + basename

    // 缓存检查 - 这里简单复用 pathCache
    if (this.softPathCache.has(cacheKey)) {
      return this.softPathCache.get(cacheKey)!
    }

    let softPath = ''
    const gamePathRegex = /\/Game\/[^.]+/
    const pathDerivedSoftPath = deriveSoftPathFromRealPath(realPath)

    try {
      // 对于位于 Unreal Content/备份 Game 目录下的资产，磁盘路径最稳定，优先采用
      if (pathDerivedSoftPath && pathDerivedSoftPath.endsWith(endsWith)) {
        this.softPathCache.set(cacheKey, pathDerivedSoftPath)
        return pathDerivedSoftPath
      }

      // 第一步：优先尝试 FolderName
      if (result && result.header) {
        const originalPath = result.header.FolderName
        softPath = fixChineseEncoding(originalPath)

        if (softPath && softPath.startsWith('/Game')) {
          if (softPath.endsWith(endsWith)) {
            this.softPathCache.set(cacheKey, softPath)
            return softPath
          }
        }
      }

      // 第二步：名称查找优化
      if (basename && result && Array.isArray(result.names)) {
        for (const nameObj of result.names) {
          const originalName = nameObj.Name
          const name = fixChineseEncoding(originalName)
          if (name && name.endsWith(endsWith) && name.startsWith('/Game')) {
            softPath = name
            break
          }
        }
        if (softPath && softPath.startsWith('/Game') && softPath.endsWith(endsWith)) {
          this.softPathCache.set(cacheKey, softPath)
          return softPath
        }
      }

      // 第三步：双重循环优化
      outerLoop: if (result && Array.isArray(result.gatherableTextData)) {
        for (const item of result.gatherableTextData) {
          for (const context of item.SourceSiteContexts) {
            const originalDesc = context.SiteDescription
            const desc = fixChineseEncoding(originalDesc)
            if (desc && desc.startsWith('/Game') && desc.endsWith(endsWith)) {
              const match = desc.match(gamePathRegex)
              if (match) {
                softPath = match[0]
                break outerLoop
              }
            }
          }
        }
      }
      if (softPath && softPath.startsWith('/Game') && softPath.endsWith(endsWith)) {
        this.softPathCache.set(cacheKey, softPath)
        return softPath
      }

      // 第四步：路径处理优化
      const contentIndex = realPath.indexOf('Content')
      if (contentIndex !== -1) {
        const relativePath = realPath.slice(contentIndex + 7).replace(/\\/g, '/')
        // 去除扩展名
        softPath = '/Game' + relativePath.replace(/\.[^.]*$/, '')
      }

      // 最终回退方案
      this.softPathCache.set(cacheKey, softPath || '')
    } catch (e) {
      console.error('Error in getSoftPath:', e)
      softPath = ''
    }

    // 默认回退
    if (!softPath) {
      const nameWithoutExt = path.basename(realPath, path.extname(realPath))
      softPath = `/Game/${nameWithoutExt}`
    }

    return softPath
  }

  /**
   * 报告进度
   * @param progress 进度信息
   */
  private reportProgress(progress: DependencyProgress): void {
    try {
      this.config.progressCallback(progress)
    } catch (error) {
      console.warn('[AssetDependencyResolver] 进度回调执行失败:', error)
    }
  }

  /**
   * 调用方给的取消信号现在是不是「已取消」。
   *
   * 暴露出来是为了能验证这根线**接上了** —— 解析器支持取消但会话没把状态传进来，
   * 是一种从外面完全看不出来的失效。
   */
  get cancelled(): boolean {
    return this.config.isCancelled()
  }

  /**
   * 清理缓存
   */
  clearCache(): void {
    this.softPathCache.clear()
    this.softPathResolver.clear()
    this.processedPaths.clear()
    this.dependencyGraph.clear()
    this.errors.length = 0
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): { pathCacheSize: number; processedPathsSize: number; errorCount: number } {
    return {
      pathCacheSize: this.softPathCache.size + this.softPathResolver.size,
      processedPathsSize: this.processedPaths.size,
      errorCount: this.errors.length
    }
  }

  /**
   * 获取错误列表
   */
  getErrors(): DependencyError[] {
    return [...this.errors]
  }

  /**
   * 构建依赖图
   */
  private buildDependencyGraph(assets: AssetDependencyInfo[]): void {
    for (const asset of assets) {
      if (!this.dependencyGraph.has(asset.originPath)) {
        this.dependencyGraph.set(asset.originPath, new Set())
      }

      const dependencies = this.dependencyGraph.get(asset.originPath)!
      for (const importPath of asset.imports) {
        dependencies.add(importPath)
      }
    }
  }

  /**
   * 检测循环依赖
   */
  private detectCircularDependencies(paths: string[]): string[] {
    const visited = new Set<string>()
    const recursionStack = new Set<string>()

    for (const path of paths) {
      if (!visited.has(path)) {
        const cycle = this.dfsDetectCycle(path, visited, recursionStack, [])
        if (cycle.length > 0) {
          return cycle
        }
      }
    }

    return []
  }

  /**
   * 深度优先搜索检测循环
   */
  private dfsDetectCycle(
    currentPath: string,
    visited: Set<string>,
    recursionStack: Set<string>,
    path: string[]
  ): string[] {
    visited.add(currentPath)
    recursionStack.add(currentPath)
    path.push(currentPath)

    const dependencies = this.dependencyGraph.get(currentPath)
    if (dependencies) {
      for (const dependency of dependencies) {
        if (!visited.has(dependency)) {
          const cycle = this.dfsDetectCycle(dependency, visited, recursionStack, [...path])
          if (cycle.length > 0) {
            return cycle
          }
        } else if (recursionStack.has(dependency)) {
          // 找到循环
          const cycleStart = path.indexOf(dependency)
          return path.slice(cycleStart).concat([dependency])
        }
      }
    }

    recursionStack.delete(currentPath)
    return []
  }

  /**
   * 处理错误
   */
  private handleError(error: DependencyError): void {
    this.errors.push(error)
    console.error(`[AssetDependencyResolver] ${error.type}: ${error.message}`, {
      affectedPaths: error.affectedPaths,
      iteration: error.iteration
    })

    try {
      this.config.errorCallback(error)
    } catch (callbackError) {
      console.warn('[AssetDependencyResolver] 错误回调执行失败:', callbackError)
    }
  }
}
