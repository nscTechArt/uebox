import { ipcMain } from 'electron'
import { getVaultDatabase } from '../index'
import {
  addAssetTag,
  removeAssetTag,
  getTagIdsByAssetKey,
  getAssetsByTagId,
  getAssetsByAnyTag,
  getAssetsByAllTags,
  setTagsForAsset,
  filterAssetsByTags,
  getAssetCountsByTag,
  TagFilterOptions
} from '../models/assetTag'
// V1 NetworkVaultSync removed — V2 ChangeTracker handles sync automatically
import Database from 'better-sqlite3'

/**
 * V2: 标签同步现由 ChangeTracker 自动处理，无需手动写 journal
 */
const syncTagsToNetwork = async (_vaultDb: Database.Database, _assetKey: string): Promise<void> => {
  // V2 ChangeTracker handles this automatically
}

/**
 * 注册资产-标签关联的IPC处理函数
 */
export const registerAssetTagIPC = (): void => {
  // 为资产添加标签
  ipcMain.handle('db:assetTag:add', async (_, assetKey: string, tagId: number) => {
    void _
    try {
      const db = getVaultDatabase()
      const id = addAssetTag(db, { assetKey, tagId })
      // 🔧 同步标签到网络库
      await syncTagsToNetwork(db, assetKey)
      return { success: true, data: id }
    } catch (error) {
      console.error('添加资产标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 从资产移除标签
  ipcMain.handle('db:assetTag:remove', async (_, assetKey: string, tagId: number) => {
    void _
    try {
      const db = getVaultDatabase()
      const ok = removeAssetTag(db, assetKey, tagId)
      // 🔧 同步标签到网络库
      if (ok) await syncTagsToNetwork(db, assetKey)
      return { success: ok, data: ok }
    } catch (error) {
      console.error('移除资产标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取资产关联的标签ID列表
  ipcMain.handle('db:assetTag:getTagIdsByAssetKey', async (_, assetKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const tagIds = getTagIdsByAssetKey(db, assetKey)
      return { success: true, data: tagIds }
    } catch (error) {
      console.error('获取资产标签ID失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取某标签下的资产详细信息
  ipcMain.handle('db:assetTag:getAssetsByTagId', async (_, tagId: number) => {
    void _
    try {
      const db = getVaultDatabase()
      const assets = getAssetsByTagId(db, tagId)
      return { success: true, data: assets }
    } catch (error) {
      console.error('按标签获取资产失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取任意一个标签命中的资产（并集）
  ipcMain.handle('db:assetTag:getAssetsByAnyTag', async (_, tagIds: number[]) => {
    void _
    try {
      const db = getVaultDatabase()
      const assets = getAssetsByAnyTag(db, tagIds)
      return { success: true, data: assets }
    } catch (error) {
      console.error('按任意标签获取资产失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取同时命中所有标签的资产（交集）
  ipcMain.handle('db:assetTag:getAssetsByAllTags', async (_, tagIds: number[]) => {
    void _
    try {
      const db = getVaultDatabase()
      const assets = getAssetsByAllTags(db, tagIds)
      return { success: true, data: assets }
    } catch (error) {
      console.error('按所有标签获取资产失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 设置资产的标签集合（原子性替换）
  ipcMain.handle('db:assetTag:setTagsForAsset', async (_, assetKey: string, tagIds: number[]) => {
    void _
    try {
      const db = getVaultDatabase()
      const result = setTagsForAsset(db, assetKey, tagIds)
      // 🔧 同步标签到网络库
      await syncTagsToNetwork(db, assetKey)
      return { success: true, data: result }
    } catch (error) {
      console.error('设置资产标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 综合筛选：包含/排除/模式/按文件夹
  ipcMain.handle('db:assetTag:filterAssets', async (_, options: TagFilterOptions) => {
    void _
    try {
      const db = getVaultDatabase()
      const assets = filterAssetsByTags(db, options)
      return { success: true, data: assets }
    } catch (error) {
      console.error('综合标签筛选失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 每个标签在**当前保管库**里打在多少个资产上。
   *
   * 注意这个数字是按库算的：标签本身存在公共库（全局共享），而 asset_tags 存在
   * 保管库里。所以「用了 0 次」只代表在当前库里没用过，别的库可能正在用 ——
   * 界面上必须照实说成「本库用量」，不能让人以为可以放心删。
   */
  ipcMain.handle('db:assetTag:getUsageCounts', async () => {
    try {
      const db = getVaultDatabase()
      return { success: true, data: getAssetCountsByTag(db) }
    } catch (error) {
      console.error('统计标签用量失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
