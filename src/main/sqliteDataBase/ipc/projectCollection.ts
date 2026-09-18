import { ipcMain } from 'electron'
import { getPublicDatabase } from '../index'
import {
  createProjectCollection,
  updateProjectCollection,
  getAllProjectCollectionsWithItems,
  getProjectCollectionByKey,
  deleteProjectCollectionByKey,
  projectCollectionExists,
  searchProjectCollections,
  assignProjectToCollection,
  removeProjectFromCollection,
  clearProjectsOfCollection,
  getProjectsByCollectionKey,
  type ProjectCollectionRecord
} from '../models/projectCollection'

/**
 * 注册工程合集相关的IPC处理函数（公共数据库）
 */
export const registerProjectCollectionIPC = (): void => {
  // 创建合集
  ipcMain.handle('db:projectCollection:create', async (_, record: ProjectCollectionRecord) => {
    void _
    try {
      const db = getPublicDatabase()
      const id = createProjectCollection(db, record)
      const saved = getProjectCollectionByKey(db, record.collectionKey)
      return { success: true, data: saved?.id ?? id }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 更新合集
  ipcMain.handle(
    'db:projectCollection:update',
    async (_, collectionKey: string, updates: Partial<ProjectCollectionRecord>) => {
      void _
      try {
        const db = getPublicDatabase()
        const ok = updateProjectCollection(db, collectionKey, updates)
        return { success: true, data: ok }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 删除合集（并清空项目中的引用）
  ipcMain.handle('db:projectCollection:delete', async (_, collectionKey: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const cleared = clearProjectsOfCollection(db, collectionKey)
      const ok = deleteProjectCollectionByKey(db, collectionKey)
      return { success: true, data: { deleted: ok, cleared } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 查询合集 - 全部
  ipcMain.handle('db:projectCollection:getAll', async () => {
    try {
      const db = getPublicDatabase()
      const list = getAllProjectCollectionsWithItems(db)
      return { success: true, data: list }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 查询合集 - 按Key
  ipcMain.handle('db:projectCollection:getByKey', async (_, collectionKey: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const row = getProjectCollectionByKey(db, collectionKey)
      return { success: true, data: row }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 是否存在
  ipcMain.handle('db:projectCollection:exists', async (_, collectionKey: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const exists = projectCollectionExists(db, collectionKey)
      return { success: true, data: exists }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 搜索合集
  ipcMain.handle('db:projectCollection:search', async (_, keyword: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const list = searchProjectCollections(db, keyword)
      return { success: true, data: list }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 列出某合集下的所有项目
  ipcMain.handle('db:projectCollection:getProjects', async (_, collectionKey: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const list = getProjectsByCollectionKey(db, collectionKey)
      return { success: true, data: list }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 将项目加入合集
  ipcMain.handle(
    'db:projectCollection:addProject',
    async (_, projectKey: string, collectionKey: string) => {
      void _
      try {
        const db = getPublicDatabase()
        const ok = assignProjectToCollection(db, projectKey, collectionKey)
        return { success: true, data: ok }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 将项目移出合集。不给 collectionKey 就是从所有合集里移出去
  ipcMain.handle(
    'db:projectCollection:removeProject',
    async (_, projectKey: string, collectionKey?: string | null) => {
      void _
      try {
        const db = getPublicDatabase()
        const ok = removeProjectFromCollection(db, projectKey, collectionKey)
        return { success: true, data: ok }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}

export type { ProjectCollectionRecord }
