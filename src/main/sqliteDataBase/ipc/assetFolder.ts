import { ipcMain } from 'electron'
import { getVaultDatabase, getDatabaseManager } from '../index'
import { runInTransaction, transaction } from '../dbUtils'
import {
  applyFolderPurgePlan,
  buildFolderPurgePlan,
  collectAllDeletedFolderKeys,
  collectDeletedSubtreeKeys
} from '../services/folderPurge'
import { scheduleVaultFileCleanup } from '../services/vaultFileCleanup'
import {
  resolveNetworkFolderPath,
  resolveNetworkFolderPathByName
} from '../services/networkFolderPath'
import {
  createAssetFolder,
  getAssetFolderByKey,
  getAssetFoldersByFatherKey,
  getChildFolderCount,
  getRootAssetFolders,
  updateAssetFolder,
  deleteAssetFolder,
  getAllAssetFolders,
  getDeletedAssetFolders,
  assetFolderExists,
  getFolderPathArray,
  getBatchFolderPaths,
  getFoldersByDepth,
  updateFolderPathsRecursively,
  restoreAssetFolder,
  searchAssetFoldersByCriteria,
  getAssetFolderByPath,
  initAssetFolderModel,
  type FolderSearchCriteria,
  type AssetFolder
} from '../models/assetFolder'
import ThumbnailManager from '../../utils/ThumbnailManager'
import { join } from 'path'
import { ALL_FOLDER } from '../../init/constants'
// V1 NetworkVaultSync removed — V2 ChangeTracker handles sync automatically
import { VaultType } from '../VaultManager'
import {
  pushFolderCreate,
  pushFolderUpdate,
  pushFolderDelete
} from '../../networkV2/NetworkSyncBridge'
import { getCurrentRemoteHttpVaultContext } from '../../networkV2/currentRemoteHttpVault'

/** 删网络目录的结果。`failed` 非空时，这次删除不算成功 */
export interface NetworkDirRemoval {
  ok: boolean
  failed: Array<{ path: string; reason: string }>
  /**
   * 已经在 NAS 上删掉了的那些。
   *
   * 批量删除是并行执行的，所以「失败」几乎总是**部分失败**：这几个的目录已经没了，
   * 而下面的数据库删除整个跳过，它们的记录还留在库里。不把这份名单带回去，
   * 用户看到的就是「删除失败 + 五个文件夹还在列表里」，其中两个点进去是空的，
   * 而他完全不知道那两个已经从 NAS 上消失了。
   */
  removed: string[]
}

/**
 * 删掉共享库（NAS）上的目录，**并如实回报结果**。
 *
 * ## 为什么这一步必须挡在数据库删除前面
 *
 * 磁盘上的文件才是唯一真相源，数据库只是一份能重建的索引（AGENTS §5 第 10 条）。
 * 先删索引再删文件，一旦文件删不掉 —— 断网、NAS 只读、同事的 UE 正占着某个
 * `.uasset` —— 用户看到的是「已删除」，NAS 上却留着一个谁都再也找不到的孤儿目录，
 * 占着空间，别人打开工程还能看见它。
 *
 * 这里以前是「删库记录 → 立即 return success → setImmediate 里删文件 → 失败只 console.warn」，
 * 真实结果从来没有回到界面。现在改成：删不掉就整件事不做，把原因带回去让用户重试。
 *
 * 缩略图不走这条路 —— 它是能重新生成的派生物，删不掉最多留点垃圾，不值得挡住主流程。
 */
export async function removeNetworkDirectories(paths: string[]): Promise<NetworkDirRemoval> {
  if (paths.length === 0) return { ok: true, failed: [], removed: [] }

  const { existsSync } = await import('fs')
  const { rm } = await import('fs/promises')
  const failed: NetworkDirRemoval['failed'] = []
  const removed: string[] = []

  await Promise.all(
    paths.map(async (p) => {
      try {
        if (!existsSync(p)) {
          // 本来就不在了 —— 多半是上一次部分失败之后的重试。算删掉了，
          // 这样重试能把它的数据库记录一并收拾干净
          removed.push(p)
          return
        }
        await rm(p, { recursive: true, force: true })
        removed.push(p)
        console.log('[IPC] 网络文件夹已删除:', p)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.warn('[IPC] 删除网络文件夹失败:', p, reason)
        failed.push({ path: p, reason })
      }
    })
  )

  return { ok: failed.length === 0, failed, removed }
}

/** 后台清理缩略图。派生物，删不掉不影响这次删除的成败 */
function scheduleThumbnailCleanup(vaultNetworkPath: string, thumbnails: string[]): void {
  if (thumbnails.length === 0) return
  const captured = [...thumbnails]

  setImmediate(async () => {
    try {
      const { existsSync } = await import('fs')
      const { rm } = await import('fs/promises')
      const thumbnailDir = join(vaultNetworkPath, '.thumbnails')
      const BATCH = 20 // 每批并行删除数量，避免同时打开太多文件句柄
      let deleted = 0
      for (let i = 0; i < captured.length; i += BATCH) {
        const results = await Promise.allSettled(
          captured.slice(i, i + BATCH).map(async (name) => {
            const p = join(thumbnailDir, name)
            if (!existsSync(p)) return false
            await rm(p, { force: true })
            return true
          })
        )
        deleted += results.filter((r) => r.status === 'fulfilled' && r.value).length
      }
      console.log(`[IPC] 网络缩略图清理: ${deleted}/${captured.length}`)
    } catch (error) {
      console.warn('[IPC] 网络缩略图清理失败:', error)
    }
  })
}

function parseFolderKeyList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

export function getRootFolderKeysForRemoteDelete(
  db: ReturnType<typeof getVaultDatabase>,
  folderKeys: string[]
): string[] {
  const selected = new Set(folderKeys.map(String).filter(Boolean))
  const rootKeys: string[] = []
  for (const folderKey of selected) {
    const folder = getAssetFolderByKey(db, folderKey)
    if (!folder) continue
    const ancestors = new Set([
      ...parseFolderKeyList(folder.ancestorKeys),
      ...parseFolderKeyList(folder.pathArray)
    ])
    ancestors.delete(folderKey)
    const hasSelectedAncestor = [...ancestors].some((ancestorKey) => selected.has(ancestorKey))
    if (!hasSelectedAncestor) {
      rootKeys.push(folderKey)
    }
  }
  return rootKeys
}

/**
 * 注册资产文件夹相关的IPC处理函数
 */
export const registerAssetFolderIPC = (): void => {
  // 创建文件夹
  ipcMain.handle('db:assetFolder:create', async (_, folderData: AssetFolder) => {
    void _
    try {
      const db = getVaultDatabase()
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        const folderKey =
          folderData.folderKey || `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        const payload: AssetFolder = {
          ...folderData,
          folderKey,
          fatherKey: folderData.fatherKey || ALL_FOLDER,
          type: folderData.type || 'folder',
          isDelete: folderData.isDelete ?? 0
        }

        await remoteHttpCtx.client.createFolder(payload as unknown as Record<string, unknown>)
        await remoteHttpCtx.client.pullChanges()

        const createdFolder = getAssetFolderByKey(db, folderKey)
        if (!createdFolder) {
          throw new Error('文件夹已提交到服务端，但本地同步后未找到该文件夹')
        }

        return { success: true, data: createdFolder.id ?? 1 }
      }

      const folderId = createAssetFolder(db, folderData)

      // 网络库：在网络路径上创建物理目录
      try {
        const databaseManager = getDatabaseManager()
        const currentVault = databaseManager.getCurrentVault()
        if (
          currentVault?.vaultType === VaultType.NETWORK &&
          currentVault.networkPath &&
          !currentVault.networkPath.startsWith('http://') &&
          !currentVault.networkPath.startsWith('https://')
        ) {
          // 在网络路径上创建物理目录
          const { join } = await import('path')
          const { mkdir } = await import('fs/promises')

          // 计算网络上的目录路径
          // 注意：fatherKey === 'ALL' 代表根目录，不需要额外路径
          // fullPath 可能包含 'ALL\\' 前缀，需要过滤
          let networkFolderPath: string
          if (folderData.fullPath) {
            // 移除 fullPath 中的 'ALL\\' 或 'ALL/' 前缀
            let cleanPath = folderData.fullPath
            if (cleanPath.startsWith('ALL\\') || cleanPath.startsWith('ALL/')) {
              cleanPath = cleanPath.substring(4)
            } else if (cleanPath === 'ALL') {
              cleanPath = folderData.folderName
            }
            networkFolderPath = join(currentVault.networkPath, cleanPath)
          } else if (folderData.fatherKey && folderData.fatherKey !== ALL_FOLDER) {
            // 如果有父文件夹（且不是ALL），递归构建路径
            // 不使用 fullPath 因为它可能是过时的（重命名后不会更新）
            const buildParentPath = (fKey: string): string => {
              const folder = getAssetFolderByKey(db, fKey)
              if (!folder) return ''
              if (!folder.fatherKey || folder.fatherKey === ALL_FOLDER) {
                return folder.folderName
              }
              const parentPath = buildParentPath(folder.fatherKey)
              return parentPath ? `${parentPath}/${folder.folderName}` : folder.folderName
            }
            const parentPath = buildParentPath(folderData.fatherKey)
            networkFolderPath = join(currentVault.networkPath, parentPath, folderData.folderName)
          } else {
            // 根目录下的文件夹（包括 fatherKey 为 null 或 'ALL' 的情况）
            networkFolderPath = join(currentVault.networkPath, folderData.folderName)
          }

          console.log('[IPC] 网络文件夹路径计算:', {
            folderName: folderData.folderName,
            fullPath: folderData.fullPath,
            fatherKey: folderData.fatherKey,
            networkFolderPath
          })

          try {
            await mkdir(networkFolderPath, { recursive: true })
            console.log('[IPC] 网络文件夹已创建:', networkFolderPath)
          } catch (mkdirErr) {
            console.warn('[IPC] 网络文件夹创建失败:', mkdirErr)
          }
        }
      } catch (syncError) {
        // 网络同步失败不影响本地操作
        console.warn('[IPC] db:assetFolder:create 网络同步失败:', syncError)
      }

      // V2: 先把新建文件夹推到远端，再返回给前端。
      // 否则用户马上往该文件夹导入资产时，服务端可能还没创建这个 folderKey，
      // 资产文件已上传，但资产记录会因为引用了不存在的 folderKey 而落库失败。
      const createdFolder = getAssetFolderByKey(db, folderData.folderKey)
      await pushFolderCreate((createdFolder || folderData) as unknown as Record<string, unknown>)

      return { success: true, data: folderId }
    } catch (error) {
      console.error('创建资产文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据folderKey获取文件夹
  ipcMain.handle('db:assetFolder:getByKey', async (_, folderKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const folder = getAssetFolderByKey(db, folderKey)
      return { success: true, data: folder }
    } catch (error) {
      console.error('获取资产文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据路径获取文件夹
  ipcMain.handle('db:assetFolder:getByPath', async (_, fullPath: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const folder = getAssetFolderByPath(db, fullPath)
      return { success: true, data: folder }
    } catch (error) {
      console.error('根据路径获取资产文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据父级folderKey获取子文件夹列表
  ipcMain.handle(
    'db:assetFolder:getByFatherKey',
    async (
      _,
      fatherKey: string | null,
      sortBy?: any,
      sortOrder?: any,
      limit?: number,
      offset?: number
    ) => {
      void _
      try {
        const db = getVaultDatabase()
        const folders = getAssetFoldersByFatherKey(db, fatherKey, sortBy, sortOrder, limit, offset)
        return { success: true, data: folders }
      } catch (error) {
        console.error('获取子文件夹列表失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('db:assetFolder:getChildCount', async (_, fatherKey: string | null) => {
    void _
    try {
      const db = getVaultDatabase()
      const count = getChildFolderCount(db, fatherKey)
      return { success: true, data: count }
    } catch (error) {
      console.error('获取子文件夹数量失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取根级文件夹列表
  ipcMain.handle('db:assetFolder:getRootFolders', async (_, sortBy?: any, sortOrder?: any) => {
    try {
      const db = getVaultDatabase()
      console.log('[IPC getRootFolders] 获取数据库连接成功')
      const folders = getRootAssetFolders(db, sortBy, sortOrder)
      console.log('[IPC getRootFolders] 查询到文件夹:', folders?.length || 0, '个')
      // 输出每个文件夹的详细信息
      folders?.forEach((f, i) => {
        console.log(
          `[IPC getRootFolders] 文件夹[${i}]: folderKey=${f.folderKey}, folderName=${f.folderName}, hasChildren=${f.hasChildren}`
        )
      })
      return { success: true, data: folders }
    } catch (error) {
      console.error('获取根级文件夹列表失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 更新文件夹
  ipcMain.handle(
    'db:assetFolder:update',
    async (_, folderKey: string, updates: Partial<AssetFolder>) => {
      void _
      try {
        /** 共享盘上的目录改名失败时记在这里，最后如实回给界面 */
        let networkRenameError: string | null = null

        const db = getVaultDatabase()
        // 确保表结构是最新的（包含 color 等新字段）
        initAssetFolderModel(db)

        // 先获取旧的文件夹信息（用于网络重命名）
        const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
        if (remoteHttpCtx) {
          const existingFolder = getAssetFolderByKey(db, folderKey)
          if (!existingFolder) {
            return { success: false, error: '文件夹不存在或已被删除' }
          }

          await remoteHttpCtx.client.updateFolder(
            folderKey,
            updates as unknown as Record<string, unknown>
          )
          await remoteHttpCtx.client.pullChanges()

          const updatedFolder = getAssetFolderByKey(db, folderKey)
          if (!updatedFolder) {
            throw new Error('文件夹已在服务端更新，但本地同步后未找到最新记录')
          }

          return { success: true, data: true }
        }

        const oldFolder = getAssetFolderByKey(db, folderKey)

        const success = updateAssetFolder(db, folderKey, updates)

        // 网络库：如果是重命名操作，同时重命名网络路径上的物理目录
        if (success) {
          try {
            const databaseManager = getDatabaseManager()
            const currentVault = databaseManager.getCurrentVault()
            if (currentVault?.vaultType === VaultType.NETWORK && currentVault.networkPath) {
              // 如果是重命名操作，同时重命名网络路径上的物理目录
              if (updates.folderName !== undefined && oldFolder && oldFolder.folderName) {
                const { join, dirname, relative } = await import('path')
                const { existsSync } = await import('fs')
                const { rename } = await import('fs/promises')

                // 数据库里已经是新名字了，磁盘上还是旧名字 —— 用旧名字拼旧路径。
                // 算不出来（父链断了/成环/越界）就跳过，绝不拿一条塌缩的路径去 rename
                const oldFolderName = oldFolder.folderName
                const oldNetworkPath = resolveNetworkFolderPathByName(
                  db,
                  oldFolder.fatherKey,
                  oldFolderName,
                  currentVault.networkPath
                )
                const newNetworkPath = oldNetworkPath
                  ? join(dirname(oldNetworkPath), updates.folderName)
                  : null

                if (!oldNetworkPath || !newNetworkPath) {
                  console.warn(
                    '[IPC] 网络文件夹重命名：路径算不出来，跳过物理目录重命名',
                    folderKey
                  )
                } else if (existsSync(oldNetworkPath) && oldNetworkPath !== newNetworkPath) {
                  try {
                    await rename(oldNetworkPath, newNetworkPath)
                    console.log(`[IPC] 网络文件夹重命名: ${oldFolderName} -> ${updates.folderName}`)

                    // 下面批量改子资产路径要用相对前缀，从刚才用过的绝对路径反推，
                    // 保证两者一定是同一条路径
                    const oldNetworkRelPath = relative(
                      currentVault.networkPath,
                      oldNetworkPath
                    ).replace(/\\/g, '/')

                    // 🔧 核心修复：重命名后批量更新子资产的 filePath、originPath
                    // 原因：filePath/originPath 包含旧文件夹名，重命名后指向不存在的路径
                    try {
                      // 1. 递归获取被重命名文件夹下所有 folderKey
                      const folderRows = db
                        .prepare(
                          `
                          WITH RECURSIVE folder_tree AS (
                            SELECT folderKey FROM assetFolder WHERE folderKey = ?
                            UNION ALL
                            SELECT af.folderKey FROM assetFolder af
                            JOIN folder_tree ft ON af.fatherKey = ft.folderKey
                          )
                          SELECT folderKey FROM folder_tree
                        `
                        )
                        .all(folderKey) as { folderKey: string }[]
                      const allFolderKeys = folderRows.map((r) => r.folderKey)

                      if (allFolderKeys.length > 0) {
                        // 计算新的相对路径前缀
                        // oldNetworkRelPath = "旧名" 或 "parent/旧名"
                        // newNetworkRelPath = 替换最后一段为新名
                        const newNetworkRelPath = oldNetworkRelPath.includes('/')
                          ? oldNetworkRelPath.slice(0, oldNetworkRelPath.lastIndexOf('/') + 1) +
                            updates.folderName
                          : updates.folderName

                        // 标准化分隔符：filePath 中可能用 / 或 \
                        const oldPathSlash = oldNetworkRelPath.replace(/\\/g, '/')
                        const newPathSlash = newNetworkRelPath.replace(/\\/g, '/')
                        const oldPathBackslash = oldNetworkRelPath.replace(/\//g, '\\')
                        const newPathBackslash = newNetworkRelPath.replace(/\//g, '\\')

                        const placeholders = allFolderKeys.map(() => '?').join(',')

                        // 2. 批量更新 filePath（替换旧路径前缀为新路径前缀）
                        const updateFilePathSlash = db.prepare(
                          `UPDATE assetData SET filePath = REPLACE(filePath, ?, ?)
                           WHERE folderKey IN (${placeholders}) AND filePath LIKE ?`
                        )
                        updateFilePathSlash.run(
                          oldPathSlash + '/',
                          newPathSlash + '/',
                          ...allFolderKeys,
                          `%${oldPathSlash}/%`
                        )

                        const updateFilePathBackslash = db.prepare(
                          `UPDATE assetData SET filePath = REPLACE(filePath, ?, ?)
                           WHERE folderKey IN (${placeholders}) AND filePath LIKE ?`
                        )
                        updateFilePathBackslash.run(
                          oldPathBackslash + '\\',
                          newPathBackslash + '\\',
                          ...allFolderKeys,
                          `%${oldPathBackslash}\\%`
                        )

                        // 3. 批量更新 originPath
                        const updateOriginPathSlash = db.prepare(
                          `UPDATE assetData SET originPath = REPLACE(originPath, ?, ?)
                           WHERE folderKey IN (${placeholders}) AND originPath LIKE ?`
                        )
                        updateOriginPathSlash.run(
                          oldPathSlash + '/',
                          newPathSlash + '/',
                          ...allFolderKeys,
                          `%${oldPathSlash}/%`
                        )

                        const updateOriginPathBackslash = db.prepare(
                          `UPDATE assetData SET originPath = REPLACE(originPath, ?, ?)
                           WHERE folderKey IN (${placeholders}) AND originPath LIKE ?`
                        )
                        updateOriginPathBackslash.run(
                          oldPathBackslash + '\\',
                          newPathBackslash + '\\',
                          ...allFolderKeys,
                          `%${oldPathBackslash}\\%`
                        )

                        console.log('[IPC] 已批量更新资产路径:', {
                          foldersCount: allFolderKeys.length,
                          oldPrefix: oldNetworkRelPath,
                          newPrefix: newNetworkRelPath
                        })
                      }
                    } catch (pathUpdateErr) {
                      console.warn('[IPC] 批量更新资产路径失败:', pathUpdateErr)
                    }
                  } catch (renameErr) {
                    /*
                     * 共享盘上的目录没改成，这件事必须让用户知道。
                     *
                     * 原来只 console.warn，然后照常 return success：库里已经是新名字，
                     * NAS 上还是旧目录，之后所有资产路径都指向一个不存在的位置 ——
                     * 而用户从头到尾只看到「重命名成功」。
                     */
                    networkRenameError =
                      renameErr instanceof Error ? renameErr.message : String(renameErr)
                    console.warn('[IPC] 网络文件夹重命名失败:', renameErr)
                  }
                } else if (!existsSync(oldNetworkPath)) {
                  console.log('[IPC] 跳过重命名: 旧路径不存在')
                }
              }
            }
          } catch (syncError) {
            // 网络同步失败不影响本地操作
            console.warn('[IPC] db:assetFolder:update 网络同步失败:', syncError)
          }
        }

        // V2: 推送更新到远端
        if (success) {
          pushFolderUpdate(folderKey, updates as unknown as Record<string, unknown>).catch(() => {})
        }

        /*
         * 共享盘那一步失败**不能**报成 success:false。
         *
         * 走到这里时库里已经改完名、资产路径也重写过、`pushFolderUpdate` 还广播出去了。
         * 报 false 的话调用方按「什么都没发生」处理：界面把名字退回旧的、弹窗留着让人重试，
         * 而数据库、广播、每一条资产路径上都是新名字 —— 用户看到的和真相正好相反。
         *
         * 所以是「带警告的成功」：改是真改了，只是 NAS 上那个目录没跟上，得单独说。
         */
        return {
          success: true,
          data: success,
          ...(networkRenameError
            ? { warning: { code: 'NETWORK_DIR_RENAME_FAILED', message: networkRenameError } }
            : {})
        }
      } catch (error) {
        console.error('更新资产文件夹失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 删除文件夹
  ipcMain.handle('db:assetFolder:delete', async (_, folderKey: string) => {
    void _
    try {
      // 保护 ALL 文件夹不被删除
      if (folderKey === ALL_FOLDER) {
        console.warn('禁止删除 ALL 系统文件夹')
        return { success: false, error: 'ALL 是系统文件夹，不允许删除' }
      }

      const db = getVaultDatabase()
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        await remoteHttpCtx.client.deleteFolder(folderKey)
        await remoteHttpCtx.client.pullChanges()
        return { success: true, data: true }
      }

      // 🔧 修复：网络库模式下需要先获取文件夹信息，用于后续删除物理目录
      let folderToDelete: AssetFolder | undefined = undefined
      let networkFolderPath: string | null = null

      try {
        const databaseManager = getDatabaseManager()
        const currentVault = databaseManager.getCurrentVault()
        if (currentVault?.vaultType === VaultType.NETWORK && currentVault.networkPath) {
          folderToDelete = getAssetFolderByKey(db, folderKey)

          if (folderToDelete) {
            // 算不出来就是 null，后面据此跳过 rm —— 宁可留下一个空目录，
            // 也不能拿一条塌缩的路径去 rm -rf 网络根目录下的同名目录
            networkFolderPath = resolveNetworkFolderPath(db, folderKey, currentVault.networkPath)
            if (networkFolderPath) {
              console.log('[IPC] db:assetFolder:delete 计算网络路径:', {
                folderKey,
                folderName: folderToDelete.folderName,
                networkFolderPath
              })
            } else {
              console.warn(
                '[IPC] db:assetFolder:delete 网络路径算不出来，跳过物理目录删除:',
                folderKey
              )
            }
          }
        }
      } catch (pathErr) {
        console.warn('[IPC] db:assetFolder:delete 计算网络路径失败:', pathErr)
      }

      // 获取当前保管库信息
      const databaseManager = getDatabaseManager()
      const currentVault = databaseManager.getCurrentVault()
      const isNetworkVault = currentVault?.vaultType === VaultType.NETWORK

      // 🔧 修复：在删除前预先计算所有要删除的文件夹 key（用于后续写入 journal）
      let allDeletedFolderKeys: string[] = []
      // 🔧 修复：收集网络库资产的缩略图文件名，用于后续清理网络 .thumbnails 目录
      let assetThumbnails: string[] = []
      if (isNetworkVault) {
        const rows = db
          .prepare(
            `
            WITH RECURSIVE folder_tree AS (
              SELECT folderKey FROM assetFolder WHERE folderKey = ?
              UNION ALL
              SELECT af.folderKey FROM assetFolder af
              JOIN folder_tree ft ON af.fatherKey = ft.folderKey
            )
            SELECT folderKey FROM folder_tree
          `
          )
          .all(folderKey) as { folderKey: string }[]
        allDeletedFolderKeys = rows.map((r) => r.folderKey)
        console.log('[IPC] db:assetFolder:delete 预计算要删除的文件夹:', allDeletedFolderKeys)

        // 收集这些文件夹下所有资产的缩略图文件名
        if (allDeletedFolderKeys.length > 0) {
          const placeholders = allDeletedFolderKeys.map(() => '?').join(',')
          const thumbnailRows = db
            .prepare(
              `SELECT imgLocalPath FROM assetData WHERE folderKey IN (${placeholders}) AND imgLocalPath IS NOT NULL`
            )
            .all(...allDeletedFolderKeys) as { imgLocalPath: string }[]
          assetThumbnails = thumbnailRows
            .map(
              (r) => ThumbnailManager.extractFilenameFromFileUrl(r.imgLocalPath) || r.imgLocalPath
            )
            .filter(Boolean) as string[]
          console.log(
            '[IPC] db:assetFolder:delete 预计算要删除的缩略图:',
            assetThumbnails.length,
            '个'
          )
        }
      }

      // 网络库：先删 NAS 上的目录，删掉了才动数据库（理由见 removeNetworkDirectories 的注释）
      if (isNetworkVault && networkFolderPath) {
        const removal = await removeNetworkDirectories([networkFolderPath])
        if (!removal.ok) {
          return {
            success: false,
            code: 'NETWORK_DIR_DELETE_FAILED',
            error: removal.failed[0]?.reason ?? 'unknown',
            data: { path: removal.failed[0]?.path ?? networkFolderPath }
          }
        }
      }

      // 执行数据库删除：网络库使用硬删除，本地库使用软删除
      let success: boolean
      if (isNetworkVault) {
        // 🔧 网络库：直接硬删除（不进入回收站）
        console.log('[IPC] db:assetFolder:delete 网络库模式，执行硬删除')
        success = await transaction(db, (db) => {
          // 使用预先计算的 keys（避免重复查询）
          const keys = allDeletedFolderKeys
          if (keys.length === 0) return false
          const placeholders = keys.map(() => '?').join(',')

          // 删除资产关联
          db.prepare(
            `DELETE FROM asset_tags WHERE assetKey IN (SELECT assetKey FROM assetData WHERE folderKey IN (${placeholders}))`
          ).run(...keys)
          db.prepare(
            `DELETE FROM asset_favorites WHERE assetKey IN (SELECT assetKey FROM assetData WHERE folderKey IN (${placeholders}))`
          ).run(...keys)

          // 删除资产记录
          const assetResult = db
            .prepare(`DELETE FROM assetData WHERE folderKey IN (${placeholders})`)
            .run(...keys)

          // 删除文件夹记录
          const folderResult = db
            .prepare(`DELETE FROM assetFolder WHERE folderKey IN (${placeholders})`)
            .run(...keys)

          return (assetResult.changes ?? 0) + (folderResult.changes ?? 0) > 0
        })
      } else {
        // 本地库：软删除（进入回收站）
        success = await transaction(db, (db) => {
          return deleteAssetFolder(db, folderKey)
        })
      }

      // 目录已经在数据库操作之前删掉了。剩下缩略图这类派生物，丢后台清就行
      if (success && isNetworkVault) {
        const vaultNetworkPath = (() => {
          try {
            return getDatabaseManager().getCurrentVault()?.networkPath
          } catch {
            return null
          }
        })()
        if (vaultNetworkPath) scheduleThumbnailCleanup(vaultNetworkPath, assetThumbnails)
      }

      // V2: 推送删除到远端
      if (success) {
        pushFolderDelete(folderKey).catch(() => {})
      }

      return { success, data: success }
    } catch (error) {
      console.error('删除资产文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 🚀 批量删除文件夹（优化：N 个文件夹只需 1 次 IPC + 1 次事务 + 1 次 journal）
  ipcMain.handle('db:assetFolder:batchDelete', async (_, folderKeys: string[]) => {
    void _
    try {
      if (!folderKeys || folderKeys.length === 0) {
        return { success: true, data: { deletedCount: 0 } }
      }

      // 过滤掉 ALL 系统文件夹
      const validKeys = folderKeys.filter((k) => k !== ALL_FOLDER)
      if (validKeys.length === 0) {
        return { success: false, error: 'ALL 是系统文件夹，不允许删除' }
      }

      const db = getVaultDatabase()
      const rootKeys = getRootFolderKeysForRemoteDelete(db, validKeys)
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        const operations = rootKeys.map((folderKey) => ({
          type: 'delete',
          table: 'assetFolder',
          data: { folderKey }
        }))
        if (operations.length > 0) {
          await remoteHttpCtx.client.batch(operations)
          await remoteHttpCtx.client.pullChanges()
        }
        return { success: true, data: { deletedCount: rootKeys.length } }
      }

      const databaseManager = getDatabaseManager()
      const currentVault = databaseManager.getCurrentVault()
      const isNetworkVault = currentVault?.vaultType === VaultType.NETWORK

      // 1. 一次性递归 CTE 收集所有要删除的文件夹 key（含子文件夹）
      const placeholders = validKeys.map(() => '?').join(',')
      const allRows = db
        .prepare(
          `
          WITH RECURSIVE folder_tree AS (
            SELECT folderKey FROM assetFolder WHERE folderKey IN (${placeholders})
            UNION ALL
            SELECT af.folderKey FROM assetFolder af
            JOIN folder_tree ft ON af.fatherKey = ft.folderKey
          )
          SELECT DISTINCT folderKey FROM folder_tree
        `
        )
        .all(...validKeys) as { folderKey: string }[]
      const allDeletedKeys = allRows.map((r) => r.folderKey)

      if (allDeletedKeys.length === 0) {
        return { success: true, data: { deletedCount: 0 } }
      }

      console.log(
        `[IPC] db:assetFolder:batchDelete 收集到 ${allDeletedKeys.length} 个文件夹（含子文件夹）`
      )

      // 2. 收集网络路径和缩略图（仅网络库）
      const networkFolderPaths: string[] = []
      const assetThumbnails: string[] = []
      let vaultNetworkPath: string | null = null

      if (isNetworkVault && currentVault?.networkPath) {
        vaultNetworkPath = currentVault.networkPath

        // 只为顶层选中的文件夹计算网络路径（子文件夹会在 rm -rf 时一并删除）。
        // 算不出来的直接跳过，不允许把一条塌缩的路径塞进待删清单
        for (const key of validKeys) {
          const absolute = resolveNetworkFolderPath(db, key, vaultNetworkPath)
          if (absolute) {
            networkFolderPaths.push(absolute)
          } else {
            console.warn('[IPC] 批量删除：网络路径算不出来，跳过物理目录删除:', key)
          }
        }

        // 收集缩略图
        const BATCH = 500
        for (let i = 0; i < allDeletedKeys.length; i += BATCH) {
          const batch = allDeletedKeys.slice(i, i + BATCH)
          const ph = batch.map(() => '?').join(',')
          const thumbRows = db
            .prepare(
              `SELECT imgLocalPath FROM assetData WHERE folderKey IN (${ph}) AND imgLocalPath IS NOT NULL`
            )
            .all(...batch) as { imgLocalPath: string }[]
          assetThumbnails.push(
            ...(thumbRows
              .map(
                (r) => ThumbnailManager.extractFilenameFromFileUrl(r.imgLocalPath) || r.imgLocalPath
              )
              .filter(Boolean) as string[])
          )
        }
      }

      /*
       * 网络库：先删 NAS 上的目录，删掉了才动数据库（理由见 removeNetworkDirectories 的注释）。
       *
       * 批量删除**一定是部分成败**：`removeNetworkDirectories` 并行执行，等回到这里时
       * 成功的那几个在 NAS 上已经没了。所以不能只说一句「删除失败」——
       * 那样用户看到的是五个文件夹原样列着，其中两个点进去是空的，而他不知道
       * 那两个已经被删掉了。把 removed / failed 都如实带回去，界面才说得清
       * 「已删掉 N 个，剩下 M 个没删掉，原因是…」，重试也能把残局收干净
       * （已经不存在的目录会被算作删掉，连带清掉它们的记录）。
       */
      if (isNetworkVault && networkFolderPaths.length > 0) {
        const removal = await removeNetworkDirectories(networkFolderPaths)
        if (!removal.ok) {
          return {
            success: false,
            code: 'NETWORK_DIR_DELETE_FAILED',
            error: removal.failed[0]?.reason ?? 'unknown',
            data: {
              path: removal.failed[0]?.path ?? '',
              failedCount: removal.failed.length,
              failed: removal.failed,
              /** 这些已经从 NAS 上没了，但记录还在库里 —— 界面要说出来 */
              removedCount: removal.removed.length,
              removed: removal.removed
            }
          }
        }
      }

      // 3. 一个 DB 事务删除所有记录
      const success = await transaction(db, (db) => {
        // 分批处理防止 "too many SQL variables"
        const BATCH = 500
        for (let i = 0; i < allDeletedKeys.length; i += BATCH) {
          const batch = allDeletedKeys.slice(i, i + BATCH)
          const ph = batch.map(() => '?').join(',')

          if (isNetworkVault) {
            // 网络库：硬删除
            db.prepare(
              `DELETE FROM asset_tags WHERE assetKey IN (SELECT assetKey FROM assetData WHERE folderKey IN (${ph}))`
            ).run(...batch)
            db.prepare(
              `DELETE FROM asset_favorites WHERE assetKey IN (SELECT assetKey FROM assetData WHERE folderKey IN (${ph}))`
            ).run(...batch)
            db.prepare(`DELETE FROM assetData WHERE folderKey IN (${ph})`).run(...batch)
            db.prepare(`DELETE FROM assetFolder WHERE folderKey IN (${ph})`).run(...batch)
          } else {
            // 本地库：逐个软删除
            for (const key of batch) {
              deleteAssetFolder(db, key)
            }
          }
        }
        return true
      })

      // 目录在事务之前就删完了。剩下缩略图这类派生物，丢后台清就行
      if (success && isNetworkVault && vaultNetworkPath) {
        scheduleThumbnailCleanup(vaultNetworkPath, assetThumbnails)
      }

      return { success: true, data: { deletedCount: allDeletedKeys.length } }
    } catch (error) {
      console.error('批量删除文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 彻底删除文件夹（清除以该文件夹为根、整条链路都已软删除的连通子树）
  ipcMain.handle('db:assetFolder:hardDelete', async (_, folderKey: string) => {
    void _
    try {
      // 保护 ALL 文件夹不被删除
      if (folderKey === ALL_FOLDER) {
        console.warn('禁止彻底删除 ALL 系统文件夹')
        return { success: false, error: 'ALL 是系统文件夹，不允许删除' }
      }

      const db = getVaultDatabase()
      if (getCurrentRemoteHttpVaultContext()) {
        return {
          success: false,
          error: '远程资产服务器不支持本地彻底删除文件夹，请先在服务端开放 folder purge 能力'
        }
      }

      // 「算计划 → 改挂幸存者 → 清连接表 → 删记录」全在一个同步事务里。
      // 磁盘文件只拿到一份清单，事务提交之后才真正动手 —— 事务一旦回滚，
      // scheduleVaultFileCleanup 这行代码根本到不了，磁盘不会先于数据库被削掉。
      const outcome = runInTransaction(db, (txDb) => {
        // 只清「整条链路都是 isDelete = 1」的连通子树：中途遇到用户已恢复的
        // 文件夹就停，那棵子树整体保留并改挂，它下面仍在回收站的孙节点留着。
        const purgedFolderKeys = collectDeletedSubtreeKeys(txDb, folderKey)
        if (purgedFolderKeys.length === 0) return null

        const plan = buildFolderPurgePlan(txDb, purgedFolderKeys)
        return { plan, result: applyFolderPurgePlan(txDb, plan) }
      })

      if (!outcome) {
        // 目标不存在，或者已经被恢复了（isDelete = 0），不该被彻底删除
        return { success: false, data: false }
      }

      scheduleVaultFileCleanup(outcome.plan.files, 'assetFolder:hardDelete')

      console.log(
        `[IPC] db:assetFolder:hardDelete 完成: 文件夹 ${outcome.result.deletedFolders}，` +
          `资产 ${outcome.result.deletedAssets}，改挂幸存文件夹 ${outcome.result.reparentedFolders}，` +
          `改挂幸存资产 ${outcome.result.reparentedAssets}`
      )

      return { success: true, data: true }
    } catch (error) {
      console.error('彻底删除资产文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 恢复文件夹（递归恢复该文件夹及其子孙与资产）
  ipcMain.handle('db:assetFolder:restore', async (_, folderKey: string) => {
    void _
    try {
      if (getCurrentRemoteHttpVaultContext()) {
        return {
          success: false,
          error: '远程资产服务器暂不支持恢复文件夹，请联系管理员在服务端处理'
        }
      }

      const db = getVaultDatabase()
      const success = await transaction(db, (db) => {
        return restoreAssetFolder(db, folderKey)
      })
      return { success, data: success }
    } catch (error) {
      console.error('恢复资产文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取所有文件夹
  ipcMain.handle('db:assetFolder:getAll', async () => {
    try {
      const db = getVaultDatabase()
      const folders = getAllAssetFolders(db)
      return { success: true, data: folders }
    } catch (error) {
      console.error('获取所有资产文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取所有已软删除的文件夹（回收站）
  ipcMain.handle('db:assetFolder:getDeleted', async (_, page?: number, pageSize?: number) => {
    try {
      const db = getVaultDatabase()
      // 兼容旧调用：如果不传分页参数，返回结构可能需要适配
      // 但这里我们统一返回 { list, total } 结构，前端需要相应更新
      // 如果是旧的前端代码调用（期望返回数组），这里会破坏兼容性
      // 所以我们检查参数
      const result = getDeletedAssetFolders(db, page, pageSize)

      // 为了保持向后兼容（虽然 Ideally 应该让前端改），
      // 如果没有传分页参数，且前端期望的是数组，我们这里返回 result.list
      // 但为了性能安全，如果没传分页参数，我们在 Model 层已经限制了 2000 条

      // 如果是分页调用，返回 { list, total }
      // 如果不是分页调用（page undefined），返回 list（数组）
      if (page === undefined) {
        return { success: true, data: result.list }
      }

      return { success: true, data: result }
    } catch (error) {
      console.error('获取已删除文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 清空所有已软删除的文件夹（不影响未删除的）
  ipcMain.handle('db:assetFolder:clearDeleted', async () => {
    try {
      if (getCurrentRemoteHttpVaultContext()) {
        return {
          success: false,
          error: '远程资产服务器暂不支持从 App 清空已删除文件夹'
        }
      }

      const db = getVaultDatabase()

      // 原来这里只有一句 `DELETE FROM assetFolder WHERE isDelete = 1`，
      // 靠 ON DELETE CASCADE 收尾。但级联会连坐删掉用户**已经单独恢复**
      // （isDelete = 0）的子资产和子文件夹，还会在 asset_tags /
      // asset_favorites / folder_tags 里留下孤儿行、磁盘文件永久残留。
      // 现在显式收集：幸存者先改挂到最近的存活祖先，再清连接表和记录。
      const { plan, result } = runInTransaction(db, (txDb) => {
        const purgedFolderKeys = collectAllDeletedFolderKeys(txDb)
        const purgePlan = buildFolderPurgePlan(txDb, purgedFolderKeys)
        return { plan: purgePlan, result: applyFolderPurgePlan(txDb, purgePlan) }
      })

      scheduleVaultFileCleanup(plan.files, 'assetFolder:clearDeleted')

      console.log(
        `[IPC] db:assetFolder:clearDeleted 完成: 文件夹 ${result.deletedFolders}，` +
          `资产 ${result.deletedAssets}，改挂幸存文件夹 ${result.reparentedFolders}，` +
          `改挂幸存资产 ${result.reparentedAssets}`
      )

      // 契约保持 data: boolean，不动上层调用方
      return { success: true, data: true }
    } catch (error) {
      console.error('清空已删除文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 检查文件夹是否存在
  ipcMain.handle('db:assetFolder:exists', async (_, folderKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const exists = assetFolderExists(db, folderKey)
      return { success: true, data: exists }
    } catch (error) {
      console.error('检查资产文件夹是否存在失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取文件夹路径数组（高效版本）
  ipcMain.handle('db:assetFolder:getPathArray', async (_, folderKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const pathArray = getFolderPathArray(db, folderKey)
      return { success: true, data: pathArray }
    } catch (error) {
      console.error('获取文件夹路径数组失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 批量获取文件夹路径
  ipcMain.handle('db:assetFolder:getBatchPaths', async (_, folderKeys: string[]) => {
    void _
    try {
      const db = getVaultDatabase()
      const paths = getBatchFolderPaths(db, folderKeys)
      return { success: true, data: paths }
    } catch (error) {
      console.error('批量获取文件夹路径失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据深度获取文件夹
  ipcMain.handle('db:assetFolder:getByDepth', async (_, depth: number) => {
    void _
    try {
      const db = getVaultDatabase()
      const folders = getFoldersByDepth(db, depth)
      return { success: true, data: folders }
    } catch (error) {
      console.error('根据深度获取文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 递归更新文件夹路径信息
  ipcMain.handle('db:assetFolder:updatePathsRecursively', async (_, rootFolderKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const success = await transaction(db, (db) => {
        updateFolderPathsRecursively(db, rootFolderKey)
        return true
      })
      return { success, data: success }
    } catch (error) {
      console.error('递归更新文件夹路径信息失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取文件夹树结构
  ipcMain.handle('db:assetFolder:getTree', async () => {
    try {
      const db = getVaultDatabase()

      // 构建树结构的递归函数
      const buildTree = (fatherKey: string | null = null): any[] => {
        const folders = getAssetFoldersByFatherKey(db, fatherKey)
        return folders.map((folder) => ({
          ...folder,
          children: buildTree(folder.folderKey)
        }))
      }

      const tree = buildTree()
      return { success: true, data: tree }
    } catch (error) {
      console.error('获取文件夹树结构失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 搜索文件夹
  ipcMain.handle('db:assetFolder:search', async (_event, criteria: FolderSearchCriteria) => {
    try {
      const db = getVaultDatabase()
      const folders = searchAssetFoldersByCriteria(db, criteria)
      return { success: true, data: folders }
    } catch (error) {
      console.error('搜索文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
