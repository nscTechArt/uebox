import { ipcMain, app } from 'electron'
import { promises as fs } from 'fs'
import * as nodeFs from 'fs'
import path from 'path'
import * as http from 'http'
import * as https from 'https'
import { getVaultDatabase } from '../sqliteDataBase'
import { VaultManager, VaultType } from '../sqliteDataBase/VaultManager'
import { PathManager } from '../utils/PathManager'
import { stripAssetNameExtension } from '../utils/assetName'
import {
  getAssetDataByKey,
  getAssetDataBySoftPath,
  getAssetsByKeys,
  getAssetsBySoftPaths,
  findAssetDataByExactName,
  type AssetData
} from '../sqliteDataBase/models/assetData'
import { serviceManager } from '../services'
import { projectManager } from '../services/project'
import { extractArchiveToProjectContent } from '../services/project/archiveImport'
import { loadNamingRulesConfig } from '../utils/namingRulesConfig'
import {
  AssetDependencyResolver,
  AUTO_DISABLE_CIRCULAR_THRESHOLD,
  type AssetDependencyInfo
} from '../utils/assetDependency/AssetDependencyResolver'
import { deriveSoftPathFromRealPath } from '../utils/assetDependency/softPathResolver'
import {
  PackageCopyQueue,
  copyFileWithRetry,
  type PackageCopyStats
} from '../services/project/packageCopyQueue'
import {
  createPackageImportsReader,
  type PackageAnalyzer
} from '../services/project/packageImports'
import {
  settleImportBatch,
  type MissingDependencyFact,
  type PlannedAsset,
  type SettledAsset
} from '../services/project/importSettlement'
import {
  emptyImportFailureReport,
  isCleanImportReport,
  MAX_REPORT_ROWS,
  type ImportFailureReport
} from '../../shared/projectImport'
import {
  HttpDownloadPool,
  httpVaultAssetAlreadyImported,
  httpVaultRelativePath,
  resolveHttpVaultTarget
} from '../services/project/httpVaultDownload'
import UnrealPathManagerUtil from '../utils/UnrealPathManager'
import type { NamingRulesConfig } from '../../renderer/src/types/namingRules'
import { resolveProjectFilePath } from './projectImportPath'
import { readEngineAssociationFromDisk } from '../services/project/projectEngineSync'
import { vaultAccessKeyHeadersFromUrl } from '../networkV2/vaultAccessKeys'
import {
  compareAssetToResolvedProjectEngineVersion,
  resolveProjectEngineVersion,
  type ResolvedProjectEngineVersion
} from './projectEngineVersion'

export type ProjectImportProjectRecord = {
  projectName?: string
  projectPath?: string | null
  originPath?: string | null
  EngineAssociation?: string | null
}

const parseVersion = (v: string | null | undefined): { major: number; minor: number } => {
  const s = String(v || '').trim()
  const m = s.match(/^(\d+)(?:\.(\d+))?/) || []
  const major = Number(m[1] || 0)
  const minor = Number(m[2] || 0)
  return { major, minor }
}

const compareVersions = (a: string | null | undefined, b: string | null | undefined): number => {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1
  return 0
}

/**
 * 将版本号格式化为用户友好的显示格式
 * 例如：5.0.3-20979098+++UE5+Release-5.0 -> 5.0
 *       5.2 -> 5.2
 */
const formatVersionForDisplay = (version: string | null | undefined): string => {
  if (!version) return '未知'
  const parsed = parseVersion(version)
  if (parsed.major === 0) return version.slice(0, 10) // 截断长字符串
  return `${parsed.major}.${parsed.minor}`
}

const normalizeImports = (imports: unknown): string[] => {
  if (!imports) return []
  try {
    if (typeof imports === 'string') {
      const arr = JSON.parse(imports)
      if (Array.isArray(arr))
        return arr.filter((x) => typeof x === 'string' && x.startsWith('/Game'))
      return []
    }
    if (Array.isArray(imports)) {
      return imports.filter((x) => typeof x === 'string' && x.startsWith('/Game'))
    }
    return []
  } catch {
    return []
  }
}

const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * 临时文件名里的唯一段。
 *
 * 进程内单调递增，够用了 —— 临时目录本来就是一次导入一个，不跨进程共享。
 */
let tempFileSeq = 0
const nextTempFileSeq = (): string => `${Date.now()}_${++tempFileSeq}`

/** 导出给测试：让每个用例从干净的序号开始 */
export const __resetTempFileSeqForTest = (): void => {
  tempFileSeq = 0
}

/**
 * 从 HTTP 服务器下载文件到本地临时目录
 * 用于服务器资产库模式：服务器在 Mac 上，客户端在 Windows 上，
 * 无法直接访问 originPath（Mac 路径），需要通过 HTTP API 下载文件。
 * @param serverBaseUrl 服务器基础 URL，例如 http://192.168.31.210:18900
 * @param vaultId 保管库 ID
 * @param relativeFilePath 文件在保管库中的相对路径
 * @param tempDir 临时文件下载目录
 * @returns 本地临时文件路径
 */
const downloadFromServer = async (
  serverBaseUrl: string,
  vaultId: string,
  relativeFilePath: string,
  tempDir: string
): Promise<string> => {
  // 构建 URL：/api/vaults/{vaultId}/files/{relativePath}
  const encodedPath = relativeFilePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const fileUrl = `${serverBaseUrl}/api/vaults/${encodeURIComponent(vaultId)}/files/${encodedPath}`

  // 构建本地临时文件路径。
  //
  // 名字里必须有个真正唯一的东西：原来用 `Date.now()_文件名`，并发下载时同一毫秒里
  // 两个不同目录的同名文件（`Chars/SK.uasset` 和 `Props/SK.uasset`）会写进同一个临时
  // 文件，两条流互相覆盖，最后目标工程里只剩一个、内容还是混的。
  const fileName = path.basename(relativeFilePath)
  const tempFilePath = path.join(tempDir, `${nextTempFileSeq()}_${fileName}`)

  return new Promise((resolve, reject) => {
    const client = fileUrl.startsWith('https') ? https : http
    // 服务端现在对文件下载也鉴权，不带码会 401
    const req = client.get(
      fileUrl,
      { timeout: 60_000, headers: vaultAccessKeyHeadersFromUrl(fileUrl) },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume() // 消费响应体
          reject(new Error(`下载文件失败: HTTP ${res.statusCode} (${fileUrl})`))
          return
        }

        const writeStream = nodeFs.createWriteStream(tempFilePath)
        res.pipe(writeStream)

        writeStream.on('finish', () => {
          writeStream.close(() => resolve(tempFilePath))
        })

        writeStream.on('error', (err) => {
          // 清理临时文件
          try {
            nodeFs.unlinkSync(tempFilePath)
          } catch {
            /* ignore */
          }
          reject(err)
        })
      }
    )

    req.on('error', (err) => {
      reject(new Error(`下载文件网络错误: ${err.message} (${fileUrl})`))
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`下载文件超时: ${fileUrl}`))
    })
  })
}

const UNREAL_PACKAGE_EXTENSIONS = ['.uasset', '.umap', '.uexp', '.ubulk', '.uptnl']

const isPrimaryUnrealPackageExtension = (ext: string): boolean =>
  ext === '.uasset' || ext === '.umap'

const getPackageBasePath = (seedPath: string): string => {
  const ext = path.extname(seedPath).toLowerCase()
  return UNREAL_PACKAGE_EXTENSIONS.includes(ext) ? seedPath.slice(0, -ext.length) : seedPath
}

type PackageFile = { path: string; size: number }

/**
 * 一个 UE 包在磁盘上是一组同名不同后缀的文件（.uasset + .uexp + .ubulk…）。
 *
 * 用 `stat` 而不是 `access`：一次系统调用同时拿到「在不在」和「多大」，
 * 字节数留给进度条算速度和剩余时间。
 */
const statExistingPackageFiles = async (
  seedPath: string,
  cache?: Map<string, PackageFile[]>
): Promise<PackageFile[]> => {
  const cached = cache?.get(seedPath)
  if (cached) return cached

  const basePath = getPackageBasePath(seedPath)
  const existingFiles: PackageFile[] = []

  for (const ext of UNREAL_PACKAGE_EXTENSIONS) {
    const candidatePath = `${basePath}${ext}`
    try {
      const stat = await fs.stat(candidatePath)
      if (stat.isFile()) existingFiles.push({ path: candidatePath, size: stat.size })
    } catch {
      // ignore missing package sidecar
    }
  }

  if (existingFiles.length === 0) {
    try {
      const stat = await fs.stat(seedPath)
      if (stat.isFile()) existingFiles.push({ path: seedPath, size: stat.size })
    } catch {
      // 源包整个不存在
    }
  }

  cache?.set(seedPath, existingFiles)
  return existingFiles
}

/**
 * 目标位置上这个文件是不是已经完整地在了。
 *
 * 只比字节数，不比内容：`fs.copyFile` 不是原子操作，中途断电／被中止会留下一个
 * 长度对不上的半截文件，光看「文件存在」会把它当成已导入。哈希太贵，长度足够。
 */
const isSameSizeAtTarget = async (targetFile: string, sourceSize: number): Promise<boolean> => {
  try {
    const stat = await fs.stat(targetFile)
    return stat.isFile() && stat.size === sourceSize
  } catch {
    return false
  }
}

type PackageCopyOutcome = {
  /** 用于继续解析依赖的**源**文件路径 */
  parseSourcePath: string | null
  /** 真正排进队列（或当场拷贝）的文件数 */
  copiedOrQueued: number
  /** 目标已经有了、这次跳过的文件数 */
  skipped: number
  /** 目标已经属于别的源、这次没敢写的文件数 */
  conflicted: number
}

/**
 * 把一个包的所有分片排进拷贝队列（批量导入）或当场拷完（单个资产导入）。
 *
 * 逐个文件判断「目标是不是已经在了」，而不是在主资产那一层判一次就整包跳过。
 * 这是中止之后重试能补齐的前提：主资产写进去了、依赖还没写，重试时主资产被跳过、
 * 依赖照样补上（评审第 2 条）。
 *
 * `parseSourcePath` 不等拷贝完成 —— 解析读的是源文件，没有理由卡在目标盘的写入上，
 * 这正是流水线能并行的原因。
 */
const copyUnrealPackageFiles = async (
  sourceSeedPath: string,
  targetSeedPath: string,
  assetKey: string,
  results: Array<{ assetKey: string; from: string; to: string }>,
  queue?: PackageCopyQueue,
  cache?: Map<string, PackageFile[]>
): Promise<PackageCopyOutcome> => {
  const sourceFiles = await statExistingPackageFiles(sourceSeedPath, cache)
  if (sourceFiles.length === 0) {
    return { parseSourcePath: null, copiedOrQueued: 0, skipped: 0, conflicted: 0 }
  }

  const targetBasePath = getPackageBasePath(targetSeedPath)
  let parseSourcePath: string | null = null
  let copiedOrQueued = 0
  let skipped = 0
  let conflicted = 0

  for (const sourceFile of sourceFiles) {
    const ext = path.extname(sourceFile.path).toLowerCase()
    const targetFile = `${targetBasePath}${ext}`

    if (!parseSourcePath && isPrimaryUnrealPackageExtension(ext)) {
      parseSourcePath = sourceFile.path
    }

    // 先认领「谁要写这个目标」，再决定跳不跳。
    // 顺序反过来的话，第二个素材包的文件恰好和第一个一样大时会先被判成「已存在」，
    // 根本走不到冲突检查，于是被静默顶替。
    //
    // 认领不到说明这个位置已经属于别的源了 —— 不写，也不算「已存在」，
    // 由批量收尾统一报冲突。
    if (queue && !queue.claimTarget(sourceFile.path, targetFile)) {
      conflicted++
      continue
    }

    if (await isSameSizeAtTarget(targetFile, sourceFile.size)) {
      skipped++
      continue
    }

    if (queue) {
      queue.enqueue({
        source: sourceFile.path,
        target: targetFile,
        assetKey,
        size: sourceFile.size
      })
    } else {
      await ensureDir(path.dirname(targetFile))
      await copyFileWithRetry(sourceFile.path, targetFile)
    }
    results.push({ assetKey, from: sourceFile.path, to: targetFile })
    copiedOrQueued++
  }

  return {
    parseSourcePath: parseSourcePath || sourceFiles[0].path,
    copiedOrQueued,
    skipped,
    conflicted
  }
}

/**
 * 把一个包（主文件 + .uexp/.ubulk 等分片）复制到目标位置，给服务端资产库的下载用
 * （src/main/libraryV3：文件先经 lore 物化到影子副本，再走这里复制进工程）。
 * 返回实际复制的文件数；目标已存在且大小相同的跳过。
 */
export async function copyUnrealPackage(
  sourceSeedPath: string,
  targetSeedPath: string
): Promise<number> {
  const outcome = await copyUnrealPackageFiles(sourceSeedPath, targetSeedPath, '', [])
  return outcome.copiedOrQueued
}

/**
 * 一次「整个文件夹导入工程」共用的状态。
 *
 * 不带这个 session 时，每个资产都会新建一个依赖解析器：500 个动画共用的那副骨骼
 * 会被解析并拷贝 500 遍，找不到的依赖还会触发 500 次同步递归扫盘，主进程直接假死。
 * 整批共用一份已处理集合与路径缓存，共享依赖只做一次。
 */
export type ProjectImportBatchSession = {
  /** 工程根下的 Content 目录，整批解析一次（原来每个资产都要 readdir 一次工程根） */
  contentBase: string
  /** 工程引擎版本整批只解析一次：自编译引擎那条路要起 PowerShell 读注册表 */
  projectEngine: ResolvedProjectEngineVersion
  /** 用户在版本冲突弹窗里选了「仍然导入」：跳过版本闸，照拷不误 */
  ignoreEngineVersion: boolean
  resolver: AssetDependencyResolver
  /** 真正干活的拷贝池：规划边算边入队，它在后台并发搬文件 */
  copyQueue: PackageCopyQueue
  /** assetKey → 资产记录，整批一次查库，不再一个资产一条 SELECT */
  assetsByKey: Map<string, AssetData>
  /** HTTP 服务器库的下载临时目录，整批一个 */
  httpTempDir: string
  /** HTTP 服务器库的下载池，本地库/ SMB 库没有这一段 */
  httpDownloads?: HttpDownloadPool
  /** 下载下来的临时文件。拷贝是异步排队的，必须等队列排空才能删 */
  httpTempFiles: string[]
  /** 源包分片探测结果缓存：同一个包在「查重」和「入队」两步里各探一次，白花一半系统调用 */
  packageProbeCache: Map<string, PackageFile[]>
  /** 目标工程里某个包的真实依赖（解析二进制得来），整批共用，避免重复解析 */
  targetImportsCache: Map<string, string[] | null>
  /** 读目标包依赖用的解析器，测试可替换 */
  analyzePackage?: PackageAnalyzer
  /**
   * 实时解析发现的依赖边：软路径 → 它引用了谁。
   *
   * 依赖归属不能只信数据库：库里的 imports 会漏记（`collectReferences` 跳过没有路径的
   * objectName）。漏了一条边，共享依赖缺失就只算得到第一个资产头上。
   * 这里记的是**真解析出来的**，收尾算闭包时和数据库那份并起来用。
   */
  discoveredImports: Map<string, string[]>
  /**
   * 整批范围内**没能找到**的依赖软路径。
   *
   * 和 `sink.missingDependencies`（逐个资产、每轮清空）的分工：共享依赖只会在
   * **第一个**用到它的资产那一轮被解析到，后面的资产因为已处理去重根本不会再碰它。
   * 只看逐资产的那份，共享依赖缺失就只算第一个资产失败 —— 所以还要有一份整批累积的，
   * 收尾时按依赖闭包摊给所有用到它的资产。
   */
  batchMissingDependencies: Set<string>
  /** 网络库分支的去重集合，同样整批共享 */
  processedSoftPaths: Set<string>
  processedOriginPaths: Set<string>
  /** 用户中止了这批导入 */
  cancelled: boolean
  /** 当前这个资产的产出，每导一个换一次 */
  sink: {
    results: Array<{ assetKey: string; from: string; to: string }>
    warnings: string[]
    /** 这一轮里因为「目标已经有了」而跳过的文件数 */
    skipped: number
    /** 这一轮里因为「目标属于别的源」而没敢写的文件数 */
    conflicted: number
    /**
     * 这一轮里**没能找到**的依赖软路径。
     *
     * 只写日志是不够的：这条依赖没进工程，用户那边的资产就是残的，
     * 而界面上却是一片「成功」。必须记进结果，算这个资产失败。
     */
    missingDependencies: string[]
  }
}

/** 依赖解析器发现资产时把它排进拷贝队列 */
const copyFoundAssetInto = async (
  contentBase: string,
  sink: ProjectImportBatchSession['sink'],
  assetInfo: AssetDependencyInfo,
  queue?: PackageCopyQueue,
  cache?: Map<string, PackageFile[]>
): Promise<void> => {
  try {
    const softPath = assetInfo.softPath
    if (!softPath) return

    const relativePath = softPath.replace(/^\/Game\/?/, '')
    const ext = path.extname(assetInfo.originPath)
    const targetPath = path.join(contentBase, relativePath + ext)
    const outcome = await copyUnrealPackageFiles(
      assetInfo.originPath,
      targetPath,
      assetInfo.assetKey || '',
      sink.results,
      queue,
      cache
    )
    sink.skipped += outcome.skipped
    sink.conflicted += outcome.conflicted
  } catch (e) {
    console.error(`[project:importUAssets] 复制失败: ${assetInfo.originPath}`, e)
    sink.warnings.push(`复制失败 ${path.basename(assetInfo.originPath)}: ${e}`)
  }
}

/**
 * 并发拷几个文件。
 *
 * 本地盘上 4 路就能把队列深度喂饱；网络库（SMB / HTTP）是延迟主导的，
 * 多开几路收益大得多 —— 每个文件一次往返，串行等于把带宽扔了。
 */
const pickCopyConcurrency = (vaultType: string | undefined): number =>
  vaultType === 'network' ? 8 : 4

/**
 * 同时下几个文件。
 *
 * HTTP 下载是纯延迟主导的：一个文件一次往返，串行下 500 个小文件，时间全花在等
 * 响应上，带宽基本闲着。取 8 和网络库拷贝一个量级，再往上就该撞服务端限流了。
 */
const HTTP_DOWNLOAD_CONCURRENCY = 8

/**
 * 记下一个包的依赖边，**只并不覆盖**。
 *
 * 同一个软路径会从两个地方进来：作为依赖被实时解析时（边是全的），
 * 以及它自己也被选中导入、作为初始资产进来时（那时 `imports` 取自数据库，可能是残的）。
 * 用 `set` 覆盖的话，后者会把前者辛苦解析出来的边抹掉 —— 于是共享依赖缺失又只算得到
 * 第一个资产头上（评审第 10 轮第 1 条）。
 */
const noteDiscoveredImports = (
  session: ProjectImportBatchSession,
  softPath: string | undefined,
  imports: unknown
): void => {
  if (!softPath || !Array.isArray(imports)) return

  const incoming = imports.filter(
    (p): p is string => typeof p === 'string' && p.startsWith('/Game')
  )
  if (incoming.length === 0) return

  const existing = session.discoveredImports.get(softPath)
  session.discoveredImports.set(
    softPath,
    existing ? Array.from(new Set([...existing, ...incoming])) : incoming
  )
}

export const createBatchSession = (params: {
  contentBase: string
  projectEngine: ResolvedProjectEngineVersion
  /** 默认 false：不传就照常挡高版本资产 */
  ignoreEngineVersion?: boolean
  assetCount: number
  assetsByKey: Map<string, AssetData>
  httpTempDir: string
  httpDownloads?: HttpDownloadPool
  vaultType: string | undefined
  onCopyProgress?: (stats: PackageCopyStats) => void
  analyzePackage?: PackageAnalyzer
}): ProjectImportBatchSession => {
  const { contentBase, assetCount } = params
  const sink: ProjectImportBatchSession['sink'] = {
    results: [],
    warnings: [],
    missingDependencies: [],
    skipped: 0,
    conflicted: 0
  }
  const probeCache = new Map<string, PackageFile[]>()
  const copyQueue = new PackageCopyQueue({
    concurrency: pickCopyConcurrency(params.vaultType),
    onProgress: params.onCopyProgress
  })

  const session: ProjectImportBatchSession = {
    contentBase,
    projectEngine: params.projectEngine,
    ignoreEngineVersion: params.ignoreEngineVersion === true,
    copyQueue,
    assetsByKey: params.assetsByKey,
    httpTempDir: params.httpTempDir,
    httpDownloads: params.httpDownloads,
    httpTempFiles: [],
    packageProbeCache: probeCache,
    targetImportsCache: new Map<string, string[] | null>(),
    analyzePackage: params.analyzePackage,
    batchMissingDependencies: new Set<string>(),
    discoveredImports: new Map<string, string[]>(),
    processedSoftPaths: new Set<string>(),
    processedOriginPaths: new Set<string>(),
    cancelled: false,
    sink,
    // 解析器要引用 session 自己（读取消状态），所以先占位、建好之后再装上
    resolver: undefined as unknown as AssetDependencyResolver
  }

  session.resolver = new AssetDependencyResolver({
    // 依赖图整批累积，规模大了 DFS 就不划算 —— 沿用解析器自己那条阈值
    enableCircularDependencyDetection: assetCount <= AUTO_DISABLE_CIRCULAR_THRESHOLD,
    persistStateAcrossRuns: true,
    // 不接这一根线，解析器里那个「支持取消」的扫描就永远收不到信号，
    // 点了中止还得等它把目录翻完
    isCancelled: () => session.cancelled,
    // 解析器找不到依赖文件时只会写日志，得靠这根线把它记进当前资产的结果里
    errorCallback: (error) => {
      if (error.type !== 'file_not_found') return
      for (const affected of error.affectedPaths) {
        sink.missingDependencies.push(affected)
        // 共享依赖只在第一个用到它的资产那一轮被发现，逐资产那份会被下一轮清掉
        session.batchMissingDependencies.add(deriveSoftPathFromRealPath(affected) || affected)
      }
    },
    onAssetFound: async (assetInfo: AssetDependencyInfo) => {
      // 解析器给过来的 imports 是**实时解析**出来的，比数据库那份全 —— 记下来供收尾算闭包
      noteDiscoveredImports(session, assetInfo.softPath, assetInfo.imports)
      await copyFoundAssetInto(contentBase, sink, assetInfo, copyQueue, probeCache)
    }
  })

  return session
}

export type PlanAssetImportResult = {
  errorCode?: 'engine-version'
  success: boolean
  copied?: number
  total?: number
  warnings?: string[]
  results: Array<{ assetKey: string; from: string; to: string }>
  alreadyExists?: boolean
  error?: string
}

/**
 * 规划**一个**资产：查重、比版本、解析依赖，把要搬的文件排进会话的拷贝队列。
 *
 * ## 为什么 `session` 是必填的
 *
 * 它原来是可选的第三个参数，看着像「不传就是简单模式」的渐进式披露，实际是个
 * **模式开关**：传了 session，拷贝走队列、解析器整批共用、依赖边登记、临时文件
 * 延后清理；不传就全反过来。26 处 `session ?` 分支就是证据，而且已经害出过缺陷
 * （评审第 5 轮：新检查写成 `session ? 读磁盘 : 用数据库`，单资产入口漏了保护）。
 *
 * 更要命的是那条「简单模式」让慢路径活着：AI 的 `import_assets` 和资产库的多选导入
 * 都在 for 循环里一个一个调它，500 个动画共用的那副骨骼被解析 500 遍 —— 正是当初
 * 做批量会话要解决的问题。
 *
 * 现在只剩一条路：单个资产也是「一个资产的批量」（见 `importSingleUAssetToProject`）。
 */
async function planAssetImport(
  source: { assetKey?: string; skipDependencyResolution?: boolean } | null,
  session: ProjectImportBatchSession
): Promise<PlanAssetImportResult> {
  const warnings: string[] = []
  const results: Array<{ assetKey: string; from: string; to: string }> = []
  /**
   * 这次导入里**没能找到**的依赖软路径。
   *
   * 以前这几处只写 `console.warn`，于是界面上一片「成功」，工程里却缺着文件。
   * 现在记下来，收尾时算这个资产失败并报给用户。
   */
  const missingDependencies: string[] = []
  /** 两处都要记：逐资产那份用于本次返回，整批那份用于收尾时摊给所有用到它的资产 */
  const noteMissingDependency = (softPathOrRealPath: string): void => {
    if (!softPathOrRealPath) return
    missingDependencies.push(softPathOrRealPath)
    session.batchMissingDependencies.add(
      softPathOrRealPath.startsWith('/Game')
        ? softPathOrRealPath
        : deriveSoftPathFromRealPath(softPathOrRealPath) || softPathOrRealPath
    )
  }

  // 会话里的解析器是复用的，它的回调只认 session.sink —— 把这一轮的收集容器挂上去
  session.sink.results = results
  session.sink.warnings = warnings
  session.sink.skipped = 0
  session.sink.conflicted = 0
  session.sink.missingDependencies = []

  /** 这一轮里因为「目标已经有了」而跳过的文件数 */
  let skippedFiles = 0
  /** 这一轮里因为「目标属于别的源」而没敢写的文件数 */
  let conflictedFiles = 0

  // 下载到本地的临时文件，交给会话在队列排空之后统一清理
  const tempFilesToClean: string[] = []

  try {
    // 工程路径、Content 目录在会话建立时已经算过一次，
    // 不必每个资产都去 readdir 一遍工程根、再 mkdir 一次 Content
    const contentBase = session.contentBase
    const tempDir = session.httpTempDir

    const db = getVaultDatabase()
    const vaultManager = VaultManager.getInstance()
    const currentVault = vaultManager.getCurrentVault()
    const pathManager = PathManager.getInstance()
    const vaultType =
      currentVault?.vaultType === VaultType.REFERENCE ? VaultType.REFERENCE : VaultType.BACKUP

    // 🔧 检测是否为 HTTP 服务器资产库模式
    const httpTarget = resolveHttpVaultTarget(currentVault)

    if (httpTarget) {
      console.log(
        `[project:importUAssets] HTTP 服务器资产库: ${httpTarget.baseUrl} (vault ${httpTarget.vaultId})`
      )
    }

    /**
     * 解析资产的本地文件路径
     * 对于 HTTP 服务器资产库：从服务器下载文件到临时目录
     * 对于其他类型：直接返回本地路径
     */
    const resolveAssetPath = async (asset: AssetData): Promise<string> => {
      // HTTP 服务器资产库：通过 API 下载文件到临时目录
      if (httpTarget) {
        const relPath = httpVaultRelativePath(asset)
        if (!relPath) {
          throw new Error(`资产 ${asset.assetKey} 缺少 filePath`)
        }
        if (relPath !== String(asset.filePath || '')) {
          // 旧数据：filePath 存成了客户端本地绝对路径，只能退回拿文件名去服务器根上碰
          console.warn(
            `[project:importUAssets] filePath 是本地绝对路径(旧数据)，退回用文件名下载: ${asset.filePath} → ${relPath}`
          )
        }

        // 走下载池：整批并发下，且同一个文件只下一次。
        // 池子里多半已经把它预取好了，这里直接拿结果；没排过的（依赖是边解析边发现的，
        // 预取时还不知道）会插队立刻开下
        const pool = session.httpDownloads
        if (pool) return await pool.fetch(relPath)

        const localPath = await downloadFromServer(
          httpTarget.baseUrl,
          httpTarget.vaultId,
          relPath,
          tempDir
        )
        tempFilesToClean.push(localPath)
        return localPath
      }

      // 对于引用库和网络库（局域网共享），使用 originPath（完整的原始/网络路径）
      if (vaultType === VaultType.REFERENCE || currentVault?.vaultType === 'network') {
        return String(asset.originPath || '')
      }
      const fp = String(asset.filePath || '')
      return path.isAbsolute(fp) ? fp : pathManager.getAbsoluteFromVault(fp)
    }

    let mainAsset: AssetData | undefined
    if (source && typeof source === 'object' && 'assetKey' in source) {
      const assetKey = String(source.assetKey || '')
      if (assetKey) {
        // 会话建立时已经一次查库拿全了，不再一个资产一条 SELECT
        mainAsset = session.assetsByKey.get(assetKey) ?? getAssetDataByKey(db, assetKey)
      }
    }

    if (!mainAsset) {
      return { success: false, error: '未找到主资产', warnings, results }
    }

    const skipDependencyResolution = !!source?.skipDependencyResolution

    // HTTP 服务器库：查重排在下载**前面**。
    //
    // 「这个资产在工程里叫什么、放在哪」资产记录里就有，判断它在不在根本不需要源文件。
    // 反过来做的代价很实在：重新导一遍已经导过的文件夹，几百个文件全下一遍再一个个跳过。
    // 其他类型的库源文件就在本地/局域网上，`resolveAssetPath` 不产生 IO，仍走下面那段
    // 按分片查重的逻辑（那段更严：分片不全也算没导完）。
    // 「已存在」的判据必须连**长度**和**记录在案的直接依赖**一起查：
    // 上次导到一半被中止时，主文件可能只写了半截、依赖一个都没写，
    // 光看主文件在不在会把这种状态判成已导入，重试永远补不回来。
    if (
      httpTarget &&
      (await httpVaultAssetAlreadyImported(contentBase, mainAsset, {
        lookupBySoftPath: (softPath) => getAssetDataBySoftPath(db, softPath) ?? null,
        readImportsOfTarget: createPackageImportsReader(session.targetImportsCache, {
          analyze: session.analyzePackage
        })
      }))
    ) {
      return {
        success: true,
        copied: 0,
        total: 0,
        warnings: ['资产已存在于目标工程，已跳过'],
        results,
        alreadyExists: true
      }
    }

    const filePath = await resolveAssetPath(mainAsset)

    // 路径为空要单独挡掉。
    //
    // 记录缺 filePath 时 `getAbsoluteFromVault('')` 会算出**保管库根目录**，
    // 而那个目录是存在的 —— 下面的 fs.access 顺利通过，导入一路"成功"，
    // 最后返回 `imported: true` 和一条 ✅，可工程里什么都没有。
    // 真机验证时就是这样：报告导入了 SM_Chair_Wood，引擎里搜不到该资产。
    if (!filePath || !filePath.trim()) {
      return {
        success: false,
        error:
          `资产「${mainAsset.assetName || mainAsset.assetKey}」没有记录源文件路径，无法导入。` +
          '这条记录可能是导入中断或数据迁移留下的，请在资产库里重新导入这个文件。',
        warnings,
        results
      }
    }

    try {
      const stat = await fs.stat(filePath)
      // 同理：目录存在不代表资产文件存在。只认文件。
      if (!stat.isFile()) {
        return {
          success: false,
          error: `源路径不是一个文件：${filePath}。资产记录里的路径可能有误。`,
          warnings,
          results
        }
      }
    } catch (err) {
      console.error('[project:importUAssets] 源文件不可访问:', filePath, err)
      return { success: false, error: `源文件不存在或不可访问：${filePath}`, warnings, results }
    }

    // 这里原来有一条「主资产的包已经在目标工程里了就整个跳过」的快路径，现在删掉了。
    //
    // 它的问题是把主资产当成整个资产的代理：中止导入时完全可能主资产已经写进去、
    // 依赖还没写，重试时这条快路径直接判「已存在」，依赖永远补不回来（评审第 2 条）。
    //
    // 现在改成逐个文件判断（见 copyUnrealPackageFiles）：已经在的文件不重复拷，
    // 缺的照样补。代价是重复导入时依赖仍要解析一遍（读包头），但一个字节都不会重搬。

    // 版本兼容性检查：阻止高版本资产导入到低版本项目。
    // 工程版本整批只解析一次（自编译引擎那条路要起 PowerShell 读注册表）。
    // 用户在弹窗里点了「仍然导入」时整批放行 —— 那句「打不开」已经跟他说清楚了
    const versionCheck = compareAssetToResolvedProjectEngineVersion(
      mainAsset.engineVersion || null,
      session.projectEngine
    )
    if (versionCheck.comparison > 0 && !session.ignoreEngineVersion) {
      const assetVerDisplay = versionCheck.assetDisplayVersion
      const projectVerDisplay = versionCheck.project.displayVersion
      return {
        success: false,
        errorCode: 'engine-version',
        error: `资产引擎版本 (UE ${assetVerDisplay}) 高于目标项目版本 (UE ${projectVerDisplay})，无法导入。`,
        results,
        warnings: [
          `资产版本: UE ${assetVerDisplay}`,
          `项目版本: UE ${projectVerDisplay}`,
          '请使用相同或更高版本的虚幻引擎项目来导入此资产。'
        ]
      }
    }

    // 🔧 核心修复：网络库使用数据库查询依赖，而非物理文件路径搜索
    // 原因：网络库的目录结构不是 UE 的 Content/ 层次结构，
    // AssetDependencyResolver 的向上搜索策略无法在网络共享上找到依赖文件。
    // 但所有网络库资产已经在数据库中索引，可以通过 softPath 查到正确的 originPath。
    const isNetworkVault = currentVault?.vaultType === 'network'

    if (skipDependencyResolution) {
      const relativePath = String(mainAsset.softPath || '')
        .replace(/^\/Game\/?/, '')
        .trim()
      const targetSeedPath = path.join(
        contentBase,
        relativePath || path.basename(filePath, path.extname(filePath))
      )

      console.log(
        '[project:importUAssets] 快路径导入，跳过依赖解析:',
        mainAsset.softPath || mainAsset.assetName || filePath
      )

      const outcome = await copyUnrealPackageFiles(
        filePath,
        targetSeedPath,
        mainAsset.assetKey || '',
        results,
        session.copyQueue,
        session.packageProbeCache
      )
      conflictedFiles += outcome.conflicted
      if (outcome.copiedOrQueued === 0 && outcome.skipped > 0 && outcome.conflicted === 0) {
        return {
          success: true,
          copied: 0,
          total: 0,
          warnings: ['资产已存在于目标工程，已跳过'],
          results,
          alreadyExists: true
        }
      }
      return { success: true, copied: results.length, total: results.length, warnings, results }
    }

    if (isNetworkVault) {
      // 🔧 V2 修复：网络库使用实时解析 .uasset + 数据库辅助定位依赖
      // 旧方案仅依赖数据库 imports 列，数据不完整（collectReferences 跳过无路径的 objectName）
      // 且 softPath 匹配可能失败。新方案在导入时实时解析二进制文件获取完整依赖列表。
      console.log('[project:importUAssets] 使用实时解析 + 数据库辅助解析网络库依赖')

      const readTargetImports = createPackageImportsReader(session.targetImportsCache, {
        analyze: session.analyzePackage
      })
      const processedSoftPaths = session.processedSoftPaths
      const processedOriginPaths = session.processedOriginPaths

      // 🔧 递归从 .dependency/ 目录复制依赖文件及其子依赖
      const copyDepFromDependencyDir = async (softPath: string): Promise<void> => {
        if (processedSoftPaths.has(softPath)) return

        const networkPath = currentVault?.networkPath
        if (!networkPath) {
          console.warn(`[project:importUAssets] 依赖未找到(无网络路径): ${softPath}`)
          noteMissingDependency(softPath)
          return
        }

        const cleanSoftPath = softPath.replace(/^\/Game\/?/, '')
        const extsToTry = ['.uasset', '.umap', '.uexp', '.ubulk', '.uptnl']

        for (const tryExt of extsToTry) {
          const depFilePath = path.join(networkPath, '.dependency', cleanSoftPath + tryExt)
          try {
            await fs.access(depFilePath)
          } catch {
            continue // 尝试下一个扩展名
          }

          // 文件存在，标记并复制
          processedSoftPaths.add(softPath)
          const targetPath = path.join(contentBase, cleanSoftPath + tryExt)
          const outcome = await copyUnrealPackageFiles(
            depFilePath,
            targetPath,
            '',
            results,
            session.copyQueue,
            session.packageProbeCache
          )
          // 这一段原来只取 parseSourcePath，把跳过/冲突的计数丢了 —— 于是网络库
          // 原样重导时 skippedFiles 永远是 0，收尾判不出「已存在」
          const { parseSourcePath } = outcome
          skippedFiles += outcome.skipped
          conflictedFiles += outcome.conflicted
          console.log(
            `✅ [project:importUAssets] 从 .dependency/ 复制依赖: ${cleanSoftPath}${tryExt}`
          )

          const parseExt = path.extname(parseSourcePath || depFilePath).toLowerCase()

          // 递归解析此依赖的子依赖（仅 .uasset/.umap）
          if (parseSourcePath && isPrimaryUnrealPackageExtension(parseExt)) {
            try {
              // 只读取依赖，不走完整处理器 —— 后者顺手就把缩略图转出来存盘了，
              // 而这里根本不需要图
              const subDepPaths = (await readTargetImports(parseSourcePath)) ?? []
              // 从 .dependency/ 捞出来的包同样要登记它的依赖边，否则这一段的闭包是断的
              noteDiscoveredImports(session, softPath, subDepPaths)
              for (const subSoftPath of subDepPaths) {
                if (processedSoftPaths.has(subSoftPath)) continue
                // 先查 DB
                let subAsset = getAssetDataBySoftPath(db, subSoftPath)
                if (!subAsset) {
                  const batch = getAssetsBySoftPaths(db, [subSoftPath])
                  if (batch.length > 0) subAsset = batch[0]
                }
                if (subAsset) {
                  await processAssetAndDeps(subAsset)
                } else {
                  // 递归从 .dependency/ 查找（无深度限制）
                  await copyDepFromDependencyDir(subSoftPath)
                }
              }
            } catch (err) {
              console.warn(`[project:importUAssets] 解析依赖的子依赖失败: ${cleanSoftPath}`, err)
            }
          }
          return // 已找到并处理，退出
        }

        console.warn(`[project:importUAssets] 依赖未找到(DB和.dependency/): ${softPath}`)
        noteMissingDependency(softPath)
      }

      const processAssetAndDeps = async (asset: AssetData): Promise<void> => {
        const aSoftPath = String(asset.softPath || '')
        const assetFilePath = await resolveAssetPath(asset)
        if (!assetFilePath) return

        // 双重去重：按 softPath 和 originPath
        if (aSoftPath && processedSoftPaths.has(aSoftPath)) return
        if (processedOriginPaths.has(assetFilePath)) return
        if (aSoftPath) processedSoftPaths.add(aSoftPath)
        processedOriginPaths.add(assetFilePath)

        // 检查源文件可访问
        try {
          await fs.access(assetFilePath)
        } catch {
          console.warn(`[project:importUAssets] 依赖文件不可访问: ${assetFilePath}`)
          warnings.push(`依赖文件不可访问: ${path.basename(assetFilePath)}`)
          // 库里有记录、源文件却没了 —— 这条依赖同样进不了工程，必须算失败，
          // 不能只留一条警告（评审第 8 轮第 3 条）
          noteMissingDependency(aSoftPath || assetFilePath)
          return
        }

        // 计算目标路径并复制
        let parseSourcePath: string | null = null
        try {
          const relativePath = aSoftPath
            ? aSoftPath.replace(/^\/Game\/?/, '')
            : path.basename(assetFilePath, path.extname(assetFilePath))
          const ext = path.extname(assetFilePath)
          const targetPath = path.join(contentBase, relativePath + ext)
          const outcome = await copyUnrealPackageFiles(
            assetFilePath,
            targetPath,
            asset.assetKey || '',
            results,
            session.copyQueue,
            session.packageProbeCache
          )
          parseSourcePath = outcome.parseSourcePath
          // 同上：跳过/冲突的计数不能丢，收尾要靠它判「已存在」
          skippedFiles += outcome.skipped
          conflictedFiles += outcome.conflicted
        } catch (e) {
          console.error(`[project:importUAssets] 复制失败: ${assetFilePath}`, e)
          warnings.push(`复制失败 ${path.basename(assetFilePath)}: ${String(e)}`)
          return
        }

        // 🔧 关键修改：实时解析 .uasset 二进制获取完整依赖列表
        const ext = path.extname(parseSourcePath || assetFilePath).toLowerCase()
        if (parseSourcePath && isPrimaryUnrealPackageExtension(ext)) {
          try {
            // 只读取依赖，不走完整处理器（它会顺手存缩略图）
            const parsed = await readTargetImports(parseSourcePath)

            // 解析**失败**才回退到数据库记录。
            // 解析成功但没有依赖返回的是空数组 —— 那种情况下回退等于拿一份
            // 可能过期的记录去覆盖一个确定的答案。
            const depSoftPaths = parsed ?? normalizeImports(asset.imports)

            // 网络库走的是这条自己的实时解析，不经过 AssetDependencyResolver 的回调 ——
            // 不在这里登记的话，收尾算依赖归属时这批边根本不存在（评审第 10 轮第 2 条）
            if (parsed) noteDiscoveredImports(session, aSoftPath, parsed)

            console.log(
              `[project:importUAssets] ${path.basename(assetFilePath)} 实时解析依赖: ${depSoftPaths.length} 个 softPath`
            )

            for (const depSoftPath of depSoftPaths) {
              if (processedSoftPaths.has(depSoftPath)) continue

              // 策略1: 精确匹配 softPath
              let depAsset = getAssetDataBySoftPath(db, depSoftPath)

              // 策略2: 批量匹配（可能 softPath 有细微格式差异）
              if (!depAsset) {
                const batchResult = getAssetsBySoftPaths(db, [depSoftPath])
                if (batchResult.length > 0) depAsset = batchResult[0]
              }

              // 策略3: 按资产名模糊匹配
              if (!depAsset) {
                const depName = depSoftPath.split('/').pop() || ''
                if (depName) {
                  // 把 softPath 后缀作为偏好传下去：同名资产是常态，
                  // 不排序的话真正要的那一行可能被 LIMIT 截在外面
                  const candidates = findAssetDataByExactName(db, depName, 50, '/' + depName)
                  // 名字对不对得上单独判一次：查询按「名字」或「名字.扩展名」两种形态收，
                  // 同名同目录的旁支（SM_Chair.fbx / .png / .psd）softPath 是一样的，
                  // 只看 softPath 的话它们会顶掉真正要的那个 .uasset
                  const nameMatches = (c: AssetData): boolean =>
                    c.assetName === depName || stripAssetNameExtension(c.assetName) === depName
                  // 优先匹配 softPath 结尾一致的
                  depAsset = candidates.find(
                    (c) => c.softPath && c.softPath.endsWith('/' + depName) && nameMatches(c)
                  )
                  // 次优：名称对得上就行，不再要求 softPath
                  if (!depAsset) {
                    depAsset = candidates.find(nameMatches)
                  }
                }
              }

              if (depAsset) {
                await processAssetAndDeps(depAsset)
              } else {
                // 🔧 DB 中没有记录，尝试从 .dependency/ 目录直接查找
                await copyDepFromDependencyDir(depSoftPath)
              }
            }
          } catch (parseErr) {
            console.warn(
              `[project:importUAssets] 解析依赖失败: ${path.basename(assetFilePath)}`,
              parseErr
            )
            // 回退到数据库 imports
            const fallbackImports = normalizeImports(asset.imports)
            if (fallbackImports.length > 0) {
              const depAssets = getAssetsBySoftPaths(db, fallbackImports)
              for (const depAsset of depAssets) {
                await processAssetAndDeps(depAsset)
              }
            }
          }
        }
      }

      // 从主资产开始递归处理。网络库这条路不走 AssetDependencyResolver，
      // 跳过/冲突的计数在上面两处拷贝点直接累加，不经过 session.sink
      await processAssetAndDeps(mainAsset)
    } else {
      // 非网络库：走 AssetDependencyResolver 基于物理文件解析依赖。
      // 整批共用一个解析器（见 ProjectImportBatchSession），共享依赖只解析一次
      const resolver = session.resolver

      // 构建初始资产信息
      const initialImports = normalizeImports(mainAsset.imports)

      const initialAsset: AssetDependencyInfo = {
        assetKey: mainAsset.assetKey || '',
        name: mainAsset.assetName,
        softPath: mainAsset.softPath ?? '',
        realPath: filePath,
        originPath: filePath,
        imports: initialImports,
        classKey: mainAsset.classKey || 'uasset',
        engineVersion: mainAsset.engineVersion
      }

      await resolver.resolveDependencies([initialAsset])
      skippedFiles += session.sink.skipped
      conflictedFiles += session.sink.conflicted
    }

    // 缺失依赖的结算必须排在「已存在」**前面**。
    //
    // 反过来的话，第一次导入报了缺依赖，原样重试时所有能拷的文件都已经在了 ——
    // 于是走「一个文件都没排队」这条分支返回「已存在」，缺的那条依赖凭空消失
    // （评审第 8 轮第 1 条）。
    const missing = Array.from(
      new Set([...missingDependencies, ...session.sink.missingDependencies])
    )
    if (missing.length === 0) {
      // 有文件因为目标被别的源占了而没写成，就不是「已存在」，也不能装作一切正常
      if (conflictedFiles > 0) {
        warnings.push(
          `有 ${conflictedFiles} 个文件的目标位置已被同一批里的其他资产占用，本次没有覆盖`
        )
      } else if (results.length === 0 && skippedFiles > 0) {
        // 一个文件都没排队、但确实跳过了几个 —— 这个资产连同依赖早就在工程里了
        return {
          success: true,
          copied: 0,
          total: 0,
          warnings: ['资产已存在于目标工程，已跳过'],
          results,
          alreadyExists: true
        }
      }
    }

    if (missing.length > 0) {
      // 主文件可能已经拷过去了，但依赖缺着 —— 这个资产在工程里就是用不了的。
      // 报成功等于骗人；这里如实算失败，并把缺的东西列出来。
      const shown = missing
        .slice(0, 5)
        .map((p) => path.basename(p))
        .join('、')
      const more = missing.length > 5 ? `，另有 ${missing.length - 5} 个` : ''
      return {
        success: false,
        error: `依赖不完整：找不到 ${missing.length} 个依赖（${shown}${more}）`,
        copied: results.length,
        total: results.length,
        warnings: [...warnings, ...missing.map((p) => `依赖未找到：${p}`)],
        results
      }
    }

    return { success: true, copied: results.length, total: results.length, warnings, results }
  } catch (error: unknown) {
    return {
      success: false,
      error: String(error instanceof Error ? error.message : error),
      warnings,
      results
    }
  } finally {
    // 拷贝是排队异步做的，这里删掉临时文件就等于把还没搬走的源文件抽掉了 ——
    // 交给会话在队列排空之后统一清理
    session.httpTempFiles.push(...tempFilesToClean)
  }
}

export type ProjectImportBatchSource = {
  assetKey?: string
  assetName?: string
  skipDependencyResolution?: boolean
}

const MAX_BATCH_WARNINGS = 20

const capWarnings = (warnings: string[]): string[] => {
  if (warnings.length <= MAX_BATCH_WARNINGS) return warnings
  return [
    ...warnings.slice(0, MAX_BATCH_WARNINGS),
    `……另有 ${warnings.length - MAX_BATCH_WARNINGS} 条同类问题，详见日志`
  ]
}

export type ProjectImportBatchProgress = {
  /** 已规划完的资产数 */
  processed: number
  total: number
  succeeded: number
  existing: number
  failed: number
  currentName: string
  /** 已拷完的文件数 / 已排队的文件数 */
  filesCopied: number
  filesQueued: number
  bytesCopied: number
  bytesTotal: number
  cancelled: boolean
}

export type ProjectImportBatchResult = {
  /** 整批是不是一个问题都没有：任何一个文件没落盘都是 false */
  success: boolean
  total: number
  succeeded: number
  existing: number
  failed: number
  copied: number
  /** 排了队但没能写进工程的文件数 */
  filesFailed: number
  /** 实际写进工程的字节数 */
  bytesCopied: number
  cancelled: boolean
  warnings: string[]
  /** 每个资产的最终状态。界面按这个分组，不靠解析 warnings 里的中文 */
  assets: SettledAsset[]
  /** 出了什么问题、影响了谁。界面的「查看详情」读它 */
  report: ImportFailureReport
  error?: string
}

/**
 * 每条找不到的依赖究竟属于哪种「找不到」。
 *
 * 「保管库里根本没有」和「库里有记录、源文件丢了」的下一步完全不同，
 * 都报成「找不到 3 个依赖」等于把用户堵在原地。
 * 这一步查库 + stat 源文件，只对**真的没找到**的那几条做，不影响正常路径。
 */
const lookupMissingDependencies = async (
  db: ReturnType<typeof getVaultDatabase>,
  softPaths: ReadonlySet<string>
): Promise<Map<string, MissingDependencyFact>> => {
  const facts = new Map<string, MissingDependencyFact>()

  /*
   * 只查会被报出来的那几条。
   *
   * 报告每组封顶 `MAX_REPORT_ROWS`，多出来的行结算时会被截掉 —— 对它们查库 + stat
   * 是纯白花。源盘掉线时这个集合能到几千条，每条一次 SMB 超时，而这一步跑在进度条
   * 已经顶到 99% 之后，用户既看不见也停不掉。
   */
  const wanted = Array.from(softPaths).slice(0, MAX_REPORT_ROWS)
  if (wanted.length === 0) return facts

  /*
   * 这个集合里混着**真实磁盘路径**：`deriveSoftPathFromRealPath` 认不出
   * `/Content/` 或 `/Game/` 时，登记的就是原样的绝对路径。
   * 拿它去查 softPath 必然查不到，报成「保管库里没有」是撒谎 —— 那是我们没解析出来。
   */
  const isSoftPath = (candidate: string): boolean => candidate.startsWith('/Game')
  const softOnes = wanted.filter(isSoftPath)

  // 一条 SQL 查完，不再一个 softPath 一条 SELECT（同步 better-sqlite3 会卡住主线程）
  const records = new Map<string, AssetData>()
  if (softOnes.length > 0) {
    for (const record of getAssetsBySoftPaths(db, softOnes)) {
      const key = String(record.softPath || '')
      if (key) records.set(key, record)
    }
  }

  await Promise.all(
    wanted.map(async (softPath) => {
      // 真实路径要按反斜杠和斜杠一起切，否则整条 Windows 路径会被当成资产名
      const name = softPath.split(/[\\/]/).pop() || softPath

      if (!isSoftPath(softPath)) {
        // 连软路径都没解析出来 —— 如实说是我们这边没定位到，别打发用户去翻素材
        facts.set(softPath, { state: 'unresolved', name })
        return
      }

      const record = records.get(softPath)
      if (!record) {
        facts.set(softPath, { state: 'not-in-vault', name })
        return
      }

      const displayName = String(record.assetName || name)
      const source = String(record.filePath || record.originPath || '')
      if (!source) {
        facts.set(softPath, { state: 'source-missing', name: displayName })
        return
      }
      try {
        await fs.access(
          path.isAbsolute(source) ? source : PathManager.getInstance().getAbsoluteFromVault(source)
        )
        facts.set(softPath, { state: 'unresolved', name: displayName })
      } catch {
        facts.set(softPath, { state: 'source-missing', name: displayName })
      }
    })
  )
  return facts
}

/** 一批导入的取消令牌，按 requestId 存着，供 cancel IPC 找到它 */
const activeBatchSessions = new Map<string, ProjectImportBatchSession>()

/**
 * HTTP 服务器库：在规划循环之外「边查重边预取」。
 *
 * 两件事都不能留在规划循环里做：
 * - 已经在工程里的资产**一个字节都不下**。重复导入一个文件夹曾经要把整包白下一遍，
 *   因为查重排在下载后面。
 * - 剩下的排进下载池并发下。规划是串行的，下载留在里面就等于串行下，
 *   而 HTTP 一个文件一次往返，串行是把带宽扔了。
 *
 * 这个循环本身只做 `fs.access`（毫秒级），真正耗时的下载由池子按并发上限做，
 * 所以它跑得比规划快得多，规划轮到某个资产时文件通常已经躺在临时目录里了。
 * 依赖资产是边解析边发现的，预取时还不知道，它们走 `pool.fetch` 插队现下。
 */
const startHttpPrefetch = (
  session: ProjectImportBatchSession,
  sources: ProjectImportBatchSource[],
  pool: HttpDownloadPool
): void => {
  void (async () => {
    for (const source of sources) {
      if (session.cancelled || pool.isCancelled) return

      const asset = session.assetsByKey.get(String(source?.assetKey || ''))
      if (!asset) continue

      const relPath = httpVaultRelativePath(asset)
      if (!relPath) continue

      // 判据和规划循环里那处保持一致，否则预取会跳过「上次导到一半」的资产
      const alreadyImported = await httpVaultAssetAlreadyImported(session.contentBase, asset, {
        lookupBySoftPath: (softPath) =>
          getAssetDataBySoftPath(getVaultDatabase(), softPath) ?? null,
        readImportsOfTarget: createPackageImportsReader(session.targetImportsCache, {
          analyze: session.analyzePackage
        })
      })
      if (alreadyImported) continue
      pool.prefetch(relPath)
    }
  })().catch((error) => {
    // 预取失败不该影响导入本身：规划循环要哪个文件时自己会去 fetch
    console.warn('[project:importUAssetsBatch] 预取下载失败', error)
  })
}

/**
 * 一次把整个文件夹的 uasset 导进工程。
 *
 * 结构是**规划 + 拷贝的流水线**，不是「一个资产从头做到尾」的循环：
 *
 * - 规划（串行）：查重、比版本、解析依赖，把要搬的文件按目标路径去重后排进队列。
 *   整批共用一份依赖解析状态，共享依赖（骨骼、材质、贴图）只解析一次。
 * - 拷贝（并发）：后台 4~8 路 `fs.copyFile` 从队列里取活。规划一边算，它一边搬，
 *   两头不用互相等 —— 30G 素材包上省下来的就是这段重叠时间。
 *
 * 去重按**目标路径**做，不只是为了省事：并发下两个 worker 同时写同一个目标文件
 * 就是数据损坏。
 */
export async function importUAssetsBatchToProject(
  project: ProjectImportProjectRecord,
  sources: ProjectImportBatchSource[],
  options?: {
    onProgress?: (progress: ProjectImportBatchProgress) => void
    /** 注册到取消表里的 id，拿到它就能中止这批导入 */
    requestId?: string
    /** 依赖闭包最多走多少个节点；超了就按「无法确认」结算。测试用，默认 5000 */
    maxClosureNodes?: number
    /** 替换 .uasset 解析器。测试用，默认读真实二进制 */
    analyzePackage?: PackageAnalyzer
    /**
     * 跳过「资产版本高于工程版本」这道闸，照样拷文件。
     *
     * 只有用户在版本冲突弹窗里点了「仍然导入」才会是 true。判定依据是资产库里记的
     * engineVersion，它可能扫错或过期，所以这个口子得留；但默认必须是关的。
     */
    ignoreEngineVersion?: boolean
  }
): Promise<ProjectImportBatchResult> {
  const onProgress = options?.onProgress
  const total = sources.length
  /** 规划阶段产生的警告；结算阶段那批拼在它后面 */
  const warnings: string[] = []
  let succeeded = 0
  let existing = 0
  let failed = 0
  let processed = 0
  let currentName = ''
  /**
   * 规划阶段对每个资产的结论。
   *
   * 这里的「成功」只代表**排上了队**，文件真写没写进去是队列说了算 ——
   * 最终状态等队列跑完由 `settleImportBatch` 按实际落盘结果算（评审第 1 条）。
   */
  const planned: PlannedAsset[] = []
  /**
   * 目标文件 → 哪些资产需要它。
   *
   * 必须是**集合**：几个动画共用一副骨骼时，骨骼这个文件只会被排一次队，
   * 但它没写进去意味着这几个动画**全都**不完整。只记第一个的话会报成
   * 「成功 1、失败 1」—— 其实两个都残（评审第 3 条）。
   */
  //
  // 键用「去掉扩展名的包路径」而不是具体文件：一个 UE 包在磁盘上是 .uasset + .uexp +
  // .ubulk 一组文件，骨骼的 .ubulk 没写进去，依赖它的动画照样是残的。
  const targetOwners = new Map<string, Set<number>>()
  const addTargetOwner = (target: string, index: number): void => {
    const key = session.copyQueue.targetKey(getPackageBasePath(target))
    const owners = targetOwners.get(key)
    if (owners) owners.add(index)
    else targetOwners.set(key, new Set([index]))
  }

  /** softPath → 它的直接依赖。整批共用，省掉重复的 DB 点查 */
  const directImportsCache = new Map<string, string[]>()
  const directImportsOf = (softPath: string): string[] => {
    const cached = directImportsCache.get(softPath)
    if (cached) return cached
    // 数据库那份会漏记，实时解析那份只覆盖这批真正解析过的 —— 两份并起来才够全
    const imports = Array.from(
      new Set([
        ...normalizeImports(getAssetDataBySoftPath(db, softPath)?.imports),
        ...(session.discoveredImports.get(softPath) ?? [])
      ])
    )
    directImportsCache.set(softPath, imports)
    return imports
  }

  /** 闭包没走完的资产。有文件失败时，这些资产不能当作「确认没事」结算 */
  const closureIncompleteIndexes = new Set<number>()

  /**
   * 把一个资产**整条依赖链**上的包都登记到它名下。
   *
   * 只登记直接依赖是不够的：模型 → 材质 → 贴图，贴图挂了模型一样用不了。
   * 走的是资产记录里的 imports，纯内存 + 带缓存的 DB 点查，不碰磁盘。
   *
   * 走不完（超预算）不能一声不吭地停 —— 那等于把「没查」当成了「查过没事」。
   * 记进 `closureIncompleteIndexes`，收尾时按「无法确认」处理。
   */
  const registerDependencyClosure = (assetKey: string, index: number): void => {
    const MAX_NODES = options?.maxClosureNodes ?? 5000
    const seen = new Set<string>()
    const rootAsset = assetsByKey.get(assetKey)
    const rootSoftPath = String(rootAsset?.softPath || '')
    const queue = Array.from(
      new Set([
        ...normalizeImports(rootAsset?.imports),
        ...(rootSoftPath ? (session.discoveredImports.get(rootSoftPath) ?? []) : [])
      ])
    )
    let budget = MAX_NODES

    while (queue.length > 0) {
      if (budget-- <= 0) {
        closureIncompleteIndexes.add(index)
        console.warn(
          `[project:importUAssetsBatch] 依赖闭包超过 ${MAX_NODES} 个节点，未走完：${assetKey}`
        )
        return
      }

      const softPath = queue.shift() as string
      if (!softPath || seen.has(softPath)) continue
      seen.add(softPath)

      const relative = softPath.replace(/^\/Game\/?/, '')
      if (relative) addTargetOwner(path.join(contentBase, relative), index)

      queue.push(...directImportsOf(softPath))
    }
  }

  const emptyResult = (
    extra: Partial<ProjectImportBatchResult> = {}
  ): ProjectImportBatchResult => ({
    success: true,
    total,
    succeeded: 0,
    existing: 0,
    failed: 0,
    copied: 0,
    filesFailed: 0,
    bytesCopied: 0,
    cancelled: false,
    warnings,
    assets: [],
    report: emptyImportFailureReport(),
    ...extra
  })

  if (total === 0) {
    return emptyResult({ total: 0 })
  }

  const projectFile = await resolveProjectFilePath(project)
  if (!projectFile) {
    return emptyResult({ success: false, failed: total, error: '工程路径无效' })
  }

  const contentBase = path.join(path.dirname(projectFile), 'Content')
  await ensureDir(contentBase)

  // 渲染层传来的记录可能是升级引擎之前抄的，闸门按磁盘上的 .uproject 判。
  // 磁盘上写的是空串（源码版引擎里的工程）时退回调用方给的版本 —— 连着的编辑器
  // 报的版本是真的，`??` 接不住空串，会把闸门判成「工程版本未知」全拒掉
  const projectEngine = await resolveProjectEngineVersion(
    (await readEngineAssociationFromDisk(project)) || project.EngineAssociation || null,
    UnrealPathManagerUtil
  )

  const db = getVaultDatabase()
  const assetKeys = sources.map((s) => String(s?.assetKey || '')).filter(Boolean)
  // 一次把这批资产全查出来，而不是循环里一个资产一条 SELECT
  const assetsByKey = new Map<string, AssetData>()
  for (const asset of getAssetsByKeys(db, assetKeys)) {
    if (asset.assetKey) assetsByKey.set(asset.assetKey, asset)
  }

  const currentVault = VaultManager.getInstance().getCurrentVault()
  const httpTempDir = path.join(app.getPath('temp'), `ue-import-${Date.now()}`)
  await ensureDir(httpTempDir)

  const httpTarget = resolveHttpVaultTarget(currentVault)
  const httpDownloads = httpTarget
    ? new HttpDownloadPool({
        concurrency: HTTP_DOWNLOAD_CONCURRENCY,
        download: (relPath) =>
          downloadFromServer(httpTarget.baseUrl, httpTarget.vaultId, relPath, httpTempDir)
      })
    : undefined

  const emit = (): void => {
    if (!onProgress) return
    const stats = session.copyQueue.stats
    onProgress({
      processed,
      total,
      succeeded,
      existing,
      failed,
      currentName,
      filesCopied: stats.copied,
      filesQueued: stats.queued,
      bytesCopied: stats.bytesCopied,
      bytesTotal: stats.bytesTotal,
      cancelled: session.cancelled
    })
  }

  const session = createBatchSession({
    contentBase,
    projectEngine,
    ignoreEngineVersion: options?.ignoreEngineVersion === true,
    assetCount: total,
    assetsByKey,
    httpTempDir,
    httpDownloads,
    vaultType: currentVault?.vaultType,
    onCopyProgress: () => emit(),
    analyzePackage: options?.analyzePackage
  })

  const requestId = String(options?.requestId || '')
  if (requestId) activeBatchSessions.set(requestId, session)

  // 下载在规划循环之外并发跑起来；规划循环轮到某个资产时，文件多半已经在本地了
  if (httpDownloads) startHttpPrefetch(session, sources, httpDownloads)

  try {
    for (let index = 0; index < sources.length; index++) {
      if (session.cancelled) break

      const source = sources[index]
      currentName = String(source?.assetName || source?.assetKey || '')
      const assetKey = String(source?.assetKey || '')
      const note = (
        outcome: PlannedAsset['planned'],
        extra: { error?: string; errorCode?: 'engine-version'; primaryTarget?: string } = {}
      ): void => {
        planned.push({ index, assetKey, assetName: currentName, planned: outcome, ...extra })
      }

      try {
        const result = await planAssetImport(source, session)
        if (result.alreadyExists) {
          existing += 1
          // 「已存在」也要参与最终结算：整批重试时，共享依赖缺失只会被第一个资产
          // 解析到，后面的资产什么都不用搬就成了「已存在」—— 不登记归属的话，
          // 收尾时根本够不着它们（评审第 9 轮第 1 条）
          note('existing')
        } else if (result.success) {
          succeeded += 1
          // 记下这个资产要往哪些位置写。拷贝是排队异步做的，规划阶段的「成功」只是
          // 「排上了」；真正算不算成功，等队列跑完按实际落盘结果结算（评审第 1 条）。
          let primaryTarget: string | undefined
          for (const item of result.results) {
            addTargetOwner(item.to, index)
            if (
              !primaryTarget &&
              isPrimaryUnrealPackageExtension(path.extname(item.to).toLowerCase())
            ) {
              primaryTarget = item.to
            }
          }
          note('imported', { primaryTarget })
          if (Array.isArray(result.warnings) && result.warnings.length > 0) {
            warnings.push(...result.warnings)
          }
        } else {
          failed += 1
          const message = result.error ? String(result.error) : `导入失败：${currentName}`
          console.warn(`[project:importUAssetsBatch] ${message}`)
          warnings.push(message)
          note('failed', { error: message, errorCode: result.errorCode })
        }
      } catch (e) {
        failed += 1
        const message = `${currentName}: ${String(e instanceof Error ? e.message : e)}`
        console.warn(`[project:importUAssetsBatch] ${message}`)
        warnings.push(message)
        note('failed', { error: message })
      }

      processed = index + 1
      emit()
    }

    // 规划走完了，等后台把队列里的文件搬干净
    currentName = ''
    await session.copyQueue.drain()

    // 依赖闭包的登记推迟到这里做，不在规划循环里做：
    // 实时解析发现的依赖边要等整批走完才齐，边算边登记的话，
    // 排在前面的资产用的是还没长全的图（评审第 9 轮第 2 条）。
    for (const asset of planned) {
      if (asset.planned !== 'failed') registerDependencyClosure(asset.assetKey, asset.index)
    }

    // 按实际落盘结果结算：规划阶段的「成功」只代表排上了队，文件真写没写进去是
    // 队列说了算。三条归因路径（拷贝失败 / 缺依赖 / 闭包没走完）在纯函数里一起算，
    // 交叉情况有单测钉着（`importSettlement.ts`）。
    const settlement = settleImportBatch({
      assets: planned,
      contentBase,
      targetOwners,
      closureIncomplete: closureIncompleteIndexes,
      missingDependencies: session.batchMissingDependencies,
      missingFacts: await lookupMissingDependencies(db, session.batchMissingDependencies),
      queueFailures: session.copyQueue.getFailures(),
      queueConflicts: session.copyQueue.getConflicts(),
      packageKeyOf: (target) => session.copyQueue.targetKey(getPackageBasePath(target)),
      joinPath: path.join,
      basename: path.basename
    })
    warnings.push(...settlement.warnings)

    // 最后一条进度用结算后的数字，别让挂件停在规划阶段那份乐观统计上
    succeeded = settlement.succeeded
    existing = settlement.existing
    failed = settlement.failed

    const queueStats = session.copyQueue.stats
    emit()

    return {
      /*
       * 「整批一个问题都没有」必须连报告一起看。
       *
       * 只看 failed 数的话有两类问题整批漏网，它们的共同点是**摊不到某个资产头上**：
       * 目标路径冲突（文件根本没进队列，谁都没降级）、以及归属算不出来的缺失依赖。
       * 那两种情况下报 success: true，等于对着一个残的工程说没事。
       */
      success:
        queueStats.failed === 0 &&
        settlement.failed === 0 &&
        isCleanImportReport(settlement.report),
      total,
      succeeded: settlement.succeeded,
      existing: settlement.existing,
      failed: settlement.failed,
      copied: queueStats.copied,
      filesFailed: queueStats.failed,
      bytesCopied: queueStats.bytesCopied,
      cancelled: session.cancelled,
      assets: settlement.assets,
      report: settlement.report,
      // 上千个资产各报一条警告的话，弹窗会长到没法看，也白白撑大 IPC 载荷
      warnings: capWarnings(warnings)
    }
  } finally {
    if (requestId) activeBatchSessions.delete(requestId)
    await cleanupSessionTempFiles(session, httpTempDir)
  }
}

/** 队列排空之后才能删下载来的临时文件，否则等于把还没搬走的源文件抽掉 */
const cleanupSessionTempFiles = async (
  session: ProjectImportBatchSession,
  tempDir: string
): Promise<void> => {
  // 预取跑在规划前面，收尾时可能还有几个文件在下 —— 不等它们落完就删，
  // 临时目录删不掉（非空），下下来的文件就永远留在盘上了
  if (session.httpDownloads) {
    session.httpDownloads.cancel()
    await session.httpDownloads.drain()
    session.httpTempFiles.push(...session.httpDownloads.downloadedFiles())
  }

  for (const tmpFile of new Set(session.httpTempFiles)) {
    try {
      await fs.unlink(tmpFile)
    } catch {
      // 忽略删除失败
    }
  }
  try {
    await fs.rmdir(tempDir)
  } catch {
    // 忽略删除失败（目录可能非空或不存在）
  }
}

/**
 * 导一个资产 —— 内部就是「一个资产的批量」。
 *
 * 没有第二条代码路径：单资产曾经有一套自己的实现（不传 `session` 那半边），
 * 结果就是同一件事从不同入口进来得出不同结论（评审第 5 轮）。现在两个入口
 * 共用同一套查重、同一套解析、同一套结算。
 *
 * 顺带一个变化：返回的 `copied` 现在是**真落盘数**。以前单资产是「排上了就算」，
 * 拷贝失败根本不体现在返回值里。
 */
export async function importSingleUAssetToProject(
  project: ProjectImportProjectRecord,
  source: { assetKey?: string; assetName?: string; skipDependencyResolution?: boolean } | null
): Promise<PlanAssetImportResult> {
  // 空的 source 得当场挡掉：转给批量入口的话它看到的是「零个资产」，
  // 那是**成功**（没什么要导的），于是「没给我要导什么」会被报成导入成功
  if (!source) {
    return { success: false, error: '未找到主资产', warnings: [], results: [] }
  }

  const batch = await importUAssetsBatchToProject(project, [source])
  const asset = batch.assets[0]
  // `from` 这一栏没有真值可填（拷贝是队列做的，源路径不回传），留空。
  // 现存调用方只读 `to`
  const results = asset?.primaryTarget
    ? [{ assetKey: asset.assetKey, from: '', to: asset.primaryTarget }]
    : []

  if (asset?.status === 'existing') {
    return {
      success: true,
      copied: 0,
      total: 0,
      warnings: ['资产已存在于目标工程，已跳过'],
      results,
      alreadyExists: true
    }
  }
  if (!batch.success) {
    return {
      success: false,
      error: asset?.error || batch.error || batch.warnings[0] || '导入失败',
      copied: batch.copied,
      total: batch.copied,
      warnings: batch.warnings,
      results
    }
  }
  return {
    success: true,
    copied: batch.copied,
    total: batch.copied,
    warnings: batch.warnings,
    results
  }
}

ipcMain.handle(
  'project:importUAssets',
  async (
    _,
    project: ProjectImportProjectRecord,
    source: { assetKey?: string; skipDependencyResolution?: boolean } | null
  ) => {
    void _
    return importSingleUAssetToProject(project, source)
  }
)

ipcMain.handle(
  'project:checkImportCompatibility',
  async (_, project: ProjectImportProjectRecord, sources: ProjectImportBatchSource[]) => {
    try {
      const engine = await resolveProjectEngineVersion(
        (await readEngineAssociationFromDisk(project)) || project.EngineAssociation || null,
        UnrealPathManagerUtil
      )
      const assets = getAssetsByKeys(
        getVaultDatabase(),
        sources.map((source) => String(source.assetKey || '')).filter(Boolean)
      )
      const blocked = assets.flatMap((asset) => {
        const check = compareAssetToResolvedProjectEngineVersion(asset.engineVersion, engine)
        return check.comparison > 0
          ? [
              {
                assetKey: asset.assetKey,
                assetName: asset.assetName,
                version: check.assetDisplayVersion
              }
            ]
          : []
      })
      return { success: true, data: { projectVersion: engine.displayVersion, blocked } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

ipcMain.handle(
  'project:importUAssetsBatch',
  async (
    event,
    project: ProjectImportProjectRecord,
    sources: ProjectImportBatchSource[],
    options?: { requestId?: string; ignoreEngineVersion?: boolean }
  ): Promise<ProjectImportBatchResult> => {
    const requestId = String(options?.requestId || '')
    const list = Array.isArray(sources) ? sources : []

    // 上千个资产、几万个文件，每一步都发一条消息只会把渲染进程淹了。
    // 节流到 100ms 一条；最后一条一定发，别把进度条停在 99%
    let lastSentAt = 0
    const result = await importUAssetsBatchToProject(project, list, {
      requestId,
      ignoreEngineVersion: options?.ignoreEngineVersion === true,
      onProgress: (progress) => {
        if (event.sender.isDestroyed()) return

        const isLast =
          progress.processed >= progress.total && progress.filesCopied >= progress.filesQueued
        const now = Date.now()
        if (!isLast && now - lastSentAt < 100) return
        lastSentAt = now

        event.sender.send('project:importUAssetsBatch:progress', { requestId, ...progress })
      }
    })

    // 逐个资产那份不过 IPC：一万个资产就是一万个对象，渲染层一个都不用 ——
    // 它要的是计数和 report，两者都是有界的。主进程内的调用方（projectTool）
    // 直接拿函数返回值，不受这里影响
    return { ...result, assets: [] }
  }
)

ipcMain.handle(
  'project:importUAssetsBatch:cancel',
  async (_, requestId: string): Promise<{ success: boolean; found: boolean }> => {
    void _
    const session = activeBatchSessions.get(String(requestId || ''))
    if (!session) return { success: true, found: false }

    // 规划循环下一轮就会退出，队列里排着的活直接丢掉；正在拷的那个文件让它写完，
    // 半个文件留在工程里比多拷一个文件麻烦得多。预取的下载同理停在当前这几个
    session.cancelled = true
    session.copyQueue.cancel()
    session.httpDownloads?.cancel()
    return { success: true, found: true }
  }
)

/**
 * 需要通过 UE 插件导入的外部文件扩展名
 * 这些文件不能直接复制到 Content 目录，需要通过 UE 的 Import API 正确导入
 * - 音频文件会导入为 Sound Wave
 * - 视频文件会导入为 File Media Source
 */
const EXTERNAL_FILE_EXTENSIONS = new Set([
  // 3D 模型
  'fbx',
  'obj',
  'glb',
  'gltf',
  // 贴图
  'png',
  'jpg',
  'jpeg',
  'tga',
  'exr',
  'hdr',
  'bmp',
  'tiff',
  // 音频 → Sound Wave
  'wav',
  'mp3',
  'ogg',
  'flac',
  // 视频 → File Media Source
  'mp4',
  'mov',
  'avi',
  'wmv',
  'mkv',
  'webm',
  // 其他
  'abc',
  'ply',
  'stl',
  'usd',
  'usda',
  'usdc',
  'usdz'
])

/**
 * 判断文件是否需要通过 UE 导入 API 导入（而非直接复制）
 */
const isExternalFile = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  return EXTERNAL_FILE_EXTENSIONS.has(ext)
}

/**
 * 注意：UE5_NAMING_CONFIG 已被用户配置系统替代
 * 现在使用 getNamingRulesConfig() 从用户配置文件中读取命名规则
 * 如果配置文件不存在或加载失败，会使用 DEFAULT_NAMING_RULES_CONFIG 作为默认值
 */

/**
 * 获取用户配置的命名规则（带缓存）
 */
let cachedNamingConfig: NamingRulesConfig | null = null
let configCacheTime = 0
const CONFIG_CACHE_TTL = 5000 // 5秒缓存

function getNamingRulesConfig(): NamingRulesConfig {
  const now = Date.now()
  if (cachedNamingConfig && now - configCacheTime < CONFIG_CACHE_TTL) {
    return cachedNamingConfig
  }
  cachedNamingConfig = loadNamingRulesConfig()
  configCacheTime = now
  return cachedNamingConfig
}

/**
 * 将字符串转换为指定命名约定格式
 */
const toNamingConvention = (str: string, convention: string): string => {
  // 移除扩展名
  const name = str.replace(/\.[^/.]+$/, '')
  // 将分隔符（空格、下划线、连字符等）替换并分割
  const words = name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())

  switch (convention) {
    case 'pascalCase':
      return words.join('')
    case 'camelCase':
      return words.length > 0
        ? words[0].charAt(0).toLowerCase() + words[0].slice(1) + words.slice(1).join('')
        : ''
    case 'snake_case':
      return words.map((w) => w.toLowerCase()).join('_')
    case 'kebab-case':
      return words.map((w) => w.toLowerCase()).join('-')
    default:
      return words.join('')
  }
}

/**
 * 懒加载 pinyin-pro 的 pinyin 函数。
 *
 * 这个包接近 1MB，只有「导入含中文名的资产」这一条路径用得上，
 * 顶层 import 会让它进入启动路径的静态依赖图，每次开机白加载一次。
 * 这里延到第一次真正需要转换时再 require，并缓存结果。
 */
type PinyinFn = (str: string, options: unknown) => unknown

let cachedPinyinFn: PinyinFn | null = null

const loadPinyinFn = (): PinyinFn => {
  if (cachedPinyinFn) return cachedPinyinFn

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('pinyin-pro') as Record<string, unknown> & {
    default?: Record<string, unknown>
  }

  // 动态查找 pinyin 函数，兼容不同的打包格式（命名导出 / default.pinyin / default 本身）
  const candidates: unknown[] = [mod.pinyin, mod.default?.pinyin, mod.default]
  const pinyinFn = candidates.find((fn): fn is PinyinFn => typeof fn === 'function')

  if (!pinyinFn) {
    console.error('[convertChineseToPinyin] pinyin-pro exports:', Object.keys(mod))
    throw new Error(`Could not find pinyin function`)
  }

  cachedPinyinFn = pinyinFn
  return pinyinFn
}

/**
 * 将中文字符转换为拼音（保留其他字符不变）
 * @example
 * convertChineseToPinyin('10月20日 (1)') => '10yue20ri (1)'
 * convertChineseToPinyin('测试资产') => 'ceshizichan'
 */
const convertChineseToPinyin = (str: string): string => {
  const hasChinese = /[\u4e00-\u9fa5]/.test(str)
  if (!hasChinese) {
    return str
  }

  console.log('[convertChineseToPinyin] 发现中文:', str)

  try {
    const pinyinFn = loadPinyinFn()

    // 将中文转换为拼音（无声调，保留非中文字符）
    const pinyinResult = pinyinFn(str, {
      toneType: 'none',
      type: 'string',
      nonZh: 'consecutive'
    })

    console.log('[convertChineseToPinyin] 转换结果:', pinyinResult)
    return typeof pinyinResult === 'string' ? pinyinResult : String(pinyinResult)
  } catch (e) {
    console.error('[convertChineseToPinyin] 转换失败:', e)
    return str
  }
}

/**
 * 清理资产名称中的非法字符
 * 仅用于最后的清理步骤，不进行拼音转换
 * @example
 * cleanupIllegalCharacters('Test-Asset_Name') => 'Test_Asset_Name'
 * cleanupIllegalCharacters('10Yue20Ri') => 'MS_10Yue20Ri'
 */
const cleanupIllegalCharacters = (str: string): string => {
  // 1. 替换连字符为下划线（UE 不支持连字符）
  let cleaned = str.replace(/-/g, '_')

  // 2. 将其他非法字符替换为下划线
  cleaned = cleaned.replace(/[^a-zA-Z0-9_]/g, '_')

  // 3. 去重连续的下划线
  cleaned = cleaned.replace(/_+/g, '_')

  // 4. 去除开头和结尾的下划线
  cleaned = cleaned.replace(/^_+|_+$/g, '')

  // 5. 如果清理后为空或以数字开头，添加 MS_ 前缀
  if (!cleaned || /^[0-9]/.test(cleaned)) {
    cleaned = 'MS_' + cleaned
  }

  return cleaned
}

/**
 * 检测贴图类型并获取适当的后缀
 */
const detectTextureSuffix = (baseName: string, config: NamingRulesConfig): string => {
  for (const patternConfig of config.textureSuffixPatterns) {
    if (!patternConfig.enabled) continue
    try {
      const regex = new RegExp(patternConfig.pattern, 'i')
      if (regex.test(baseName)) {
        return patternConfig.suffix
      }
    } catch (e) {
      console.warn('[detectTextureSuffix] 无效的正则表达式:', patternConfig.pattern, e)
    }
  }
  return '' // 无法识别的贴图类型不添加后缀
}

/**
 * 规范化资产名称
 * 格式: {Prefix}_{BaseAssetName}{Suffix}
 * 使用用户配置的命名规则
 */
const normalizeAssetName = (
  filePath: string,
  assetType: string,
  useLibraryMapping = false
): { normalizedName: string; destinationPath: string } => {
  const config = getNamingRulesConfig()
  const baseName = path.basename(filePath, path.extname(filePath))

  console.log('[normalizeAssetName] 原始文件名:', baseName)

  // 步骤1: 中文转拼音（保留其他字符）
  const withPinyin = convertChineseToPinyin(baseName)
  console.log('[normalizeAssetName] 拼音转换后:', withPinyin)

  // 步骤2: 应用命名约定（PascalCase、snake_case 等）
  const namingConvention = config.namingConvention || 'pascalCase'
  let normalizedBaseName = toNamingConvention(withPinyin, namingConvention)
  console.log('[normalizeAssetName] 命名约定转换后:', normalizedBaseName)

  // 步骤3: 如果是贴图且启用自动检测，检测并添加类型后缀
  let suffix = ''
  if (assetType === 'Texture' && config.autoDetectTextureType !== false) {
    suffix = detectTextureSuffix(baseName, config)
    // 移除原始名称中可能存在的类型标识
    if (suffix) {
      for (const patternConfig of config.textureSuffixPatterns) {
        if (!patternConfig.enabled) continue
        try {
          const regex = new RegExp(patternConfig.pattern, 'gi')
          normalizedBaseName = normalizedBaseName.replace(regex, '')
        } catch {
          // 忽略无效的正则表达式
        }
      }
    }
  }

  // 步骤4: 获取前缀（如果启用自动添加前缀）
  let prefix = ''
  if (config.autoAddPrefix !== false) {
    prefix = config.assetPrefixes[assetType] || ''
  }

  // 步骤5: 组合最终名称
  const combined = `${prefix}${normalizedBaseName}${suffix}`
  console.log('[normalizeAssetName] 组合后:', combined)

  // 步骤6: 最终清理（处理连字符、非法字符等）
  const normalizedName = cleanupIllegalCharacters(combined)
  console.log('[normalizeAssetName] 最终结果:', normalizedName)

  // 获取目标目录（根据是否使用资产库映射）
  let destinationPath: string
  if (useLibraryMapping) {
    // 资产库导入使用相对路径映射
    destinationPath = config.libraryAssetTypeToDirectory[assetType] || ''
  } else {
    // 项目导入使用绝对路径映射
    destinationPath = config.assetTypeToDirectory[assetType] || '/Game/Imported'
  }

  return { normalizedName, destinationPath }
}

/**
 * 获取文件的资产类型
 */
const getAssetType = (filePath: string): string => {
  const config = getNamingRulesConfig()
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  return config.extensionToAssetType[ext] || 'Unknown'
}

/**
 * 按资产类型对文件进行分组，并生成规范化的导入信息
 */
const categorizeAndNormalizeFiles = (
  filePaths: string[],
  useLibraryMapping = false
): Array<{
  originalPath: string
  assetType: string
  normalizedName: string
  destinationPath: string
}> => {
  return filePaths.map((filePath) => {
    const assetType = getAssetType(filePath)
    const { normalizedName, destinationPath } = normalizeAssetName(
      filePath,
      assetType,
      useLibraryMapping
    )
    return {
      originalPath: filePath,
      assetType,
      normalizedName,
      destinationPath
    }
  })
}

/**
 * 导入外部文件到 UE 项目
 * 这个处理器通过 WebSocket 调用 UE 插件的 content.import 命令
 * 让 UE 正确处理 FBX/GLB/PNG 等文件并生成对应的 .uasset
 */
export async function importExternalFilesToProject(params: {
  files: string[]
  destinationPath?: string
  overwrite?: boolean
  targetConnectionId?: string
  /** FBX 按动画导入到这个骨架（见 content.import 的 skeleton） */
  skeleton?: string
  /** FBX 导成什么（见 content.import 的 fbx_import_as） */
  fbxImportAs?: string
  /** 动画重采样帧率（见 content.import 的 anim_frame_rate） */
  animFrameRate?: number
  /** 按源文件名（含扩展名）指定资产名，盖过自动规范化的名字 —— 覆盖现有资产要靠它对上名 */
  nameOverrides?: Record<string, string>
}): Promise<{
  success: boolean
  imported?: Array<{
    name: string
    path: string
    class: string
    originalName?: string
    normalizedName?: string
  }>
  imported_count?: number
  requested_count?: number
  error?: string
  ue_not_connected?: boolean
  warnings?: string[]
  needs_plugin_confirmation?: boolean
  non_uasset_files?: string[]
}> {
  try {
    const {
      files,
      destinationPath = '/Game/Imported',
      overwrite = false,
      targetConnectionId,
      skeleton,
      fbxImportAs,
      animFrameRate,
      nameOverrides
    } = params

    // 检查 WebSocket 连接
    const wsService = serviceManager.getWebSocketService()
    if (wsService.getConnectionCount() === 0) {
      return {
        success: false,
        error: '没有连接的虚幻引擎项目。请确保虚幻引擎已启动并安装了 UnrealAgentLink 插件。',
        ue_not_connected: true
      }
    }

    // 验证文件存在
    const validFiles: string[] = []
    for (const filePath of files) {
      try {
        await fs.access(filePath)
        validFiles.push(filePath)
      } catch {
        console.warn('[project:importExternalFiles] 文件不存在或不可访问:', filePath)
      }
    }

    if (validFiles.length === 0) {
      return {
        success: false,
        error: '没有有效的文件可导入'
      }
    }

    console.log('[project:importExternalFiles] 准备导入文件:', validFiles)

    // 检查是否有非uasset资产（需要插件转换）
    const nonUassetFiles = validFiles.filter((filePath) => {
      const ext = path.extname(filePath).toLowerCase()
      return ext !== '.uasset' && ext !== '.umap'
    })

    // 如果有非uasset资产，检查是否有已连接的项目（通过 WebSocket 连接状态判断）
    if (nonUassetFiles.length > 0) {
      // 检查是否有已连接的项目（如果 WebSocket 连接数为 0，说明没有项目连接，插件未启用）
      if (wsService.getConnectionCount() === 0) {
        return {
          success: false,
          error: '插件未启用，无法自动转换为虚幻格式',
          needs_plugin_confirmation: true,
          non_uasset_files: nonUassetFiles
        }
      }
    }

    // 规范化文件并按目标目录分组
    // 判断是否为资产库导入（通过检查是否有 destinationPath 参数且不是默认值）
    // 如果 destinationPath 是默认值，说明是项目导入；否则可能是资产库导入
    // 但更准确的方式是检查调用上下文，这里先假设如果 destinationPath 不是 /Game/Imported，则可能是资产库导入
    // 实际上，资产库导入应该使用 libraryAssetTypeToDirectory，项目导入使用 assetTypeToDirectory
    // 为了区分，我们检查 destinationPath 是否包含相对路径特征（不包含 /Game/）
    // 判断是否为资产库导入：如果 destinationPath 不是以 /Game/ 开头，则使用资产库映射
    const isLibraryImport = Boolean(destinationPath && !destinationPath.startsWith('/Game/'))
    const normalizedFiles = categorizeAndNormalizeFiles(validFiles, isLibraryImport)
    console.log('[project:importExternalFiles] 规范化后的文件信息:', normalizedFiles)

    // 按目标目录分组
    const filesByDestination = new Map<
      string,
      Array<{ originalPath: string; normalizedName: string; assetType: string }>
    >()

    for (const file of normalizedFiles) {
      // 如果用户指定了目标路径，所有文件使用同一路径；否则使用规范化的目录
      const targetDir =
        destinationPath !== '/Game/Imported' ? destinationPath : file.destinationPath

      if (!filesByDestination.has(targetDir)) {
        filesByDestination.set(targetDir, [])
      }
      filesByDestination.get(targetDir)!.push({
        originalPath: file.originalPath,
        normalizedName: file.normalizedName,
        assetType: file.assetType
      })
    }

    console.log('[project:importExternalFiles] 按目录分组:', Object.fromEntries(filesByDestination))

    // 收集所有导入结果
    const allImported: Array<{
      name: string
      path: string
      class: string
      originalName?: string
      normalizedName?: string
    }> = []
    let totalImportedCount = 0
    let totalRequestedCount = 0
    const errors: string[] = []

    // 按目录批量导入
    for (const [targetDir, files] of filesByDestination) {
      console.log(`[project:importExternalFiles] 导入 ${files.length} 个文件到 ${targetDir}`)

      try {
        // 构造 normalized_names
        const normalizedNames = files.map((f) => ({
          original: path.basename(f.originalPath),
          normalized: nameOverrides?.[path.basename(f.originalPath)] || f.normalizedName
        }))

        console.log(
          '[project:importExternalFiles] normalized_names:',
          JSON.stringify(normalizedNames, null, 2)
        )

        // 调用 UE 插件的 content.import 命令
        const response = await wsService.callRequest<{
          ok: boolean
          imported_count: number
          requested_count: number
          imported: Array<{ name: string; path: string; class: string; auto_generated?: boolean }>
          error?: string
        }>(
          'content.import',
          {
            files: files.map((f) => f.originalPath),
            destination_path: targetDir,
            overwrite,
            // 传递规范化名称信息给 UE 插件（如果插件支持）
            normalized_names: normalizedNames,
            ...(skeleton ? { skeleton } : {}),
            ...(fbxImportAs ? { fbx_import_as: fbxImportAs } : {}),
            ...(animFrameRate ? { anim_frame_rate: animFrameRate } : {})
          },
          targetConnectionId,
          120000 // 导入可能需要较长时间，设置 2 分钟超时
        )

        console.log(`[project:importExternalFiles] ${targetDir} 导入响应:`, response)

        if (response && response.ok) {
          totalImportedCount += response.imported_count
          totalRequestedCount += response.requested_count

          // 添加额外的规范化信息
          for (const imported of response.imported) {
            const matchingFile = files.find(
              (f) => path.basename(f.originalPath, path.extname(f.originalPath)) === imported.name
            )
            allImported.push({
              ...imported,
              originalName: matchingFile ? path.basename(matchingFile.originalPath) : undefined,
              normalizedName: matchingFile?.normalizedName
            })
          }
        } else {
          errors.push(`${targetDir}: ${response?.error || '导入失败'}`)
        }
      } catch (err) {
        console.error(`[project:importExternalFiles] 导入到 ${targetDir} 时出错:`, err)
        errors.push(`${targetDir}: ${String(err instanceof Error ? err.message : err)}`)
      }
    }

    // 返回汇总结果
    if (allImported.length > 0) {
      return {
        success: true,
        imported: allImported,
        imported_count: totalImportedCount,
        requested_count: totalRequestedCount,
        warnings: errors.length > 0 ? errors : undefined
      }
    } else if (errors.length > 0) {
      return {
        success: false,
        error: errors.join('; ')
      }
    } else {
      return {
        success: false,
        error: '导入资产失败'
      }
    }
  } catch (error: unknown) {
    console.error('[project:importExternalFiles] 错误:', error)
    return {
      success: false,
      error: String(error instanceof Error ? error.message : error)
    }
  }
}

ipcMain.handle(
  'project:importExternalFiles',
  async (
    _,
    params: {
      files: string[]
      destinationPath?: string
      overwrite?: boolean
    }
  ) => {
    void _
    return importExternalFilesToProject(params)
  }
)

/**
 * 把资产库里的 zip 素材包解进工程的 Content 目录。
 *
 * 用户往资产库里拖 zip 时我们不问也不解 —— 他可能就是想存个包。等他真的要把它
 * 导进工程了，才是问「解压还是原样复制」的时机。
 */
ipcMain.handle(
  'project:extractArchiveToProject',
  async (_, params: { zipPath: string; projectPath: string }) => {
    void _
    return extractArchiveToProjectContent(params)
  }
)

/**
 * 规范化导入 uasset/umap 资产到 UE 项目
 * 通过 UE 插件的 content.normalized_import 命令实现
 * 自动处理依赖闭包、包名重映射和引用修复
 */
ipcMain.handle(
  'project:normalizedImportAssets',
  async (
    _,
    params: {
      files: string[]
      targetRoot?: string
      usePascalCase?: boolean
      autoRenameOnConflict?: boolean
      projectEngineVersion?: string // 用户选择的目标项目的引擎版本
    }
  ): Promise<{
    success: boolean
    totalFiles?: number
    successCount?: number
    failedCount?: number
    imported?: Array<{
      originalName: string
      normalizedName: string
      oldPath: string
      newPath: string
      assetClass: string
    }>
    redirects?: Array<{ from: string; to: string }>
    warnings?: string[]
    errors?: string[]
    error?: string
    ue_not_connected?: boolean
  }> => {
    void _

    try {
      const {
        files,
        targetRoot = '/Game/Imported',
        usePascalCase = true,
        autoRenameOnConflict = true,
        projectEngineVersion
      } = params

      // 检查 WebSocket 连接
      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return {
          success: false,
          error: '没有连接的虚幻引擎项目。请确保虚幻引擎已启动并安装了 UnrealAgentLink 插件。',
          ue_not_connected: true
        }
      }

      // 解析路径并验证文件存在
      const pathManager = PathManager.getInstance()
      const validFiles: string[] = []
      for (const filePath of files) {
        // 如果是相对路径，转换为绝对路径
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : pathManager.getAbsoluteFromVault(filePath)

        try {
          await fs.access(absolutePath)
          validFiles.push(absolutePath)
        } catch {
          console.warn('[project:normalizedImportAssets] 文件不存在或不可访问:', absolutePath)
        }
      }

      if (validFiles.length === 0) {
        return {
          success: false,
          error: '没有有效的文件可导入'
        }
      }

      // 版本兼容性检查：使用用户选择的项目版本
      // 如果没有传递项目版本，则尝试使用连接的项目版本
      let targetEngineVersion = projectEngineVersion
      if (!targetEngineVersion) {
        const connectedProjects = projectManager.getInteractiveProjects()
        if (connectedProjects.length > 0) {
          targetEngineVersion = connectedProjects[0].engineVersion
        }
      }

      // 尝试从当前活动的 vault 数据库获取资产版本信息
      if (targetEngineVersion) {
        const targetEngineVersionInfo = await resolveProjectEngineVersion(
          targetEngineVersion,
          UnrealPathManagerUtil
        )
        const db = getVaultDatabase()
        if (db) {
          for (const filePath of validFiles) {
            try {
              // 从路径推断 softPath 并查询资产信息
              const gameIndex = filePath.indexOf('/Game/')
              const gameIndexWin = filePath.indexOf('\\Game\\')
              const idx = gameIndex !== -1 ? gameIndex : gameIndexWin

              if (idx !== -1) {
                let softPath = filePath.substring(idx)
                softPath = softPath.replace(/\\/g, '/')
                softPath = softPath.replace(/\.uasset$/, '').replace(/\.umap$/, '')

                // 查询资产
                const assets = getAssetsBySoftPaths(db, [softPath])
                if (assets.length > 0) {
                  const assetEngineVersion = assets[0].engineVersion

                  if (assetEngineVersion) {
                    const comparison = compareVersions(
                      assetEngineVersion,
                      targetEngineVersionInfo.comparableVersion
                    )
                    if (comparison > 0) {
                      // 资产版本高于项目版本，阻止导入
                      const assetName = path.basename(filePath, path.extname(filePath))
                      const assetVerDisplay = formatVersionForDisplay(assetEngineVersion)
                      const projectVerDisplay = targetEngineVersionInfo.displayVersion
                      return {
                        success: false,
                        error: `资产 "${assetName}" 的引擎版本 (UE ${assetVerDisplay}) 高于目标项目版本 (UE ${projectVerDisplay})，无法导入。`,
                        warnings: [
                          `资产版本: UE ${assetVerDisplay}`,
                          `项目版本: UE ${projectVerDisplay}`,
                          '请使用相同或更高版本的虚幻引擎项目来导入此资产。'
                        ]
                      }
                    }
                  }
                }
              }
            } catch (versionError) {
              console.warn('[project:normalizedImportAssets] 版本检查失败:', versionError)
              // 版本检查失败不阻止导入，只记录警告
            }
          }
        }
      }

      console.log('[project:normalizedImportAssets] 准备规范化导入文件:', validFiles)
      console.log('[project:normalizedImportAssets] 目标根目录:', targetRoot)

      // 调用 UE 插件的 content.normalized_import 命令
      const response = await wsService.callRequest<{
        ok: boolean
        total_files: number
        success_count: number
        failed_count: number
        imported: Array<{
          original_name: string
          normalized_name: string
          old_path: string
          new_path: string
          class: string
        }>
        redirects: Array<{ from: string; to: string }>
        errors?: string[]
        warnings?: string[]
        error?: string
      }>(
        'content.normalized_import',
        {
          files: validFiles,
          target_root: targetRoot,
          use_pascal_case: usePascalCase,
          auto_rename_on_conflict: autoRenameOnConflict
        },
        undefined,
        180000 // 规范化导入可能需要较长时间，设置 3 分钟超时
      )

      console.log('[project:normalizedImportAssets] UE 响应:', response)

      if (response && response.ok) {
        return {
          success: true,
          totalFiles: response.total_files,
          successCount: response.success_count,
          failedCount: response.failed_count,
          imported: response.imported.map((item) => ({
            originalName: item.original_name,
            normalizedName: item.normalized_name,
            oldPath: item.old_path,
            newPath: item.new_path,
            assetClass: item.class
          })),
          redirects: response.redirects,
          warnings: response.warnings,
          errors: response.errors
        }
      } else {
        return {
          success: false,
          error: response?.error || '规范化导入失败',
          errors: response?.errors,
          warnings: response?.warnings
        }
      }
    } catch (error: unknown) {
      console.error('[project:normalizedImportAssets] 错误:', error)
      return {
        success: false,
        error: String(error instanceof Error ? error.message : error)
      }
    }
  }
)

export { isExternalFile, EXTERNAL_FILE_EXTENSIONS }
