import { ipcMain } from 'electron'
import {
  AssetImportManager,
  type AssetImportConfig,
  type ImportResult
} from '../utils/assetDependency'
import { AssetImportService } from '../services/asset/AssetImportService'
import { getDatabaseManager } from '../sqliteDataBase'
import { VaultServiceManager } from '../networkV2/VaultServiceManager'

/**
 * 资产导入IPC处理器
 * 提供渲染进程调用的资产导入接口
 */

// 创建全局导入管理器实例
let importManager: AssetImportManager | null = null

/**
 * 获取或创建导入管理器实例
 */
function getImportManager(config?: AssetImportConfig): AssetImportManager {
  // 总是重新创建实例以确保配置（如 importToVault）是最新的
  return new AssetImportManager(config)
}

/**
 * 获取当前 vault 的 V2 网络角色和 ID
 */
function getV2Context(): { networkV2Role: 'server' | 'client' | 'none'; networkV2VaultId: string } {
  try {
    const manager = getDatabaseManager()
    const currentVault = manager.getCurrentVault()
    if (currentVault && currentVault.vaultType === 'network') {
      const vsm = VaultServiceManager.getInstance()
      const role = vsm.getRole(currentVault.id)
      if (role !== 'none') {
        return { networkV2Role: role, networkV2VaultId: currentVault.id }
      }
    }
  } catch {
    // VaultServiceManager 未初始化时忽略
  }
  return { networkV2Role: 'none', networkV2VaultId: '' }
}

function resolveImportStorageConfig(
  currentVault: ReturnType<ReturnType<typeof getDatabaseManager>['getCurrentVault']>
) {
  if (!currentVault) {
    return {
      storageMode: 'none' as const,
      vaultPath: '',
      remoteVaultUrl: ''
    }
  }

  if (currentVault.vaultType === 'backup') {
    return {
      storageMode: 'local-copy' as const,
      vaultPath: currentVault.path,
      remoteVaultUrl: ''
    }
  }

  if (currentVault.vaultType === 'network') {
    if (
      currentVault.networkPath?.startsWith('http://') ||
      currentVault.networkPath?.startsWith('https://')
    ) {
      return {
        storageMode: 'remote-http' as const,
        vaultPath: '',
        remoteVaultUrl: currentVault.networkPath
      }
    }

    if (currentVault.networkPath) {
      return {
        storageMode: 'local-copy' as const,
        vaultPath: currentVault.networkPath,
        remoteVaultUrl: ''
      }
    }
  }

  return {
    storageMode: 'none' as const,
    vaultPath: '',
    remoteVaultUrl: ''
  }
}

async function ensureRemoteClientContext(
  currentVault: ReturnType<ReturnType<typeof getDatabaseManager>['getCurrentVault']>
) {
  let v2ctx = getV2Context()
  const storage = resolveImportStorageConfig(currentVault)

  if (currentVault && storage.storageMode === 'remote-http' && v2ctx.networkV2Role === 'none') {
    try {
      const manager = getDatabaseManager()
      const retryResult = await manager.getVaultManager().retryNetworkService(currentVault.id)
      if (!retryResult.success) {
        throw new Error(retryResult.error || '重连失败')
      }
      v2ctx = getV2Context()
    } catch (error) {
      console.warn('[IPC] 远程资产库导入前重连失败:', error)
    }
  }

  return { v2ctx, storage }
}

/**
 * 导入资产文件列表（带依赖解析）
 */
ipcMain.handle(
  'asset:importWithDependencies',
  async (
    _,
    filePaths: string[],
    folderKey: string,
    config?: AssetImportConfig
  ): Promise<ImportResult> => {
    try {
      // 获取当前保管库信息
      const manager = getDatabaseManager()
      const currentVault = manager.getCurrentVault()
      const { v2ctx, storage } = await ensureRemoteClientContext(currentVault)
      if (storage.storageMode === 'remote-http' && v2ctx.networkV2Role === 'none') {
        throw new Error('远程资产服务器未连接，无法导入到服务器资产库，请先重连当前网络库')
      }

      const importManager = getImportManager({
        ...config,
        enableDependencyResolution: true,
        maxDependencyDepth: 20,
        storageMode: storage.storageMode,
        vaultPath: storage.vaultPath,
        remoteVaultUrl: storage.remoteVaultUrl,
        ...v2ctx,
        progressCallback: (progress) => {
          if (config?.progressCallback) {
            config.progressCallback(progress)
          }
        }
      })

      return await importManager.importAssets(filePaths, folderKey)
    } catch (error) {
      console.error('[IPC] 资产导入失败:', error)
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        processedAssets: 0,
        dependencyAssets: 0,
        skippedAssets: 0,
        errors: [error instanceof Error ? error.message : String(error)],
        assetKeys: []
      }
    }
  }
)

/**
 * 导入资产文件列表（不解析依赖）
 */
ipcMain.handle(
  'asset:importSimple',
  async (
    _,
    filePaths: string[],
    folderKey: string,
    config?: AssetImportConfig
  ): Promise<ImportResult> => {
    try {
      const dbManager = getDatabaseManager()
      const currentVault = dbManager.getCurrentVault()
      const { v2ctx, storage } = await ensureRemoteClientContext(currentVault)
      if (storage.storageMode === 'remote-http' && v2ctx.networkV2Role === 'none') {
        throw new Error('远程资产服务器未连接，无法导入到服务器资产库，请先重连当前网络库')
      }

      const manager = getImportManager({
        ...config,
        enableDependencyResolution: false,
        storageMode: storage.storageMode,
        vaultPath: storage.vaultPath,
        remoteVaultUrl: storage.remoteVaultUrl,
        ...v2ctx,
        progressCallback: (progress) => {
          if (config?.progressCallback) {
            config.progressCallback(progress)
          }
        }
      })

      return await manager.importAssets(filePaths, folderKey)
    } catch (error) {
      console.error('[IPC] 简单资产导入失败:', error)
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        processedAssets: 0,
        dependencyAssets: 0,
        skippedAssets: 0,
        errors: [error instanceof Error ? error.message : String(error)],
        assetKeys: []
      }
    }
  }
)

/**
 * 获取导入管理器统计信息
 */
ipcMain.handle('asset:getImportStats', async () => {
  try {
    if (!importManager) {
      return { cacheStats: { pathCacheSize: 0, processedPathsSize: 0 } }
    }
    return importManager.getStats()
  } catch (error) {
    console.error('[IPC] 获取导入统计失败:', error)
    return { cacheStats: { pathCacheSize: 0, processedPathsSize: 0 } }
  }
})

/**
 * 清理导入管理器资源
 */
ipcMain.handle('asset:clearImportCache', async () => {
  try {
    if (importManager) {
      importManager.dispose()
      importManager = null
    }
    return { success: true }
  } catch (error) {
    console.error('[IPC] 清理导入缓存失败:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * 批量导入资产（支持进度回调）
 */
ipcMain.handle(
  'asset:batchImportWithProgress',
  async (
    event,
    filePaths: string[],
    folderKey: string,
    config?: AssetImportConfig
  ): Promise<ImportResult> => {
    try {
      const dbManager = getDatabaseManager()
      const currentVault = dbManager.getCurrentVault()
      const { v2ctx, storage } = await ensureRemoteClientContext(currentVault)
      if (storage.storageMode === 'remote-http' && v2ctx.networkV2Role === 'none') {
        throw new Error('远程资产服务器未连接，无法导入到服务器资产库，请先重连当前网络库')
      }

      const manager = getImportManager({
        ...config,
        enableDependencyResolution: config?.enableDependencyResolution ?? true,
        storageMode: storage.storageMode,
        vaultPath: storage.vaultPath,
        remoteVaultUrl: storage.remoteVaultUrl,
        ...v2ctx,
        progressCallback: (progress) => {
          event.sender.send('asset:importProgress', progress)
        }
      })

      const result = await manager.importAssets(filePaths, folderKey)

      // 发送完成事件
      event.sender.send('asset:importCompleted', result)

      return result
    } catch (error) {
      console.error('[IPC] 批量资产导入失败:', error)
      const errorResult: ImportResult = {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        processedAssets: 0,
        dependencyAssets: 0,
        skippedAssets: 0,
        errors: [error instanceof Error ? error.message : String(error)],
        assetKeys: []
      }

      // 发送错误事件
      event.sender.send('asset:importError', errorResult)

      return errorResult
    }
  }
)

/**
 * 保存图片到资产库
 * 用于将图片保存到 AIGC 子目录
 */
ipcMain.handle(
  'assets:saveImageToLibrary',
  async (
    _,
    params: {
      imageData: string // URL 或 Base64
      fileName: string
      subFolder?: string // 子文件夹名称
    }
  ): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    try {
      // console.log('我正在处理一张图片')
      const { imageData, fileName, subFolder } = params

      // 动态导入依赖
      const { PathManager } = await import('../utils/PathManager')
      const { getVaultDatabase } = await import('../sqliteDataBase')
      const { createAssetFolder, getAssetFolderByKey } = await import(
        '../sqliteDataBase/models/assetFolder'
      )
      const { createAssetData } = await import('../sqliteDataBase/models/assetData')
      const { join } = await import('path')
      const { existsSync, promises: fs } = await import('fs')

      const pm = PathManager.getInstance()
      const vaultPath = pm.getCurrentVaultPath()

      // 构建目标目录路径
      const targetDir = subFolder
        ? join(vaultPath, 'AIGC', subFolder)
        : join(vaultPath, 'AIGC', '图片')

      // 确保目录存在
      if (!existsSync(targetDir)) {
        await fs.mkdir(targetDir, { recursive: true })
      }

      // 确保数据库文件夹结构
      const db = getVaultDatabase()
      if (!getAssetFolderByKey(db, 'AIGC')) {
        createAssetFolder(db, {
          folderKey: 'AIGC',
          fatherKey: null,
          type: 'system',
          folderName: 'AIGC',
          img: ''
        })
      }

      // 根据子文件夹创建对应的数据库记录
      const folderKey = subFolder ? `AIGC_${subFolder.toLowerCase()}` : 'AIGC_image'
      const folderName = subFolder || '图片'
      if (!getAssetFolderByKey(db, folderKey)) {
        createAssetFolder(db, {
          folderKey,
          fatherKey: 'AIGC',
          type: 'folder',
          folderName,
          img: ''
        })
      }

      const filePath = join(targetDir, fileName)

      // 下载或转换图片
      let buffer: Buffer
      if (imageData.startsWith('data:')) {
        // Base64 数据
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '')
        buffer = Buffer.from(base64Data, 'base64')
      } else if (imageData.startsWith('http')) {
        // HTTP URL
        const response = await fetch(imageData)
        if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)
        buffer = Buffer.from(await response.arrayBuffer())
      } else if (imageData.startsWith('file://')) {
        // 本地文件路径
        const localPath = imageData.replace('file://', '')
        buffer = await fs.readFile(localPath)
      } else {
        throw new Error('不支持的图片格式，请提供 URL、Base64 或 file:// 路径')
      }

      await fs.writeFile(filePath, buffer)

      // 创建资产记录
      createAssetData(db, {
        assetKey: `aigc_image_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        folderKey,
        assetName: fileName,
        filePath,
        originPath: filePath,
        fileSize: buffer.length,
        fileExtension: 'png',
        modifiedTime: new Date().toISOString(),
        processorType: 'AIGC',
        assetType: 'Texture',
        classNameCn: 'AIGC 图片',
        classColor: '#9B59B6'
      })

      console.log(`[IPC] 保存图片到资产库: ${filePath}`)
      return { success: true, filePath }
    } catch (error) {
      console.error('[IPC] 保存图片到资产库失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 重新导入单个资产
 */
ipcMain.handle('asset:reimportAsset', async (_, assetKey: string) => {
  try {
    const service = new AssetImportService()
    const success = await service.reimportAsset(assetKey)
    return { success }
  } catch (error) {
    console.error('[IPC] 重新导入资产失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

/**
 * 重新导入文件夹
 */
ipcMain.handle('asset:reimportFolder', async (_, folderKey: string) => {
  try {
    const service = new AssetImportService()
    const result = await service.reimportFolder(folderKey)
    return {
      success: true,
      total: result.total,
      successCount: result.success,
      failed: result.failed
    }
  } catch (error) {
    console.error('[IPC] 重新导入文件夹失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})
