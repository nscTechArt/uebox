import {
  AssetDependencyResolver,
  type AssetDependencyInfo,
  type DependencyProgress
} from './AssetDependencyResolver'
import { getAppWindows } from '../../appWindows'
import { UnrealAssetProcessor } from '../fileProcessor/UnrealAssetProcessor'
import { getDatabase } from '../../sqliteDataBase'
import { createAssetData } from '../../sqliteDataBase/models/assetData'
import type { AssetData } from '../../sqliteDataBase/models/assetData'
import { getAssetFolderByKey } from '../../sqliteDataBase/models/assetFolder'
import { VaultServiceManager } from '../../networkV2/VaultServiceManager'
import path from 'path'
import fse from 'fs-extra'
import { PathManager } from '../PathManager'

/**
 * 导入配置接口
 */
export interface AssetImportConfig {
  enableDependencyResolution?: boolean
  maxDependencyDepth?: number
  batchSize?: number
  progressCallback?: (progress: ImportProgress) => void
  skipExistingAssets?: boolean
  storageMode?: 'none' | 'local-copy' | 'remote-http'
  vaultPath?: string
  remoteVaultUrl?: string
  /** V2 网络保管库角色: server / client / none */
  networkV2Role?: 'server' | 'client' | 'none'
  /** V2 网络保管库 ID */
  networkV2VaultId?: string
}

/**
 * 导入进度信息
 */
export interface ImportProgress {
  stage:
    | 'scanning'
    | 'processing'
    | 'resolving_dependencies'
    | 'restoring_files'
    | 'saving'
    | 'completed'
  currentStep: number
  totalSteps: number
  currentFile?: string
  processedAssets: number
  totalAssets: number
  dependencyProgress?: DependencyProgress
}

/**
 * 导入结果
 */
export interface ImportResult {
  success: boolean
  message: string
  processedAssets: number
  dependencyAssets: number
  skippedAssets: number
  errors: string[]
  assetKeys: string[]
}

/**
 * 资产导入管理器
 * 集成依赖解析功能，提供完整的资产导入解决方案
 */
export class AssetImportManager {
  private readonly dependencyResolver: AssetDependencyResolver
  private readonly assetProcessor: UnrealAssetProcessor
  private readonly config: Required<AssetImportConfig>

  constructor(config: AssetImportConfig = {}) {
    this.config = {
      enableDependencyResolution: config.enableDependencyResolution ?? true,
      maxDependencyDepth: config.maxDependencyDepth ?? 20,
      batchSize: config.batchSize ?? 50,
      progressCallback: config.progressCallback ?? (() => {}),
      skipExistingAssets: config.skipExistingAssets ?? true,
      storageMode: config.storageMode ?? 'none',
      vaultPath: config.vaultPath ?? '',
      remoteVaultUrl: config.remoteVaultUrl ?? '',
      networkV2Role: config.networkV2Role ?? 'none',
      networkV2VaultId: config.networkV2VaultId ?? ''
    }

    this.assetProcessor = new UnrealAssetProcessor()
    this.dependencyResolver = new AssetDependencyResolver({
      maxIterations: this.config.maxDependencyDepth,
      batchSize: this.config.batchSize,
      enableCache: true,
      progressCallback: (progress) => {
        this.reportProgress({
          stage: 'resolving_dependencies',
          currentStep: progress.currentIteration,
          totalSteps: this.config.maxDependencyDepth,
          processedAssets: progress.processedPaths,
          totalAssets: progress.totalPaths,
          dependencyProgress: progress
        })
      }
    })
  }

  /**
   * 导入资产文件列表
   * @param filePaths 文件路径列表
   * @param folderKey 目标文件夹Key
   * @returns 导入结果
   */
  async importAssets(filePaths: string[], folderKey: string): Promise<ImportResult> {
    const result: ImportResult = {
      success: false,
      message: '',
      processedAssets: 0,
      dependencyAssets: 0,
      skippedAssets: 0,
      errors: [],
      assetKeys: []
    }

    try {
      this.reportProgress({
        stage: 'scanning',
        currentStep: 0,
        totalSteps: filePaths.length,
        processedAssets: 0,
        totalAssets: filePaths.length
      })

      // 1. 扫描和处理初始资产
      const initialAssets = await this.processInitialAssets(filePaths, folderKey)
      result.processedAssets = initialAssets.length
      result.assetKeys.push(...initialAssets.map((asset) => asset.assetKey))

      if (initialAssets.length === 0) {
        result.message = '没有找到有效的资产文件'
        return result
      }

      let allAssets = initialAssets

      // 2. 依赖解析（如果启用）
      if (this.config.enableDependencyResolution) {
        this.reportProgress({
          stage: 'resolving_dependencies',
          currentStep: 0,
          totalSteps: this.config.maxDependencyDepth,
          processedAssets: initialAssets.length,
          totalAssets: initialAssets.length
        })

        const dependencyAssets = await this.resolveDependencies(initialAssets)
        const newDependencies = dependencyAssets.filter(
          (dep) => !initialAssets.some((initial) => initial.assetKey === dep.assetKey)
        )

        allAssets = [...initialAssets, ...newDependencies]
        result.dependencyAssets = newDependencies.length
        result.assetKeys.push(...newDependencies.map((asset) => asset.assetKey))
      }

      // 2.5. 写入目标存储
      if (this.config.storageMode === 'local-copy' && this.config.vaultPath) {
        await this.copyAssetsToVault(allAssets, this.config.vaultPath)
      } else if (
        this.config.storageMode === 'remote-http' &&
        this.config.networkV2Role === 'client' &&
        this.config.networkV2VaultId
      ) {
        await this.uploadAssetsToRemoteVault(allAssets, this.config.networkV2VaultId, folderKey)
      }

      // 3. 保存到数据库
      await this.saveAssetsToDatabase(allAssets, folderKey)

      result.success = true
      result.message = this.generateSuccessMessage(result)
    } catch (error) {
      console.error('[AssetImportManager] 导入失败:', error)
      result.errors.push(error instanceof Error ? error.message : String(error))
      result.message = `导入失败: ${result.errors.join(', ')}`
    } finally {
      this.reportProgress({
        stage: 'completed',
        currentStep: result.processedAssets + result.dependencyAssets,
        totalSteps: result.processedAssets + result.dependencyAssets,
        processedAssets: result.processedAssets,
        totalAssets: result.processedAssets + result.dependencyAssets
      })
    }

    return result
  }

  /**
   * 处理初始资产列表
   * @param filePaths 文件路径列表
   * @param folderKey 文件夹Key
   * @returns 处理后的资产信息列表
   */
  private async processInitialAssets(
    filePaths: string[],
    folderKey: string
  ): Promise<AssetDependencyInfo[]> {
    void folderKey
    const assets: AssetDependencyInfo[] = []
    const supportedExtensions = this.assetProcessor.getSupportedExtensions()

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i]

      this.reportProgress({
        stage: 'processing',
        currentStep: i + 1,
        totalSteps: filePaths.length,
        currentFile: path.basename(filePath),
        processedAssets: assets.length,
        totalAssets: filePaths.length
      })

      try {
        // path.extname 返回带点的扩展名（如 '.uasset'），需要移除点以匹配 supportedExtensions
        const ext = path.extname(filePath).toLowerCase().replace('.', '')
        if (!supportedExtensions.includes(ext)) {
          console.warn(`[AssetImportManager] 不支持的文件类型: ${filePath}`)
          continue
        }

        // 检查是否已存在
        if (this.config.skipExistingAssets && (await this.assetExists(filePath))) {
          console.log(`[AssetImportManager] 跳过已存在的资产: ${filePath}`)
          continue
        }

        // 处理资产文件
        const metadata = await this.assetProcessor.processFile(filePath)
        if (metadata && metadata.metadata) {
          const asset: AssetDependencyInfo = {
            assetKey: metadata.metadata.assetKey || this.generateAssetKey(),
            softPath: metadata.metadata.softPath || this.generateSoftPath(filePath),
            realPath: filePath,
            originPath: filePath,
            imports: this.parseImports(metadata.metadata.imports),
            classKey: metadata.metadata.classKey || 'uasset',
            name: metadata.metadata.name || path.basename(filePath, path.extname(filePath)),
            engineVersion: metadata.metadata.engineVersion,
            imgLocalPath:
              typeof metadata.metadata.imgLocalPath === 'string'
                ? metadata.metadata.imgLocalPath
                : undefined
          }

          assets.push(asset)
        }
      } catch (error) {
        console.error(`[AssetImportManager] 处理文件失败: ${filePath}`, error)
      }
    }

    return assets
  }

  /**
   * 解析资产依赖
   * @param initialAssets 初始资产列表
   * @returns 包含依赖的完整资产列表
   */
  private async resolveDependencies(
    initialAssets: AssetDependencyInfo[]
  ): Promise<AssetDependencyInfo[]> {
    try {
      return await this.dependencyResolver.resolveDependencies(initialAssets)
    } catch (error) {
      console.error('[AssetImportManager] 依赖解析失败:', error)
      // 依赖解析失败时返回原始资产列表
      return initialAssets
    }
  }

  /**
   * 保存资产到数据库
   * 根据 V2 网络角色自动分流：
   *  - Client: 通过 SyncClient.batch() 代理到 Server
   *  - Server: 直写本地 DB + ChangeTracker 记录 + WebSocket 广播
   *  - none:   直写本地 DB（原有行为）
   */
  private async saveAssetsToDatabase(
    assets: AssetDependencyInfo[],
    folderKey: string
  ): Promise<void> {
    const total = assets.length
    this.reportProgress({
      stage: 'saving',
      currentStep: 0,
      totalSteps: total,
      processedAssets: 0,
      totalAssets: total
    })

    const role = this.config.networkV2Role
    const vaultId = this.config.networkV2VaultId

    if (role === 'client' && vaultId) {
      // ─── Client 模式：通过 SyncClient 批量代理到 Server ───
      await this.saveViaClient(assets, folderKey, vaultId)
    } else if (role === 'server' && vaultId) {
      // ─── Server 模式：直写 DB + 记录变更 + 广播 ───
      await this.saveAsServer(assets, folderKey, vaultId)
    } else {
      // ─── 普通模式：直写本地 DB ───
      await this.saveLocal(assets, folderKey)
    }
  }

  /** 将 AssetDependencyInfo 转换为 DB 记录（单条，避免批量 map 占内存） */
  private buildAssetRecord(asset: AssetDependencyInfo, folderKey: string): Record<string, unknown> {
    return {
      assetKey: asset.assetKey,
      folderKey,
      assetName: asset.name,
      filePath: asset.realPath,
      fileSize: 0,
      fileExtension: path.extname(asset.realPath).toLowerCase().replace('.', ''),
      modifiedTime: new Date().toISOString(),
      processorType: 'UnrealAsset',
      assetType: 'UnrealAsset',
      engineVersion: asset.engineVersion,
      classKey: asset.classKey,
      name: asset.name,
      originPath: asset.originPath,
      ext: path.extname(asset.realPath).toLowerCase(),
      folderName: path.dirname(asset.realPath),
      softPath: asset.softPath,
      assetClass: this.extractAssetClass(asset.softPath),
      className: asset.classKey,
      imports: JSON.stringify(asset.imports),
      imgLocalPath: asset.imgLocalPath || '',
      size: 0
    }
  }

  private async uploadAssetsToRemoteVault(
    assets: AssetDependencyInfo[],
    vaultId: string,
    folderKey: string
  ): Promise<void> {
    const vsm = VaultServiceManager.getInstance()
    const client = vsm.getClient(vaultId)
    if (!client) {
      throw new Error('远程资产服务器未连接，无法上传导入文件')
    }

    this.reportProgress({
      stage: 'restoring_files',
      currentStep: 0,
      totalSteps: assets.length,
      processedAssets: 0,
      totalAssets: assets.length
    })

    const timestamp = Date.now().toString()
    const pathManager = PathManager.getInstance()
    const buildFolderRelativePath = (currentFolderKey?: string): string => {
      if (!currentFolderKey || currentFolderKey === 'ALL') return ''
      const folder = getAssetFolderByKey(getDatabase(), currentFolderKey)
      if (!folder) return ''
      if (!folder.fatherKey || folder.fatherKey === 'ALL') {
        return folder.folderName
      }
      const parentPath = buildFolderRelativePath(folder.fatherKey)
      return parentPath ? `${parentPath}/${folder.folderName}` : folder.folderName
    }
    const remoteFolderPrefix = buildFolderRelativePath(folderKey)

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i]
      try {
        if (!asset.softPath) {
          console.warn(`[AssetImportManager] 资产缺少软路径，跳过远程上传: ${asset.assetKey}`)
          continue
        }

        const ext = path.extname(asset.realPath)
        const relativeSoftPath = asset.softPath.startsWith('/')
          ? asset.softPath.slice(1)
          : asset.softPath
        const remoteAssetPath = remoteFolderPrefix
          ? path.posix.join(remoteFolderPrefix, 'assetData', timestamp, relativeSoftPath + ext)
          : path.posix.join('assetData', timestamp, relativeSoftPath + ext)

        await client.uploadLocalFile(asset.realPath, remoteAssetPath)
        asset.realPath = remoteAssetPath

        if (asset.imgLocalPath) {
          const localThumbPath = pathManager.getThumbnailFilePath(asset.imgLocalPath)
          const remoteThumbPath = path.posix.join('.thumbnails', asset.imgLocalPath)
          await client.uploadLocalFile(localThumbPath, remoteThumbPath)
        }

        this.reportProgress({
          stage: 'restoring_files',
          currentStep: i + 1,
          totalSteps: assets.length,
          currentFile: path.basename(remoteAssetPath),
          processedAssets: i + 1,
          totalAssets: assets.length
        })
      } catch (error) {
        console.error(`[AssetImportManager] 远程上传失败: ${asset.originPath}`, error)
        throw error
      }
    }
  }

  /**
   * Client 模式：分批构建 + SyncClient.batch() 代理到 Server
   * - 不连接时直接抛错，避免静默不一致
   * - 失败的 batch 最多重试 2 次
   */
  private async saveViaClient(
    assets: AssetDependencyInfo[],
    folderKey: string,
    vaultId: string
  ): Promise<void> {
    const vsm = VaultServiceManager.getInstance()
    const client = vsm.getClient(vaultId)
    if (!client) {
      throw new Error('未连接到主机 Server，无法导入资产。请检查网络连接后重试。')
    }

    const total = assets.length
    const BATCH_SIZE = 50
    const MAX_RETRIES = 2
    let saved = 0
    let failed = 0

    for (let i = 0; i < total; i += BATCH_SIZE) {
      // 按批构建记录，用完即释放，避免一次性 map 全部
      const end = Math.min(i + BATCH_SIZE, total)
      const operations: Array<{
        type: 'insert'
        table: 'assetData'
        data: Record<string, unknown>
      }> = []
      for (let j = i; j < end; j++) {
        operations.push({
          type: 'insert' as const,
          table: 'assetData' as const,
          data: this.buildAssetRecord(assets[j], folderKey)
        })
      }

      // 带重试的 batch 发送
      let success = false
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await client.batch(operations)
          saved += operations.length
          success = true
          break
        } catch (err) {
          if (attempt < MAX_RETRIES) {
            console.warn(
              `[AssetImportManager] Client batch 失败，第 ${attempt + 1} 次重试 (${i}-${end}):`,
              err instanceof Error ? err.message : err
            )
            // 短暂等待后重试
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
          } else {
            console.error(`[AssetImportManager] Client batch 最终失败 (${i}-${end}):`, err)
            failed += operations.length
          }
        }
      }

      if (success) {
        console.log(`[AssetImportManager] Client batch 已发送 ${saved}/${total}`)
      }

      this.reportProgress({
        stage: 'saving',
        currentStep: end,
        totalSteps: total,
        processedAssets: end,
        totalAssets: total
      })
    }

    // Client.batch() 只会把变更提交到远端 Server。
    // 如果不立刻回拉，本地 SQLite 仍是旧数据，UI 刷新后也看不到刚导入的资产。
    if (saved > 0) {
      await client.pullChanges()
    }

    // 通知渲染进程刷新
    this.broadcastToRenderer('asset:changed', {
      source: 'networkV2',
      vaultId,
      op: 'batch',
      applied: saved
    })

    if (failed > 0) {
      throw new Error(
        `${saved} 个资产同步成功，${failed} 个资产同步失败（已重试 ${MAX_RETRIES} 次）`
      )
    }
  }

  /** Server 模式：逐条构建 + 直写 DB + ChangeTracker + WS 广播 */
  private async saveAsServer(
    assets: AssetDependencyInfo[],
    folderKey: string,
    vaultId: string
  ): Promise<void> {
    const db = getDatabase()
    const vsm = VaultServiceManager.getInstance()
    const total = assets.length

    for (let i = 0; i < total; i++) {
      const record = this.buildAssetRecord(assets[i], folderKey)
      try {
        createAssetData(db, record as AssetData)

        // 记录到 change_log 并通过 WebSocket 广播给已连接的 Client
        const assetKey = record.assetKey as string
        try {
          const server = vsm.getServer()
          if (server) {
            const entry = server.getVaultEntry(vaultId)
            if (entry) {
              const seq = entry.tracker.record('insert', 'assetData', assetKey, record, 'server')
              server.broadcastChange(vaultId, seq, 'insert', 'assetData', assetKey, record)
            }
          }
        } catch (syncErr) {
          console.warn(`[AssetImportManager] Server 变更同步失败: ${assetKey}`, syncErr)
        }
      } catch (error) {
        console.error(`[AssetImportManager] 保存资产失败: ${record.assetKey}`, error)
      }

      this.reportProgress({
        stage: 'saving',
        currentStep: i + 1,
        totalSteps: total,
        processedAssets: i + 1,
        totalAssets: total
      })
    }

    // 通知渲染进程刷新
    this.broadcastToRenderer('asset:changed', {
      source: 'networkV2',
      vaultId,
      op: 'batch',
      applied: total
    })
  }

  /** 普通模式（非网络）：逐条构建 + 直写本地 DB */
  private async saveLocal(assets: AssetDependencyInfo[], folderKey: string): Promise<void> {
    const db = getDatabase()
    const total = assets.length

    for (let i = 0; i < total; i++) {
      const record = this.buildAssetRecord(assets[i], folderKey)
      try {
        createAssetData(db, record as AssetData)
      } catch (error) {
        console.error(`[AssetImportManager] 保存资产失败: ${record.assetKey}`, error)
      }

      this.reportProgress({
        stage: 'saving',
        currentStep: i + 1,
        totalSteps: total,
        processedAssets: i + 1,
        totalAssets: total
      })
    }
  }

  /** 广播资产变更到盒子自己的渲染窗口（不含 Agent 浏览器） */
  private broadcastToRenderer(channel: string, payload: unknown): void {
    for (const win of getAppWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  /**
   * 将资产复制到保管库并还原目录结构
   * @param assets 资产列表
   * @param vaultPath 保管库根路径
   */
  private async copyAssetsToVault(assets: AssetDependencyInfo[], vaultPath: string): Promise<void> {
    this.reportProgress({
      stage: 'restoring_files',
      currentStep: 0,
      totalSteps: assets.length,
      processedAssets: 0,
      totalAssets: assets.length
    })

    // 1. 创建时间戳文件夹
    // 所有的资产都将在这个时间戳文件夹下还原结构
    const timestamp = Date.now().toString()
    const timestampFolder = path.join(vaultPath, 'assetData', timestamp)
    await fse.ensureDir(timestampFolder)
    console.log(`[AssetImportManager] 创建时间戳备份文件夹: ${timestampFolder}`)

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i]
      try {
        if (!asset.softPath) {
          console.warn(`[AssetImportManager] 资产缺少软路径，跳过复制: ${asset.assetKey}`)
          continue
        }

        const ext = path.extname(asset.realPath)

        // 软路径通常是 /Game/Folder/Name
        // 移除开头的斜杠，并确保使用系统分隔符
        const relativePath = asset.softPath.startsWith('/')
          ? asset.softPath.slice(1)
          : asset.softPath

        // 构建完整的目标路径
        // path.join 会自动处理分隔符
        // 目标路径 = 保管库路径 + assetData + 时间戳 + softPath
        const destPath = path.join(timestampFolder, relativePath + ext)
        const destDir = path.dirname(destPath)

        // 确保目标目录存在
        await fse.ensureDir(destDir)

        // 检查源文件和目标文件是否相同
        const sourcePath = path.resolve(asset.realPath)
        const targetPath = path.resolve(destPath)

        if (sourcePath !== targetPath) {
          // 复制文件
          await fse.copy(sourcePath, targetPath, { overwrite: true })
        }

        // 更新资产的真实路径为保管库中的路径
        // 这样后续 saveAssetsToDatabase 会使用这个新路径入库
        asset.realPath = targetPath

        this.reportProgress({
          stage: 'restoring_files',
          currentStep: i + 1,
          totalSteps: assets.length,
          currentFile: path.basename(destPath),
          processedAssets: i + 1,
          totalAssets: assets.length
        })
      } catch (error) {
        console.error(`[AssetImportManager] 复制文件失败: ${asset.softPath}`, error)
        // 不中断整个流程，仅记录错误
      }
    }
  }

  /**
   * 检查资产是否已存在
   * @param filePath 文件路径
   * @returns 是否存在
   */
  private async assetExists(filePath: string): Promise<boolean> {
    void filePath
    // TODO: 根据实际数据库结构实现查重逻辑
    return false
  }

  /**
   * 解析imports字符串
   * @param imports imports数据
   * @returns 解析后的路径数组
   */
  private parseImports(imports: any): string[] {
    try {
      if (typeof imports === 'string') {
        return JSON.parse(imports)
      }
      if (Array.isArray(imports)) {
        return imports
      }
      return []
    } catch {
      return []
    }
  }

  /**
   * 生成资产Key
   * @returns 唯一的资产Key
   */
  private generateAssetKey(): string {
    return `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * 生成软路径
   * @param filePath 文件路径
   * @returns 软路径
   */
  private generateSoftPath(filePath: string): string {
    const fileName = path.basename(filePath, path.extname(filePath))
    return `/Game/${fileName}`
  }

  /**
   * 提取资产类别
   * @param softPath 软路径
   * @returns 资产类别
   */
  private extractAssetClass(softPath: string): string {
    return softPath.split('/')[2] || ''
  }

  /**
   * 生成成功消息
   * @param result 导入结果
   * @returns 成功消息
   */
  private generateSuccessMessage(result: ImportResult): string {
    const parts: string[] = []

    // 只显示非0的计数项
    if (result.processedAssets > 0) {
      parts.push(` ${result.processedAssets} 个资产`)
    }

    if (result.dependencyAssets > 0) {
      parts.push(` ${result.dependencyAssets} 个依赖资产`)
    }

    if (result.skippedAssets > 0) {
      parts.push(`跳过 ${result.skippedAssets} 个已存在资产`)
    }

    return parts.length > 0 ? `成功导入 (${parts.join('，')})` : '导入完成'
  }

  /**
   * 报告进度
   * @param progress 进度信息
   */
  private reportProgress(progress: ImportProgress): void {
    try {
      this.config.progressCallback(progress)
    } catch (error) {
      console.warn('[AssetImportManager] 进度回调执行失败:', error)
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.dependencyResolver.clearCache()
  }

  /**
   * 获取统计信息
   */
  getStats(): { cacheStats: any } {
    return {
      cacheStats: this.dependencyResolver.getCacheStats()
    }
  }
}
