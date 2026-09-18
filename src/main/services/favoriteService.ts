import { VaultManager } from '../sqliteDataBase/VaultManager'
import {
  AssetFavorite,
  FavoriteItemType,
  addAssetFavorite,
  removeAssetFavorite,
  isAssetFavorited,
  getUserFavorites,
  getFavoriteAssetKeys,
  getFavoriteFolderKeys,
  batchCheckFavoriteStatus,
  getFavoriteCount,
  clearUserFavorites
} from '../sqliteDataBase/models/assetFavorite'
import { logger } from './logger'

export interface FavoriteServiceOptions {
  userId?: number
  vaultId?: string
}

/**
 * 收藏服务类
 * 提供资产收藏相关的业务逻辑
 */
export class FavoriteService {
  private vaultManager: VaultManager
  private defaultOptions: FavoriteServiceOptions

  constructor(vaultManager: VaultManager, options: FavoriteServiceOptions = {}) {
    this.vaultManager = vaultManager
    this.defaultOptions = options
  }

  /**
   * 添加资产或文件夹到收藏
   * @param assetKey 资产键值或文件夹键值
   * @param options 选项
   * @param itemType 收藏项类型（默认为 'asset'）
   * @returns 收藏记录ID
   */
  async addFavorite(
    assetKey: string,
    options: FavoriteServiceOptions = {},
    itemType: FavoriteItemType = 'asset'
  ): Promise<number> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        throw new Error('当前没有活跃的保管库')
      }

      const mergedOptions = { ...this.defaultOptions, ...options }

      // 检查是否已经收藏
      if (isAssetFavorited(db, assetKey, mergedOptions.userId, mergedOptions.vaultId, itemType)) {
        const typeLabel = itemType === 'folder' ? '文件夹' : '资产'
        logger.warn(`${typeLabel} ${assetKey} 已经在收藏中`)
        throw new Error(`${typeLabel}已经在收藏中`)
      }

      const favoriteId = addAssetFavorite(db, {
        assetKey,
        itemType,
        userId: mergedOptions.userId,
        vaultId: mergedOptions.vaultId
      })

      const typeLabel = itemType === 'folder' ? '文件夹' : '资产'
      logger.info(`${typeLabel} ${assetKey} 添加到收藏成功，ID: ${favoriteId}`)
      return favoriteId
    } catch (error) {
      logger.error(`添加收藏失败: ${error}`)
      throw error
    }
  }

  /**
   * 从收藏中移除资产或文件夹
   * @param assetKey 资产键值或文件夹键值
   * @param options 选项
   * @param itemType 收藏项类型（默认为 'asset'）
   * @returns 是否移除成功
   */
  async removeFavorite(
    assetKey: string,
    options: FavoriteServiceOptions = {},
    itemType: FavoriteItemType = 'asset'
  ): Promise<boolean> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        throw new Error('当前没有活跃的保管库')
      }

      const mergedOptions = { ...this.defaultOptions, ...options }

      const success = removeAssetFavorite(
        db,
        assetKey,
        mergedOptions.userId,
        mergedOptions.vaultId,
        itemType
      )

      const typeLabel = itemType === 'folder' ? '文件夹' : '资产'
      if (success) {
        logger.info(`${typeLabel} ${assetKey} 从收藏中移除成功`)
      } else {
        logger.warn(`${typeLabel} ${assetKey} 不在收藏中或移除失败`)
      }

      return success
    } catch (error) {
      logger.error(`移除收藏失败: ${error}`)
      throw error
    }
  }

  /**
   * 切换资产或文件夹收藏状态
   * @param assetKey 资产键值或文件夹键值
   * @param options 选项
   * @param itemType 收藏项类型（默认为 'asset'）
   * @returns 切换后的收藏状态
   */
  async toggleFavorite(
    assetKey: string,
    options: FavoriteServiceOptions = {},
    itemType: FavoriteItemType = 'asset'
  ): Promise<boolean> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        throw new Error('当前没有活跃的保管库')
      }

      const mergedOptions = { ...this.defaultOptions, ...options }
      const isFavorited = isAssetFavorited(
        db,
        assetKey,
        mergedOptions.userId,
        mergedOptions.vaultId,
        itemType
      )

      if (isFavorited) {
        await this.removeFavorite(assetKey, options, itemType)
        return false
      } else {
        await this.addFavorite(assetKey, options, itemType)
        return true
      }
    } catch (error) {
      logger.error(`切换收藏状态失败: ${error}`)
      throw error
    }
  }

  /**
   * 检查资产或文件夹是否已收藏
   * @param assetKey 资产键值或文件夹键值
   * @param options 选项
   * @param itemType 收藏项类型（默认为 'asset'）
   * @returns 是否已收藏
   */
  async isFavorited(
    assetKey: string,
    options: FavoriteServiceOptions = {},
    itemType: FavoriteItemType = 'asset'
  ): Promise<boolean> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        return false
      }

      const mergedOptions = { ...this.defaultOptions, ...options }
      return isAssetFavorited(db, assetKey, mergedOptions.userId, mergedOptions.vaultId, itemType)
    } catch (error) {
      logger.error(`检查收藏状态失败: ${error}`)
      return false
    }
  }

  /**
   * 获取用户的所有收藏
   * @param options 选项
   * @returns 收藏列表
   */
  async getFavorites(options: FavoriteServiceOptions = {}): Promise<AssetFavorite[]> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        return []
      }

      const mergedOptions = { ...this.defaultOptions, ...options }
      return getUserFavorites(db, mergedOptions.userId, mergedOptions.vaultId)
    } catch (error) {
      logger.error(`获取收藏列表失败: ${error}`)
      return []
    }
  }

  /**
   * 获取收藏的资产键值列表
   * @param options 选项
   * @returns 资产键值数组
   */
  async getFavoriteAssetKeys(options: FavoriteServiceOptions = {}): Promise<string[]> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        return []
      }

      const mergedOptions = { ...this.defaultOptions, ...options }
      return getFavoriteAssetKeys(db, mergedOptions.userId, mergedOptions.vaultId)
    } catch (error) {
      logger.error(`获取收藏资产键值失败: ${error}`)
      return []
    }
  }

  /**
   * 批量检查资产收藏状态
   * @param assetKeys 资产键值数组
   * @param options 选项
   * @returns 收藏状态映射
   */
  async batchCheckFavoriteStatus(
    assetKeys: string[],
    options: FavoriteServiceOptions = {}
  ): Promise<Record<string, boolean>> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        return {}
      }

      const mergedOptions = { ...this.defaultOptions, ...options }
      return batchCheckFavoriteStatus(db, assetKeys, mergedOptions.userId, mergedOptions.vaultId)
    } catch (error) {
      logger.error(`批量检查收藏状态失败: ${error}`)
      return {}
    }
  }

  /**
   * 获取收藏总数
   * @param options 选项
   * @returns 收藏总数
   */
  async getFavoriteCount(options: FavoriteServiceOptions = {}): Promise<number> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        return 0
      }

      const mergedOptions = { ...this.defaultOptions, ...options }
      return getFavoriteCount(db, mergedOptions.userId, mergedOptions.vaultId)
    } catch (error) {
      logger.error(`获取收藏总数失败: ${error}`)
      return 0
    }
  }

  /**
   * 清空用户的所有收藏
   * @param options 选项
   * @returns 删除的记录数
   */
  async clearFavorites(options: FavoriteServiceOptions = {}): Promise<number> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        return 0
      }

      const mergedOptions = { ...this.defaultOptions, ...options }
      const deletedCount = clearUserFavorites(db, mergedOptions.userId, mergedOptions.vaultId)

      logger.info(`清空收藏成功，删除了 ${deletedCount} 条记录`)
      return deletedCount
    } catch (error) {
      logger.error(`清空收藏失败: ${error}`)
      throw error
    }
  }

  /**
   * 获取收藏的资产详细信息
   * @param options 选项
   * @returns 收藏的资产信息
   */
  async getFavoriteAssetsWithDetails(
    options: FavoriteServiceOptions = {}
  ): Promise<Record<string, unknown>[]> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        return []
      }

      const mergedOptions = { ...this.defaultOptions, ...options }

      // 获取收藏的资产键值
      const favoriteKeys = getFavoriteAssetKeys(db, mergedOptions.userId, mergedOptions.vaultId)

      if (favoriteKeys.length === 0) {
        return []
      }

      // 查询资产详细信息
      const placeholders = favoriteKeys.map(() => '?').join(',')
      const stmt = db.prepare(`
        SELECT ad.*, fav.created_at as favorited_at
        FROM assetData ad
        INNER JOIN asset_favorites fav ON ad.assetKey = fav.assetKey
        INNER JOIN assetFolder fol ON ad.folderKey = fol.folderKey AND fol.isDelete = 0
        WHERE ad.assetKey IN (${placeholders})
          AND ad.isDelete = 0
          AND fav.itemType = 'asset'
          AND (fav.userId = ? OR fav.userId IS NULL)
          AND (fav.vaultId = ? OR fav.vaultId IS NULL)
        ORDER BY fav.created_at DESC
      `)

      return stmt.all(
        ...favoriteKeys,
        mergedOptions.userId || null,
        mergedOptions.vaultId || null
      ) as Record<string, unknown>[]
    } catch (error) {
      logger.error(`获取收藏资产详情失败: ${error}`)
      return []
    }
  }

  /**
   * 获取收藏的文件夹详细信息
   * @param options 选项
   * @returns 收藏的文件夹信息
   */
  async getFavoriteFoldersWithDetails(
    options: FavoriteServiceOptions = {}
  ): Promise<Record<string, unknown>[]> {
    try {
      const db = this.vaultManager.getCurrentVaultDatabase()
      if (!db) {
        return []
      }

      const mergedOptions = { ...this.defaultOptions, ...options }

      // 获取收藏的文件夹键值
      const folderKeys = getFavoriteFolderKeys(db, mergedOptions.userId, mergedOptions.vaultId)

      if (folderKeys.length === 0) {
        return []
      }

      // 查询文件夹详细信息
      const placeholders = folderKeys.map(() => '?').join(',')
      const stmt = db.prepare(`
        SELECT af.*, fav.created_at as favorited_at, 'folder' as type
        FROM assetFolder af
        INNER JOIN asset_favorites fav ON af.folderKey = fav.assetKey
        WHERE af.folderKey IN (${placeholders})
          AND af.isDelete = 0
          AND fav.itemType = 'folder'
          AND (fav.userId = ? OR fav.userId IS NULL)
          AND (fav.vaultId = ? OR fav.vaultId IS NULL)
        ORDER BY fav.created_at DESC
      `)

      const rows = stmt.all(
        ...folderKeys,
        mergedOptions.userId || null,
        mergedOptions.vaultId || null
      ) as Record<string, unknown>[]

      // 转换格式以便前端使用
      return rows.map((folder) => ({
        id: folder.folderKey,
        name: folder.folderName,
        type: 'folder',
        path: folder.fullPath || '',
        folderKey: folder.folderKey,
        folderName: folder.folderName,
        fatherKey: folder.fatherKey,
        fullPath: folder.fullPath,
        size: 0,
        modifiedTime: folder.updated_at || folder.created_at || new Date().toISOString(),
        extension: '',
        favorited_at: folder.favorited_at
      }))
    } catch (error) {
      logger.error(`获取收藏文件夹详情失败: ${error}`)
      return []
    }
  }

  /**
   * 获取所有收藏项（包含资产和文件夹）
   * @param options 选项
   * @returns 收藏的资产和文件夹信息
   */
  async getAllFavoritesWithDetails(
    options: FavoriteServiceOptions = {}
  ): Promise<Record<string, unknown>[]> {
    try {
      // 同时获取资产和文件夹
      const [assets, folders] = await Promise.all([
        this.getFavoriteAssetsWithDetails(options),
        this.getFavoriteFoldersWithDetails(options)
      ])

      // 合并并按收藏时间排序，文件夹排在前面
      const all = [...folders, ...assets]
      return all
    } catch (error) {
      logger.error(`获取所有收藏项失败: ${error}`)
      return []
    }
  }
}

/**
 * 创建收藏服务实例
 * @param vaultManager 保管库管理器
 * @param options 选项
 * @returns 收藏服务实例
 */
export const createFavoriteService = (
  vaultManager: VaultManager,
  options: FavoriteServiceOptions = {}
): FavoriteService => {
  return new FavoriteService(vaultManager, options)
}
