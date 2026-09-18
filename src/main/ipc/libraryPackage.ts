/**
 * 蓝图包 / 材质包的 IPC 层。
 *
 * 只做三件事：解析出当前保管库的根目录、把参数转成 service 认识的形状、
 * 包成 `{ success, data, error }`。**所有安全判断都在
 * `services/libraryPackageStore.ts` 里** —— 那些函数拿真实临时目录测过，
 * 这里再判一遍只会出现两份会漂的规则。
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import { VaultManager, VaultType } from '../sqliteDataBase/VaultManager'
import {
  createPackage,
  deletePackage,
  readLibraryMeta,
  readPackage,
  readPackageFile,
  renamePackage,
  writeLibraryMeta,
  scanPackages,
  updatePackage,
  writePackageFile,
  type LibraryPackageEntry,
  type LibraryPackageProblem,
  type ScanResult
} from '../services/libraryPackageStore'
import { LIBRARY_KINDS, type LibraryKind } from '../utils/libraryPackage'
import type { LibraryPackageDto } from '../../shared/libraryPackage'

interface IpcResult<T> {
  success: boolean
  data: T
  error?: string
}

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function fail<T>(error: string, data: T): IpcResult<T> {
  return { success: false, data, error }
}

/**
 * 当前保管库在磁盘上的根目录。
 *
 * 网络协作库的内容在 `networkPath` 上，本地库在 `path` 上 —— 取错了要么
 * 找不到包，要么把包写进本地缓存目录再也同步不出去。
 */
function getVaultRoot(): string | null {
  const vault = VaultManager.getInstance().getCurrentVault()
  if (!vault) return null
  if (vault.vaultType === VaultType.NETWORK) return vault.networkPath || null
  return vault.path || null
}

function assertLibrary(value: unknown): LibraryKind {
  if (typeof value !== 'string' || !LIBRARY_KINDS.includes(value as LibraryKind)) {
    throw new Error(`未知的库: ${String(value)}`)
  }
  return value as LibraryKind
}

/** 渲染进程不需要知道绝对路径长什么样，但删除和改名要拿它当句柄，所以照原样回传 */
function toDto(entry: LibraryPackageEntry): LibraryPackageDto {
  return {
    dirPath: entry.dirPath,
    relPath: entry.relPath,
    library: entry.library,
    manifest: entry.manifest
  }
}

const EMPTY_SCAN: { entries: LibraryPackageDto[]; problems: LibraryPackageProblem[] } = {
  entries: [],
  problems: []
}

export function registerLibraryPackageIPC(): void {
  /**
   * 走一遍磁盘，把所有包找出来。
   *
   * 这是「删掉数据库、重新扫一遍、库完整回来」的那个入口 ——
   * 磁盘是唯一真相源，索引从这里重建。
   */
  ipcMain.handle('library-package:scan', async () => {
    const root = getVaultRoot()
    if (!root) return fail('没有活跃的保管库', EMPTY_SCAN)

    try {
      const result: ScanResult = await scanPackages(root)
      return ok({ entries: result.entries.map(toDto), problems: result.problems })
    } catch (error) {
      console.error('[LibraryPackageIpc] 扫描失败', error)
      return fail(error instanceof Error ? error.message : '扫描失败', EMPTY_SCAN)
    }
  })

  ipcMain.handle('library-package:read', async (_e: IpcMainInvokeEvent, dirPath: unknown) => {
    const root = getVaultRoot()
    if (!root) return fail('没有活跃的保管库', null)

    try {
      const result = await readPackage(root, String(dirPath || ''))
      if (!result) return fail('路径不在当前保管库里', null)
      if ('reason' in result) return fail(`包读不了: ${result.reason}`, null)
      return ok(toDto(result))
    } catch (error) {
      console.error('[LibraryPackageIpc] 读取失败', error)
      return fail(error instanceof Error ? error.message : '读取失败', null)
    }
  })

  ipcMain.handle(
    'library-package:create',
    async (
      _e: IpcMainInvokeEvent,
      payload: {
        library: unknown
        id: string
        name: string
        payload: unknown
        parentRelPath?: string
      }
    ) => {
      const root = getVaultRoot()
      if (!root) return fail('没有活跃的保管库', null)

      try {
        const entry = await createPackage(root, {
          library: assertLibrary(payload?.library),
          id: String(payload?.id || ''),
          name: String(payload?.name || ''),
          payload: payload?.payload ?? null,
          now: Date.now(),
          parentRelPath: payload?.parentRelPath
        })
        if (!entry) return fail('目标目录不在当前保管库里', null)
        return ok(toDto(entry))
      } catch (error) {
        console.error('[LibraryPackageIpc] 新建失败', error)
        return fail(error instanceof Error ? error.message : '新建失败', null)
      }
    }
  )

  ipcMain.handle(
    'library-package:update',
    async (
      _e: IpcMainInvokeEvent,
      dirPath: unknown,
      patch: { name?: string; payload?: unknown; cover?: string }
    ) => {
      const root = getVaultRoot()
      if (!root) return fail('没有活跃的保管库', null)

      try {
        const entry = await updatePackage(root, String(dirPath || ''), {
          name: patch?.name,
          payload: patch?.payload,
          cover: patch?.cover,
          now: Date.now()
        })
        if (!entry) return fail('包不存在、路径越界，或封面路径不合法', null)
        return ok(toDto(entry))
      } catch (error) {
        console.error('[LibraryPackageIpc] 更新失败', error)
        return fail(error instanceof Error ? error.message : '更新失败', null)
      }
    }
  )

  ipcMain.handle(
    'library-package:rename',
    async (_e: IpcMainInvokeEvent, dirPath: unknown, newName: unknown) => {
      const root = getVaultRoot()
      if (!root) return fail('没有活跃的保管库', null)

      try {
        const entry = await renamePackage(
          root,
          String(dirPath || ''),
          String(newName || ''),
          Date.now()
        )
        if (!entry) return fail('包不存在或路径越界', null)
        return ok(toDto(entry))
      } catch (error) {
        console.error('[LibraryPackageIpc] 改名失败', error)
        return fail(error instanceof Error ? error.message : '改名失败', null)
      }
    }
  )

  ipcMain.handle('library-package:delete', async (_e: IpcMainInvokeEvent, dirPath: unknown) => {
    const root = getVaultRoot()
    if (!root) return fail('没有活跃的保管库', false)

    try {
      const deleted = await deletePackage(root, String(dirPath || ''))
      return ok(deleted)
    } catch (error) {
      console.error('[LibraryPackageIpc] 删除失败', error)
      return fail(error instanceof Error ? error.message : '删除失败', false)
    }
  })

  ipcMain.handle(
    'library-package:writeFile',
    async (_e: IpcMainInvokeEvent, dirPath: unknown, relPath: unknown, data: unknown) => {
      const root = getVaultRoot()
      if (!root) return fail('没有活跃的保管库', false)

      try {
        // 渲染进程传过来的是 ArrayBuffer / Uint8Array，转成 Buffer 再落盘。
        // 两者要分开转：`Buffer.from(ArrayBuffer)` 是零拷贝视图，
        // `Buffer.from(Uint8Array)` 是复制，混着写会挑不到重载。
        const buffer =
          data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data))
            : Buffer.from(data as Uint8Array)
        const written = await writePackageFile(
          root,
          String(dirPath || ''),
          String(relPath || ''),
          buffer
        )
        if (!written) return fail('路径不合法或不在包里', false)
        return ok(true)
      } catch (error) {
        console.error('[LibraryPackageIpc] 写包内文件失败', error)
        return fail(error instanceof Error ? error.message : '写入失败', false)
      }
    }
  )

  /** 分组列表、迁移标记这类库级元信息。返回 null 表示还没写过。 */
  ipcMain.handle('library-package:readMeta', async () => {
    const root = getVaultRoot()
    if (!root) return fail('没有活跃的保管库', null as string | null)

    try {
      return ok(await readLibraryMeta(root))
    } catch (error) {
      console.error('[LibraryPackageIpc] 读元信息失败', error)
      return fail(error instanceof Error ? error.message : '读取失败', null as string | null)
    }
  })

  ipcMain.handle('library-package:writeMeta', async (_e: IpcMainInvokeEvent, text: unknown) => {
    const root = getVaultRoot()
    if (!root) return fail('没有活跃的保管库', false)

    try {
      return ok(await writeLibraryMeta(root, String(text ?? '')))
    } catch (error) {
      console.error('[LibraryPackageIpc] 写元信息失败', error)
      return fail(error instanceof Error ? error.message : '写入失败', false)
    }
  })

  ipcMain.handle(
    'library-package:readFile',
    async (_e: IpcMainInvokeEvent, dirPath: unknown, relPath: unknown) => {
      const root = getVaultRoot()
      if (!root) return fail('没有活跃的保管库', null)

      try {
        const buffer = await readPackageFile(root, String(dirPath || ''), String(relPath || ''))
        if (!buffer) return fail('文件不存在或路径不合法', null)
        // Uint8Array 能过结构化克隆，Buffer 不能
        return ok(new Uint8Array(buffer))
      } catch (error) {
        console.error('[LibraryPackageIpc] 读包内文件失败', error)
        return fail(error instanceof Error ? error.message : '读取失败', null)
      }
    }
  )

  console.log('[LibraryPackageIpc] 已注册')
}
