import { ipcMain } from 'electron'
import { VaultManager } from '../VaultManager'
import { createFavoriteService, FavoriteServiceOptions } from '../../services/favoriteService'
import { logger } from '../../services/logger'

/**
 * 注册资产收藏相关的IPC处理器
 * @param vaultManager 保管库管理器
 */
export const registerAssetFavoriteIpcHandlers = (vaultManager: VaultManager): void => {
  /**
   * 添加资产到收藏
   */
  ipcMain.handle(
    'db:assetFavorite:add',
    async (_, assetKey: string, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const favoriteId = await favoriteService.addFavorite(assetKey, { userId, vaultId })

        return {
          success: true,
          data: favoriteId,
          message: '添加收藏成功'
        }
      } catch (error) {
        logger.error('IPC - 添加收藏失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '添加收藏失败',
          message: '添加收藏失败'
        }
      }
    }
  )

  /**
   * 从收藏中移除资产
   */
  ipcMain.handle(
    'db:assetFavorite:remove',
    async (_, assetKey: string, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const success = await favoriteService.removeFavorite(assetKey, { userId, vaultId })

        return {
          success,
          data: success,
          message: success ? '移除收藏成功' : '资产不在收藏中'
        }
      } catch (error) {
        logger.error('IPC - 移除收藏失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '移除收藏失败',
          message: '移除收藏失败'
        }
      }
    }
  )

  /**
   * 切换资产收藏状态
   */
  ipcMain.handle(
    'db:assetFavorite:toggle',
    async (_, assetKey: string, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const isFavorited = await favoriteService.toggleFavorite(assetKey, { userId, vaultId })

        return {
          success: true,
          data: isFavorited,
          message: isFavorited ? '添加收藏成功' : '移除收藏成功'
        }
      } catch (error) {
        logger.error('IPC - 切换收藏状态失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '切换收藏状态失败',
          message: '切换收藏状态失败'
        }
      }
    }
  )

  /**
   * 检查资产是否已收藏
   */
  ipcMain.handle(
    'db:assetFavorite:isFavorite',
    async (_, assetKey: string, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const isFavorited = await favoriteService.isFavorited(assetKey, { userId, vaultId })

        return {
          success: true,
          data: isFavorited,
          message: '查询收藏状态成功'
        }
      } catch (error) {
        logger.error('IPC - 查询收藏状态失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '查询收藏状态失败',
          message: '查询收藏状态失败'
        }
      }
    }
  )

  /**
   * 获取用户的所有收藏
   */
  ipcMain.handle(
    'db:assetFavorite:getFavoritesByUser',
    async (_, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const favorites = await favoriteService.getFavorites({ userId, vaultId })

        return {
          success: true,
          data: favorites,
          message: '获取收藏列表成功'
        }
      } catch (error) {
        logger.error('IPC - 获取收藏列表失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '获取收藏列表失败',
          message: '获取收藏列表失败'
        }
      }
    }
  )

  /**
   * 获取收藏的资产键值列表
   */
  ipcMain.handle(
    'asset-favorite:get-asset-keys',
    async (_, options: FavoriteServiceOptions = {}) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, options)
        const assetKeys = await favoriteService.getFavoriteAssetKeys(options)

        return {
          success: true,
          data: assetKeys,
          message: '获取收藏资产键值成功'
        }
      } catch (error) {
        logger.error('IPC - 获取收藏资产键值失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '获取收藏资产键值失败',
          message: '获取收藏资产键值失败'
        }
      }
    }
  )

  /**
   * 批量检查资产收藏状态
   */
  ipcMain.handle(
    'db:assetFavorite:batchCheckFavorites',
    async (_, assetKeys: string[], userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const statusMap = await favoriteService.batchCheckFavoriteStatus(assetKeys, {
          userId,
          vaultId
        })

        return {
          success: true,
          data: statusMap,
          message: '批量检查收藏状态成功'
        }
      } catch (error) {
        logger.error('IPC - 批量检查收藏状态失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '批量检查收藏状态失败',
          message: '批量检查收藏状态失败'
        }
      }
    }
  )

  /**
   * 获取收藏总数
   */
  ipcMain.handle(
    'db:assetFavorite:getFavoriteCount',
    async (_, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const count = await favoriteService.getFavoriteCount({ userId, vaultId })

        return {
          success: true,
          data: count,
          message: '获取收藏总数成功'
        }
      } catch (error) {
        logger.error('IPC - 获取收藏总数失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '获取收藏总数失败',
          message: '获取收藏总数失败'
        }
      }
    }
  )

  /**
   * 清空用户的所有收藏
   */
  ipcMain.handle(
    'db:assetFavorite:clearAllFavorites',
    async (_, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const deletedCount = await favoriteService.clearFavorites({ userId, vaultId })

        return {
          success: true,
          data: deletedCount,
          message: `清空收藏成功，删除了 ${deletedCount} 条记录`
        }
      } catch (error) {
        logger.error('IPC - 清空收藏失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '清空收藏失败',
          message: '清空收藏失败'
        }
      }
    }
  )

  // ==================== 文件夹收藏相关 IPC 处理器 ====================

  /**
   * 添加文件夹到收藏
   */
  ipcMain.handle(
    'db:assetFavorite:addFolder',
    async (_, folderKey: string, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const favoriteId = await favoriteService.addFavorite(
          folderKey,
          { userId, vaultId },
          'folder'
        )

        return {
          success: true,
          data: favoriteId,
          message: '添加文件夹到收藏成功'
        }
      } catch (error) {
        logger.error('IPC - 添加文件夹收藏失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '添加文件夹收藏失败',
          message: '添加文件夹收藏失败'
        }
      }
    }
  )

  /**
   * 从收藏中移除文件夹
   */
  ipcMain.handle(
    'db:assetFavorite:removeFolder',
    async (_, folderKey: string, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const success = await favoriteService.removeFavorite(
          folderKey,
          { userId, vaultId },
          'folder'
        )

        return {
          success,
          data: success,
          message: success ? '移除文件夹收藏成功' : '文件夹不在收藏中'
        }
      } catch (error) {
        logger.error('IPC - 移除文件夹收藏失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '移除文件夹收藏失败',
          message: '移除文件夹收藏失败'
        }
      }
    }
  )

  /**
   * 切换文件夹收藏状态
   */
  ipcMain.handle(
    'db:assetFavorite:toggleFolder',
    async (_, folderKey: string, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const isFavorited = await favoriteService.toggleFavorite(
          folderKey,
          { userId, vaultId },
          'folder'
        )

        return {
          success: true,
          data: isFavorited,
          message: isFavorited ? '添加文件夹到收藏成功' : '移除文件夹收藏成功'
        }
      } catch (error) {
        logger.error('IPC - 切换文件夹收藏状态失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '切换文件夹收藏状态失败',
          message: '切换文件夹收藏状态失败'
        }
      }
    }
  )

  /**
   * 检查文件夹是否已收藏
   */
  ipcMain.handle(
    'db:assetFavorite:isFolderFavorite',
    async (_, folderKey: string, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const isFavorited = await favoriteService.isFavorited(
          folderKey,
          { userId, vaultId },
          'folder'
        )

        return {
          success: true,
          data: isFavorited,
          message: '查询文件夹收藏状态成功'
        }
      } catch (error) {
        logger.error('IPC - 查询文件夹收藏状态失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '查询文件夹收藏状态失败',
          message: '查询文件夹收藏状态失败'
        }
      }
    }
  )

  /**
   * 获取收藏的文件夹详细信息
   */
  ipcMain.handle(
    'db:assetFavorite:getFavoriteFoldersWithDetails',
    async (_, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const folders = await favoriteService.getFavoriteFoldersWithDetails({ userId, vaultId })

        return {
          success: true,
          data: folders,
          message: '获取收藏文件夹详情成功'
        }
      } catch (error) {
        logger.error('IPC - 获取收藏文件夹详情失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '获取收藏文件夹详情失败',
          message: '获取收藏文件夹详情失败'
        }
      }
    }
  )

  /**
   * 获取所有收藏项（资产和文件夹）
   */
  ipcMain.handle(
    'db:assetFavorite:getAllFavoritesWithDetails',
    async (_, userId: number, vaultId: string) => {
      void _
      try {
        const favoriteService = createFavoriteService(vaultManager, { userId, vaultId })
        const items = await favoriteService.getAllFavoritesWithDetails({ userId, vaultId })

        return {
          success: true,
          data: items,
          message: '获取所有收藏项成功'
        }
      } catch (error) {
        logger.error('IPC - 获取所有收藏项失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '获取所有收藏项失败',
          message: '获取所有收藏项失败'
        }
      }
    }
  )

  logger.info('资产收藏 IPC 处理器注册完成')
}
