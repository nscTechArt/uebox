/**
 * 蓝图库 / 材质库本地持久化的 IPC 处理
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { DatabaseManager } from '../DatabaseManager'
import {
  applyLibraryStorePatch,
  loadLibraryStore,
  migrateLibraryStoreFromLocal,
  type LibraryName,
  type LibraryStorePatch,
  type LibraryStoreRecord,
  type LibraryStoreSnapshot
} from '../models/libraryStore'

const ALLOWED_LIBRARIES: readonly LibraryName[] = ['blueprint', 'material']

function assertLibrary(value: unknown): LibraryName {
  if (typeof value !== 'string' || !ALLOWED_LIBRARIES.includes(value as LibraryName)) {
    throw new Error(`[LibraryStoreIpc] 未知的库名: ${String(value)}`)
  }
  return value as LibraryName
}

export function registerLibraryStoreIpc(): void {
  const dbManager = DatabaseManager.getInstance()

  ipcMain.handle(
    'library-store:load',
    async (_event: IpcMainInvokeEvent, library: unknown): Promise<LibraryStoreSnapshot> => {
      const db = dbManager.getPublicDatabase()
      return loadLibraryStore(db, assertLibrary(library))
    }
  )

  ipcMain.handle(
    'library-store:save',
    async (
      _event: IpcMainInvokeEvent,
      library: unknown,
      patch: LibraryStorePatch
    ): Promise<void> => {
      const db = dbManager.getPublicDatabase()
      applyLibraryStorePatch(db, assertLibrary(library), patch || {})
    }
  )

  ipcMain.handle(
    'library-store:migrate',
    async (
      _event: IpcMainInvokeEvent,
      library: unknown,
      payload: { records: LibraryStoreRecord[]; ui: string }
    ): Promise<boolean> => {
      const db = dbManager.getPublicDatabase()
      return migrateLibraryStoreFromLocal(db, assertLibrary(library), {
        records: payload?.records || [],
        ui: payload?.ui || '{}'
      })
    }
  )

  console.log('[LibraryStoreIpc] IPC 处理器已注册')
}
