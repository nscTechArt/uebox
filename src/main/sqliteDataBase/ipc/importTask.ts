import { ipcMain } from 'electron'
import { getPublicDatabase } from '../index'
import {
  createImportTask,
  updateImportTask,
  getImportTaskByTaskId,
  listImportTasks,
  type ImportTaskRecord
} from '../models/importTask'

export const registerImportTaskIPC = (): void => {
  ipcMain.handle('db:importTask:create', async (_, task: ImportTaskRecord) => {
    void _
    try {
      const db = getPublicDatabase()
      const id = createImportTask(db, task)
      const created = getImportTaskByTaskId(db, task.taskId)
      return { success: true, data: { id, record: created } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'db:importTask:update',
    async (_, taskId: string, patch: Partial<ImportTaskRecord>) => {
      void _
      try {
        const db = getPublicDatabase()
        const ok = updateImportTask(db, taskId, patch)
        const record = getImportTaskByTaskId(db, taskId)
        return { success: ok, data: record }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('db:importTask:get', async (_, taskId: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const record = getImportTaskByTaskId(db, taskId)
      return { success: true, data: record }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:importTask:list', async () => {
    try {
      const db = getPublicDatabase()
      const records = listImportTasks(db)
      return { success: true, data: records }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
