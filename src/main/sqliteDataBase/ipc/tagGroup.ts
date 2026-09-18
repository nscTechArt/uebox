import { ipcMain } from 'electron'
import { getPublicDatabase } from '../index'
import {
  createTagGroup,
  getTagGroupById,
  getTagGroupByName,
  getAllTagGroups,
  updateTagGroup,
  deleteTagGroup,
  searchTagGroups,
  getTagCountByGroupId,
  batchUpdateTagGroupSort,
  TagGroup
} from '../models/tagGroup'
import { transaction } from '../dbUtils'

/**
 * 注册标签组相关的IPC处理函数
 */
export const registerTagGroupIPC = (): void => {
  // 创建标签组
  ipcMain.handle('db:tagGroups:create', async (_, groupData: TagGroup) => {
    void _
    try {
      const db = getPublicDatabase()
      const groupId = await transaction(db, (db) => {
        return createTagGroup(db, groupData)
      })
      return { success: true, data: { id: groupId } }
    } catch (error) {
      console.error('创建标签组失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据ID获取标签组
  ipcMain.handle('db:tagGroups:getById', async (_, id: number) => {
    void _
    try {
      const db = getPublicDatabase()
      const group = getTagGroupById(db, id)
      return { success: true, data: group }
    } catch (error) {
      console.error(`获取标签组(ID: ${id})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据名称获取标签组
  ipcMain.handle('db:tagGroups:getByName', async (_, name: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const group = getTagGroupByName(db, name)
      return { success: true, data: group }
    } catch (error) {
      console.error(`获取标签组(名称: ${name})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取所有标签组
  ipcMain.handle('db:tagGroups:getAll', async () => {
    try {
      const db = getPublicDatabase()
      const groups = getAllTagGroups(db)
      return { success: true, data: groups }
    } catch (error) {
      console.error('获取所有标签组失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取标签组及其标签数量
  ipcMain.handle('db:tagGroups:getAllWithCount', async () => {
    try {
      const db = getPublicDatabase()
      const groups = getAllTagGroups(db)
      const groupsWithCount = groups.map((group) => ({
        ...group,
        tagCount: getTagCountByGroupId(db, group.id!)
      }))
      return { success: true, data: groupsWithCount }
    } catch (error) {
      console.error('获取标签组及标签数量失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 更新标签组
  ipcMain.handle('db:tagGroups:update', async (_, id: number, updates: Partial<TagGroup>) => {
    void _
    try {
      const db = getPublicDatabase()
      const updated = await transaction(db, (db) => {
        return updateTagGroup(db, id, updates)
      })
      return { success: true, data: { updated } }
    } catch (error) {
      console.error(`更新标签组(ID: ${id})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 删除标签组
  ipcMain.handle('db:tagGroups:delete', async (_, id: number) => {
    void _
    try {
      const db = getPublicDatabase()
      const deleted = await transaction(db, (db) => {
        return deleteTagGroup(db, id)
      })
      return { success: true, data: { deleted } }
    } catch (error) {
      console.error(`删除标签组(ID: ${id})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 搜索标签组
  ipcMain.handle('db:tagGroups:search', async (_, keyword: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const groups = searchTagGroups(db, keyword)
      return { success: true, data: groups }
    } catch (error) {
      console.error(`搜索标签组(关键词: ${keyword})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取标签组的标签数量
  ipcMain.handle('db:tagGroups:getTagCount', async (_, groupId: number) => {
    void _
    try {
      const db = getPublicDatabase()
      const count = getTagCountByGroupId(db, groupId)
      return { success: true, data: { count } }
    } catch (error) {
      console.error(`获取标签组(ID: ${groupId})标签数量失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 批量更新标签组排序
  ipcMain.handle(
    'db:tagGroups:batchUpdateSort',
    async (_, sortData: Array<{ id: number; sort_order: number }>) => {
      void _
      try {
        const db = getPublicDatabase()
        const updated = await transaction(db, (db) => {
          return batchUpdateTagGroupSort(db, sortData)
        })
        return { success: true, data: { updated } }
      } catch (error) {
        console.error('批量更新标签组排序失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 批量创建标签组
  ipcMain.handle('db:tagGroups:batchCreate', async (_, groupsData: TagGroup[]) => {
    void _
    try {
      const db = getPublicDatabase()
      const groupIds = await transaction(db, (db) => {
        return groupsData.map((groupData) => createTagGroup(db, groupData))
      })
      return { success: true, data: { ids: groupIds } }
    } catch (error) {
      console.error('批量创建标签组失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 批量删除标签组
  ipcMain.handle('db:tagGroups:batchDelete', async (_, ids: number[]) => {
    void _
    try {
      const db = getPublicDatabase()
      const results = await transaction(db, (db) => {
        return ids.map((id) => deleteTagGroup(db, id))
      })
      const deletedCount = results.filter((result) => result).length
      return { success: true, data: { deletedCount, total: ids.length } }
    } catch (error) {
      console.error('批量删除标签组失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 复制标签组
  ipcMain.handle('db:tagGroups:duplicate', async (_, id: number, newName?: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const result = await transaction(db, (db) => {
        const originalGroup = getTagGroupById(db, id)
        if (!originalGroup) {
          throw new Error('标签组不存在')
        }

        const duplicatedGroup: TagGroup = {
          name: newName || `${originalGroup.name} - 副本`,
          color: originalGroup.color,
          sort_order: (originalGroup.sort_order || 0) + 1
        }

        return createTagGroup(db, duplicatedGroup)
      })
      return { success: true, data: { id: result } }
    } catch (error) {
      console.error(`复制标签组(ID: ${id})失败:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  console.log('标签组IPC处理函数注册完成')
}
