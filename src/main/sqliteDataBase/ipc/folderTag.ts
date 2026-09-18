import { ipcMain } from 'electron'
import { getVaultDatabase } from '../index'
import {
  addFolderTag,
  removeFolderTag,
  getTagIdsByFolderKey,
  getFoldersByTagId,
  getFoldersByAnyTag,
  getFoldersByAllTags,
  setTagsForFolder,
  addTagsToFolder,
  removeTagsFromFolder,
  clearFolderTags,
  countFoldersWithTag
} from '../models/folderTag'

/**
 * 注册文件夹-标签关联的IPC处理函数
 */
export const registerFolderTagIPC = (): void => {
  // 为文件夹添加标签
  ipcMain.handle('db:folderTag:add', async (_, folderKey: string, tagId: number) => {
    void _
    try {
      const db = getVaultDatabase()
      const id = addFolderTag(db, { folderKey, tagId })
      return { success: true, data: id }
    } catch (error) {
      console.error('添加文件夹标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 从文件夹移除标签
  ipcMain.handle('db:folderTag:remove', async (_, folderKey: string, tagId: number) => {
    void _
    try {
      const db = getVaultDatabase()
      const ok = removeFolderTag(db, folderKey, tagId)
      return { success: ok, data: ok }
    } catch (error) {
      console.error('移除文件夹标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取文件夹关联的标签ID列表
  ipcMain.handle('db:folderTag:getTagIdsByFolderKey', async (_, folderKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const tagIds = getTagIdsByFolderKey(db, folderKey)
      return { success: true, data: tagIds }
    } catch (error) {
      console.error('获取文件夹标签ID失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取某标签下的文件夹详细信息
  ipcMain.handle('db:folderTag:getFoldersByTagId', async (_, tagId: number) => {
    void _
    try {
      const db = getVaultDatabase()
      const folders = getFoldersByTagId(db, tagId)
      return { success: true, data: folders }
    } catch (error) {
      console.error('按标签获取文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取任意一个标签命中的文件夹（并集）
  ipcMain.handle('db:folderTag:getFoldersByAnyTag', async (_, tagIds: number[]) => {
    void _
    try {
      const db = getVaultDatabase()
      const folders = getFoldersByAnyTag(db, tagIds)
      return { success: true, data: folders }
    } catch (error) {
      console.error('按任意标签获取文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取同时命中所有标签的文件夹（交集）
  ipcMain.handle('db:folderTag:getFoldersByAllTags', async (_, tagIds: number[]) => {
    void _
    try {
      const db = getVaultDatabase()
      const folders = getFoldersByAllTags(db, tagIds)
      return { success: true, data: folders }
    } catch (error) {
      console.error('按所有标签获取文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 设置文件夹的标签集合（原子性替换）
  ipcMain.handle(
    'db:folderTag:setTagsForFolder',
    async (_, folderKey: string, tagIds: number[]) => {
      void _
      try {
        const db = getVaultDatabase()
        const result = setTagsForFolder(db, folderKey, tagIds)
        return { success: true, data: result }
      } catch (error) {
        console.error('设置文件夹标签失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 批量添加标签到文件夹
  ipcMain.handle('db:folderTag:addTagsToFolder', async (_, folderKey: string, tagIds: number[]) => {
    void _
    try {
      const db = getVaultDatabase()
      const count = addTagsToFolder(db, folderKey, tagIds)
      return { success: true, data: { addedCount: count } }
    } catch (error) {
      console.error('批量添加文件夹标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 批量从文件夹移除标签
  ipcMain.handle(
    'db:folderTag:removeTagsFromFolder',
    async (_, folderKey: string, tagIds: number[]) => {
      void _
      try {
        const db = getVaultDatabase()
        const count = removeTagsFromFolder(db, folderKey, tagIds)
        return { success: true, data: { removedCount: count } }
      } catch (error) {
        console.error('批量移除文件夹标签失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 清除文件夹的所有标签
  ipcMain.handle('db:folderTag:clear', async (_, folderKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const count = clearFolderTags(db, folderKey)
      return { success: true, data: { deletedCount: count } }
    } catch (error) {
      console.error('清除文件夹标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取带有特定标签的文件夹数量
  ipcMain.handle('db:folderTag:countFoldersWithTag', async (_, tagId: number) => {
    void _
    try {
      const db = getVaultDatabase()
      const count = countFoldersWithTag(db, tagId)
      return { success: true, data: count }
    } catch (error) {
      console.error('统计带标签的文件夹数量失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
