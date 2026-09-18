import { ipcMain } from 'electron'
import { getPublicDatabase, getVaultDatabase } from '../index'
import {
  createTag,
  getTagById,
  getTagByName,
  getAllTags,
  getTagsByGroupId,
  getUngroupedTags,
  updateTag,
  deleteTag,
  searchTags,
  getFavoriteTags,
  toggleTagFavorite,
  Tag
} from '../models/tag'
import { transaction } from '../dbUtils'
import { removeAllAssetTagsByTagId } from '../models/assetTag'

/**
 * 删掉标签之后，把当前保管库里指向它的关联记录一并清掉。
 *
 * 标签存在公共库，asset_tags 存在每个保管库里。`deleteTag` 只动公共库那一行，
 * 引用是清不掉的 —— 于是删一个标签就在所有库里留下一批指向空 id 的悬空记录。
 * agent 那条路径（tools/adapted/asset/manageTags）一直有清，界面这条没有，
 * 同一个操作走 AI 和走鼠标结果不一样。这里先把界面这条对齐。
 *
 * **只清当前库**：别的保管库的库文件此刻没打开，动不了。所以跨库的悬空记录依然存在，
 * 那要等「标签清单按库存放」的改造落地才能根治，不是这里能解决的。
 *
 * 清理失败不让删除本身回滚 —— 标签已经从公共库没了，悬空记录是可以事后扫的。
 *
 * @param tagId 已经从公共库删掉的标签 id
 */
const detachTagFromCurrentVault = (tagId: number): void => {
  try {
    removeAllAssetTagsByTagId(getVaultDatabase(), tagId)
  } catch (error) {
    console.error(`清理标签(ID: ${tagId})在当前保管库的关联失败:`, error)
  }
}

/**
 * 注册标签相关的IPC处理函数
 */
export const registerTagIPC = (): void => {
  // 创建标签
  ipcMain.handle('db:tags:create', async (_, tagData: Tag) => {
    void _
    try {
      const db = getPublicDatabase()
      const tagId = await transaction(db, (db) => {
        return createTag(db, tagData)
      })
      return { success: true, data: { id: tagId } }
    } catch (error) {
      console.error('创建标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据ID获取标签
  ipcMain.handle('db:tags:getById', async (_, id: number) => {
    void _
    try {
      const db = getPublicDatabase()
      const tag = getTagById(db, id)
      return { success: true, data: tag }
    } catch (error) {
      console.error(`获取标签(ID: ${id})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据名称获取标签
  ipcMain.handle('db:tags:getByName', async (_, name: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const tag = getTagByName(db, name)
      return { success: true, data: tag }
    } catch (error) {
      console.error(`获取标签(名称: ${name})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取所有标签
  ipcMain.handle('db:tags:getAll', async () => {
    try {
      const db = getPublicDatabase()
      const tags = getAllTags(db)
      return { success: true, data: tags }
    } catch (error) {
      console.error('获取所有标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据标签组ID获取标签
  ipcMain.handle('db:tags:getByGroupId', async (_, groupId: number) => {
    void _
    try {
      const db = getPublicDatabase()
      const tags = getTagsByGroupId(db, groupId)
      return { success: true, data: tags }
    } catch (error) {
      console.error(`获取标签组(ID: ${groupId})下的标签失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取未分组的标签
  ipcMain.handle('db:tags:getUngrouped', async () => {
    try {
      const db = getPublicDatabase()
      const tags = getUngroupedTags(db)
      return { success: true, data: tags }
    } catch (error) {
      console.error('获取未分组标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 更新标签
  ipcMain.handle('db:tags:update', async (_, id: number, updates: Partial<Tag>) => {
    void _
    try {
      const db = getPublicDatabase()
      const updated = await transaction(db, (db) => {
        return updateTag(db, id, updates)
      })
      return { success: true, data: { updated } }
    } catch (error) {
      console.error(`更新标签(ID: ${id})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 删除标签
  ipcMain.handle('db:tags:delete', async (_, id: number) => {
    void _
    try {
      const db = getPublicDatabase()
      const deleted = await transaction(db, (db) => {
        return deleteTag(db, id)
      })
      if (deleted) detachTagFromCurrentVault(id)
      return { success: true, data: { deleted } }
    } catch (error) {
      console.error(`删除标签(ID: ${id})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 搜索标签
  ipcMain.handle('db:tags:search', async (_, keyword: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const tags = searchTags(db, keyword)
      return { success: true, data: tags }
    } catch (error) {
      console.error(`搜索标签(关键词: ${keyword})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 批量创建标签
  ipcMain.handle('db:tags:batchCreate', async (_, tagsData: Tag[]) => {
    void _
    try {
      const db = getPublicDatabase()
      const tagIds = await transaction(db, (db) => {
        return tagsData.map((tagData) => createTag(db, tagData))
      })
      return { success: true, data: { ids: tagIds } }
    } catch (error) {
      console.error('批量创建标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 批量删除标签
  ipcMain.handle('db:tags:batchDelete', async (_, ids: number[]) => {
    void _
    try {
      const db = getPublicDatabase()
      const results = await transaction(db, (db) => {
        return ids.map((id) => deleteTag(db, id))
      })
      ids.forEach((id, index) => {
        if (results[index]) detachTagFromCurrentVault(id)
      })
      const deletedCount = results.filter((result) => result).length
      return { success: true, data: { deletedCount, total: ids.length } }
    } catch (error) {
      console.error('批量删除标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 移动标签到指定标签组
  ipcMain.handle('db:tags:moveToGroup', async (_, tagIds: number[], groupId: number | null) => {
    void _
    try {
      const db = getPublicDatabase()
      const results = await transaction(db, (db) => {
        return tagIds.map((tagId) => updateTag(db, tagId, { group_id: groupId }))
      })
      const updatedCount = results.filter((result) => result).length
      return { success: true, data: { updatedCount, total: tagIds.length } }
    } catch (error) {
      console.error('移动标签到标签组失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取常用标签
  ipcMain.handle('db:tags:getFavorites', async () => {
    try {
      const db = getPublicDatabase()
      const tags = getFavoriteTags(db)
      return { success: true, data: tags }
    } catch (error) {
      console.error('获取常用标签失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 切换标签常用状态
  ipcMain.handle('db:tags:toggleFavorite', async (_, id: number) => {
    void _
    try {
      const db = getPublicDatabase()
      const updated = await transaction(db, (db) => {
        return toggleTagFavorite(db, id)
      })
      return { success: true, data: { updated } }
    } catch (error) {
      console.error(`切换标签(ID: ${id})常用状态失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  console.log('标签IPC处理函数注册完成')
}
