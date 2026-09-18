import { ipcMain } from 'electron'
import { join } from 'path'
import {
  VaultManager,
  type CreateVaultConfig,
  type VaultInfo
} from '../sqliteDataBase/VaultManager'
import {
  cleanThumbnailCache,
  checkWritePermission,
  type CleanupResult
} from '../services/cache/CacheCleanupService'
import { getNetworkVaultSync } from '../smb/NetworkVaultSync'
import { hostname } from 'os'

// ... existing imports ...

/**
 * 注册保管库相关的IPC处理函数
 */
export const registerVaultIPC = (): void => {
  console.log('注册保管库IPC处理器')
}

/**
 * 获取本机主机名
 */
ipcMain.handle('app:getHostname', () => {
  return hostname()
})

// ...

// ...

/**
 * 更新保管库图标
 */
ipcMain.handle(
  'vault:updateIcon',
  async (_, vaultId: string, iconPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const vaultInfo = vaultManager.getVaultById(vaultId)

      const success = await vaultManager.updateVaultIcon(vaultId, iconPath)

      if (success && vaultInfo && vaultInfo.vaultType === 'network' && vaultInfo.networkPath) {
        // 如果是网络保管库，同步更新 Manifest
        try {
          const syncManager = getNetworkVaultSync()
          await syncManager.updateVaultBasicInfo(
            vaultInfo.networkPath,
            { icon: iconPath },
            hostname()
          )
        } catch (syncError) {
          console.error('[IPC] 同步保管库图标到网络失败:', syncError)
          // 不阻断本地更新成功的返回，但打日志
        }
      }

      if (success) {
        return { success: true }
      } else {
        return { success: false, error: '更新图标失败' }
      }
    } catch (error) {
      console.error('[IPC] 更新保管库图标失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 重命名保管库
 */
ipcMain.handle(
  'vault:rename',
  async (_, vaultId: string, newName: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const vaultInfo = vaultManager.getVaultById(vaultId)

      const success = await vaultManager.renameVault(vaultId, newName)

      if (success && vaultInfo && vaultInfo.vaultType === 'network' && vaultInfo.networkPath) {
        // 如果是网络保管库，同步更新 Manifest
        try {
          const syncManager = getNetworkVaultSync()
          await syncManager.updateVaultBasicInfo(
            vaultInfo.networkPath,
            { name: newName },
            hostname()
          )
        } catch (syncError) {
          console.error('[IPC] 同步保管库名称到网络失败:', syncError)
          // 不阻断本地更新成功的返回，但打日志
        }
      }

      if (success) {
        return { success: true }
      } else {
        return { success: false, error: '重命名失败' }
      }
    } catch (error) {
      console.error('[IPC] 重命名保管库失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 更新共享浏览路径
 */
ipcMain.handle(
  'vault:updateBrowsePath',
  async (
    _,
    vaultId: string,
    browsePath?: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const success = await vaultManager.updateVaultBrowsePath(vaultId, browsePath)

      if (success) {
        return { success: true }
      }
      return { success: false, error: '更新共享浏览路径失败' }
    } catch (error) {
      console.error('[IPC] 更新共享浏览路径失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 更新网络保管库连接地址
 */
ipcMain.handle(
  'vault:updateNetworkPath',
  async (
    _,
    vaultId: string,
    networkPath: string
  ): Promise<{ success: boolean; data?: { networkError?: string }; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const result = await vaultManager.updateVaultNetworkPath(vaultId, networkPath)

      return { success: true, data: result }
    } catch (error) {
      console.error('[IPC] 更新网络保管库地址失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 获取所有保管库列表
 */
ipcMain.handle(
  'vault:getAll',
  async (): Promise<{ success: boolean; data?: VaultInfo[]; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const vaults = vaultManager.getAllVaults()

      return { success: true, data: vaults }
    } catch (error) {
      console.error('[IPC] 获取保管库列表失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 重试网络保管库连接
 */
ipcMain.handle(
  'vault:checkUpgradeReadiness',
  async (
    _,
    vaultId: string
  ): Promise<{
    success: boolean
    data?: { ready: boolean; error?: string; assetCount: number; folderCount: number }
    error?: string
  }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const result = await vaultManager.checkNetworkUpgradeReadiness(vaultId)
      return { success: true, data: result }
    } catch (error) {
      console.error('[IPC] 检查网络库升级准备状态失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

ipcMain.handle(
  'vault:retryNetwork',
  async (
    _,
    vaultId: string
  ): Promise<{
    success: boolean
    error?: string
    audit?: {
      backupPath: string
      beforeAssetCount: number
      afterAssetCount: number
      beforeFolderCount: number
      afterFolderCount: number
      hasDrift: boolean
    }
  }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      return await vaultManager.retryNetworkService(vaultId)
    } catch (error) {
      console.error('[IPC] 重试网络连接失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 更新保管库排序
 */
ipcMain.handle(
  'vault:updateOrder',
  async (_, vaultIds: string[]): Promise<{ success: boolean; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      vaultManager.updateVaultOrder(vaultIds)

      return { success: true }
    } catch (error) {
      console.error('[IPC] 更新保管库排序失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 获取当前活跃保管库
 */
ipcMain.handle(
  'vault:getCurrent',
  async (): Promise<{ success: boolean; data?: VaultInfo; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const currentVault = vaultManager.getCurrentVault()

      return { success: true, data: currentVault || undefined }
    } catch (error) {
      console.error('[IPC] 获取当前保管库失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 创建新保管库
 */
ipcMain.handle(
  'vault:create',
  async (
    _,
    config: CreateVaultConfig
  ): Promise<{ success: boolean; data?: VaultInfo; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const vaultInfo = await vaultManager.createVault(config)

      return { success: true, data: vaultInfo }
    } catch (error) {
      console.error('[IPC] 创建保管库失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 切换保管库
 */
ipcMain.handle(
  'vault:switch',
  async (_, vaultId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const result = await vaultManager.switchToVault(vaultId)

      // 直接返回 VaultManager 的结果（包含具体错误信息）
      return result
    } catch (error) {
      console.error('[IPC] 切换保管库失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 移动保管库
 */
ipcMain.handle(
  'vault:move',
  async (
    _,
    vaultId: string,
    newParentPath: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      await vaultManager.moveVault(vaultId, newParentPath)
      return { success: true }
    } catch (error) {
      console.error('[IPC] 移动保管库失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 删除保管库
 */
ipcMain.handle(
  'vault:delete',
  async (_, vaultId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const success = await vaultManager.deleteVault(vaultId)

      if (success) {
        return { success: true }
      } else {
        return { success: false, error: '删除保管库失败' }
      }
    } catch (error) {
      console.error('[IPC] 删除保管库失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 验证保管库路径
 */
ipcMain.handle(
  'vault:validatePath',
  async (
    _,
    customPath: string
  ): Promise<{ valid: boolean; error?: string; warnings?: string[] }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const result = await vaultManager.validateCustomPath(customPath)

      return result
    } catch (error) {
      console.error('[IPC] 验证保管库路径失败:', error)
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 获取保管库统计信息
 */
ipcMain.handle(
  'vault:getStats',
  async (_, vaultId: string): Promise<{ success: boolean; data?: any; error?: string }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      await vaultManager.updateVaultStats(vaultId)
      const vaultInfo = vaultManager.getVaultById(vaultId)

      return {
        success: true,
        data: {
          assetCount: vaultInfo?.assetCount || 0,
          totalSize: vaultInfo?.totalSize || 0
        }
      }
    } catch (error) {
      console.error('[IPC] 获取保管库统计失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

/**
 * 清理未使用的缩略图缓存
 */
ipcMain.handle(
  'vault:cleanThumbnailCache',
  async (): Promise<{
    success: boolean
    data?: CleanupResult
    error?: string
  }> => {
    try {
      const vaultManager = VaultManager.getInstance()
      const currentVault = vaultManager.getCurrentVault()

      if (!currentVault) {
        return { success: false, error: '未选择保管库' }
      }

      // 获取缩略图目录路径（仅 SMB 共享路径使用 networkPath）
      let thumbnailsDir: string
      if (
        currentVault.vaultType === 'network' &&
        currentVault.networkPath &&
        !currentVault.networkPath.startsWith('http')
      ) {
        thumbnailsDir = join(currentVault.networkPath, '.thumbnails')
      } else {
        thumbnailsDir = join(currentVault.path, 'thumbnails')
      }

      // 获取保管库数据库
      const vaultDb = vaultManager.getCurrentVaultDatabase()
      if (!vaultDb) {
        return { success: false, error: '无法获取保管库数据库' }
      }

      // 对于网络库，需要检查写入权限
      if (currentVault.vaultType === 'network') {
        const hasPermission = await checkWritePermission(thumbnailsDir)
        if (!hasPermission) {
          return {
            success: false,
            error: 'NO_WRITE_PERMISSION'
          }
        }
      }

      // 执行清理
      const result = await cleanThumbnailCache(vaultDb, thumbnailsDir, false)

      return { success: result.success, data: result, error: result.error }
    } catch (error) {
      console.error('[IPC] 清理缩略图缓存失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)
