/**
 * 对象存储的 IPC 出口：设置页的配置 / 测试 / 查看 / 清理，以及输入框里的提前上传。
 *
 * 用户点一下就发一次的动作，一律回 `{ success, error? }` 而不是抛异常 ——
 * 调用方各自决定怎么报，渲染层那一层也就不走 `unwrapResult()`（见 api/objectStorage.ts）。
 */

import { ipcMain } from 'electron'

import type { ObjectStorageSaveInput } from '../../shared/objectStorage'
import {
  cleanOlderThan,
  getObjectStorageView,
  isObjectStorageReady,
  listStoredObjects,
  removeStoredObjects,
  runAutoClean,
  saveObjectStorageConfig,
  testObjectStorage,
  uploadMediaFile
} from '../services/objectStorage/objectStorageService'

/** 启动后等一会儿再自动清理：别和开机那一波初始化抢网络 */
const AUTO_CLEAN_DELAY_MS = 60_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerObjectStorageIPC(): void {
  ipcMain.handle('object-storage:get', () => getObjectStorageView())

  ipcMain.handle('object-storage:save', async (_event, input: ObjectStorageSaveInput) => {
    try {
      return { success: true, view: await saveObjectStorageConfig(input) }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  })

  ipcMain.handle('object-storage:test', (_event, input: ObjectStorageSaveInput) =>
    testObjectStorage(input)
  )

  ipcMain.handle('object-storage:ready', () => isObjectStorageReady())

  ipcMain.handle('object-storage:list', async () => {
    try {
      return { success: true, objects: await listStoredObjects() }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  })

  ipcMain.handle('object-storage:remove', async (_event, keys: string[]) => {
    try {
      return { success: true, ...(await removeStoredObjects(Array.isArray(keys) ? keys : [])) }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  })

  ipcMain.handle('object-storage:clean', async (_event, days: number) => {
    try {
      return { success: true, ...(await cleanOlderThan(Math.max(0, Number(days) || 0))) }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  })

  /**
   * 拖进输入框就开传。发送时主进程会接上同一次上传（按路径认），不会传第二遍，
   * 所以这里失败了也不要紧：发送那一路会再试一次，再不行就只给路径。
   */
  ipcMain.handle('object-storage:upload', async (event, filePath: string) => {
    try {
      const { key } = await uploadMediaFile(filePath, undefined, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('object-storage:upload-progress', { filePath, ...progress })
        }
      })
      return { success: true, key }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  })

  setTimeout(() => void runAutoClean(), AUTO_CLEAN_DELAY_MS)
}
