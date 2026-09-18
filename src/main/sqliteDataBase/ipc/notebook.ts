/**
 * 知识库 IPC 处理程序
 * 处理渲染进程与主进程之间的知识库数据通信
 */
import { ipcMain } from 'electron'
import { getPublicDatabase } from '../index'
import {
  createNotebook,
  getNotebookById,
  listNotebooks,
  updateNotebook,
  deleteNotebook,
  countNotebooks,
  createNotebookSource,
  getNotebookSources,
  updateNotebookSource,
  deleteNotebookSource,
  type NotebookData,
  type NotebookSourceData
} from '../models/notebook'

/**
 * 注册知识库相关的 IPC 处理函数
 */
export const registerNotebookIPC = (): void => {
  // ========== 知识库 CRUD ==========

  /**
   * 创建知识库
   */
  ipcMain.handle('notebook:create', async (_, data: Partial<NotebookData>): Promise<string> => {
    try {
      const db = getPublicDatabase()
      return createNotebook(db, data)
    } catch (error) {
      console.error('[Notebook IPC] 创建知识库失败:', error)
      throw error
    }
  })

  /**
   * 获取单个知识库
   */
  ipcMain.handle('notebook:get', async (_, notebookId: string): Promise<NotebookData | null> => {
    try {
      const db = getPublicDatabase()
      return getNotebookById(db, notebookId) ?? null
    } catch (error) {
      console.error('[Notebook IPC] 获取知识库失败:', error)
      throw error
    }
  })

  /**
   * 获取知识库列表
   */
  ipcMain.handle(
    'notebook:list',
    async (_, options?: { limit?: number; offset?: number }): Promise<NotebookData[]> => {
      try {
        const db = getPublicDatabase()
        return listNotebooks(db, options)
      } catch (error) {
        console.error('[Notebook IPC] 获取知识库列表失败:', error)
        throw error
      }
    }
  )

  /**
   * 更新知识库
   */
  ipcMain.handle(
    'notebook:update',
    async (_, notebookId: string, updates: Partial<NotebookData>): Promise<boolean> => {
      try {
        const db = getPublicDatabase()
        return updateNotebook(db, notebookId, updates)
      } catch (error) {
        console.error('[Notebook IPC] 更新知识库失败:', error)
        throw error
      }
    }
  )

  /**
   * 删除知识库
   */
  ipcMain.handle('notebook:delete', async (_, notebookId: string): Promise<boolean> => {
    try {
      const db = getPublicDatabase()
      return deleteNotebook(db, notebookId)
    } catch (error) {
      console.error('[Notebook IPC] 删除知识库失败:', error)
      throw error
    }
  })

  /**
   * 获取知识库数量
   */
  ipcMain.handle('notebook:count', async (): Promise<number> => {
    try {
      const db = getPublicDatabase()
      return countNotebooks(db)
    } catch (error) {
      console.error('[Notebook IPC] 获取知识库数量失败:', error)
      throw error
    }
  })

  // ========== 来源 CRUD ==========

  /**
   * 添加来源
   */
  ipcMain.handle(
    'notebook:source:create',
    async (
      _,
      data: Omit<NotebookSourceData, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<string> => {
      try {
        const db = getPublicDatabase()
        return createNotebookSource(db, data)
      } catch (error) {
        console.error('[Notebook IPC] 添加来源失败:', error)
        throw error
      }
    }
  )

  /**
   * 获取知识库的所有来源
   */
  ipcMain.handle(
    'notebook:source:list',
    async (_, notebookId: string): Promise<NotebookSourceData[]> => {
      try {
        const db = getPublicDatabase()
        return getNotebookSources(db, notebookId)
      } catch (error) {
        console.error('[Notebook IPC] 获取来源列表失败:', error)
        throw error
      }
    }
  )

  /**
   * 更新来源
   */
  ipcMain.handle(
    'notebook:source:update',
    async (_, sourceId: string, updates: Partial<NotebookSourceData>): Promise<boolean> => {
      try {
        const db = getPublicDatabase()
        return updateNotebookSource(db, sourceId, updates)
      } catch (error) {
        console.error('[Notebook IPC] 更新来源失败:', error)
        throw error
      }
    }
  )

  /**
   * 删除来源
   */
  ipcMain.handle('notebook:source:delete', async (_, sourceId: string): Promise<boolean> => {
    try {
      const db = getPublicDatabase()
      return deleteNotebookSource(db, sourceId)
    } catch (error) {
      console.error('[Notebook IPC] 删除来源失败:', error)
      throw error
    }
  })

  console.log('知识库 IPC 处理程序注册完成')
}
