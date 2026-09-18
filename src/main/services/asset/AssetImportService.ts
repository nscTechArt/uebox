import { join, isAbsolute, basename } from 'path'
import { promises as fsPromises, existsSync, mkdirSync, statSync } from 'fs'
import { createHash } from 'crypto'

import { getDatabaseManager, getPublicDatabase, getVaultDatabase } from '../../sqliteDataBase'
import { transaction } from '../../sqliteDataBase/dbUtils'
import {
  createAssetData,
  AssetData,
  initAssetDataModel,
  getAssetDataByKey,
  updateAssetData
} from '../../sqliteDataBase/models/assetData'
import {
  createAssetFolder,
  findOrCreateAssetFolder,
  getAssetFolderByKey
} from '../../sqliteDataBase/models/assetFolder'
import { FileProcessorManager } from '../../utils/fileProcessor/FileProcessorManager'
import { UnrealAssetProcessor } from '../../utils/fileProcessor/UnrealAssetProcessor'
import { AssetBackupManager, type BackupAssetInfo } from '../../utils/assetBackup'
import {
  buildImportThumbnail,
  prefetchFolderTypes,
  readUpluginInfo
} from '../../sqliteDataBase/ipc/assetData/importAssetMedia'
import {
  createImportTask,
  updateImportTask,
  getImportTaskByTaskId
} from '../../sqliteDataBase/models/importTask'
import { ALL_FOLDER } from '../../init/constants'
import { loadNamingRulesConfig } from '../../utils/namingRulesConfig'
import { ImportPerformanceCollector, classifyError } from '../../utils/ImportPerformanceCollector'

import { autoTagAsset, autoTagPluginVersion } from './autoTagService'
import { getAssetClassNameCn, getAssetClassColor } from '../../utils/assetClassUtils'
import { PathManager } from '../../utils/PathManager'
import { AssetDependencyResolver, type AssetDependencyInfo } from '../../utils/assetDependency'
import { getAssetNameFromFileName } from '../../utils/assetName'
import {
  PreloadedMetadataIndex,
  packageFolderRelativePath
} from '../../utils/preloadedMetadataIndex'
import { calculateFastFileHash } from '../../sqliteDataBase/ipc/assetData/fileUtils'
import { findIdenticalLocalAssets } from '../../sqliteDataBase/ipc/assetData/importDedup'
import { deriveFallbackSoftPath, deriveSoftPathFromDiskPath } from './backupSoftPath'

/**
 * 生成安全的 assetKey，防止文件名过长导致 Windows MAX_PATH 错误
 * Windows 路径限制为 260 字符，缩略图路径格式为：
 * C:\Users\xxx\AppData\Roaming\unreal-box\database\vaults\vault_xxx\thumbnails\thumbnail-{assetKey}.png
 * 为确保安全，assetKey 限制在 50 字符以内
 * @param fileName 原始文件名
 * @returns 安全的 assetKey
 */
function generateSafeAssetKey(fileName: string): string {
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).substr(2, 9)

  // 移除扩展名，获取纯文件名
  const nameWithoutExt = getAssetNameFromFileName(fileName)

  // 如果文件名较短（<=30字符），直接使用
  if (nameWithoutExt.length <= 30) {
    return `${nameWithoutExt}_${timestamp}_${randomSuffix}`
  }

  // 文件名过长时，使用前15字符 + MD5哈希前8位 + 时间戳 + 随机后缀
  // 这确保了：1. 可读性（保留部分原始名称）2. 唯一性（哈希+时间戳+随机）3. 安全长度
  const prefix = nameWithoutExt.substring(0, 15).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')
  const hash = createHash('md5').update(nameWithoutExt).digest('hex').substring(0, 8)
  return `${prefix}_${hash}_${timestamp}_${randomSuffix}`
}

/**
 * 写入队列，保证事务串行执行
 */
export class WriterQueue {
  private chain: Promise<unknown> = Promise.resolve()
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task)
    this.chain = next.catch(() => {})
    return next
  }
}

// 全局单例写队列
const globalWriterQueue = new WriterQueue()

/**
 * 为Promise添加超时保护
 * @param promise 原始Promise
 * @param ms 超时毫秒数
 * @param errorMessage 超时错误信息
 * @returns 带超时保护的Promise
 */
function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage || `操作超时 ${ms}ms`)), ms)
    )
  ])
}

// 解析超时配置（10秒）
const PARSE_TIMEOUT_MS = 10000

export interface ImportOptions {
  rootFolderPath: string
  targetFolderKey?: string
  folderContents: any[]
  onProgress?: (progress: { total: number; done: number; percent: number }) => void
  onStageChange?: (stage: string) => void
  onPaused?: (progress: { total: number; done: number; percent: number }) => void
  // 新增：从虚幻引擎预获取的资产元数据，可以跳过 uasset 二进制解析
  preloadedMetadata?: Array<{
    name: string
    package: string
    class: string
    dependencies: string[]
    size?: number
    thumbnail_path?: string // 虚幻引擎临时目录中的缩略图文件路径
    is_selected?: boolean // true=用户选中的主资产，false=依赖资产
  }>
  // 新增：package 路径到 folderKey 的映射，用于根据 UE 资产路径确定目标文件夹
  packageToFolderKey?: Map<string, string>
  // 新增：引擎版本号（来自 UE 插件报告，如 "5.3.2-29314046+++UE5+Release-5.3"）
  engineVersion?: string
}

export class AssetImportService {
  /**
   * 重新导入资产（修复资产数据）
   * @param assetKey 资产Key
   */
  async reimportAsset(assetKey: string): Promise<boolean> {
    console.log(`[AssetImportService] Reimporting asset: ${assetKey}`)

    let db: any
    try {
      db = getVaultDatabase()
    } catch (e) {
      console.warn('[AssetImportService] getVaultDatabase failed, trying via manager:', e)
      const manager = getDatabaseManager()
      db = manager.getVaultDatabase()
    }

    if (!db) {
      throw new Error('[AssetImportService] Failed to get vault database instance')
    }

    console.log('[AssetImportService] db check:', {
      isObject: typeof db === 'object',
      hasPrepare: typeof db.prepare === 'function',
      constructor: db.constructor?.name,
      keys: Object.keys(db || {})
    })

    if (typeof db.prepare !== 'function') {
      console.error('[AssetImportService] CRITICAL ERROR: db.prepare is not a function!', db)
      // 尝试最后一种挽救措施：直接从 VaultManager 获取（虽然通常不需要）
      try {
        const manager = getDatabaseManager()
        const vaultManager = manager.getVaultManager()
        const rawDb = vaultManager.getCurrentVaultDatabase()
        if (rawDb && typeof rawDb.prepare === 'function') {
          console.log('[AssetImportService] Recovered db from VaultManager directly')
          db = rawDb
        } else {
          throw new Error('db.prepare is missing even after direct retrieval')
        }
      } catch (retryError) {
        throw new Error(
          `Database connection invalid: db.prepare is not a function. db type: ${typeof db}`
        )
      }
    }

    const asset = getAssetDataByKey(db, assetKey)
    if (!asset || !asset.filePath) {
      throw new Error(`Asset not found or missing file path: ${assetKey}`)
    }

    // 路径补全：如果 filePath 是相对路径，将其转换为绝对路径
    // 很多老数据或者备份模式下的数据存储的是相对路径（如 ../../xxx）
    let targetFilePath = asset.filePath
    if (!isAbsolute(targetFilePath)) {
      try {
        const pm = PathManager.getInstance()
        targetFilePath = pm.getAbsoluteFromVault(asset.filePath)
        console.log(
          `[AssetImportService] Resolved relative path: ${asset.filePath} -> ${targetFilePath}`
        )
      } catch (e) {
        console.warn(
          '[AssetImportService] Failed to resolve path via PathManager, trying fallback:',
          e
        )
        // Fallback: 尝试直接拼接当前保管库路径
        try {
          const currentVault = getDatabaseManager().getCurrentVault()
          if (currentVault?.path) {
            targetFilePath = join(currentVault.path, asset.filePath)
          }
        } catch (e2) {
          console.warn('[AssetImportService] Fallback resolution failed:', e2)
        }
      }
    }

    if (!existsSync(targetFilePath)) {
      // 文件不存在，无法修复
      throw new Error(`File not found: ${targetFilePath} (origin: ${asset.filePath})`)
    }

    try {
      // 使用 UnrealAssetProcessor 重新解析文件
      const processor = new UnrealAssetProcessor()
      const fileMetadata = await processor.processFile(targetFilePath)

      // 更新数据库中的资产数据
      // 注意：这里我们只更新 metadata 中的信息，保留原有的 id, assetKey, folderKey 等
      if (fileMetadata.metadata) {
        const updateData: Partial<AssetData> = {
          // 更新核心字段
          classKey: fileMetadata.metadata.classKey,
          name: fileMetadata.metadata.name,
          ext: fileMetadata.metadata.ext,
          softPath: fileMetadata.metadata.softPath,
          assetClass: fileMetadata.metadata.assetClass,
          className: fileMetadata.metadata.className,
          // 修复：手动计算中文类名和颜色，因为 UnrealAssetProcessor 可能不返回这些 UI 字段
          classNameCn:
            fileMetadata.metadata.classNameCn ||
            getAssetClassNameCn(fileMetadata.metadata.className),
          classColor:
            fileMetadata.metadata.classColor || getAssetClassColor(fileMetadata.metadata.className),
          // 重点：更新 imports，确保是 JSON 字符串
          imports: Array.isArray(fileMetadata.metadata.imports)
            ? JSON.stringify(fileMetadata.metadata.imports)
            : fileMetadata.metadata.imports,
          size: fileMetadata.fileSize,
          // 如果有新计算的 MD5
          fileMd5: fileMetadata.metadata.fileMd5 || asset.fileMd5
        }

        // 如果重新解析生成了新的缩略图，且原资产没有缩略图，则更新
        if (fileMetadata.metadata.imgLocalPath && !asset.imgLocalPath) {
          updateData.imgLocalPath = fileMetadata.metadata.imgLocalPath
        }

        updateAssetData(db, assetKey, updateData)
        return true
      }
      return false
    } catch (error) {
      console.error(`Reimport asset failed: ${assetKey}`, error)
      throw error
    }
  }

  /**
   * 递归重新导入文件夹下的所有资产
   * @param folderKey 文件夹Key
   */
  async reimportFolder(
    folderKey: string
  ): Promise<{ total: number; success: number; failed: number }> {
    // 获取数据库连接，使用与 reimportAsset 相同的稳健逻辑
    let db: any
    try {
      db = getVaultDatabase()
    } catch (e) {
      const manager = getDatabaseManager()
      db = manager.getVaultDatabase()
    }

    if (!db || typeof db.prepare !== 'function') {
      throw new Error(
        `[AssetImportService] Invalid database connection in reimportFolder. db.prepare type: ${typeof db?.prepare}`
      )
    }

    let total = 0
    let success = 0
    let failed = 0

    // 1. 获取当前文件夹下的所有资产
    const assets = db
      .prepare(`SELECT assetKey FROM assetData WHERE folderKey = ? AND isDelete = 0`)
      .all(folderKey) as { assetKey: string }[]

    for (const asset of assets) {
      total++
      try {
        await this.reimportAsset(asset.assetKey)
        success++
      } catch (e) {
        console.error(`Failed to reimport asset ${asset.assetKey} in folder ${folderKey}`, e)
        failed++
      }
    }

    // 2. 获取所有子文件夹
    const subFolders = db
      .prepare(`SELECT folderKey FROM assetFolder WHERE fatherKey = ? AND isDelete = 0`)
      .all(folderKey) as { folderKey: string }[]

    for (const subFolder of subFolders) {
      const result = await this.reimportFolder(subFolder.folderKey)
      total += result.total
      success += result.success
      failed += result.failed
    }

    return { total, success, failed }
  }

  /**
   * 快速计算文件哈希 - 只读取文件的开头、中间、结尾部分和文件大小
   * 对于大文件可以实现秒级计算
   * @param filePath 文件路径
   * @returns 哈希值（小写字符串）
   */
  private async calculateFileMd5(filePath: string): Promise<string> {
    // 这里原来有一份和 fileUtils.calculateFastFileHash 一模一样的实现，
    // 两份都踩着「三段并发读、谁先读完谁先喂哈希」那个坑。合成一份，
    // 顺序问题只要修一次，将来也不会再分叉。
    return calculateFastFileHash(filePath)
  }

  /**
   * 导入文件夹结构及元数据
   */
  async importFolderStructureWithMetadata(options: ImportOptions) {
    const {
      rootFolderPath,
      targetFolderKey: initialTargetFolderKey,
      folderContents,
      onProgress,
      onStageChange,
      onPaused,
      preloadedMetadata, // 新增：从虚幻引擎预获取的元数据
      packageToFolderKey, // 新增：package 路径到文件夹的映射
      engineVersion: optionEngineVersion // 新增：引擎版本号
    } = options
    let targetFolderKey = initialTargetFolderKey
    /**
     * 这个函数原来从头到尾没有一次 close —— UE 插件每导入一次就漏一个句柄。
     * 泄漏的句柄让 WAL 一直长，Windows 上还会压住库文件，导致删库/移库 EBUSY。
     * 声明在 try 外面，才能在 finally 里无条件关掉。
     */
    let importDb: { close?: () => void } | null = null

    try {
      const databaseManager = getDatabaseManager()
      const vaultInfo = databaseManager.getVaultManager().getCurrentVault()
      if (!vaultInfo) {
        throw new Error('当前保管库不存在')
      }
      const vaultDbPath = join(vaultInfo.path, 'vault-data.db')
      const Database = require('better-sqlite3')
      const db = new Database(vaultDbPath)
      importDb = db
      try {
        db.pragma('journal_mode = WAL')
        db.pragma('busy_timeout = 5000')
      } catch {}

      // 确保数据库表结构是最新的（包含所有新增字段）
      initAssetDataModel(db)

      const fileProcessor = new FileProcessorManager()
      // 🚫 分类功能已禁用，但保留命名规则配置以便将来可能重新启用
      const _namingRules = loadNamingRulesConfig()
      void _namingRules // 防止 lint 警告
      console.log('📜 [AssetImportService] 已加载命名规则配置（分类功能已禁用）')

      // 🎯 初始化性能采集器
      const perfCollector = new ImportPerformanceCollector(rootFolderPath)

      // 获取当前保管库信息，判断是备份模式还是引用模式
      // 局域网协作库也需要复制文件到网络路径（Binary Transfer）
      const currentVault = databaseManager.getCurrentVault()
      const isBackupMode =
        currentVault?.vaultType === 'backup' || currentVault?.vaultType === 'network'

      console.log('🚀 [AssetImportService] 开始导入文件夹结构')
      console.log('🚀 [AssetImportService] 根文件夹路径:', rootFolderPath)
      console.log('🚀 [AssetImportService] 目标文件夹:', targetFolderKey)
      console.log('🚀 [AssetImportService] 文件夹内容数量:', folderContents.length)
      console.log('🚀 [AssetImportService] 预加载元数据数量:', preloadedMetadata?.length || 0)
      console.log(
        `🚀 [AssetImportService] 当前保管库: ${currentVault?.name}, vaultType=${currentVault?.vaultType}, isBackupMode=${isBackupMode}`
      )

      // 先处理所有 .uasset 和 .umap 文件的元数据
      const processedMetadata = new Map<string, any>()

      // 🚀 如果有预加载元数据，先建立「磁盘路径 -> 元数据」的索引
      type PreloadedMeta = {
        name: string
        package: string
        class: string
        dependencies: string[]
        size?: number
        thumbnail_path?: string // 虚幻引擎临时目录中的缩略图文件路径
        is_selected?: boolean // true=用户选中的主资产，false=依赖资产
      }
      // 按路径配对的索引：同名不同目录的资产不会互相串，见 preloadedMetadataIndex.ts 的注释
      const preloadedMetadataIndex = new PreloadedMetadataIndex<PreloadedMeta>(
        preloadedMetadata ?? []
      )

      // packageToFolderKey 的键是插件送来的原始大小写；软路径也可能来自本地二进制解析，
      // 两边大小写未必一致 —— 先精确查一次，再退回小写查一次
      const folderKeyByLowerRelativePath = new Map<string, string>()
      if (packageToFolderKey) {
        for (const [relativePath, key] of packageToFolderKey.entries()) {
          folderKeyByLowerRelativePath.set(relativePath.toLowerCase(), key)
        }
      }
      const resolveFolderKeyByRelativePath = (relativePath: string): string =>
        packageToFolderKey?.get(relativePath) ??
        folderKeyByLowerRelativePath.get(relativePath.toLowerCase()) ??
        ''
      if (preloadedMetadata && preloadedMetadata.length > 0) {
        console.log('✨ [AssetImportService] 使用虚幻引擎预获取的元数据，跳过二进制解析')
        let thumbnailCount = 0
        for (const meta of preloadedMetadata) {
          if (meta.thumbnail_path && meta.thumbnail_path.length > 0) {
            thumbnailCount++
            console.log(
              `🖼️ [AssetImportService] 收到缩略图路径: ${meta.name} -> ${meta.thumbnail_path}`
            )
          }
        }
        console.log(
          `📊 [AssetImportService] 总共 ${preloadedMetadata.length} 个资产, 其中 ${thumbnailCount} 个包含缩略图`
        )
      }

      // 分离文件夹和文件（保持原有排序逻辑）
      const sortedContents = folderContents.sort((a, b) => {
        const depthA = a.depth || 0
        const depthB = b.depth || 0
        if (depthA !== depthB) return depthA - depthB
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      const files = sortedContents.filter((item) => item.type === 'file')
      console.log('📁 [AssetImportService] 文件数量:', files.length)

      const totalFilesForProgress = files.length
      let handledFilesForProgress = 0

      // 进度权重配置
      const PREPROCESS_WEIGHT = 70
      const WRITING_WEIGHT = 30
      let lastProgressTime = 0
      const PROGRESS_INTERVAL = 200 // 200ms 发送一次进度

      /**
       * 发送加权进度
       * @param current 当前阶段处理数量
       * @param total 总数量
       * @param basePercent 基础百分比（预处理为0，写入为70）
       * @param weight 当前阶段权重（预处理为70，写入为30）
       * @param stage 当前阶段名称
       * @param force 是否强制发送
       */
      const sendWeightedProgress = (
        current: number,
        total: number,
        basePercent: number,
        weight: number,
        stage: string,
        force = false
      ) => {
        const now = Date.now()
        if (!force && now - lastProgressTime < PROGRESS_INTERVAL && current < total) {
          return
        }
        lastProgressTime = now

        const currentStagePercent = total > 0 ? current / total : 0
        const globalPercent = Math.min(100, Math.round(basePercent + currentStagePercent * weight))

        try {
          if (onProgress) {
            onProgress({
              total: total,
              done: current,
              percent: globalPercent
            })
          }

          // 更新数据库任务状态
          // 注意：这里可能会频繁更新数据库，可以考虑进一步节流或只更新内存状态
          // 为避免性能问题，我们只在进度变化较大时更新数据库，或者复用上面的节流逻辑
          // 但考虑到 updateImportTask 可能涉及磁盘IO，我们尽量减少调用
          // 这里暂时复用发送前端进度的频率
          updateImportTask(publicDb, taskId, {
            percent: globalPercent,
            doneItems: current,
            totalItems: total,
            stage: stage
          })
        } catch (e) {
          console.warn('发送进度失败:', e)
        }
      }

      const publicDb = getPublicDatabase()
      const taskId = rootFolderPath
      const vaultId = currentVault?.id || ''

      createImportTask(publicDb, {
        taskId,
        vaultId,
        rootPath: rootFolderPath,
        targetFolderKey: targetFolderKey || null,
        status: 'parsing',
        stage: 'parsing',
        percent: 0,
        totalItems: totalFilesForProgress,
        doneItems: 0,
        pauseRequested: 0,
        resumeCursor: 0
      })

      // 定义 shouldPause 函数，检查任务是否被请求暂停
      // 🚀 优化：使用节流策略，每 10 个文件才检查一次数据库，减少 I/O 开销
      let pauseCheckCounter = 0
      let cachedPauseState = false
      const PAUSE_CHECK_INTERVAL = 10 // 每处理 10 个文件检查一次暂停状态

      const shouldPause = (): boolean => {
        pauseCheckCounter++
        if (pauseCheckCounter >= PAUSE_CHECK_INTERVAL) {
          pauseCheckCounter = 0
          const task = getImportTaskByTaskId(publicDb, taskId)
          cachedPauseState = task?.pauseRequested === 1
        }
        return cachedPauseState
      }

      updateImportTask(publicDb, taskId, { status: 'preprocessing', stage: 'preprocessing' })
      if (onStageChange) onStageChange('preprocessing')

      // 🎯 开始预处理阶段计时
      perfCollector.startPhase('assetParsing')

      // 🚀 性能优化：统计需要解析的 uasset/umap 文件数量
      const uassetFiles = files.filter((f) => {
        const ext = f.name.split('.').pop()?.toLowerCase() || ''
        return ext === 'uasset' || ext === 'umap'
      })
      const totalUassets = uassetFiles.length
      let processedUassets = 0 // 仅用于日志
      let processedPreprocessCount = 0 // 用于进度条
      console.log(`📊 [AssetImportService] 需要解析的 uasset/umap 文件: ${totalUassets} 个`)

      // 🕐 大文件延迟解析队列：先快速导入，后台慢慢解析
      const pendingLargeFiles: Array<{ path: string; name: string; size: number }> = []

      // 🔄 失败资产延后重试队列：批量导入时可能因文件系统竞争导致 invalid uasset 错误
      // 将这些失败的文件收集起来，在主循环结束后进行延后重试，最多重试 3 次
      const MAX_RETRY_ATTEMPTS = 3
      const RETRY_DELAY_MS = 200 // 每次重试之间的延迟
      const pendingRetryFiles: Array<{
        file: (typeof files)[0]
        fileExtension: string
        nameWithoutExt: string
        fileSize: number
        retryCount: number
        lastError: string
      }> = []

      // 预处理所有 .uasset 和 .umap 文件的元数据
      for (const file of files) {
        if (shouldPause()) {
          updateImportTask(publicDb, taskId, { status: 'paused', stage: 'preprocessing' })

          if (onPaused) {
            // 计算当前进度用于暂停状态
            const currentStagePercent =
              totalFilesForProgress > 0 ? processedPreprocessCount / totalFilesForProgress : 0
            const globalPercent = Math.round(0 + currentStagePercent * PREPROCESS_WEIGHT)

            onPaused({
              total: totalFilesForProgress,
              done: processedPreprocessCount,
              percent: globalPercent
            })
          }
          return { success: true, data: JSON.stringify({ paused: true }) } as any
        }

        const fileExtension = file.name.split('.').pop()?.toLowerCase() || ''
        if (fileExtension === 'uasset' || fileExtension === 'umap') {
          const nameWithoutExt = getAssetNameFromFileName(file.name)

          // 🚀 检查是否有预加载的元数据
          // ⚠️ 按**路径**配对，不按资产名 —— UE 允许同名资产分处不同目录
          //    （M1_Clothing/M_yifu_Inst 和 M1_Clothing2/M_yifu_Inst），按名字配会让后者
          //    领到前者的软路径。配不上就走下面的二进制解析，自己从 uasset 里读，宁慢不错。
          let foundPreloaded = false
          {
            const meta = preloadedMetadataIndex.match(file.path)
            if (meta) {
              const packagePath = meta.package
              // 🖼️ 处理缩略图：从 UE 临时目录复制到保管库
              let imgLocalPath: string | undefined = undefined
              if (meta.thumbnail_path && vaultInfo) {
                try {
                  // 🔧 检查源文件是否存在（插件可能发送了相对路径或路径已失效）
                  const thumbSourcePath = meta.thumbnail_path
                  if (!existsSync(thumbSourcePath)) {
                    console.warn(
                      `🖼️ [AssetImportService] 缩略图源文件不存在，跳过: ${thumbSourcePath} (资产: ${meta.name})`
                    )
                  } else {
                    // 创建缩略图目录
                    const thumbnailsDir = join(vaultInfo.path, 'thumbnails')
                    if (!existsSync(thumbnailsDir)) {
                      mkdirSync(thumbnailsDir, { recursive: true })
                    }

                    // 🔧 使用安全的 ASCII 文件名，避免中文字符导致路径问题
                    const safeId = `${Date.now()}_${Math.random().toString(36).substr(2, 8)}`
                    const thumbnailFileName = `thumb_${safeId}.png`
                    const thumbnailAbsPath = join(thumbnailsDir, thumbnailFileName)

                    // 复制临时文件到目标位置
                    await fsPromises.copyFile(thumbSourcePath, thumbnailAbsPath)

                    // 🌐 网络库：同时复制缩略图到网络 .thumbnails 目录
                    let networkCopySuccess = false
                    if (
                      currentVault?.vaultType === 'network' &&
                      currentVault.networkPath &&
                      !currentVault.networkPath.startsWith('http')
                    ) {
                      try {
                        const networkThumbDir = join(currentVault.networkPath, '.thumbnails')
                        if (!existsSync(networkThumbDir)) {
                          mkdirSync(networkThumbDir, { recursive: true })
                        }
                        const networkThumbPath = join(networkThumbDir, thumbnailFileName)
                        await fsPromises.copyFile(thumbSourcePath, networkThumbPath)
                        console.log(
                          `🖼️ [AssetImportService] 缩略图已复制到网络库: ${networkThumbPath}`
                        )
                        networkCopySuccess = true
                      } catch (networkCopyError) {
                        console.warn(
                          `🖼️ [AssetImportService] 无法复制缩略图到网络库，保留本地副本: ${thumbnailFileName}`,
                          networkCopyError
                        )
                      }

                      // 🔧 仅在网络复制成功时删除本地副本
                      if (networkCopySuccess) {
                        try {
                          await fsPromises.unlink(thumbnailAbsPath)
                        } catch {
                          // 忽略删除失败
                        }
                      }
                    }

                    // 尝试删除 UE 临时文件
                    try {
                      await fsPromises.unlink(thumbSourcePath)
                    } catch {
                      // 忽略删除失败（可能被 UE 占用）
                    }

                    // 🔧 存储文件名（前端会自动拼接 thumbnails 目录）
                    imgLocalPath = thumbnailFileName
                    console.log(
                      `🖼️ [AssetImportService] 缩略图已保存: ${thumbnailFileName} (资产: ${meta.name})`
                    )
                  }
                } catch (thumbError) {
                  console.warn(
                    `🖼️ [AssetImportService] 保存缩略图失败 ${meta.name} (路径: ${meta.thumbnail_path}):`,
                    thumbError
                  )
                }
              }

              // 🖼️ 回退：如果 UE 端未提供缩略图，尝试从 .uasset 二进制文件中提取嵌入式缩略图
              // 拖拽导入能正常显示缩略图，就是因为走了二进制解析路径提取了嵌入式缩略图
              if (!imgLocalPath && fileExtension === 'uasset') {
                try {
                  const fallbackMetadata = await withTimeout(
                    fileProcessor.processFile(file.path),
                    PARSE_TIMEOUT_MS,
                    `缩略图回退解析超时 ${file.name}`
                  )
                  if (fallbackMetadata?.metadata?.imgLocalPath) {
                    imgLocalPath = fallbackMetadata.metadata.imgLocalPath
                    console.log(
                      `🖼️ [AssetImportService] 从 .uasset 嵌入式缩略图回退提取成功: ${meta.name} -> ${imgLocalPath}`
                    )
                  }
                } catch (fallbackError) {
                  console.warn(
                    `🖼️ [AssetImportService] 缩略图回退解析失败 ${meta.name}:`,
                    fallbackError
                  )
                }
              }

              // 构建与 fileProcessor.processFile 兼容的元数据格式
              // 使用 is_selected 字段判断是否为用户选中的主资产
              // is_selected = true 表示用户选中的主资产，is_selected = false 表示依赖资产
              const isMainAsset = meta.is_selected !== false // 默认为 true（兼容旧版本）
              const syntheticMetadata = {
                processorType: 'UnrealAsset',
                assetType: 'UnrealAsset',
                engineVersion: optionEngineVersion, // 🔧 使用从 payload 传入的引擎版本
                isMainAsset: isMainAsset,
                metadata: {
                  classKey: meta.class.toLowerCase(),
                  name: meta.name,
                  originPath: file.path,
                  ext: fileExtension,
                  folderName: packagePath.split('/').slice(0, -1).join('/'),
                  softPath: packagePath,
                  assetClass: meta.class,
                  className: meta.class,
                  imports: meta.dependencies,
                  imgLocalPath: imgLocalPath, // 🖼️ 设置缩略图路径
                  size: meta.size || file.size,
                  assetConfig: undefined,
                  assetConfigPath: undefined
                }
              }
              processedMetadata.set(file.path, syntheticMetadata)
              foundPreloaded = true
              console.log(
                `✅ [AssetImportService] 使用预加载元数据: ${meta.name} (${meta.class}) <- ${packagePath}`
              )
            }
          }

          // 如果没有预加载元数据，则回退到二进制解析
          if (!foundPreloaded) {
            const fileSize = file.size || 0

            // 🛡️ 边界保护：超大文件警告
            if (fileSize > 500 * 1024 * 1024) {
              console.warn(
                `⚠️ [AssetImportService] 超大文件预警: ${file.name} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`
              )
            }

            // 🛡️ 分级超时策略（根据文件大小动态调整）
            const getTimeoutMs = (size: number): number => {
              if (size > 500 * 1024 * 1024) return 120000 // >500MB: 120秒
              if (size > 100 * 1024 * 1024) return 60000 // >100MB: 60秒
              if (size > 50 * 1024 * 1024) return 30000 // >50MB: 30秒
              return PARSE_TIMEOUT_MS // 默认 10秒
            }
            const timeout = getTimeoutMs(fileSize)

            try {
              // 🛡️ 添加超时保护，避免单文件卡死整个进程
              const parseStartTime = Date.now()
              const fileMetadata = await withTimeout(
                fileProcessor.processFile(file.path),
                timeout,
                `解析超时 ${file.name} (${timeout / 1000}秒)`
              )
              const parseDuration = Date.now() - parseStartTime

              // 🎯 记录解析耗时
              perfCollector.recordParseTime(parseDuration)
              if (parseDuration > 1000) {
                perfCollector.recordSlowFile({
                  filePath: file.path,
                  fileSize: fileSize,
                  duration: parseDuration,
                  assetType: fileExtension
                })
              }

              if (fileMetadata && fileMetadata.metadata) {
                processedMetadata.set(file.path, fileMetadata)
              }
            } catch (error) {
              // 🛡️ 增强错误恢复：记录详细错误但不阻塞导入
              const errMsg = error instanceof Error ? error.message : String(error)

              // 🔄 检查是否为可重试的 invalid uasset 错误（可能是文件系统竞争导致）
              const isRetryableError =
                errMsg.includes('invalid uasset') ||
                errMsg.includes('Read incomplete') ||
                errMsg.includes('file too small')

              if (isRetryableError) {
                // 将文件加入延后重试队列，稍后重试
                console.log(
                  `🔄 [AssetImportService] 将文件加入延后重试队列: ${file.name} (${errMsg.substring(0, 50)})`
                )
                pendingRetryFiles.push({
                  file,
                  fileExtension,
                  nameWithoutExt,
                  fileSize,
                  retryCount: 0,
                  lastError: errMsg.substring(0, 200)
                })
              } else {
                // 非可重试错误：记录并创建基础元数据
                console.warn(
                  `⚠️ [AssetImportService] 预处理虚幻资产失败 ${file.name}: ${errMsg.substring(0, 100)}`
                )

                // 🎯 记录错误到性能采集器
                perfCollector.recordError({
                  filePath: file.path,
                  fileName: file.name,
                  fileSize: fileSize,
                  errorCategory: classifyError(errMsg),
                  errorMessage: errMsg.substring(0, 200),
                  duration: 0
                })

                // 创建基础元数据，确保文件仍能被导入
                processedMetadata.set(file.path, {
                  processorType: 'UnrealAsset',
                  assetType: 'UnrealAsset',
                  metadata: {
                    name: nameWithoutExt,
                    originPath: file.path,
                    ext: fileExtension,
                    size: fileSize,
                    parseError: errMsg.substring(0, 200)
                  }
                })
              }
            }
          }
          // 📊 更新解析进度
          processedUassets++
          if (
            totalUassets > 0 &&
            (processedUassets % 500 === 0 || processedUassets === totalUassets)
          ) {
            const percent = Math.round((processedUassets / totalUassets) * 100)
            console.log(
              `📊 [AssetImportService] 预处理进度: ${processedUassets}/${totalUassets} (${percent}%)`
            )
          }
        }

        // 🚀 更新预处理总进度（包括跳过的非uasset文件）
        processedPreprocessCount++
        sendWeightedProgress(
          processedPreprocessCount,
          totalFilesForProgress,
          0,
          PREPROCESS_WEIGHT,
          'preprocessing'
        )

        // 🛡️ OOM修复: 预处理分批 GC
        // 每 2000 文件让出事件循环并尝试 GC，降低内存峰值
        if (processedPreprocessCount % 2000 === 0 && processedPreprocessCount > 0) {
          console.log(
            `🛡️ [AssetImportService] 预处理批次 ${processedPreprocessCount / 2000} 完成，触发 GC`
          )
          await new Promise((r) => setImmediate(r))
          ;(global as any).gc?.()
        }
      }

      // 🔄 延后重试阶段：处理批量导入时因文件系统竞争而失败的文件
      if (pendingRetryFiles.length > 0) {
        console.log(
          `🔄 [AssetImportService] 开始延后重试阶段，共 ${pendingRetryFiles.length} 个文件需要重试`
        )

        let retryRound = 0
        while (pendingRetryFiles.length > 0 && retryRound < MAX_RETRY_ATTEMPTS) {
          retryRound++
          console.log(
            `🔄 [AssetImportService] 延后重试第 ${retryRound}/${MAX_RETRY_ATTEMPTS} 轮，待处理 ${pendingRetryFiles.length} 个文件`
          )

          // 等待一段时间让文件系统稳定
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * retryRound))

          // 复制当前队列并清空，准备处理
          const currentBatch = [...pendingRetryFiles]
          pendingRetryFiles.length = 0

          for (const retryItem of currentBatch) {
            const { file, fileExtension, nameWithoutExt, fileSize } = retryItem

            // 🛡️ 分级超时策略（根据文件大小动态调整）
            const getTimeoutMs = (size: number): number => {
              if (size > 500 * 1024 * 1024) return 120000
              if (size > 100 * 1024 * 1024) return 60000
              if (size > 50 * 1024 * 1024) return 30000
              return PARSE_TIMEOUT_MS
            }
            const timeout = getTimeoutMs(fileSize)

            try {
              const parseStartTime = Date.now()
              const fileMetadata = await withTimeout(
                fileProcessor.processFile(file.path),
                timeout,
                `解析超时 ${file.name} (${timeout / 1000}秒)`
              )
              const parseDuration = Date.now() - parseStartTime

              // 🎯 记录解析耗时
              perfCollector.recordParseTime(parseDuration)
              if (parseDuration > 1000) {
                perfCollector.recordSlowFile({
                  filePath: file.path,
                  fileSize: fileSize,
                  duration: parseDuration,
                  assetType: fileExtension
                })
              }

              if (fileMetadata && fileMetadata.metadata) {
                processedMetadata.set(file.path, fileMetadata)
                console.log(
                  `✅ [AssetImportService] 延后重试成功: ${file.name} (第 ${retryRound} 轮)`
                )
              }
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error)
              retryItem.retryCount++
              retryItem.lastError = errMsg.substring(0, 200)

              // 检查是否仍然是可重试错误
              const isRetryableError =
                errMsg.includes('invalid uasset') ||
                errMsg.includes('Read incomplete') ||
                errMsg.includes('file too small')

              if (isRetryableError && retryItem.retryCount < MAX_RETRY_ATTEMPTS) {
                // 仍为可重试错误且未达到最大重试次数，重新加入队列
                pendingRetryFiles.push(retryItem)
              } else {
                // 达到最大重试次数或不可重试，记录错误并创建基础元数据
                console.warn(
                  `❌ [AssetImportService] 延后重试最终失败: ${file.name} (尝试 ${retryItem.retryCount + 1} 次): ${errMsg.substring(0, 100)}`
                )

                // 🎯 记录错误到性能采集器
                perfCollector.recordError({
                  filePath: file.path,
                  fileName: file.name,
                  fileSize: fileSize,
                  errorCategory: classifyError(errMsg),
                  errorMessage: errMsg.substring(0, 200),
                  duration: 0
                })

                // 创建基础元数据，确保文件仍能被导入
                processedMetadata.set(file.path, {
                  processorType: 'UnrealAsset',
                  assetType: 'UnrealAsset',
                  metadata: {
                    name: nameWithoutExt,
                    originPath: file.path,
                    ext: fileExtension,
                    size: fileSize,
                    parseError: `重试 ${retryItem.retryCount + 1} 次后仍失败: ${errMsg.substring(0, 150)}`
                  }
                })
              }
            }
          }
        }

        // 如果还有未处理完的文件（已达到最大轮数），处理剩余
        for (const retryItem of pendingRetryFiles) {
          const { file, fileExtension, nameWithoutExt, fileSize, lastError } = retryItem
          console.warn(
            `❌ [AssetImportService] 延后重试放弃: ${file.name} (已尝试 ${retryItem.retryCount + 1} 次)`
          )

          // 🎯 记录错误到性能采集器
          perfCollector.recordError({
            filePath: file.path,
            fileName: file.name,
            fileSize: fileSize,
            errorCategory: classifyError(lastError),
            errorMessage: lastError,
            duration: 0
          })

          // 创建基础元数据
          processedMetadata.set(file.path, {
            processorType: 'UnrealAsset',
            assetType: 'UnrealAsset',
            metadata: {
              name: nameWithoutExt,
              originPath: file.path,
              ext: fileExtension,
              size: fileSize,
              parseError: `重试 ${MAX_RETRY_ATTEMPTS} 次后仍失败: ${lastError.substring(0, 150)}`
            }
          })
        }

        console.log(`🔄 [AssetImportService] 延后重试阶段完成`)
      }

      // 🎯 结束预处理阶段计时
      perfCollector.endPhase('assetParsing', processedUassets)

      // 初始化资产备份管理器和预处理备份信息（仅在备份模式下）
      const backupManager = isBackupMode ? new AssetBackupManager() : null
      let timestampFolderPath: string | null = null

      // 备份管理器初始化日志已隐藏

      // 预处理需要备份的资产信息
      const backupAssets: BackupAssetInfo[] = []
      // 🔧 修复：dependencyAssetInfos 声明在外层作用域，后续 DB 写入可以访问
      const dependencyAssetInfos: AssetDependencyInfo[] = []
      const backupAssetIndexBySoftPath = new Map<string, number>()
      const backupAssetScoreBySoftPath = new Map<string, number>()
      const dependencyAssetIndexBySoftPath = new Map<string, number>()
      const initialSourcePaths = new Set<string>()

      const normalizeSoftPathKey = (softPath: string): string =>
        String(softPath || '')
          .replace(/\\/g, '/')
          .replace(/\.[^.\/]+$/, '')
          .replace(/\/+/g, '/')
          .replace(/^\/?game/i, '/Game')
          .toLowerCase()

      const getBackupCandidateScore = (
        sourcePath: string,
        softPath: string,
        isInitial: boolean
      ): number => {
        let score = isInitial ? 100 : 0
        const derivedSoftPath = deriveSoftPathFromDiskPath(sourcePath)
        if (
          derivedSoftPath &&
          normalizeSoftPathKey(derivedSoftPath) === normalizeSoftPathKey(softPath)
        ) {
          score += 10
        }
        return score
      }

      const upsertBackupAssetCandidate = (
        candidate: BackupAssetInfo,
        options: { isInitial: boolean; dependencyInfo?: AssetDependencyInfo }
      ): boolean => {
        const softPathKey = normalizeSoftPathKey(candidate.softPath)
        if (!softPathKey) {
          backupAssets.push(candidate)
          if (options.isInitial) {
            initialSourcePaths.add(candidate.sourcePath)
          }
          if (options.dependencyInfo) {
            dependencyAssetInfos.push({
              ...options.dependencyInfo,
              assetKey: candidate.assetKey
            })
          }
          return true
        }

        const candidateScore = getBackupCandidateScore(
          candidate.sourcePath,
          candidate.softPath,
          options.isInitial
        )
        const existingIndex = backupAssetIndexBySoftPath.get(softPathKey)

        if (existingIndex === undefined) {
          backupAssetIndexBySoftPath.set(softPathKey, backupAssets.length)
          backupAssetScoreBySoftPath.set(softPathKey, candidateScore)
          backupAssets.push(candidate)
          if (options.isInitial) {
            initialSourcePaths.add(candidate.sourcePath)
          }
          if (options.dependencyInfo) {
            dependencyAssetIndexBySoftPath.set(softPathKey, dependencyAssetInfos.length)
            dependencyAssetInfos.push({
              ...options.dependencyInfo,
              assetKey: candidate.assetKey
            })
          }
          return true
        }

        const existingCandidate = backupAssets[existingIndex]
        if (existingCandidate?.sourcePath === candidate.sourcePath) {
          return false
        }

        const existingScore = backupAssetScoreBySoftPath.get(softPathKey) ?? 0
        if (candidateScore > existingScore) {
          console.warn(
            `[AssetImportService] 检测到 softPath 冲突，使用更可靠来源: ${candidate.softPath}\n` +
              `  保留: ${candidate.sourcePath}\n` +
              `  替换: ${existingCandidate?.sourcePath || 'unknown'}`
          )
          backupAssets[existingIndex] = candidate
          backupAssetScoreBySoftPath.set(softPathKey, candidateScore)
          if (options.isInitial) {
            initialSourcePaths.add(candidate.sourcePath)
          }
          if (options.dependencyInfo) {
            const depIndex = dependencyAssetIndexBySoftPath.get(softPathKey)
            const nextDependencyInfo = {
              ...options.dependencyInfo,
              assetKey: candidate.assetKey
            }
            if (depIndex === undefined) {
              dependencyAssetIndexBySoftPath.set(softPathKey, dependencyAssetInfos.length)
              dependencyAssetInfos.push(nextDependencyInfo)
            } else {
              dependencyAssetInfos[depIndex] = nextDependencyInfo
            }
          }
          return true
        }

        console.warn(
          `[AssetImportService] 跳过 softPath 冲突候选: ${candidate.softPath}\n` +
            `  现有: ${existingCandidate?.sourcePath || 'unknown'}\n` +
            `  跳过: ${candidate.sourcePath}`
        )
        return false
      }
      if (isBackupMode && backupManager) {
        // 开始预处理备份资产信息

        for (const file of files) {
          // 移除备份资产预处理阶段的虚幻资产类型限制，支持所有文件类型
          const metadata = processedMetadata.get(file.path)
          // 兜底路径必须带目录 —— 原来是 `/Game/<文件名>`，两个不同目录下的同名文件
          // 会被判成同一个资产，其中一个直接被剔除出备份清单（源目录一删就是死链接）
          const softPath =
            metadata?.metadata?.softPath || deriveFallbackSoftPath(file.path, rootFolderPath)

          const assetKey = generateSafeAssetKey(file.name)

          upsertBackupAssetCandidate(
            {
              sourcePath: file.path,
              softPath,
              assetKey,
              // 传递依赖信息，以便后续递归解析
              imports: metadata?.metadata?.imports,
              name: file.name
            },
            { isInitial: true }
          )
        }

        // 🏷️ 递归依赖解析（如果用户导入的是单个或多个uasset文件）
        // 我们只在文件数量较少时才自动尝试解析，避免大批量导入时太慢
        // 或者始终尝试解析，由 AssetDependencyResolver 内部去重

        // 🔧 修复：收集依赖文件的完整元数据，用于后续创建 DB 记录
        // 原来只将依赖文件加入 backupAssets（用于文件复制），但从未写入数据库
        // 导致网络库导出到项目时，基于 DB 的依赖查询找不到这些文件
        // 🛡️ 性能保护：网络资产库导入文件夹时跳过递归依赖解析
        // 乐观假设：导入文件夹时，相关依赖都已在文件夹中，无需递归查找
        if (currentVault?.vaultType === 'network') {
          console.log(
            `⚠️ [AssetImportService] 网络资产库模式，跳过递归依赖解析（假设依赖已在导入文件夹中）`
          )
        } else {
          try {
            console.log(
              `🔄 [AssetImportService] 开始解析依赖... 初始文件数: ${backupAssets.length}`
            )

            // 转换为 DependencyInfo 格式
            const initialAssets: AssetDependencyInfo[] = backupAssets.map((ba) => ({
              assetKey: ba.assetKey,
              softPath: ba.softPath,
              realPath: ba.sourcePath,
              originPath: ba.sourcePath,
              imports: Array.isArray(ba.imports) ? ba.imports : [],
              classKey: 'uasset', // 暂时假设
              name: ba.name || basename(ba.sourcePath)
            }))

            // 🛡️ 使用 Set 做 O(1) 去重，替代原来的 backupAssets.some() O(n²) 线性扫描
            const addedSourcePaths = new Set(initialSourcePaths)

            const resolver = new AssetDependencyResolver({
              enableCache: true,
              maxIterations: 20, // 限制递归深度为 20
              enableCircularDependencyDetection: true,
              onAssetFound: (asset) => {
                if (addedSourcePaths.has(asset.originPath)) {
                  return
                }
                addedSourcePaths.add(asset.originPath)

                console.log(`✅ [AssetImportService] 发现依赖文件: ${asset.name}`)
                const assetKey = generateSafeAssetKey(basename(asset.originPath))

                console.log(`📦 [AssetImportService] 准备备份依赖文件: ${asset.name}`)
                console.log(`   - 原始路径: ${asset.originPath}`)
                console.log(`   - 软路径: ${asset.softPath}`)

                const inserted = upsertBackupAssetCandidate(
                  {
                    sourcePath: asset.originPath,
                    softPath: asset.softPath,
                    assetKey,
                    imports: asset.imports,
                    name: asset.name
                  },
                  {
                    isInitial: false,
                    dependencyInfo: initialSourcePaths.has(asset.originPath) ? undefined : asset
                  }
                )

                if (!inserted) {
                  return
                }
              }
            })

            // 流式模式下，resolveDependencies 返回空数组
            await resolver.resolveDependencies(initialAssets)

            console.log(
              `🔄 [AssetImportService] 依赖解析完成，发现 ${dependencyAssetInfos.length} 个依赖文件`
            )
          } catch (error) {
            console.error('❌ [AssetImportService] 依赖解析失败:', error)
          }
        } // end of SKIP_DEP_THRESHOLD else

        // 需要备份的资产总数日志已隐藏
      }

      // 初始化备份路径映射和资产键映射
      const backupPathMap = new Map<string, string>()
      const assetKeyMap = new Map<string, string>()
      // 备份真的跑完了、映射可信 —— 只有这时候「不在 assetKeyMap 里」才说明
      // 这个文件是被去重剔除的；备份整个抛错时映射也是空的，那种情况不能当去重看
      let backupMappingReady = false

      // 执行批量备份（仅在备份模式下）
      if (isBackupMode && backupManager && backupAssets.length > 0) {
        // 开始执行备份操作

        try {
          // 🚀 恢复时间戳文件夹逻辑，但在时间戳文件夹内保持目录结构
          timestampFolderPath = await backupManager.createTimestampFolder()
          console.log(`📂 [AssetImportService] 创建时间戳备份文件夹: ${timestampFolderPath}`)

          // 批量备份完成

          const backupResults = await backupManager.batchBackupAssets(
            backupAssets,
            timestampFolderPath
          )
          // 批量备份完成

          backupResults.forEach((result) => {
            backupPathMap.set(result.assetKey, result.relativePath)
          })
          backupAssets.forEach((asset) => {
            assetKeyMap.set(asset.sourcePath, asset.assetKey)
          })
          backupMappingReady = true
          // 备份路径映射创建完成
        } catch (error) {
          console.error('❌ [AssetImportService] 备份操作失败:', error)
        }
      } else {
        // 非备份模式下，为每个文件生成 assetKey
        files.forEach((file) => {
          // 非备份模式下的 assetKey 生成也需要覆盖所有文件类型
          const assetKey = generateSafeAssetKey(file.name)
          assetKeyMap.set(file.path, assetKey)
        })
      }

      updateImportTask(publicDb, taskId, { status: 'writing', stage: 'writing' })
      if (onStageChange) onStageChange('writing')

      // 🎯 开始写入阶段计时
      perfCollector.startPhase('dbTransaction')

      // ── 事务外：批量预取文件夹类型 / 图标 / 插件版本 ──────────────
      // 这些是 stat + readdir + 读 .uplugin，原本逐个 await 在下面的事务里，
      // 等于把整库写锁按文件夹数量占住。它们只看磁盘路径、不读数据库。
      const prefetchFolderPaths = [
        rootFolderPath,
        ...sortedContents.filter((item) => item.type === 'folder').map((item) => item.path)
      ]
      const folderTypes = await prefetchFolderTypes(
        prefetchFolderPaths,
        false,
        'root-and-plugins',
        rootFolderPath
      )

      const folderInit = await globalWriterQueue.enqueue(() =>
        transaction(db, (db) => {
          const allFolderKey = ALL_FOLDER
          const allFolder = getAssetFolderByKey(db, allFolderKey)
          if (!allFolder) {
            createAssetFolder(db, {
              folderKey: allFolderKey,
              fatherKey: null,
              type: 'system',
              folderName: 'ALL',
              img: ''
            })
          }
          const isFileImportToAll = rootFolderPath === ALL_FOLDER
          let rootFolderKey: string

          // 真正新建了几个 / 复用了几个已有的，用来如实汇报 foldersCreated
          let createdFolderCount = 0
          let reusedFolderCount = 0
          const findOrCreateFolder = (
            fatherKey: string,
            folderName: string,
            folderType: string,
            iconPath?: string
          ): string => {
            const { folderKey, created } = findOrCreateAssetFolder(db, {
              folderKey: `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              fatherKey,
              type: folderType,
              folderName,
              img: iconPath || ''
            })
            if (created) createdFolderCount++
            else reusedFolderCount++
            return folderKey
          }
          if (targetFolderKey && targetFolderKey !== allFolderKey) {
            const targetExists = db
              .prepare('SELECT isDelete FROM assetFolder WHERE folderKey = ?')
              .get(targetFolderKey) as { isDelete: number } | undefined
            if (!targetExists) {
              if (targetFolderKey === 'generated-models') {
                // 特殊处理AIGC模型文件夹
                // 创建 AIGC 根文件夹
                const aigcFolderKey = 'AIGC'
                const aigcFolderExists = db
                  .prepare('SELECT isDelete FROM assetFolder WHERE folderKey = ?')
                  .get(aigcFolderKey) as { isDelete: number } | undefined
                if (!aigcFolderExists) {
                  createAssetFolder(db, {
                    folderKey: aigcFolderKey,
                    folderName: 'AIGC',
                    fatherKey: null,
                    type: 'system',
                    img: ''
                  })
                }
                // 创建 模型 子文件夹
                const modelFolderKey = 'AIGC_model'
                const modelFolderExists = db
                  .prepare('SELECT isDelete FROM assetFolder WHERE folderKey = ?')
                  .get(modelFolderKey) as { isDelete: number } | undefined
                if (!modelFolderExists) {
                  createAssetFolder(db, {
                    folderKey: modelFolderKey,
                    folderName: '模型',
                    fatherKey: aigcFolderKey,
                    type: 'folder',
                    img: ''
                  })
                }
                // 使用模型文件夹作为目标
                targetFolderKey = modelFolderKey
              } else {
                targetFolderKey = allFolderKey
              }
            } else if (targetExists.isDelete === 1) {
              db.prepare('UPDATE assetFolder SET isDelete = 0 WHERE folderKey = ?').run(
                targetFolderKey
              )
            }
          }
          if (isFileImportToAll) {
            rootFolderKey = targetFolderKey || allFolderKey
          } else {
            const rootFolderName = rootFolderPath.split(/[\\\\/]/).pop() || 'Unknown'
            // 结果已由 prefetchFolderTypes 在事务外批量取好
            const { type: folderType, iconPath } = folderTypes.get(rootFolderPath) ?? {
              type: 'normal',
              iconPath: undefined
            }
            console.log(
              `📁 [AssetImportService] 根文件夹类型检测: path=${rootFolderPath}, type=${folderType}, iconPath=${iconPath || '无'}`
            )
            rootFolderKey = findOrCreateFolder(
              targetFolderKey || allFolderKey,
              rootFolderName,
              folderType,
              iconPath
            )
          }
          const pathToKeyMap = new Map<string, string>()
          // 🏷️ 插件版本映射：folderPath -> pluginVersion
          const pluginVersionMap = new Map<
            string,
            { versionName?: string; engineVersion?: string }
          >()
          const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/')
          if (!isFileImportToAll) {
            pathToKeyMap.set(normalizePath(rootFolderPath), rootFolderKey)
            // 检测根文件夹的插件版本（已在事务外预取）
            const rootPluginVersion = folderTypes.get(rootFolderPath)?.pluginVersion
            if (rootPluginVersion) {
              pluginVersionMap.set(normalizePath(rootFolderPath), rootPluginVersion)
              console.log(
                `🏷️ [AssetImportService] 根文件夹插件版本: ${rootPluginVersion.versionName || '未知'}, 引擎版本: ${rootPluginVersion.engineVersion || '未知'}`
              )
            }
          }
          const folders = sortedContents.filter((item) => item.type === 'folder')
          for (const folder of folders) {
            const normalizedFolderPath = normalizePath(folder.path)
            const parentPath = normalizedFolderPath.substring(
              0,
              normalizedFolderPath.lastIndexOf('/')
            )
            const parentFolderKey = pathToKeyMap.get(parentPath) || rootFolderKey
            // 结果已由 prefetchFolderTypes 在事务外批量取好
            const { type: subFolderType, iconPath: subIconPath } = folderTypes.get(folder.path) ?? {
              type: 'normal',
              iconPath: undefined
            }
            const folderKey = findOrCreateFolder(
              parentFolderKey,
              folder.name,
              subFolderType,
              subIconPath
            )
            pathToKeyMap.set(normalizedFolderPath, folderKey)
            // 🏷️ 检测子文件夹的插件版本
            if (subFolderType === 'plugin') {
              const subPluginVersion = folderTypes.get(folder.path)?.pluginVersion
              if (subPluginVersion) {
                pluginVersionMap.set(normalizedFolderPath, subPluginVersion)
                console.log(
                  `🏷️ [AssetImportService] 子文件夹插件版本: ${folder.name} -> ${subPluginVersion.versionName || '未知'}`
                )
              }
            }
          }
          return {
            rootFolderKey,
            pathToKeyMap,
            pluginVersionMap,
            isFileImportToAll,
            foldersCount: folders.length,
            createdFolderCount,
            reusedFolderCount
          }
        })
      )

      // 缓存已创建的分类文件夹: path -> folderKey
      // path 格式: rootFolderKey + '/' + relativePath
      const categoryFolderCache = new Map<string, string>()

      let processedFiles = 0
      let skippedFiles = 0
      // 已经写过记录的软路径 —— 依赖兜底那一轮据此去重，否则同一个资产会留下两条记录
      const writtenSoftPaths = new Set<string>()
      // 收集导入的资产keys，用于前端增量更新和选中新资产
      const importedAssetKeys: string[] = []

      // 🏷️ 特别重要：收集待标签资产，在事务外部批量处理
      // 这样可以避免在事务进行中操作其他数据库导致的死锁
      const pendingAutoTags: Array<{ assetKey: string; assetName: string; folderPath?: string }> =
        []
      const startCursor = getImportTaskByTaskId(publicDb, taskId)?.resumeCursor || 0
      for (let i = startCursor; i < files.length; i++) {
        if (shouldPause()) {
          updateImportTask(publicDb, taskId, {
            status: 'paused',
            stage: 'writing',
            resumeCursor: i,
            doneItems: handledFilesForProgress,
            percent: Math.round(
              PREPROCESS_WEIGHT +
                (handledFilesForProgress / Math.max(1, totalFilesForProgress)) * WRITING_WEIGHT
            )
          })

          if (onPaused) {
            const currentStagePercent =
              totalFilesForProgress > 0 ? handledFilesForProgress / totalFilesForProgress : 0
            const globalPercent = Math.round(
              PREPROCESS_WEIGHT + currentStagePercent * WRITING_WEIGHT
            )
            onPaused({
              total: totalFilesForProgress,
              done: handledFilesForProgress,
              percent: globalPercent
            })
          }
          return { success: true, data: JSON.stringify({ paused: true }) } as any
        }

        const file = files[i]

        // 备份模式下，被 softPath 去重剔除出备份清单的文件不会被拷进保管库。
        // 它仍然建记录的话，filePath 只能落成源工程路径 —— 用户一删源工程就是死链接，
        // 网络库导出也拿不到文件。同一个 softPath 的那条记录已经写过了，这里直接跳过。
        if (isBackupMode && backupMappingReady && !assetKeyMap.has(file.path)) {
          console.warn(
            `⏭️ [AssetImportService] 该文件未进入备份清单（软路径重复），跳过建记录: ${file.path}`
          )
          skippedFiles++
          processedMetadata.delete(file.path)
          continue
        }

        let folderKey: string
        let parentFolderPath: string | undefined // 🏷️ 用于查找插件版本标签
        if (folderInit.isFileImportToAll) {
          folderKey = folderInit.rootFolderKey
        } else {
          const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/')
          const normalizedFilePath = normalizePath(file.path)
          const parentPath = normalizedFilePath.substring(0, normalizedFilePath.lastIndexOf('/'))
          folderKey = folderInit.pathToKeyMap.get(parentPath) || folderInit.rootFolderKey
          parentFolderPath = parentPath // 🏷️ 保存父文件夹路径用于插件版本检测
        }

        // 🚀 按这个文件自己的软路径放进对应文件夹，保持 UE 里的原有目录结构
        // ⚠️ 软路径取自它自己的元数据（预加载配上的，或退回二进制解析出来的），
        //    不再按资产名去猜 —— 按名字猜会让同名不同目录的资产互相串
        if (packageToFolderKey && packageToFolderKey.size > 0) {
          const softPath: string | undefined = processedMetadata.get(file.path)?.metadata?.softPath
          const relativePath = softPath ? packageFolderRelativePath(softPath) : ''
          const mappedFolderKey = relativePath ? resolveFolderKeyByRelativePath(relativePath) : ''
          if (mappedFolderKey) {
            console.log(
              `📁 [AssetImportService] 按软路径确定目标文件夹: ${file.name} -> ${relativePath} -> ${mappedFolderKey}`
            )
            folderKey = mappedFolderKey
          } else if (relativePath) {
            console.warn(
              `📁 [AssetImportService] 软路径没有对应文件夹，落在根目录: ${file.name} -> ${relativePath}`
            )
          }
        }
        const assetKey =
          assetKeyMap.get(file.path) ||
          `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        const fileExtension = file.name.split('.').pop()?.toLowerCase() || ''
        const nameWithoutExt = getAssetNameFromFileName(file.name)
        const isUnrealAsset = ['uasset', 'umap', 'ubulk', 'uexp'].includes(fileExtension)
        const backupPath = backupPathMap.get(assetKey)
        // 🔧 修复：将 backupPath 转换为正确的绝对路径
        // - 对于备份模式：使用本地保管库路径 + 相对路径
        // - 对于网络模式：使用网络路径 + 相对路径
        let finalFilePath = file.path // 默认使用源路径（非备份模式）
        if (isBackupMode && backupPath) {
          if (currentVault?.vaultType === 'network' && currentVault.networkPath) {
            // 网络库：从 backupPath 提取时间戳文件夹后的相对路径，拼接到 networkPath
            // backupPath 格式类似 "assetData/1737461234/Game/Characters/Hero.uasset"
            // 我们需要使用本地保管库路径来构建完整路径
            finalFilePath = join(currentVault.path, backupPath)
          } else {
            // 本地备份模式：使用本地保管库路径 + backupPath
            finalFilePath = join(currentVault?.path || '', backupPath)
          }
        }

        // 🔍 计算文件快速哈希并检查是否已存在相同文件
        let fileMd5: string | undefined = undefined
        let existingAsset: AssetData | undefined = undefined
        try {
          // 始终使用源文件路径计算快速哈希（file.path 是原始文件路径）
          // 确保使用绝对路径
          const sourceFilePath = file.path
          const normalizedSourcePath = sourceFilePath ? join(sourceFilePath) : sourceFilePath
          console.log(
            `🔍 [AssetImportService] 准备计算快速哈希: ${file.name}, 原始路径: ${sourceFilePath}, 规范化路径: ${normalizedSourcePath}`
          )

          // 尝试多个可能的路径
          const pathsToTry = [normalizedSourcePath, sourceFilePath]
          let actualFilePath: string | null = null

          for (const pathToTry of pathsToTry) {
            if (pathToTry && existsSync(pathToTry)) {
              actualFilePath = pathToTry
              break
            }
          }

          if (actualFilePath) {
            console.log(`✅ [AssetImportService] 文件存在，开始计算快速哈希: ${actualFilePath}`)
            fileMd5 = await this.calculateFileMd5(actualFilePath)
            console.log(
              `✅ [AssetImportService] 快速哈希计算完成: ${file.name} -> ${fileMd5?.substring(0, 16)}...`
            )

            // 旧抽样指纹只筛选候选；完整内容核验放在写事务之外。
            existingAsset = (
              await findIdenticalLocalAssets(db, actualFilePath, fileMd5!, currentVault?.path || '')
            )[0]

            if (existingAsset && existingAsset.filePath && existsSync(existingAsset.filePath)) {
              // 如果找到相同哈希的文件且文件存在，复用已有文件的路径
              console.log(
                `♻️ [AssetImportService] 发现相同哈希文件，复用已有文件: ${file.name} (哈希: ${fileMd5?.substring(0, 8)}...) -> ${existingAsset.filePath}`
              )
              finalFilePath = existingAsset.filePath
              // 跳过文件复制，直接使用已有文件
              // 注意：在备份模式下，如果复用已有文件，就不需要再备份了
              // 重要：即使复用已有文件，我们仍然需要保存当前文件的哈希值
            } else if (existingAsset && existingAsset.filePath) {
              // 如果找到相同哈希但文件不存在，清除引用，继续正常流程
              // console.warn(
              //   `⚠️ [AssetImportService] 找到相同哈希但文件不存在，继续正常导入: ${existingAsset.filePath}`
              // )
              existingAsset = undefined
            } else {
              // console.log(`📝 [AssetImportService] 未找到相同哈希文件，将创建新记录: ${file.name}`)
            }
          } else {
            // console.warn(
            //   `⚠️ [AssetImportService] 文件不存在，无法计算哈希。尝试的路径: ${pathsToTry.join(', ')}`
            // )
          }
        } catch (hashError) {
          console.error(`❌ [AssetImportService] 计算文件哈希失败 ${file.path}:`, hashError)
          // 哈希计算失败不影响导入流程，继续执行
        }

        // 🚫 分类功能已禁用 - 保留用户拖入时的原始目录结构
        // 这样做的好处：
        // 1. 更好地处理虚幻资产，保持项目原有的目录组织方式
        // 2. 避免重名问题（同名文件在不同目录下不会冲突）
        // 3. 用户更容易找到和管理导入的资产
        const targetCategoryPath: string = ''
        // 以下为原分类逻辑，已注释禁用：
        // if (namingRules) {
        //   let assetType = ''
        //   if (isUnrealAsset) {
        //     const meta = processedMetadata.get(file.path)
        //     if (meta?.metadata?.className) {
        //       assetType = meta.metadata.className
        //     } else if (fileExtension === 'umap') {
        //       assetType = 'World'
        //     }
        //   } else {
        //     assetType = namingRules.extensionToAssetType[fileExtension] || ''
        //   }
        //   if (assetType) {
        //     let mappedDir = namingRules.libraryAssetTypeToDirectory[assetType]
        //     if (!mappedDir && assetType.includes('Texture')) {
        //       mappedDir = namingRules.libraryAssetTypeToDirectory['Texture']
        //     } else if (!mappedDir && assetType.includes('MaterialInstance')) {
        //       mappedDir = namingRules.libraryAssetTypeToDirectory['MaterialInstance']
        //     } else if (!mappedDir && assetType.includes('Material')) {
        //       mappedDir = namingRules.libraryAssetTypeToDirectory['Material']
        //     }
        //     if (mappedDir) {
        //       targetCategoryPath = mappedDir
        //     }
        //   }
        // }

        // ── 事务外：.uplugin 元数据读取 ──────────────────────────────
        // 读文件不能放进事务：better-sqlite3 是同步 API，事务里一旦 await，
        // BEGIN 就跨越事件循环挂在共享连接上。它只依赖文件路径，不读数据库。
        const upluginInfo =
          fileExtension === 'uplugin'
            ? await readUpluginInfo(file.path || finalFilePath, nameWithoutExt)
            : undefined
        const thumbnailFileName = await buildImportThumbnail(
          file.path || finalFilePath,
          assetKey,
          fileExtension
        )

        try {
          await globalWriterQueue.enqueue(() =>
            transaction(db, (db) => {
              // 📂 处理分类文件夹创建逻辑
              if (targetCategoryPath) {
                // 移除可能的开头的 slash，如 /Game/Imported/Meshes -> Game/Imported/Meshes
                const cleanPath = targetCategoryPath.replace(/^[\\/]+/, '').replace(/\\/g, '/')
                const parts = cleanPath.split('/')

                let currentParentKey = folderKey // 起始于原本计算出的父目录（通常是工程根目录）

                for (const part of parts) {
                  if (!part) continue

                  // 构建缓存key: parentKey + partName
                  const cacheKey = `${currentParentKey}_${part}`

                  let subFolderKey = categoryFolderCache.get(cacheKey)

                  if (!subFolderKey) {
                    // 检查DB是否存在 (防止重启任务时的重复创建，虽然这里是单次任务，但为了健壮性)
                    // 注意：这里我们只在当前任务上下文内检查。如果数据库之前就有，我们可能重复创建同名文件夹？
                    // AssetFolder 允许同名文件夹。为了避免重复，我们查询一下。
                    const existing = db
                      .prepare(
                        'SELECT folderKey FROM assetFolder WHERE fatherKey = ? AND folderName = ? AND isDelete = 0'
                      )
                      .get(currentParentKey, part) as { folderKey: string } | undefined

                    if (existing) {
                      subFolderKey = existing.folderKey
                    } else {
                      // 创建新文件夹
                      subFolderKey = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                      createAssetFolder(db, {
                        folderKey: subFolderKey,
                        fatherKey: currentParentKey,
                        type: 'folder', // 视为普通文件夹
                        folderName: part,
                        img: ''
                      })
                      // console.log(`Starting create category folder: ${part} under ${currentParentKey}`)
                    }
                    categoryFolderCache.set(cacheKey, subFolderKey)
                  }

                  currentParentKey = subFolderKey
                }

                // 更新当前文件的 folderKey 为最终的子目录
                folderKey = currentParentKey
              }

              if (isUnrealAsset && (fileExtension === 'uasset' || fileExtension === 'umap')) {
                const fileMetadata = processedMetadata.get(file.path)
                if (fileMetadata) {
                  const data: AssetData = {
                    assetKey,
                    folderKey,
                    assetName: nameWithoutExt,
                    filePath: finalFilePath,
                    fileSize: file.size || 0,
                    fileExtension,
                    modifiedTime: file.modifiedTime,
                    processorType: fileMetadata.processorType,
                    assetType: fileMetadata.assetType,
                    engineVersion: fileMetadata.engineVersion,
                    classKey: fileMetadata.metadata?.classKey,
                    name: fileMetadata.metadata?.name,
                    // 🔧 修复：网络库/备份模式下使用复制后的路径，而非原始源路径
                    originPath: finalFilePath || fileMetadata.metadata?.originPath,
                    ext: fileMetadata.metadata?.ext,
                    folderName: fileMetadata.metadata?.folderName,
                    softPath: fileMetadata.metadata?.softPath,
                    assetClass: fileMetadata.metadata?.assetClass,
                    className: fileMetadata.metadata?.className,
                    classNameCn: getAssetClassNameCn(
                      fileMetadata.metadata?.className ||
                        (fileExtension === 'umap' ? 'World' : undefined)
                    ),
                    classColor: getAssetClassColor(
                      fileMetadata.metadata?.className ||
                        (fileExtension === 'umap' ? 'World' : undefined)
                    ),
                    imports: fileMetadata.metadata?.imports
                      ? JSON.stringify(fileMetadata.metadata.imports)
                      : undefined,
                    imgLocalPath: fileMetadata.metadata?.imgLocalPath,
                    size: fileMetadata.metadata?.size,
                    assetConfig: fileMetadata.metadata?.assetConfig,
                    assetConfigPath: fileMetadata.metadata?.assetConfigPath,
                    // 根据 isMainAsset 标志设置：主资产 = 0，依赖资产 = 1
                    isDependency: fileMetadata.isMainAsset ? 0 : 1,
                    fileMd5: fileMd5, // 添加MD5值
                    // 🔌 插件信息：如果是 .uplugin 文件，保存详细的插件元数据
                    pluginInfo:
                      fileExtension === 'uplugin' && fileMetadata.metadata
                        ? JSON.stringify({
                            friendlyName: fileMetadata.metadata.friendlyName,
                            description: fileMetadata.metadata.description,
                            category: fileMetadata.metadata.category,
                            createdBy: fileMetadata.metadata.createdBy,
                            versionName: fileMetadata.metadata.versionName,
                            version: fileMetadata.metadata.version,
                            engineVersion: fileMetadata.metadata.engineVersion,
                            isBetaVersion: fileMetadata.metadata.isBetaVersion,
                            isExperimentalVersion: fileMetadata.metadata.isExperimentalVersion,
                            canContainContent: fileMetadata.metadata.canContainContent,
                            modules: fileMetadata.metadata.modules,
                            plugins: fileMetadata.metadata.plugins
                          })
                        : undefined
                  }
                  createAssetData(db, data)
                  importedAssetKeys.push(assetKey)

                  // 🏷️ 收集待标签资产，在事务外部批量处理（避免死锁）
                  pendingAutoTags.push({
                    assetKey,
                    assetName: nameWithoutExt,
                    folderPath: parentFolderPath
                  })

                  console.log(`✅ [AssetImportService] 写入资产成功: ${nameWithoutExt} (有元数据)`)
                  processedFiles++
                } else {
                  // 用户手动导入的虚幻资产（解析失败或无预加载元数据），仍然是主资产
                  const id = createAssetData(db, {
                    assetKey,
                    folderKey,
                    assetName: nameWithoutExt,
                    filePath: finalFilePath,
                    fileSize: file.size || 0,
                    fileExtension,
                    modifiedTime: file.modifiedTime,
                    processorType: 'UnrealAsset',
                    assetType: 'UnrealAsset',
                    engineVersion: undefined,
                    classNameCn: getAssetClassNameCn(
                      fileExtension === 'umap' ? 'World' : undefined
                    ),
                    classColor: getAssetClassColor(fileExtension === 'umap' ? 'World' : undefined),
                    isDependency: 0, // 用户手动导入的都是主资产
                    fileMd5: fileMd5 // 添加MD5值
                  })

                  // 🏷️ 收集待标签资产，在事务外部批量处理（避免死锁）
                  pendingAutoTags.push({
                    assetKey,
                    assetName: nameWithoutExt,
                    folderPath: parentFolderPath
                  })

                  console.log(
                    `✅ [AssetImportService] 写入资产成功: ${nameWithoutExt} (无元数据, id=${id})`
                  )
                  void id
                  importedAssetKeys.push(assetKey)
                  skippedFiles++
                }
              } else {
                // 非虚幻资产文件，默认为主资产（用户主动导入的文件）
                console.log(
                  `📄 [AssetImportService] 处理非虚幻资产: ${file.name}, 扩展名: ${fileExtension}, 路径: ${file.path}`
                )
                const data: any = {
                  assetKey,
                  folderKey,
                  assetName: nameWithoutExt,
                  filePath: finalFilePath,
                  originPath: finalFilePath, // 🔧 添加缺失的 originPath 字段
                  imgLocalPath: thumbnailFileName,
                  fileSize: file.size || 0,
                  fileExtension,
                  modifiedTime: file.modifiedTime,
                  processorType: 'FileSystem',
                  assetType: 'File',
                  engineVersion: undefined,
                  classNameCn: '文件',
                  classColor: '#888888',
                  isDependency: 0, // 主资产
                  fileMd5: fileMd5 // 添加MD5值
                }

                // 🔌 .uplugin 元数据已在事务外读好，这里只落库
                if (upluginInfo) {
                  data.assetType = 'Plugin'
                  data.processorType = 'UnrealAsset'
                  data.classNameCn = '插件'
                  data.classColor = '#8B5CF6' // 紫色
                  data.engineVersion = upluginInfo.engineVersion
                  data.pluginInfo = upluginInfo.pluginInfo
                }

                createAssetData(db, data)
                importedAssetKeys.push(assetKey)

                // 🏷️ 收集待标签资产，在事务外部批量处理（避免死锁）
                pendingAutoTags.push({
                  assetKey,
                  assetName: nameWithoutExt,
                  folderPath: parentFolderPath
                })

                processedFiles++
              }
            })
          )
          handledFilesForProgress++

          // 🚀 发送写入进度
          sendWeightedProgress(
            handledFilesForProgress,
            totalFilesForProgress,
            PREPROCESS_WEIGHT,
            WRITING_WEIGHT,
            'writing'
          )

          // 记下这个软路径已经有记录了，后面依赖兜底那一轮不用再建一条
          const writtenSoftPath = processedMetadata.get(file.path)?.metadata?.softPath
          if (writtenSoftPath) {
            writtenSoftPaths.add(normalizeSoftPathKey(writtenSoftPath))
          }

          // 🛡️ OOM修复: 写入后即删 - 释放已处理的元数据内存
          processedMetadata.delete(file.path)

          // 🛡️ OOM修复: 每 500 文件触发 GC
          if (handledFilesForProgress % 500 === 0 && handledFilesForProgress > 0) {
            await new Promise((r) => setImmediate(r))
            ;(global as any).gc?.()
          }
        } catch (error) {
          console.error(`写入资产 ${file.name} 失败:`, error)
          skippedFiles++
          // 🛡️ OOM修复: 即使写入失败也要删除元数据
          processedMetadata.delete(file.path)
        }
      }

      // 🔧 为依赖文件创建 DB 记录（修复网络库导出时找不到依赖的问题）
      if (isBackupMode && dependencyAssetInfos.length > 0) {
        console.log(
          `📦 [AssetImportService] 开始为 ${dependencyAssetInfos.length} 个依赖文件创建 DB 记录`
        )
        let depWritten = 0
        for (const depAsset of dependencyAssetInfos) {
          try {
            // 这个软路径在上面的主循环里已经建过记录了 —— 再建一条就是库里一个资产两份
            if (
              depAsset.softPath &&
              writtenSoftPaths.has(normalizeSoftPathKey(depAsset.softPath))
            ) {
              continue
            }

            // 计算依赖文件的备份路径
            const depBackupPath = backupPathMap.get(depAsset.assetKey)
            let depFilePath = depAsset.originPath
            if (depBackupPath) {
              if (currentVault?.vaultType === 'network' && currentVault.networkPath) {
                depFilePath = join(currentVault.path, depBackupPath)
              } else {
                depFilePath = join(currentVault?.path || '', depBackupPath)
              }
            }

            const depExt = depAsset.originPath.split('.').pop()?.toLowerCase() || 'uasset'
            const depNameWithoutExt = getAssetNameFromFileName(depAsset.name)

            // 📁 依赖也按自己的软路径进对应文件夹 —— 原来一律扔根目录，
            //    用户看到的就是一堆漂在项目根下、0 字节、没有缩略图的孤儿资产
            const depRelativePath = depAsset.softPath
              ? packageFolderRelativePath(depAsset.softPath)
              : ''
            const depFolderKey =
              (depRelativePath ? resolveFolderKeyByRelativePath(depRelativePath) : '') ||
              folderInit.rootFolderKey

            // 大小照实写，别写 0 —— 界面上「0 B」会让用户以为文件是坏的
            let depFileSize = 0
            try {
              if (existsSync(depFilePath)) {
                depFileSize = statSync(depFilePath).size
              }
            } catch {
              // 拿不到大小就留 0，不值得为此让整条记录写不进去
            }

            await globalWriterQueue.enqueue(() =>
              transaction(db, (db) => {
                createAssetData(db, {
                  assetKey: depAsset.assetKey,
                  folderKey: depFolderKey,
                  assetName: depNameWithoutExt,
                  filePath: depFilePath,
                  fileSize: depFileSize,
                  fileExtension: depExt,
                  modifiedTime: new Date().toISOString(),
                  processorType: 'UnrealAsset',
                  assetType: 'UnrealAsset',
                  engineVersion: depAsset.engineVersion,
                  classKey: depAsset.classKey || 'uasset',
                  name: depNameWithoutExt,
                  originPath: depFilePath,
                  ext: depExt,
                  softPath: depAsset.softPath,
                  imports: depAsset.imports ? JSON.stringify(depAsset.imports) : undefined,
                  isDependency: 1 // 标记为依赖资产
                })
              })
            )
            importedAssetKeys.push(depAsset.assetKey)
            depWritten++
          } catch (depErr) {
            console.warn(
              `⚠️ [AssetImportService] 写入依赖资产 DB 记录失败: ${depAsset.name}`,
              depErr
            )
          }
        }
        console.log(
          `📦 [AssetImportService] 依赖文件 DB 记录写入完成: ${depWritten}/${dependencyAssetInfos.length}`
        )
      }

      // 🏷️ 批量处理自动标签（在所有事务完成后，避免数据库死锁）
      if (pendingAutoTags.length > 0) {
        console.log(
          `🏷️ [AssetImportService] 开始批量处理 ${pendingAutoTags.length} 个资产的智能标签`
        )
        for (const tag of pendingAutoTags) {
          try {
            autoTagAsset(tag.assetKey, tag.assetName)

            // 🏷️ 检查是否在插件文件夹中，如果是则添加版本标签
            if (tag.folderPath && folderInit.pluginVersionMap) {
              // 查找匹配的插件版本（从当前路径向上查找）
              let pathToCheck = tag.folderPath
              while (pathToCheck) {
                const pluginVersion = folderInit.pluginVersionMap.get(pathToCheck)
                if (pluginVersion) {
                  autoTagPluginVersion(tag.assetKey, pluginVersion)
                  break
                }
                // 向上一级目录查找
                const lastSlash = pathToCheck.lastIndexOf('/')
                if (lastSlash <= 0) break
                pathToCheck = pathToCheck.substring(0, lastSlash)
              }
            }
          } catch (err) {
            console.warn(`[AutoTag] 自动标签失败: ${tag.assetName}`, err)
          }
        }
        console.log(`🏷️ [AssetImportService] 批量标签处理完成`)
      }

      updateImportTask(publicDb, taskId, {
        status: 'completed',
        stage: 'completed',
        totalItems: totalFilesForProgress,
        doneItems: totalFilesForProgress,
        percent: 100
      })

      // if (progressInterval) clearInterval(progressInterval) // 已移除定时器
      if (onProgress) {
        onProgress({
          total: totalFilesForProgress,
          done: totalFilesForProgress,
          percent: 100
        })
      }

      // 📊 计算总字节统计
      let totalBytesReceived = 0
      for (const file of files) {
        totalBytesReceived += file.size || 0
      }

      const totalGBReceived = (totalBytesReceived / (1024 * 1024 * 1024)).toFixed(2)

      console.log(`📊 [AssetImportService] ========== 导入完成摘要 ==========`)
      console.log(`📊 [AssetImportService] 源路径: ${rootFolderPath}`)
      console.log(`📊 [AssetImportService] 接收的文件总数: ${files.length} 个`)
      console.log(`📊 [AssetImportService] 接收的文件总大小: ${totalGBReceived} GB`)
      console.log(`📊 [AssetImportService] 成功处理文件: ${processedFiles} 个`)
      console.log(`📊 [AssetImportService] 跳过文件: ${skippedFiles} 个`)
      console.log(
        `📊 [AssetImportService] 文件夹: 新建 ${folderInit.createdFolderCount} 个 / 复用 ${folderInit.reusedFolderCount} 个`
      )

      // 🎯 结束写入阶段计时并生成性能报告
      perfCollector.endPhase('dbTransaction', processedFiles)
      perfCollector.setFileStats(files.length, totalBytesReceived)
      const perfReport = perfCollector.generateReport()

      console.log(
        `🎯 [AssetImportService] 性能报告已生成: 瓶颈=${perfReport.bottleneck}, 错误率=${(perfReport.errorSummary.errorRate * 100).toFixed(1)}%`
      )

      if (skippedFiles > 0) {
        console.log(`⚠️ [AssetImportService] 注意: 有 ${skippedFiles} 个文件被跳过！`)
        console.log(`⚠️ [AssetImportService] 可能的原因:`)
        console.log(`   - 文件写入数据库失败`)
        console.log(`   - 哈希计算失败`)
        console.log(`   - 元数据解析失败`)
      }

      // 检查是否有严重的丢失
      const lossPercentage =
        files.length > 0
          ? (((files.length - processedFiles - skippedFiles) / files.length) * 100).toFixed(1)
          : '0'
      if (parseFloat(lossPercentage) > 1) {
        console.warn(`❌ [AssetImportService] 警告: 检测到 ${lossPercentage}% 的文件丢失！`)
        console.warn(`   - 预期处理: ${files.length} 个`)
        console.warn(`   - 实际处理: ${processedFiles} 个`)
        console.warn(`   - 明确跳过: ${skippedFiles} 个`)
        console.warn(`   - 未知丢失: ${files.length - processedFiles - skippedFiles} 个`)
      }

      console.log(`📊 [AssetImportService] ================================`)

      // 🕐 后台延迟解析大文件（不阻塞返回，异步进行）
      if (pendingLargeFiles.length > 0) {
        console.log(`🕐 [AssetImportService] 启动后台解析 ${pendingLargeFiles.length} 个大文件...`)
        // 使用 setImmediate 确保先返回结果，再开始后台解析
        setImmediate(async () => {
          for (let i = 0; i < pendingLargeFiles.length; i++) {
            const largeFile = pendingLargeFiles[i]
            try {
              console.log(
                `🔄 [AssetImportService] 后台解析中: ${largeFile.name} (${i + 1}/${pendingLargeFiles.length})`
              )
              // 🛡️ 后台解析超时保护（30秒，比前台宽松）
              const fileMetadata = await withTimeout(
                fileProcessor.processFile(largeFile.path),
                30000,
                `后台解析超时 ${largeFile.name}`
              )
              if (fileMetadata && fileMetadata.metadata) {
                // 更新已导入资产的元数据
                const assetKey = importedAssetKeys.find((key) => {
                  const asset = getAssetDataByKey(db, key)
                  return asset?.filePath === largeFile.path || asset?.originPath === largeFile.path
                })
                if (assetKey) {
                  // 更新数据库中的元数据
                  updateAssetData(db, assetKey, {
                    className: fileMetadata.metadata.className,
                    softPath: fileMetadata.metadata.softPath,
                    imports: fileMetadata.metadata.imports
                      ? JSON.stringify(fileMetadata.metadata.imports)
                      : undefined,
                    imgLocalPath: fileMetadata.metadata.imgLocalPath
                  })
                  console.log(`✅ [AssetImportService] 后台解析完成: ${largeFile.name}`)
                }
              }
            } catch (err) {
              console.warn(`⚠️ [AssetImportService] 后台解析失败: ${largeFile.name}`, err)
            }
          }
          console.log(`🎉 [AssetImportService] 所有大文件后台解析完成`)
        })
      }

      return {
        success: true,
        data: {
          rootFolderKey: folderInit.rootFolderKey,
          // 复用到已有文件夹的不算「新建」，重复导入时汇报的数字才对得上
          foldersCreated: folderInit.createdFolderCount,
          filesCreated: processedFiles,
          processedFiles,
          skippedFiles,
          pathMappings: folderInit.pathToKeyMap.size,
          importedAssetKeys, // 返回导入的资产keys列表
          // 📊 诊断信息
          diagnostics: {
            totalFilesReceived: files.length,
            totalBytesReceived,
            processedFiles,
            skippedFiles,
            lossPercentage: parseFloat(lossPercentage)
          }
        }
      }
    } catch (error) {
      console.error('导入文件夹结构失败:', error)
      // if (progressInterval) clearInterval(progressInterval) // 已移除
      return { success: false, error: (error as Error).message }
    } finally {
      // 成功、暂停、抛异常 —— 每条路都要把连接还回去
      try {
        importDb?.close?.()
      } catch (closeErr) {
        console.warn('[AssetImportService] 关闭导入数据库连接失败:', closeErr)
      }
      importDb = null
    }
  }
}
