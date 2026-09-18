import { ipcMain } from 'electron'

import { getVaultDatabase } from '../../index'
import { transaction } from '../../dbUtils'
import {
  createAssetData,
  getAssetDataByKey,
  getAssetDataByFolderKey,
  getFilteredAssetCountByFolderKey,
  searchAssetDataByName,
  updateAssetData,
  deleteAssetData,
  deleteAssetDataByFolderKey,
  getAllAssetData,
  restoreAssetData,
  assetDataExists,
  getAssetDataBySoftPath,
  getAssetsBySoftPaths,
  getRetainedFilePaths,
  getSharedLiveFilePaths,
  initAssetDataModel,
  type AssetData
} from '../../models/assetData'
import {
  pushAssetCreate,
  pushAssetUpdate,
  pushAssetDelete,
  pushBatchOperations
} from '../../../networkV2/NetworkSyncBridge'
import { getCurrentRemoteHttpVaultContext } from '../../../networkV2/currentRemoteHttpVault'
import { assetUpdateRejectionMessage, checkRendererAssetUpdate } from './updateGuard'
import { scheduleVaultFileCleanup, type VaultFileRef } from '../../services/vaultFileCleanup'
import {
  getRetainedThumbnailFilenames,
  retainSharedThumbnails
} from '../../services/vaultThumbnailRefs'

/**
 * ── 物理清理的两道占用闸 ─────────────────────────────────────────────
 *
 * 「彻底删除」要动磁盘，动之前必须问两句：这个**素材文件**还有没有别人用？
 * 这张**封面图**还有没有别人用？两句都在删数据库行之前问完，问完的结果
 * 随行记在清理清单里（见 services/vaultFileCleanup 的 VaultFileRef）。
 *
 * 1. 素材文件：同一个文件导入两遍会留下两条记录、两个 assetKey，但 filePath
 *    是同一个。软删掉其中一条不碰磁盘，可一旦「彻底删除 / 清空回收站」，
 *    `deleteVaultBackupAndThumbnail` 就会照着 filePath 把文件 unlink 掉 ——
 *    还活着的那条记录当场指向一个不存在的文件，界面上是个打不开的空壳。
 *    **回收站里的其他记录同样算占用者**，否则它们只能恢复出空壳。
 *    判断走 models/assetData 的 getRetainedFilePaths / getSharedLiveFilePaths。
 *
 * 2. 封面图：以前这里写着「缩略图不用手软，文件名带随机串，两次导入各有各的
 *    一张」—— 那句话对导入生成的 imgLocalPath 成立，对 customPoster 不成立：
 *    批量封面上传把同一个文件名同时写进一个文件夹的 img 和它下面 N 个资产的
 *    customPoster。删掉其中一个资产就把其余 N-1 个**还活着**的资产连带文件夹
 *    封面一起削成裂图。判断走 services/vaultThumbnailRefs。
 *
 * 两道闸都要**排除本次真的要删掉的那些行**，否则它们会把自己数成占用者，
 * 文件于是永远删不掉。**数据库行照删，文件留给幸存者** —— 等最后一个用它的人
 * 也走了，那一次自然会把它删干净，不会永久残留。
 */

export function registerAssetDataCrudIPC(): void {
  ipcMain.handle('db:assetData:create', async (_, assetData: AssetData) => {
    void _
    try {
      const db = getVaultDatabase()
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        await remoteHttpCtx.client.createAsset(assetData as unknown as Record<string, unknown>)
        await remoteHttpCtx.client.pullChanges()
        return { success: true, data: 1 }
      }

      const assetId = createAssetData(db, assetData)
      // 只走 push*：它内部已按角色分流，重复调 syncChangeToV2 会让 server
      // 角色下每次写都记两条 change_log、广播两遍
      const remoteSync = await pushAssetCreate(assetData as unknown as Record<string, unknown>)
      return {
        success: true,
        data: assetId,
        ...(remoteSync.status === 'skipped' ? {} : { remoteSync })
      }
    } catch (error) {
      console.error('创建资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:getByKey', async (_, assetKey: string) => {
    void _
    try {
      return { success: true, data: getAssetDataByKey(getVaultDatabase(), assetKey) }
    } catch (error) {
      console.error('获取资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:getById', async (_, assetKey: string) => {
    void _
    try {
      return { success: true, data: getAssetDataByKey(getVaultDatabase(), assetKey) }
    } catch (error) {
      console.error('获取资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:getBySoftPath', async (_, softPath: string) => {
    void _
    try {
      return { success: true, data: getAssetDataBySoftPath(getVaultDatabase(), softPath) }
    } catch (error) {
      console.error('根据软路径获取资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:getBySoftPaths', async (_, softPaths: string[]) => {
    void _
    try {
      return {
        success: true,
        data: getAssetsBySoftPaths(getVaultDatabase(), Array.isArray(softPaths) ? softPaths : [])
      }
    } catch (error) {
      console.error('批量获取软路径资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'db:assetData:getByFolderKey',
    async (
      _,
      folderKey: string,
      sortBy?: string,
      sortOrder?: string,
      showDependencies?: boolean,
      limit?: number,
      offset?: number
    ) => {
      void _
      try {
        const db = getVaultDatabase()
        initAssetDataModel(db)
        const assets = getAssetDataByFolderKey(
          db,
          folderKey,
          sortBy as 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
          sortOrder as 'asc' | 'desc',
          showDependencies ?? false,
          limit,
          offset
        )
        return { success: true, data: assets }
      } catch (error) {
        console.error('获取文件夹资产数据失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'db:assetData:getCountByFolderKey',
    async (_, folderKey: string, showDependencies?: boolean) => {
      void _
      try {
        const db = getVaultDatabase()
        initAssetDataModel(db)
        const count = getFilteredAssetCountByFolderKey(db, folderKey, showDependencies ?? true)
        return { success: true, data: count }
      } catch (error) {
        console.error('获取文件夹资产数量失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'db:assetData:getByFolderKeyRecursive',
    async (_, rootFolderKey: string, filters?: { keyword?: string }) => {
      void _
      try {
        const db = getVaultDatabase()
        const searchableColumns = ['ad.assetName']
        const whereClauses: string[] = ['ad.isDelete = 0', 'COALESCE(ad.isDependency, 0) = 0']
        const params: any[] = [rootFolderKey]

        const keyword = filters?.keyword?.trim()
        if (keyword) {
          const likeParam = `%${keyword}%`
          const ors = searchableColumns.map((col) => `${col} LIKE ? COLLATE NOCASE`)
          whereClauses.push(`(${ors.join(' OR ')})`)
          for (let i = 0; i < searchableColumns.length; i++) params.push(likeParam)
        }

        const sql = `
        WITH RECURSIVE folder_tree AS (
          SELECT folderKey FROM assetFolder WHERE folderKey = ? AND isDelete = 0
          UNION ALL
          SELECT af.folderKey FROM assetFolder af
          JOIN folder_tree ft ON af.fatherKey = ft.folderKey
          WHERE af.isDelete = 0
        )
        SELECT ad.* FROM assetData ad
        JOIN folder_tree ft ON ad.folderKey = ft.folderKey
        ${whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : ''}
        ORDER BY ad.assetName ASC
      `

        return { success: true, data: db.prepare(sql).all(...params) }
      } catch (error) {
        console.error('递归获取文件夹树中的资产失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('db:assetData:search', async (_, searchTerm: string) => {
    void _
    try {
      return { success: true, data: searchAssetDataByName(getVaultDatabase(), searchTerm) }
    } catch (error) {
      console.error('搜索资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'db:assetData:update',
    async (_, assetKey: string, updates: Partial<AssetData>) => {
      void _
      try {
        // 通用更新通道不许碰路径列和状态列，见 updateGuard.ts 的注释
        const guard = checkRendererAssetUpdate(updates)
        if (!guard.ok) {
          console.warn('[db:assetData:update] 拒绝受保护字段:', guard.rejected)
          return { success: false, error: assetUpdateRejectionMessage(guard.rejected) }
        }

        const db = getVaultDatabase()
        const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
        if (remoteHttpCtx) {
          const existing = getAssetDataByKey(db, assetKey)
          if (!existing) return { success: false, error: '资产不存在或已被删除' }

          await remoteHttpCtx.client.updateAsset(
            assetKey,
            updates as unknown as Record<string, unknown>
          )
          await remoteHttpCtx.client.pullChanges()
          return { success: true, data: true }
        }

        const success = updateAssetData(db, assetKey, updates)
        if (!success) return { success: false, data: false }

        // ⚠️ 不再 .catch(() => {})：远端推送的结果必须让渲染层看到。
        // 注意 success 仍然只反映**本地写**的结果 —— 离线时本地写照常成功，
        // remoteSync 只是一个旁路字段，不会把「没网」变成「保存失败」。
        // 只走 push*：它内部已按角色分流；以前这里还额外调一次 syncChangeToV2，
        // server 角色下等于每次写都记两条 change_log、广播两遍。
        const remoteSync = await pushAssetUpdate(assetKey, updates as Record<string, unknown>)
        return {
          success: true,
          data: true,
          ...(remoteSync.status === 'skipped' ? {} : { remoteSync })
        }
      } catch (error) {
        console.error('更新资产数据失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('db:assetData:delete', async (_, assetKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        await remoteHttpCtx.client.deleteAsset(assetKey)
        await remoteHttpCtx.client.pullChanges()
        return { success: true, data: true }
      }

      const success = deleteAssetData(db, assetKey)
      if (!success) return { success: false, data: false }

      const remoteSync = await pushAssetDelete(assetKey)
      return {
        success: true,
        data: true,
        ...(remoteSync.status === 'skipped' ? {} : { remoteSync })
      }
    } catch (error) {
      console.error('删除资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 彻底删除（回收站里的「永久删除」）。**只有批量这一条路。**
   *
   * 原来还有一个单条的 `db:assetData:hardDelete`，删掉了：它和这里是同一件事的
   * 两份实现，而「删文件前先问一句还有没有别人在用」的判断要在两边各写一遍 ——
   * 封面图被连坐删掉那个 bug，正是因为其中一处没写。一件事一条路。
   *
   * 批量也不是「循环调单条」的语法糖：每条都要算一遍「这个文件 / 这张封面还有没有
   * 别人用」，而那是一次全库扫描。回收站里勾 200 个按彻底删除，逐条算就是
   * 200 次扫描全压在主进程上。这里一次算完，整批共用。
   */
  ipcMain.handle('db:assetData:hardDeleteMany', async (_, assetKeys: string[]) => {
    void _
    try {
      const keys = Array.from(
        new Set((assetKeys ?? []).map((key) => String(key ?? '').trim()).filter(Boolean))
      )
      if (keys.length === 0) return { success: true, data: { deleted: [], failed: [] } }

      const db = getVaultDatabase()
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        const deleted: string[] = []
        const failed: Array<{ assetKey: string; error: string }> = []
        for (const assetKey of keys) {
          try {
            await remoteHttpCtx.client.purgeAsset(assetKey)
            deleted.push(assetKey)
          } catch (error) {
            failed.push({ assetKey, error: (error as Error).message })
          }
        }
        if (deleted.length > 0) await remoteHttpCtx.client.pullChanges()
        return { success: true, data: { deleted, failed } }
      }

      const rows = db
        .prepare(
          `SELECT assetKey, filePath, imgLocalPath, customPoster FROM assetData
            WHERE isDelete = 1 AND assetKey IN (${keys.map(() => '?').join(',')})`
        )
        .all(...keys) as Array<{
        assetKey: string
        filePath?: string
        imgLocalPath?: string
        customPoster?: string
      }>

      // 两道占用闸都在删行之前、整批一次算完（见文件顶部「物理清理的两道占用闸」）
      const purgedKeys = rows.map((row) => row.assetKey)
      const retainedPaths = getRetainedFilePaths(
        db,
        rows.map((row) => row.filePath),
        purgedKeys
      )
      const retainedThumbnails = getRetainedThumbnailFilenames(db, { excludeAssetKeys: purgedKeys })
      const cleanup = rows.map((row) =>
        retainSharedThumbnails(
          {
            filePath: row.filePath && retainedPaths.has(row.filePath) ? null : row.filePath,
            imgLocalPath: row.imgLocalPath,
            customPoster: row.customPoster
          },
          retainedThumbnails
        )
      )

      const deleted = await transaction(db, (innerDb) => {
        const done: string[] = []
        const dropTags = innerDb.prepare(`DELETE FROM asset_tags WHERE assetKey = ?`)
        const dropFavorites = innerDb.prepare(`DELETE FROM asset_favorites WHERE assetKey = ?`)
        const dropAsset = innerDb.prepare(
          `DELETE FROM assetData WHERE assetKey = ? AND isDelete = 1`
        )
        for (const assetKey of purgedKeys) {
          dropTags.run(assetKey)
          dropFavorites.run(assetKey)
          if (dropAsset.run(assetKey).changes > 0) done.push(assetKey)
        }
        return done
      })

      scheduleVaultFileCleanup(cleanup, 'hardDeleteMany')

      const failed = keys
        .filter((key) => !deleted.includes(key))
        .map((assetKey) => ({ assetKey, error: '它不在回收站里' }))
      return { success: true, data: { deleted, failed } }
    } catch (error) {
      console.error('批量彻底删除资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 一次恢复一批。
   *
   * 界面上「彻底删除」早就是整批的（Delete 键一下删掉选中的全部），恢复却只能
   * 右键一个一个点 —— **破坏性的那一半批量，可撤销的那一半不批量**，正好反了。
   * 误删两百个的人要点两百次右键。
   */
  ipcMain.handle('db:assetData:restoreMany', async (_, assetKeys: string[]) => {
    void _
    try {
      const keys = Array.from(
        new Set((assetKeys ?? []).map((key) => String(key ?? '').trim()).filter(Boolean))
      )
      if (keys.length === 0) return { success: true, data: { restored: [], failed: [] } }

      const restored: string[] = []
      const failed: Array<{ assetKey: string; error: string }> = []
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      const db = getVaultDatabase()

      for (const assetKey of keys) {
        try {
          if (remoteHttpCtx) {
            await remoteHttpCtx.client.restoreAsset(assetKey)
            restored.push(assetKey)
            continue
          }
          if (!restoreAssetData(db, assetKey)) {
            failed.push({ assetKey, error: '它不在回收站里' })
            continue
          }
          // 不推的话服务端那行还是 isDelete=1，下一次对账会把它又软删回去
          await pushAssetUpdate(assetKey, { isDelete: 0, updated_at: new Date().toISOString() })
          restored.push(assetKey)
        } catch (error) {
          failed.push({ assetKey, error: (error as Error).message })
        }
      }

      if (remoteHttpCtx && restored.length > 0) await remoteHttpCtx.client.pullChanges()

      return { success: true, data: { restored, failed } }
    } catch (error) {
      console.error('批量恢复资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:restore', async (_, assetKey: string) => {
    void _
    try {
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        await remoteHttpCtx.client.restoreAsset(assetKey)
        await remoteHttpCtx.client.pullChanges()
        return { success: true, data: true }
      }

      const db = getVaultDatabase()
      const success = restoreAssetData(db, assetKey)
      if (!success) return { success, data: success }

      // 恢复也是一次改动，不推的话服务端那行还是 isDelete=1，
      // 快照里根本没有它 → 下一次对账把刚恢复的资产又软删回去，「恢复不了」
      const remoteSync = await pushAssetUpdate(assetKey, {
        isDelete: 0,
        updated_at: new Date().toISOString()
      })
      return {
        success: true,
        data: true,
        ...(remoteSync.status === 'skipped' ? {} : { remoteSync })
      }
    } catch (error) {
      console.error('恢复资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:deleteByFolderKey', async (_, folderKey: string) => {
    void _
    try {
      if (getCurrentRemoteHttpVaultContext()) {
        return { success: false, error: '远程资产服务器不支持按文件夹本地批量删除' }
      }

      const deletedCount = await transaction(getVaultDatabase(), (db) => {
        return deleteAssetDataByFolderKey(db, folderKey)
      })
      return { success: true, data: deletedCount }
    } catch (error) {
      console.error('批量删除文件夹资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:getDistinctAssetTypes', async () => {
    try {
      const db = getVaultDatabase()
      const { getDistinctAssetTypes } = await import('../../models/assetData')
      return { success: true, data: getDistinctAssetTypes(db) }
    } catch (error) {
      console.error('获取资产类型列表失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:getAll', async () => {
    try {
      return { success: true, data: getAllAssetData(getVaultDatabase()) }
    } catch (error) {
      console.error('获取所有资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:clearDeleted', async () => {
    try {
      const db = getVaultDatabase()

      const { success, files } = await transaction(db, (innerDb) => {
        const rows = innerDb
          .prepare(
            `SELECT assetKey, filePath, imgLocalPath, customPoster FROM assetData WHERE isDelete = 1`
          )
          .all() as Array<{
          assetKey: string
          filePath?: string
          imgLocalPath?: string
          customPoster?: string
        }>

        // 清理清单在删行之前一次算完：哪些 filePath 还被 isDelete = 0 的记录占着，
        // 占着的就别 unlink（理由见文件顶部那两道闸）。这里不逐条查 ——
        // 回收站里几千条就是几千次 SELECT，全压在这个同步事务里主进程会卡住。
        const stillUsed = getSharedLiveFilePaths(
          innerDb,
          rows.map((row) => row.filePath)
        )
        // 缩略图同理：清空回收站要删掉的是这一整批，其余的行（包括还活着的资产
        // 和文件夹封面）指着的封面图一张都不能动
        const retainedThumbnails = getRetainedThumbnailFilenames(innerDb, {
          excludeAssetKeys: rows.map((row) => row.assetKey)
        })

        innerDb
          .prepare(
            `DELETE FROM asset_tags WHERE assetKey IN (SELECT assetKey FROM assetData WHERE isDelete = 1)`
          )
          .run()
        innerDb
          .prepare(
            `DELETE FROM asset_favorites WHERE assetKey IN (SELECT assetKey FROM assetData WHERE isDelete = 1)`
          )
          .run()
        const result = innerDb.prepare(`DELETE FROM assetData WHERE isDelete = 1`).run()

        return {
          success: result.changes >= 0,
          files: rows.map<VaultFileRef>((row) =>
            retainSharedThumbnails(
              {
                filePath: row.filePath && stillUsed.has(row.filePath) ? null : row.filePath,
                imgLocalPath: row.imgLocalPath,
                customPoster: row.customPoster
              },
              retainedThumbnails
            )
          )
        }
      })

      scheduleVaultFileCleanup(files, 'clearDeleted')

      return { success, data: success }
    } catch (error) {
      console.error('清空已删除资产失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:exists', async (_, assetKey: string) => {
    void _
    try {
      return { success: true, data: assetDataExists(getVaultDatabase(), assetKey) }
    } catch (error) {
      console.error('检查资产数据是否存在失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:batchCreate', async (_, assetDataList: AssetData[]) => {
    void _
    try {
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        const operations = (assetDataList || []).map((assetData) => ({
          type: 'insert',
          table: 'assetData',
          data: assetData as unknown as Record<string, unknown>
        }))
        if (operations.length > 0) {
          await remoteHttpCtx.client.batch(operations)
          await remoteHttpCtx.client.pullChanges()
        }
        return { success: true, data: operations.map((_, index) => index + 1) }
      }

      const created: AssetData[] = []
      const results = await transaction(getVaultDatabase(), (db) => {
        return (assetDataList || [])
          .map((assetData) => {
            try {
              const id = createAssetData(db, assetData)
              created.push(assetData)
              return id
            } catch (error) {
              console.error(`创建资产 ${assetData.assetKey} 失败:`, error)
              return null
            }
          })
          .filter((id) => id !== null)
      })

      // 同 batchDelete：不推的话这批资产只存在于本地，对账时会被差集软删掉
      const remoteSync = await pushBatchOperations(
        created.map((assetData) => ({
          type: 'insert' as const,
          table: 'assetData' as const,
          data: assetData as unknown as Record<string, unknown>
        }))
      )
      return {
        success: true,
        data: results,
        ...(remoteSync.status === 'skipped' ? {} : { remoteSync })
      }
    } catch (error) {
      console.error('批量创建资产数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:batchDelete', async (_, assetKeys: string[]) => {
    void _
    try {
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        const keys = (assetKeys || []).map(String).filter(Boolean)
        const operations = keys.map((assetKey) => ({
          type: 'delete',
          table: 'assetData',
          data: { assetKey }
        }))
        if (operations.length > 0) {
          await remoteHttpCtx.client.batch(operations)
          await remoteHttpCtx.client.pullChanges()
        }
        return { success: true, data: { deleted: operations.length } }
      }

      const deleted: string[] = []
      const deletedCount = await transaction(getVaultDatabase(), (db) => {
        for (const key of assetKeys ?? []) {
          try {
            if (deleteAssetData(db, key)) deleted.push(key)
          } catch (error) {
            console.error(`软删除资产 ${key} 失败:`, error)
          }
        }
        return deleted.length
      })

      // 单条删除一直在推，批量删除以前什么都不推 —— 而多选删除走的正是这条路。
      // 结果是同事那边看不到，本端下一次对账又被服务端还活着的行盖回来，
      // 用户看到的就是「删了又回来」。
      const remoteSync = await pushBatchOperations(
        deleted.map((assetKey) => ({
          type: 'delete' as const,
          table: 'assetData' as const,
          data: { assetKey }
        }))
      )
      return {
        success: true,
        data: { deleted: deletedCount },
        ...(remoteSync.status === 'skipped' ? {} : { remoteSync })
      }
    } catch (error) {
      console.error('批量软删除资产失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:moveToFolder', async (_, assetKey: string, newFolderKey: string) => {
    void _
    try {
      const updates = {
        folderKey: newFolderKey,
        updated_at: new Date().toISOString()
      }
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      if (remoteHttpCtx) {
        await remoteHttpCtx.client.updateAsset(assetKey, updates)
        await remoteHttpCtx.client.pullChanges()
        return { success: true, data: true }
      }

      const success = updateAssetData(getVaultDatabase(), assetKey, updates)
      if (!success) return { success: false, data: false }

      const remoteSync = await pushAssetUpdate(assetKey, updates)
      return {
        success: true,
        data: true,
        ...(remoteSync.status === 'skipped' ? {} : { remoteSync })
      }
    } catch (error) {
      console.error('移动资产到文件夹失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
