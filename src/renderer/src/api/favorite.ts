/**
 * 资产收藏API接口
 */
export const favoriteAPI = {
  /**
   * 添加收藏
   * @param assetKey 资产键
   * @param userId 用户ID
   * @param vaultId 保管库ID
   * @returns 是否成功
   */
  add: async (assetKey: string, userId?: number, vaultId?: string): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.add(assetKey, userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    // 后端返回收藏ID，视为成功
    return typeof result.data === 'number' ? result.data > 0 : !!result.data
  },

  /**
   * 移除收藏
   * @param assetKey 资产键
   * @param userId 用户ID
   * @param vaultId 保管库ID
   * @returns 是否成功
   */
  remove: async (assetKey: string, userId?: number, vaultId?: string): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.remove(assetKey, userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 切换收藏状态
   * @param assetKey 资产键
   * @param userId 用户ID
   * @param vaultId 保管库ID
   * @returns 切换后的状态（true表示已收藏，false表示已取消收藏）
   */
  toggle: async (assetKey: string, userId?: number, vaultId?: string): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.toggle(assetKey, userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 检查是否已收藏
   * @param assetKey 资产键
   * @param userId 用户ID
   * @param vaultId 保管库ID
   * @returns 是否已收藏
   */
  isFavorite: async (assetKey: string, userId?: number, vaultId?: string): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.isFavorite(assetKey, userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 获取用户的收藏列表
   * @param userId 用户ID
   * @param vaultId 保管库ID
   * @returns 收藏列表
   */
  getFavoritesByUser: async (userId?: number, vaultId?: string): Promise<AssetFavorite[]> => {
    const result = await window.api.database.assetFavorite.getFavoritesByUser(userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 批量检查收藏状态
   * @param assetKeys 资产键数组
   * @param userId 用户ID
   * @param vaultId 保管库ID
   * @returns 收藏状态映射对象
   */
  batchCheckFavorites: async (
    assetKeys: string[],
    userId?: number,
    vaultId?: string
  ): Promise<Record<string, boolean>> => {
    const result = await window.api.database.assetFavorite.batchCheckFavorites(
      assetKeys,
      userId,
      vaultId
    )
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 获取收藏总数
   * @param userId 用户ID
   * @param vaultId 保管库ID
   * @returns 收藏总数
   */
  getFavoriteCount: async (userId?: number, vaultId?: string): Promise<number> => {
    const result = await window.api.database.assetFavorite.getFavoriteCount(userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 清空所有收藏
   * @param userId 用户ID
   * @param vaultId 保管库ID
   * @returns 是否成功
   */
  clearAllFavorites: async (userId?: number, vaultId?: string): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.clearAllFavorites(userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    // 返回是否操作成功（即使删除数量为0也视为成功）
    return !!result.success
  },

  // ========== 文件夹收藏相关 ==========

  /**
   * 添加文件夹到收藏
   * @param folderKey 文件夹键
   * @param userId 用户ID
   * @param vaultId 保管库ID
   */
  addFolder: async (folderKey: string, userId?: number, vaultId?: string): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.addFolder(folderKey, userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    return typeof result.data === 'number' ? result.data > 0 : !!result.data
  },

  /**
   * 从收藏中移除文件夹
   * @param folderKey 文件夹键
   * @param userId 用户ID
   * @param vaultId 保管库ID
   */
  removeFolder: async (folderKey: string, userId?: number, vaultId?: string): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.removeFolder(folderKey, userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 切换文件夹收藏状态
   * @param folderKey 文件夹键
   * @param userId 用户ID
   * @param vaultId 保管库ID
   */
  toggleFolder: async (folderKey: string, userId?: number, vaultId?: string): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.toggleFolder(folderKey, userId, vaultId)
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 检查文件夹是否已收藏
   * @param folderKey 文件夹键
   * @param userId 用户ID
   * @param vaultId 保管库ID
   */
  isFolderFavorite: async (
    folderKey: string,
    userId?: number,
    vaultId?: string
  ): Promise<boolean> => {
    const result = await window.api.database.assetFavorite.isFolderFavorite(
      folderKey,
      userId,
      vaultId
    )
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 获取收藏的文件夹详细信息
   * @param userId 用户ID
   * @param vaultId 保管库ID
   */
  getFavoriteFoldersWithDetails: async (
    userId?: number,
    vaultId?: string
  ): Promise<FavoriteFolder[]> => {
    const result = await window.api.database.assetFavorite.getFavoriteFoldersWithDetails(
      userId,
      vaultId
    )
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  },

  /**
   * 获取所有收藏项（资产和文件夹）
   * @param userId 用户ID
   * @param vaultId 保管库ID
   */
  getAllFavoritesWithDetails: async (
    userId?: number,
    vaultId?: string
  ): Promise<Array<AssetData | FavoriteFolder>> => {
    const result = await window.api.database.assetFavorite.getAllFavoritesWithDetails(
      userId,
      vaultId
    )
    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  }
}

/**
 * 收藏的文件夹类型
 */
export interface FavoriteFolder {
  id: string
  name: string
  type: 'folder'
  path: string
  folderKey: string
  folderName: string
  fatherKey?: string
  fullPath?: string
  size: number
  modifiedTime: string
  extension: string
  favorited_at?: string
}

export default favoriteAPI
