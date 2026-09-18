/**
 * 局域网协作库 IPC 处理器
 */
import { ipcMain, BrowserWindow } from 'electron'
import { getNetworkAuthManager } from '../smb/NetworkAuthManager'
import { getNetworkVaultSync } from '../smb/NetworkVaultSync'
import { getAssetClassNameCn } from '../utils/assetClassUtils'
import { getTagByName, createTag, initTagModel } from '../sqliteDataBase/models/tag'
import { setTagsForAsset, initAssetTagModel } from '../sqliteDataBase/models/assetTag'
import { getPublicDatabase } from '../sqliteDataBase/index'
import Database from 'better-sqlite3'

// 取消信号管理 - 用于跟踪正在进行的扫描任务
const activeScans = new Map<string, { aborted: boolean }>()

/**
 * 从 softPath 中提取资产分类
 */
const extractAssetClass = (softPath?: string): string => {
  if (!softPath) return 'Other'
  // 从 /Game/xxx/... 中提取第一级目录作为分类
  const match = softPath.match(/\/Game\/([^/]+)/)
  return match ? match[1] : 'Other'
}

/**
 * 同步资产标签到本地的 asset_tags 关联表
 * 如果标签不存在则自动创建
 * @param vaultDb 保管库数据库（用于 asset_tags）
 */
const syncAssetTags = (vaultDb: Database.Database, assetKey: string, tagNames: string[]): void => {
  // 确保 asset_tags 表已初始化（保管库数据库）
  initAssetTagModel(vaultDb)

  if (!tagNames || tagNames.length === 0) {
    // 清空该资产的所有标签
    setTagsForAsset(vaultDb, assetKey, [])
    return
  }

  // 🔧 关键修复：tags 表在公共数据库中
  const publicDb = getPublicDatabase()
  initTagModel(publicDb)

  const tagIds: number[] = []
  for (const tagName of tagNames) {
    // 从公共数据库尝试获取现有标签
    const tag = getTagByName(publicDb, tagName)
    if (!tag) {
      // 标签不存在，在公共数据库创建新标签
      const newTagId = createTag(publicDb, { name: tagName })
      console.log(`[NetworkVault] 自动创建标签: ${tagName} -> ID: ${newTagId}`)
      tagIds.push(newTagId)
    } else {
      tagIds.push(tag.id!)
    }
  }

  // 更新资产的标签关联（保管库数据库）
  setTagsForAsset(vaultDb, assetKey, tagIds)
}

/** 网络凭据接口 */
interface NetworkCredentials {
  username: string
  password: string
  domain?: string
}

/**
 * 注册局域网协作库相关的 IPC 处理器
 */
export function registerNetworkVaultHandlers(): void {
  const authManager = getNetworkAuthManager()
  const syncManager = getNetworkVaultSync()

  // ========== 认证相关 ==========

  /**
   * 测试网络路径访问
   */
  ipcMain.handle('networkVault:testAccess', async (_event, networkPath: string) => {
    try {
      const result = await authManager.testAccess(networkPath)
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 检查网络路径的写入权限
   */
  ipcMain.handle('networkVault:checkWritePermission', async (_event, networkPath: string) => {
    try {
      const result = await syncManager.checkWritePermission(networkPath)
      return result
    } catch (error) {
      return { canWrite: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 使用凭据连接网络路径
   */
  ipcMain.handle(
    'networkVault:connect',
    async (_event, networkPath: string, credentials: NetworkCredentials) => {
      try {
        const result = await authManager.connectWithCredentials(networkPath, credentials)
        return result
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 断开网络连接
   */
  ipcMain.handle('networkVault:disconnect', async (_event, networkPath: string) => {
    try {
      await authManager.disconnect(networkPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 保存凭据
   */
  ipcMain.handle(
    'networkVault:saveCredentials',
    async (_event, networkPath: string, credentials: NetworkCredentials) => {
      try {
        await authManager.saveCredentials(networkPath, credentials)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 加载已保存的凭据
   */
  ipcMain.handle('networkVault:loadCredentials', async (_event, networkPath: string) => {
    try {
      const credentials = await authManager.loadCredentials(networkPath)
      return { success: true, data: credentials }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 删除已保存的凭据
   */
  ipcMain.handle('networkVault:deleteCredentials', async (_event, networkPath: string) => {
    try {
      await authManager.deleteCredentials(networkPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ========== 同步相关 ==========

  /**
   * 读取远程 manifest
   */
  ipcMain.handle('networkVault:readManifest', async (_event, networkPath: string) => {
    try {
      const manifest = await syncManager.readManifest(networkPath)
      return { success: true, data: manifest }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 创建局域网协作库
   */
  ipcMain.handle(
    'networkVault:create',
    async (_event, networkPath: string, name: string, createdBy: string) => {
      try {
        const result = await syncManager.createNetworkVault(networkPath, name, createdBy)
        return result
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 检查远程更新
   */
  ipcMain.handle(
    'networkVault:checkForUpdates',
    async (_event, networkPath: string, lastKnownVersion: number) => {
      try {
        const hasUpdates = await syncManager.checkForUpdates(networkPath, lastKnownVersion)
        return { success: true, data: hasUpdates }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 从网络同步
   */
  ipcMain.handle(
    'networkVault:syncFromNetwork',
    async (_event, networkPath: string, localCachePath: string) => {
      try {
        const result = await syncManager.syncFromNetwork(networkPath, localCachePath)
        return result
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 扫描资产
   */
  ipcMain.handle(
    'networkVault:scanAssets',
    async (_event, networkPath: string, options?: object) => {
      try {
        const assets = await syncManager.scanAssets(networkPath, options)
        return { success: true, data: assets }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 添加资产
   */
  ipcMain.handle(
    'networkVault:addAssets',
    async (
      _event,
      networkPath: string,
      assets: object[],
      modifiedBy: string,
      expectedVersion?: number
    ) => {
      try {
        const result = await syncManager.addAssets(
          networkPath,
          assets as Parameters<typeof syncManager.addAssets>[1],
          modifiedBy,
          expectedVersion
        )
        // V3 优化: 添加后统一执行 Compaction
        if (result.success && result.added && result.added > 0) {
          const lockResult = await syncManager.acquireLock(networkPath)
          if (lockResult.acquired) {
            try {
              await syncManager.compactJournals(networkPath)
            } finally {
              await syncManager.releaseLock(networkPath)
            }
          }
        }
        return result
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 更新资产
   */
  ipcMain.handle(
    'networkVault:updateAsset',
    async (
      _event,
      networkPath: string,
      assetKey: string,
      updates: object,
      modifiedBy: string,
      expectedVersion?: number
    ) => {
      try {
        const result = await syncManager.updateAsset(
          networkPath,
          assetKey,
          updates,
          modifiedBy,
          expectedVersion
        )
        return result
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 扫描现有资产并初始化清单（带进度回调和元数据解析）
   * 用于已有资产的网络路径首次接入
   */
  ipcMain.handle(
    'networkVault:initializeFromExisting',
    async (event, networkPath: string, vaultName: string) => {
      try {
        const os = await import('os')
        const currentHostname = os.hostname()

        // 🔧 新增：检查是否有写入权限
        const permissionCheck = await syncManager.checkWritePermission(networkPath)
        const isReadOnly = !permissionCheck.canWrite

        // 1. 检查是否已有清单（🔧 改用 getFullManifest 包含 Journal 条目）
        const existingManifest = await syncManager.getFullManifest(networkPath)
        const startVersion = existingManifest?.version

        // 🔧 如果没有写入权限且没有现有清单，无法初始化
        if (isReadOnly && !existingManifest) {
          console.log('[NetworkVault] 只读模式但没有现有清单，无法初始化')
          return {
            success: false,
            readOnly: true,
            error: '没有写入权限，且该网络路径尚未被初始化。请让有写权限的用户先初始化资产库。'
          }
        }

        // 🔧 如果是只读模式但有现有清单，跳过扫描，直接返回成功让 syncToLocalSQLite 处理
        if (isReadOnly && existingManifest) {
          console.log('[NetworkVault] 只读模式，已有清单，跳过扫描直接同步')
          return {
            success: true,
            readOnly: true,
            data: {
              added: existingManifest.assets?.length || 0,
              total: existingManifest.assets?.length || 0,
              message: '只读模式：已同步现有资产清单'
            }
          }
        }

        // 创建可取消的扫描任务
        const scanId = `scan_${Date.now()}`
        const abortSignal = { aborted: false }
        activeScans.set(scanId, abortSignal)

        // 获取发送进度的窗口
        const win = BrowserWindow.fromWebContents(event.sender)

        // 2. 扫描现有资产（带进度回调和元数据解析）
        console.log(`[NetworkVault] 开始扫描网络路径: ${networkPath}`)

        const assets = await syncManager.scanAssetsWithMetadata(networkPath, {
          onProgress: (current, total, assetName) => {
            // 发送进度事件到渲染进程
            win?.webContents.send('networkVault:scanProgress', {
              scanId,
              current,
              total,
              assetName,
              phase: 'parsing'
            })
          },
          abortSignal,
          parseMetadata: true
        })

        // 清理扫描任务
        activeScans.delete(scanId)

        // 检查是否被取消
        if (abortSignal.aborted) {
          console.log('[NetworkVault] 扫描已被用户取消')
          return { success: false, cancelled: true, error: '扫描已取消' }
        }

        console.log(`[NetworkVault] 发现 ${assets.length} 个资产`)

        if (assets.length === 0) {
          return { success: true, data: { added: 0, message: '未发现任何资产文件' } }
        }

        // 3. 创建或更新清单
        if (!existingManifest) {
          const createResult = await syncManager.createNetworkVault(
            networkPath,
            vaultName,
            currentHostname
          )
          if (!createResult.success) {
            return { success: false, error: createResult.error }
          }
        }

        // 4. 从资产中提取唯一文件夹并添加到清单
        const folderSet = new Set<string>()
        for (const asset of assets) {
          if (asset.folder && asset.folder !== 'ALL') {
            folderSet.add(asset.folder)
          }
        }

        console.log(
          `[NetworkVault] 从 ${assets.length} 个资产中提取到 ${folderSet.size} 个唯一文件夹路径:`,
          Array.from(folderSet)
        )

        // 统计各文件夹的资产数量
        const folderAssetCount: Record<string, number> = {}
        for (const asset of assets) {
          const f = asset.folder || 'ALL'
          folderAssetCount[f] = (folderAssetCount[f] || 0) + 1
        }
        console.log('[NetworkVault] 各文件夹资产数量:', folderAssetCount)

        // 创建文件夹条目（支持层级结构）
        // 路径格式如: "Content", "Content/Textures", "Content/Textures/UI"
        const folderPathToKey = new Map<string, string>()
        const folders: Array<{
          key: string
          name: string
          parent: string
          createdBy: string
          createdAt: string
        }> = []

        if (folderSet.size > 0) {
          // 按路径深度排序，确保父文件夹先创建
          const sortedPaths = Array.from(folderSet).sort((a, b) => {
            const depthA = (a.match(/\//g) || []).length
            const depthB = (b.match(/\//g) || []).length
            return depthA - depthB
          })

          for (const folderPath of sortedPaths) {
            // 解析路径的每一级
            const parts = folderPath.split('/')
            let currentPath = ''

            for (let i = 0; i < parts.length; i++) {
              const part = parts[i]
              const previousPath = currentPath
              currentPath = currentPath ? `${currentPath}/${part}` : part

              // 如果这一级已经创建过，跳过
              if (folderPathToKey.has(currentPath)) continue

              // 确定父文件夹
              const parentKey = previousPath ? folderPathToKey.get(previousPath) : 'ALL'

              // 创建文件夹
              const folderKey = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
              folderPathToKey.set(currentPath, folderKey)

              folders.push({
                key: folderKey,
                name: part, // 只使用目录名，不是完整路径
                parent: parentKey || 'ALL',
                createdBy: currentHostname,
                createdAt: new Date().toISOString()
              })
              console.log(
                `[NetworkVault] 创建文件夹: ${part} (path: ${currentPath}, parent: ${parentKey || 'ALL'}, key: ${folderKey})`
              )
            }
          }

          // 将文件夹添加到清单
          if (folders.length > 0) {
            await syncManager.addFolders(networkPath, folders, currentHostname)
            console.log(`[NetworkVault] 添加了 ${folders.length} 个文件夹到清单（支持层级）`)
          }

          // 更新资产的 folder 字段为实际的 folderKey
          for (const asset of assets) {
            if (asset.folder && asset.folder !== 'ALL') {
              const key = folderPathToKey.get(asset.folder)
              if (key) {
                asset.folder = key
              }
            }
          }
        }

        // 5. 添加资产到清单
        const addResult = await syncManager.addAssets(
          networkPath,
          assets,
          currentHostname,
          startVersion
        )

        if (!addResult.success) {
          return addResult
        }

        // V3 优化: 资产添加完成后统一执行 Compaction
        console.log('[NetworkVault] 资产添加完成，执行统一 Compaction')
        const lockResult = await syncManager.acquireLock(networkPath)
        if (lockResult.acquired) {
          try {
            await syncManager.compactJournals(networkPath)
          } finally {
            await syncManager.releaseLock(networkPath)
          }
        }

        console.log(`[NetworkVault] 清单初始化完成: 添加 ${addResult.added} 个资产`)

        return {
          success: true,
          data: {
            added: addResult.added,
            total: assets.length,
            message: `已添加 ${addResult.added} 个资产到网络清单`
          }
        }
      } catch (error) {
        console.error('[NetworkVault] 初始化清单失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 取消正在进行的扫描
   */
  ipcMain.handle('networkVault:cancelScan', async (_event, scanId: string) => {
    const signal = activeScans.get(scanId)
    if (signal) {
      signal.aborted = true
      activeScans.delete(scanId)
      console.log(`[NetworkVault] 取消扫描: ${scanId}`)
      return { success: true }
    }
    return { success: false, error: '扫描任务不存在' }
  })

  /**
   * 同步网络 manifest 资产到当前保管库的本地 SQLite
   * 应在保管库创建并切换后调用
   */
  ipcMain.handle('networkVault:syncToLocalSQLite', async (_event, networkPath: string) => {
    try {
      console.log(`[NetworkVault] 开始同步网络资产到本地 SQLite: ${networkPath}`)

      // 🔧 检查写入权限，只有可写用户才触发 Compaction
      const permissionCheck = await syncManager.checkWritePermission(networkPath)
      if (permissionCheck.canWrite) {
        // 0. 先触发 Compaction，确保 Journal 条目已合并到 manifest
        const lockResult = await syncManager.acquireLock(networkPath)
        if (lockResult.acquired) {
          try {
            await syncManager.compactJournals(networkPath)
          } finally {
            await syncManager.releaseLock(networkPath)
          }
        }
      } else {
        console.log('[NetworkVault] 只读模式，跳过 Compaction')
      }

      // 1. 读取完整的 manifest（包含未 Compaction 的 Journal 条目）
      // 🔧 修复：使用 getFullManifest 代替 readManifest，确保只读用户能看到所有资产和删除操作
      const manifest = await syncManager.getFullManifest(networkPath)
      if (!manifest) {
        return { success: false, error: 'manifest 不存在' }
      }

      console.log(
        `[NetworkVault] manifest 内容: assets=${manifest.assets?.length || 0}, folders=${manifest.folders?.length || 0}`
      )

      // 🔧 诊断日志：打印文件夹层级信息，帮助定位只读用户同步问题
      if (manifest.folders && manifest.folders.length > 0) {
        console.log('[NetworkVault] 文件夹层级详情:')
        for (const folder of manifest.folders) {
          console.log(`  - ${folder.name} (key: ${folder.key}, parent: ${folder.parent || 'ALL'})`)
        }
      } else {
        console.log('[NetworkVault] ⚠️ manifest.folders 为空！检查 Journal 合并是否正确')
      }

      // 🚀 内存优化：移除 per-asset DEBUG 日志

      // 🔧 注意：即使 manifest.assets 为空也不能提前返回
      // 因为需要继续执行删除同步逻辑（删除本地存在但网络 manifest 中已不存在的资产）
      if (manifest.assets.length === 0) {
        console.log('[NetworkVault] manifest 中没有资产，将继续执行删除同步')
      }

      // 2. 动态导入需要的模块
      const { VaultManager } = await import('../sqliteDataBase/VaultManager')
      const { createAssetData } = await import('../sqliteDataBase/models/assetData')
      const { createAssetFolder, getAssetFolderByKey } = await import(
        '../sqliteDataBase/models/assetFolder'
      )
      const { extname } = await import('path')

      const vaultManager = VaultManager.getInstance()
      const vaultDb = vaultManager.getCurrentVaultDatabase()

      if (!vaultDb) {
        return { success: false, error: '无法获取当前保管库数据库连接' }
      }

      // 同步 Vault 元数据 (图标)
      // 按 networkPath 同步所有匹配的本地网络库记录，避免只更新当前激活库导致图标不一致
      if (typeof manifest.icon === 'string') {
        const normalizeNetworkPath = (value?: string): string =>
          (value || '')
            .replace(/[\\/]+$/, '')
            .replace(/\//g, '\\')
            .toLowerCase()

        const normalizedTargetPath = normalizeNetworkPath(networkPath)
        const matchedVaults = vaultManager.getAllVaults().filter((vault) => {
          const normalizedVaultPath = normalizeNetworkPath(vault.networkPath || vault.path)
          return normalizedVaultPath === normalizedTargetPath
        })

        for (const matchedVault of matchedVaults) {
          if (matchedVault.icon !== manifest.icon) {
            console.log(
              `[NetworkVault] 同步发现图标更新: ${matchedVault.icon} -> ${manifest.icon} (vaultId=${matchedVault.id})`
            )
            await vaultManager.updateVaultIcon(matchedVault.id, manifest.icon)
          }
        }
      }

      // 3. 确保 ALL 根文件夹存在
      const allFolderExists = getAssetFolderByKey(vaultDb, 'ALL')
      if (!allFolderExists) {
        createAssetFolder(vaultDb, {
          folderKey: 'ALL',
          fatherKey: null,
          type: 'folder',
          folderName: '全部资产',
          fullPath: '/',
          pathArray: '[]',
          depth: 0
        })
        console.log('[NetworkVault] 创建 ALL 根文件夹')
      }

      // 3.5 同步文件夹结构 - 保持正确的父-子-孙层级
      let folderCount = 0
      if (manifest.folders && manifest.folders.length > 0) {
        console.log(`[NetworkVault] 开始同步 ${manifest.folders.length} 个文件夹...`)

        // Step 1: 构建所有文件夹的信息 Map
        const folderInfoMap = new Map<
          string,
          { key: string; name: string; parent: string | null; img?: string }
        >(
          manifest.folders.map((f) => [
            f.key,
            { key: f.key, name: f.name, parent: f.parent || null, img: f.img }
          ])
        )

        // Step 2: 收集所有被引用但不在 manifest 中的父文件夹 (orphan parents)
        const orphanParents = new Set<string>()
        for (const folder of manifest.folders) {
          if (folder.parent && folder.parent !== 'ALL' && !folderInfoMap.has(folder.parent)) {
            orphanParents.add(folder.parent)
          }
        }

        // Step 3: 为 orphan parents 创建合成条目
        // 尝试从已存在的 SQLite 记录获取正确名称
        if (orphanParents.size > 0) {
          console.log(`[NetworkVault] 发现 ${orphanParents.size} 个缺失的父文件夹，正在重建层级...`)

          for (const orphanKey of orphanParents) {
            // 🔧 首先尝试从已存在的 SQLite 记录获取名称
            const existingFolder = getAssetFolderByKey(vaultDb, orphanKey)
            let folderName = orphanKey // 默认使用 key 作为名称
            let parentKey = 'ALL' // 默认父级

            if (
              existingFolder &&
              existingFolder.folderName &&
              existingFolder.folderName !== orphanKey
            ) {
              // SQLite 中已有正确名称，使用它
              folderName = existingFolder.folderName
              parentKey = existingFolder.fatherKey || 'ALL'
              console.log(
                `[NetworkVault] 从 SQLite 获取孤儿文件夹信息: ${folderName} (${orphanKey})`
              )
            } else {
              console.log(`[NetworkVault] 孤儿文件夹无名称信息，使用 key: ${orphanKey}`)
            }

            folderInfoMap.set(orphanKey, {
              key: orphanKey,
              name: folderName,
              parent: parentKey
            })
          }
        }

        // Step 4: 计算每个文件夹的真实深度 (递归计算)
        const depthCache = new Map<string, number>()
        const getDepth = (folderKey: string): number => {
          if (folderKey === 'ALL') return 0
          if (depthCache.has(folderKey)) return depthCache.get(folderKey)!

          const info = folderInfoMap.get(folderKey)
          if (!info || !info.parent || info.parent === 'ALL') {
            depthCache.set(folderKey, 1)
            return 1
          }

          const parentDepth = getDepth(info.parent)
          const depth = parentDepth + 1
          depthCache.set(folderKey, depth)
          return depth
        }

        // 计算所有文件夹的深度
        for (const [key] of folderInfoMap) {
          getDepth(key)
        }

        // Step 5: 按深度排序所有文件夹 (包括 orphan parents)
        const allFolderKeys = Array.from(folderInfoMap.keys())
        const sortedKeys = allFolderKeys.sort((a, b) => {
          return (depthCache.get(a) || 0) - (depthCache.get(b) || 0)
        })

        console.log(`[NetworkVault] 将按深度顺序创建 ${sortedKeys.length} 个文件夹`)

        // Step 6: 按顺序创建文件夹
        for (const folderKey of sortedKeys) {
          // 跳过已存在的
          const existing = getAssetFolderByKey(vaultDb, folderKey)
          if (existing) continue

          const folderInfo = folderInfoMap.get(folderKey)!
          const parentKey = folderInfo.parent || 'ALL'

          try {
            const parentFolder = getAssetFolderByKey(vaultDb, parentKey)
            const parentPath = parentFolder?.fullPath || '/'
            const fullPath =
              parentPath === '/' ? `/${folderInfo.name}` : `${parentPath}/${folderInfo.name}`
            const depth = depthCache.get(folderKey) || 1

            createAssetFolder(vaultDb, {
              folderKey: folderInfo.key,
              fatherKey: parentKey,
              type: 'folder',
              folderName: folderInfo.name,
              img: folderInfo.img, // 同步文件夹封面
              fullPath: fullPath,
              pathArray: JSON.stringify([parentKey, folderInfo.key]),
              depth: depth
            })
            console.log(
              `[NetworkVault] 创建文件夹: ${folderInfo.name} (key: ${folderInfo.key}, parent: ${parentKey}, depth: ${depth})`
            )
            folderCount++
          } catch (err: unknown) {
            // 处理 UNIQUE 约束错误
            if (
              err instanceof Error &&
              'code' in err &&
              (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
            ) {
              console.log(`[NetworkVault] 文件夹已存在: ${folderKey}`)
            } else {
              console.warn(`[NetworkVault] 创建文件夹失败: ${folderInfo.name}`, err)
            }
          }
        }

        console.log(`[NetworkVault] 同步了 ${folderCount} 个文件夹`)
      } else if (manifest.assets && manifest.assets.length > 0) {
        // 🔧 兼容性修复：如果 manifest.folders 为空但有资产，从资产的 folder 字段中恢复文件夹
        console.log('[NetworkVault] manifest.folders 为空，尝试从资产数据恢复文件夹结构...')

        // 收集所有唯一的 folderKey
        const folderKeys = new Set<string>()
        for (const asset of manifest.assets) {
          if (asset.folder && asset.folder !== 'ALL') {
            folderKeys.add(asset.folder)
          }
        }

        console.log(`[NetworkVault] 从资产中发现 ${folderKeys.size} 个唯一文件夹 key`)

        // 为每个缺失的文件夹创建本地记录
        for (const folderKey of folderKeys) {
          try {
            const existingFolder = getAssetFolderByKey(vaultDb, folderKey)
            if (!existingFolder) {
              // 尝试从资产的 path 推断文件夹名称
              const asset = manifest.assets.find((a) => a.folder === folderKey)
              const folderName =
                asset?.path?.split('\\\\')[0] || asset?.path?.split('/')[0] || folderKey

              createAssetFolder(vaultDb, {
                folderKey: folderKey,
                fatherKey: 'ALL',
                type: 'folder',
                folderName: folderName,
                fullPath: `/${folderName}`,
                pathArray: JSON.stringify(['ALL', folderKey]),
                depth: 1
              })
              console.log(`[NetworkVault] 从资产恢复文件夹: ${folderName} (key: ${folderKey})`)
              folderCount++
            }
          } catch (folderError) {
            console.warn(`[NetworkVault] 恢复文件夹失败: ${folderKey}`, folderError)
          }
        }

        if (folderCount > 0) {
          console.log(`[NetworkVault] 共恢复了 ${folderCount} 个缺失的文件夹`)
        }
      }

      // 4. 同步资产到本地数据库
      const { updateAssetData, getAssetDataByKey, deleteAssetData } = await import(
        '../sqliteDataBase/models/assetData'
      )

      // 🔧 FIX: 在同步资产前，确保所有被资产引用的 folderKey 都存在于本地 SQLite
      // 避免 FOREIGN KEY 约束失败导致资产被跳过
      // 使用递归方式确保整个父文件夹链都存在，保持正确的层级结构
      const folderMapForPreCreate = new Map(manifest.folders?.map((f) => [f.key, f]) || [])
      const referencedFolderKeys = new Set<string>()
      for (const asset of manifest.assets) {
        const fk = asset.folder || 'ALL'
        if (fk !== 'ALL') {
          referencedFolderKeys.add(fk)
        }
      }

      // 🔧 诊断日志：显示关键数据
      console.log(`[NetworkVault] ========== 同步诊断 ==========`)
      console.log(`[NetworkVault] manifest.assets.length = ${manifest.assets.length}`)
      console.log(`[NetworkVault] manifest.folders.length = ${manifest.folders?.length || 0}`)
      console.log(`[NetworkVault] folderMapForPreCreate.size = ${folderMapForPreCreate.size}`)
      console.log(`[NetworkVault] referencedFolderKeys.size = ${referencedFolderKeys.size}`)
      console.log(`[NetworkVault] ================================`)

      let preCreatedFolderCount = 0

      // 递归确保文件夹及其所有父文件夹都存在
      const ensureFolderExistsRecursive = (folderKey: string): boolean => {
        if (folderKey === 'ALL') return true

        // 已存在则跳过
        const existing = getAssetFolderByKey(vaultDb, folderKey)
        if (existing) return true

        // 从 manifest 获取文件夹信息
        const folderInfo = folderMapForPreCreate.get(folderKey)
        if (!folderInfo) {
          // 文件夹不在 manifest 中，尝试创建到 ALL 下作为回退
          // 但首先再次检查是否已存在（可能由第一阶段创建）
          const existingAgain = getAssetFolderByKey(vaultDb, folderKey)
          if (existingAgain) {
            return true // 已存在，无需创建
          }

          try {
            createAssetFolder(vaultDb, {
              folderKey: folderKey,
              fatherKey: 'ALL',
              type: 'folder',
              folderName: folderKey, // 使用 key 作为名称
              fullPath: `/${folderKey}`,
              pathArray: JSON.stringify(['ALL', folderKey]),
              depth: 1
            })
            console.log(`[NetworkVault] 创建未知文件夹到 ALL: ${folderKey}`)
            preCreatedFolderCount++
            return true
          } catch (err: unknown) {
            // 处理 UNIQUE 约束错误 - 说明文件夹已存在，视为成功
            if (
              err instanceof Error &&
              'code' in err &&
              (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
            ) {
              console.log(`[NetworkVault] 文件夹已存在(UNIQUE): ${folderKey}`)
              return true
            }
            console.warn(`[NetworkVault] 创建未知文件夹失败: ${folderKey}`, err)
            return false
          }
        }

        const parentKey = folderInfo.parent || 'ALL'

        // 递归确保父文件夹存在
        if (!ensureFolderExistsRecursive(parentKey)) {
          console.warn(`[NetworkVault] 无法创建 ${folderInfo.name} 的父文件夹链`)
          return false
        }

        // 父文件夹现在一定存在，创建当前文件夹
        try {
          const parentFolder = getAssetFolderByKey(vaultDb, parentKey)
          const parentPath = parentFolder?.fullPath || '/'
          const fullPath =
            parentPath === '/' ? `/${folderInfo.name}` : `${parentPath}/${folderInfo.name}`
          const depth = (parentFolder?.depth ?? 0) + 1

          createAssetFolder(vaultDb, {
            folderKey: folderInfo.key,
            fatherKey: parentKey,
            type: 'folder',
            folderName: folderInfo.name,
            fullPath: fullPath,
            pathArray: JSON.stringify([parentKey, folderInfo.key]),
            depth: depth
          })
          console.log(
            `[NetworkVault] 递归创建缺失文件夹: ${folderInfo.name} (key: ${folderInfo.key}, parent: ${parentKey}, depth: ${depth})`
          )
          preCreatedFolderCount++
          return true
        } catch (err) {
          console.warn(`[NetworkVault] 创建文件夹失败: ${folderInfo.name}`, err)
          return false
        }
      }

      // 对所有被资产引用的文件夹，递归确保其存在
      for (const folderKey of referencedFolderKeys) {
        ensureFolderExistsRecursive(folderKey)
      }

      // 🔧 额外修复：同步所有 manifest.folders 中的文件夹（包括空文件夹树）
      // 确保即使没有资产的文件夹也能被正确同步
      if (manifest.folders && manifest.folders.length > 0) {
        for (const folder of manifest.folders) {
          ensureFolderExistsRecursive(folder.key)
        }
      }

      if (preCreatedFolderCount > 0) {
        console.log(
          `[NetworkVault] 共递归创建 ${preCreatedFolderCount} 个缺失的文件夹（含空文件夹树）`
        )
      }

      let syncCount = 0
      let updateCount = 0
      let thumbnailSyncCount = 0 // 统计同步的缩略图数量

      for (const asset of manifest.assets) {
        try {
          // 检查资产是否存在（包括已删除的），避免 UNIQUE 约束冲突
          const existingAssetIncludingDeleted = vaultDb
            .prepare(
              'SELECT assetKey, isDelete, imgLocalPath, note, tags, customPoster FROM assetData WHERE assetKey = ?'
            )
            .get(asset.key) as
            | {
                assetKey: string
                isDelete: number
                imgLocalPath: string | null
                note: string | null
                tags: string | null
                customPoster: string | null
              }
            | undefined

          if (!existingAssetIncludingDeleted) {
            // 资产完全不存在，创建新记录
            const ext = extname(asset.path).toLowerCase().replace('.', '')
            // 缩略图只需要文件名，因为网络库的 .thumbnails 目录已经存储了缩略图
            // UI 会自动从 networkPath/.thumbnails/ 目录读取
            const thumbnailFilename = asset.thumbnail || ''
            if (thumbnailFilename) {
              thumbnailSyncCount++
              console.log(`[NetworkVault] 同步缩略图: ${asset.name} -> ${thumbnailFilename}`)
            }
            // 🔧 修复：从 metadata 子对象中读取元数据字段（manifest 结构）
            const metaClassName = (asset.metadata?.className as string) || asset.className
            const metaEngineVersion =
              (asset.metadata?.engineVersion as string) || asset.engineVersion
            const metaSoftPath = asset.metadata?.softPath as string | undefined

            createAssetData(vaultDb, {
              assetKey: asset.key,
              folderKey: asset.folder || 'ALL',
              assetName: asset.name,
              filePath: asset.path,
              fileSize: asset.size,
              fileExtension: ext,
              originPath: `${networkPath}\\${asset.path}`,
              ext: ext,
              name: asset.name,
              assetType: metaClassName || asset.type, // 优先使用 className 作为资产类型
              className: metaClassName,
              classNameCn: getAssetClassNameCn(metaClassName), // 添加中文类名
              assetClass: extractAssetClass(metaSoftPath), // 添加资产分类
              engineVersion: metaEngineVersion,
              imgLocalPath: thumbnailFilename,
              customPoster: thumbnailFilename || undefined, // 网络库的 thumbnail 同步为本地的 customPoster
              note: asset.note,
              tags: asset.tags ? JSON.stringify(asset.tags) : undefined,
              modifiedTime: asset.modifiedAt || new Date().toISOString(),
              // 从 metadata 中提取额外字段
              softPath: metaSoftPath,
              imports: asset.metadata?.imports ? JSON.stringify(asset.metadata.imports) : undefined
            })
            syncCount++
          } else {
            // 资产已存在（可能是活跃的或已删除的），检查是否需要更新
            const updates: Record<string, unknown> = {}

            // 如果资产被软删除，先恢复它
            if (existingAssetIncludingDeleted.isDelete === 1) {
              updates.isDelete = 0
              console.log(`[NetworkVault] 恢复已删除资产: ${asset.name}`)
            }

            // 检查名称变更 - 需要先获取完整资产信息
            const fullExistingAsset = getAssetDataByKey(vaultDb, asset.key)
            if (fullExistingAsset) {
              if (asset.name && asset.name !== fullExistingAsset.assetName) {
                updates.assetName = asset.name
                updates.name = asset.name
              }

              // 检查文件夹变更
              const manifestFolder = asset.folder || 'ALL'
              if (manifestFolder !== fullExistingAsset.folderKey) {
                updates.folderKey = manifestFolder
              }
            }

            // 检查缩略图变更
            if (asset.thumbnail && asset.thumbnail !== existingAssetIncludingDeleted.imgLocalPath) {
              updates.imgLocalPath = asset.thumbnail
              updates.customPoster = asset.thumbnail // 同时更新 customPoster
              thumbnailSyncCount++
              console.log(`[NetworkVault] 更新缩略图: ${asset.name} -> ${asset.thumbnail}`)
            }

            // 检查备注变更
            if (asset.note !== undefined && asset.note !== existingAssetIncludingDeleted.note) {
              updates.note = asset.note
              console.log(`[NetworkVault] 更新备注: ${asset.name}`)
            }

            // 检查标签变更
            const remoteTags = asset.tags ? JSON.stringify(asset.tags) : null
            // 🚀 内存优化：移除 per-asset DEBUG 日志（每个资产 3 行字符串拼接）
            if (remoteTags !== existingAssetIncludingDeleted.tags) {
              updates.tags = remoteTags
              console.log(`[NetworkVault] 检测到标签变更: ${asset.name}`)
              // 🔧 同步标签关联表（自动创建不存在的标签）
              syncAssetTags(vaultDb, asset.key, asset.tags || [])
            }

            // 🔧 检查元数据字段变更（修复只读同步元数据丢失问题）
            if (fullExistingAsset) {
              // 🔧 修复：从 metadata 子对象读取（与 manifest 结构一致）
              const metaClassName = (asset.metadata?.className as string) || asset.className
              const metaEngineVersion =
                (asset.metadata?.engineVersion as string) || asset.engineVersion

              // className
              if (metaClassName && metaClassName !== fullExistingAsset.className) {
                updates.className = metaClassName
                updates.assetType = metaClassName // assetType 使用 className
                updates.classNameCn = getAssetClassNameCn(metaClassName)
              }
              // engineVersion
              if (metaEngineVersion && metaEngineVersion !== fullExistingAsset.engineVersion) {
                updates.engineVersion = metaEngineVersion
              }
              // softPath
              const manifestSoftPath = asset.metadata?.softPath as string | undefined
              if (manifestSoftPath && manifestSoftPath !== fullExistingAsset.softPath) {
                updates.softPath = manifestSoftPath
                updates.assetClass = extractAssetClass(manifestSoftPath)
              }
              // imports
              const manifestImports = asset.metadata?.imports
                ? JSON.stringify(asset.metadata.imports)
                : undefined
              if (manifestImports && manifestImports !== fullExistingAsset.imports) {
                updates.imports = manifestImports
              }
            }

            // 如果有变更，更新数据库
            if (Object.keys(updates).length > 0) {
              updateAssetData(vaultDb, asset.key, updates)
              updateCount++
              console.log(`[NetworkVault] 更新本地资产: ${asset.key}`, updates)
            }
          }
        } catch (assetError) {
          console.warn(`[NetworkVault] 同步资产失败: ${asset.key}`, assetError)
        }
      }

      // 5. 同步删除：删除本地存在但网络 manifest 中已不存在的资产
      const manifestAssetKeys = new Set(manifest.assets.map((a) => a.key))
      const localAssets = vaultDb
        .prepare('SELECT assetKey FROM assetData WHERE isDelete = 0')
        .all() as { assetKey: string }[]
      let deleteCount = 0
      for (const localAsset of localAssets) {
        if (!manifestAssetKeys.has(localAsset.assetKey)) {
          // 🔧 修复：使用软删除（isDelete=1）替代硬删除，防止竞态下资产永久丢失
          deleteAssetData(vaultDb, localAsset.assetKey)
          deleteCount++
          console.log(`[NetworkVault] 同步软删除本地资产: ${localAsset.assetKey}`)
        }
      }

      // 5.5 🔧 同步删除文件夹：删除本地存在但网络 manifest 中已不存在的文件夹
      // 🔧 重要：保留"孤儿父文件夹"（被其他文件夹引用为父级但不在 manifest 中的文件夹）
      // 允许空文件夹存在，以维持正确的层级结构
      let folderDeleteCount = 0

      const manifestFolderKeys = new Set(manifest.folders?.map((f) => f.key) || [])
      // 添加 'ALL' 到集合（系统文件夹不应删除）
      manifestFolderKeys.add('ALL')

      // 🔧 收集所有被引用为父文件夹的 key（这些不应该被删除）
      const referencedAsParent = new Set<string>()
      for (const folder of manifest.folders || []) {
        if (folder.parent && folder.parent !== 'ALL') {
          referencedAsParent.add(folder.parent)
        }
      }
      // 也从资产的 folder 字段收集（确保资产所在的文件夹不被删除）
      for (const asset of manifest.assets || []) {
        if (asset.folder && asset.folder !== 'ALL') {
          referencedAsParent.add(asset.folder)
        }
      }

      const { getAllAssetFolders, deleteAssetFolder } = await import(
        '../sqliteDataBase/models/assetFolder'
      )
      const localFolders = getAllAssetFolders(vaultDb)

      // 按深度倒序排序，确保先删除子文件夹再删除父文件夹（避免外键约束问题）
      const foldersToDelete = localFolders
        .filter((f) => {
          // 不删除 manifest 中存在的文件夹
          if (manifestFolderKeys.has(f.folderKey)) return false
          // 不删除已标记删除的
          if (f.isDelete === 1) return false
          // 🔧 不删除被引用为父文件夹的（孤儿父文件夹）
          if (referencedAsParent.has(f.folderKey)) {
            console.log(`[NetworkVault] 保留孤儿父文件夹: ${f.folderKey}`)
            return false
          }
          return true
        })
        .sort((a, b) => (b.depth || 0) - (a.depth || 0))

      for (const folder of foldersToDelete) {
        try {
          // 🔧 修复：使用软删除替代硬删除，防止竞态下资产永久丢失
          // 先软删除该文件夹下的所有资产
          vaultDb
            .prepare(
              `UPDATE assetData SET isDelete = 1, updated_at = datetime('now', 'localtime') WHERE folderKey = ? AND isDelete = 0`
            )
            .run(folder.folderKey)
          // 再软删除文件夹本身
          deleteAssetFolder(vaultDb, folder.folderKey)
          folderDeleteCount++
          console.log(
            `[NetworkVault] 同步软删除本地文件夹: ${folder.folderName} (${folder.folderKey})`
          )
        } catch (delErr) {
          console.warn(`[NetworkVault] 删除文件夹失败: ${folder.folderKey}`, delErr)
        }
      }

      console.log(
        `[NetworkVault] 本地 SQLite 同步完成: ${syncCount} 个新资产, ${updateCount} 个更新, ${deleteCount} 个资产删除, ${folderDeleteCount} 个文件夹删除, ${thumbnailSyncCount} 个缩略图`
      )

      // 🔧 修复：synced 应该包含所有变更类型（新增 + 更新 + 删除），这样前端才能正确判断是否有变化
      const totalChanges = syncCount + updateCount + deleteCount + folderDeleteCount
      return {
        success: true,
        data: {
          synced: totalChanges, // 总变更数，用于前端判断是否需要刷新
          added: syncCount,
          updated: updateCount,
          deleted: deleteCount,
          foldersDeleted: folderDeleteCount,
          total: manifest.assets.length,
          message:
            totalChanges > 0
              ? `已同步: ${syncCount} 个新增, ${updateCount} 个更新, ${deleteCount} 个删除`
              : '已是最新，无需同步'
        }
      }
    } catch (error) {
      console.error('[NetworkVault] 同步到本地 SQLite 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 删除局域网协作库资产
   * 同时删除本地 SQLite 记录、网络物理文件，并写入 Journal 同步到网络
   */
  ipcMain.handle(
    'networkVault:deleteAsset',
    async (_event, networkPath: string, assetKey: string) => {
      try {
        // 检查写入权限
        const permissionCheck = await syncManager.checkWritePermission(networkPath)
        if (!permissionCheck.canWrite) {
          console.log('[NetworkVault] 只读模式，无法删除资产')
          return {
            success: false,
            error: '没有写入权限，无法删除资产。请联系有权限的管理员进行操作。'
          }
        }

        const { getVaultDatabase } = await import('../sqliteDataBase/index')
        const db = getVaultDatabase()

        // V2: 通过 NetworkSyncBridge 推送删除到远端
        try {
          const { pushAssetDelete } = await import('../networkV2/NetworkSyncBridge')
          await pushAssetDelete(assetKey)
          console.log(`[NetworkVault] 资产删除已推送到远端: ${assetKey}`)
        } catch (pushErr) {
          console.warn('[NetworkVault] 推送删除失败:', pushErr)
        }

        // 从本地 SQLite 删除
        const stmt = db.prepare('DELETE FROM assetData WHERE assetKey = ?')
        const result = stmt.run(assetKey)
        console.log(`[NetworkVault] 本地 SQLite 已删除: ${assetKey}, changes: ${result.changes}`)

        return { success: true, data: { deleted: result.changes > 0 } }
      } catch (error) {
        console.error('[NetworkVault] 删除资产失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 批量删除局域网协作库资产
   * V2: 通过 NetworkSyncBridge 推送删除 + SQLite 事务批量删除
   */
  ipcMain.handle(
    'networkVault:batchDeleteAssets',
    async (_event, networkPath: string, assetKeys: string[]) => {
      if (!assetKeys || assetKeys.length === 0) {
        return { success: true, data: { deletedCount: 0 } }
      }

      try {
        // 检查写入权限（只检查一次）
        const permissionCheck = await syncManager.checkWritePermission(networkPath)
        if (!permissionCheck.canWrite) {
          console.log('[NetworkVault] 只读模式，无法批量删除资产')
          return {
            success: false,
            error: '没有写入权限，无法删除资产。请联系有权限的管理员进行操作。'
          }
        }

        const { getVaultDatabase } = await import('../sqliteDataBase/index')
        const db = getVaultDatabase()

        // 推送删除到远端。未连接/失败会入队，不再是「warn 一句然后照样本地硬删」——
        // 那样服务端那些行还活着，下一次同步看到 key 还在，又把它们拉回来，
        // 用户看到的是「删不掉，删一次回来一次」。
        const { pushBatchOperations } = await import('../networkV2/NetworkSyncBridge')
        const deleteOps = assetKeys.map((key) => ({
          type: 'delete' as const,
          table: 'assetData' as const,
          data: { assetKey: key }
        }))
        const remoteSync = await pushBatchOperations(deleteOps)
        console.log(
          `[NetworkVault] 批量删除推送结果: ${remoteSync.status} (${assetKeys.length} 个)`
        )

        // SQLite 事务批量删除
        const deleteStmt = db.prepare('DELETE FROM assetData WHERE assetKey = ?')
        const deleteTransaction = db.transaction((keys: string[]) => {
          let count = 0
          for (const key of keys) {
            const result = deleteStmt.run(key)
            count += result.changes
          }
          return count
        })

        const deletedCount = deleteTransaction(assetKeys)
        console.log(`[NetworkVault] SQLite 批量删除完成: ${deletedCount} 条记录`)

        return {
          success: true,
          data: { deletedCount },
          ...(remoteSync.status === 'skipped' ? {} : { remoteSync })
        }
      } catch (error) {
        console.error('[NetworkVault] 批量删除资产失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 增量扫描 - 检测网络路径中新增的文件
   * 用于检测通过 Windows 资源管理器等外部方式添加的文件
   * 使用统一同步方法，合并锁获取、Journal 合并和物理扫描
   */
  ipcMain.handle('networkVault:incrementalScan', async (event, networkPath: string) => {
    const scanId = `scan_${Date.now()}`
    const abortSignal = { aborted: false }
    activeScans.set(scanId, abortSignal)

    try {
      console.log(`[NetworkVault] 开始统一同步: ${networkPath}`)

      // 使用统一同步方法（内部已包含锁获取和 Journal 合并）
      const result = await syncManager.unifiedSync(networkPath, {
        abortSignal,
        onProgress: (current, total, phase) => {
          event.sender.send('networkVault:incrementalScanProgress', {
            current,
            total,
            phase,
            scanId
          })
        }
      })

      if (!result.success) {
        return { success: false, error: result.error }
      }

      // =============================================
      // 🔧 重构：一次性全量同步 manifest → SQLite
      // 先完成所有 SQLite 写入，再统一返回给前端刷新
      // 确保用户看到的 UI 是最终状态，不存在滞后
      // =============================================
      let metadataUpdateCount = 0
      let cleanupAssetDeleteCount = 0
      let cleanupFolderDeleteCount = 0

      try {
        const { VaultManager } = await import('../sqliteDataBase/VaultManager')
        const { createAssetData, updateAssetData } = await import(
          '../sqliteDataBase/models/assetData'
        )
        const { createAssetFolder, getAllAssetFolders } = await import(
          '../sqliteDataBase/models/assetFolder'
        )
        const { extname } = await import('path')

        const vaultManager = VaultManager.getInstance()
        const vaultDb = vaultManager.getCurrentVaultDatabase()

        // 🚀 OOM修复: 使用 unifiedSync 已返回的 manifest（避免再次读取 256MB）
        const manifest = result.manifest || (await syncManager.getFullManifest(networkPath))

        if (manifest) {
          // 同步 Vault 元数据 (图标)
          // 增量扫描也要同步，避免“未发现新文件”时图标变化被忽略
          if (typeof manifest.icon === 'string') {
            const normalizeNetworkPath = (value?: string): string =>
              (value || '')
                .replace(/[\\/]+$/, '')
                .replace(/\//g, '\\')
                .toLowerCase()

            const normalizedTargetPath = normalizeNetworkPath(networkPath)
            const matchedVaults = vaultManager.getAllVaults().filter((vault) => {
              const normalizedVaultPath = normalizeNetworkPath(vault.networkPath || vault.path)
              return normalizedVaultPath === normalizedTargetPath
            })

            for (const matchedVault of matchedVaults) {
              if (matchedVault.icon !== manifest.icon) {
                console.log(
                  `[NetworkVault] 增量扫描同步图标: ${matchedVault.icon} -> ${manifest.icon} (vaultId=${matchedVault.id})`
                )
                await vaultManager.updateVaultIcon(matchedVault.id, manifest.icon)
              }
            }
          }
        }

        if (vaultDb && manifest) {
          // =============================================
          // 🚀 性能优化：所有 SQLite 写操作包裹在一个事务中
          // 避免每条 UPDATE 都触发磁盘 fsync，几百次写操作变成一次磁盘写入
          // =============================================
          const syncTransaction = vaultDb.transaction(() => {
            const manifestKeyToSqliteKey = new Map<string, string>()

            // ---- Phase 0: 一次性加载所有本地文件夹到内存（供 Phase 2/3/4 共用） ----
            // 🚀 内存优化：避免 getAllAssetFolders 被多次调用（之前 Phase 2/3/4 各调一次）
            const allLocalFolders = getAllAssetFolders(vaultDb)
            const localFolderByKey = new Map(allLocalFolders.map((f) => [f.folderKey, f]))
            const localFolderByNameParent = new Map<string, (typeof allLocalFolders)[0]>()
            for (const f of allLocalFolders) {
              localFolderByNameParent.set(`${f.folderName}::${f.fatherKey || 'ALL'}`, f)
            }
            // 🚀 供 Phase 4 使用的文件夹 key Set（纯内存查找）
            const localFolderKeySet = new Set(localFolderByKey.keys())
            localFolderKeySet.add('ALL')

            // ---- Phase 1: 确保 ALL 根文件夹存在 ----
            if (!localFolderByKey.has('ALL')) {
              createAssetFolder(vaultDb, {
                folderKey: 'ALL',
                fatherKey: null,
                type: 'folder',
                folderName: '全部资产',
                fullPath: '/',
                pathArray: '[]',
                depth: 0
              })
              localFolderKeySet.add('ALL')
            }

            // ---- Phase 2: 同步文件夹（创建/更新 manifest 中有的） ----
            if (manifest.folders && manifest.folders.length > 0) {
              const manifestFolderMap = new Map(manifest.folders.map((f) => [f.key, f]))

              // 递归计算深度（纯内存操作）
              const depthCache = new Map<string, number>()
              const getDepth = (key: string): number => {
                if (key === 'ALL') return 0
                if (depthCache.has(key)) return depthCache.get(key)!
                const info = manifestFolderMap.get(key)
                if (!info || !info.parent || info.parent === 'ALL') {
                  depthCache.set(key, 1)
                  return 1
                }
                const d = getDepth(info.parent) + 1
                depthCache.set(key, d)
                return d
              }
              for (const [key] of manifestFolderMap) getDepth(key)

              // 按深度排序，父文件夹先创建
              const sortedFolders = [...manifest.folders].sort(
                (a, b) => (depthCache.get(a.key) || 0) - (depthCache.get(b.key) || 0)
              )

              // 🚀 内存优化：复用 Phase 0 加载的 localFolderByKey / localFolderByNameParent

              for (const folder of sortedFolders) {
                const existing = localFolderByKey.get(folder.key)
                if (existing) {
                  manifestKeyToSqliteKey.set(folder.key, folder.key)
                  // 检查封面更新
                  const remoteImg = folder.img || undefined
                  const localImg = existing.img || undefined
                  if (remoteImg !== localImg) {
                    // 🚀 直接用 prepared statement 而非 updateAssetFolder（后者每次 PRAGMA table_info）
                    vaultDb
                      .prepare(
                        `UPDATE assetFolder SET img = ?, updated_at = datetime('now', 'localtime') WHERE folderKey = ?`
                      )
                      .run(folder.img || null, folder.key)
                    metadataUpdateCount++
                  }
                  continue
                }

                // 按名称+父级去重（使用内存索引）
                const parentKey = folder.parent || 'ALL'
                const sqliteParentKey = manifestKeyToSqliteKey.get(parentKey) || parentKey
                const existsByNameAndParent = localFolderByNameParent.get(
                  `${folder.name}::${sqliteParentKey}`
                )
                if (existsByNameAndParent) {
                  manifestKeyToSqliteKey.set(folder.key, existsByNameAndParent.folderKey)
                  continue
                }

                try {
                  createAssetFolder(vaultDb, {
                    folderKey: folder.key,
                    fatherKey: sqliteParentKey,
                    type: 'folder',
                    folderName: folder.name,
                    img: folder.img
                  })
                  manifestKeyToSqliteKey.set(folder.key, folder.key)
                  // 更新内存索引（供后续文件夹引用）
                  localFolderByKey.set(folder.key, {
                    folderKey: folder.key,
                    folderName: folder.name,
                    fatherKey: sqliteParentKey
                  } as any)
                  localFolderByNameParent.set(`${folder.name}::${sqliteParentKey}`, {
                    folderKey: folder.key
                  } as any)
                } catch (err) {
                  console.warn(`[NetworkVault] 创建文件夹失败: ${folder.name}`, err)
                }
              }
            }

            // ---- Phase 3: 批量清理多余的文件夹 ----
            {
              const manifestFolderKeysSet = new Set(manifest.folders?.map((f) => f.key) || [])
              manifestFolderKeysSet.add('ALL')

              // 被 manifest 引用的 key 不应删除
              const referencedKeys = new Set<string>()
              for (const folder of manifest.folders || []) {
                if (folder.parent && folder.parent !== 'ALL') referencedKeys.add(folder.parent)
              }
              for (const asset of manifest.assets || []) {
                if (asset.folder && asset.folder !== 'ALL') referencedKeys.add(asset.folder)
              }

              // 🚀 内存优化：复用 Phase 0 加载的 localFolderByKey（不再第 3 次调 getAllAssetFolders）
              const keysToDelete: string[] = []
              for (const [fk, f] of localFolderByKey) {
                if (manifestFolderKeysSet.has(fk)) continue
                if (f.isDelete === 1) continue
                if (referencedKeys.has(fk)) continue
                keysToDelete.push(fk)
              }

              if (keysToDelete.length > 0) {
                // 🚀 批量软删除：一条 SQL 搞定所有文件夹 + 其下资产
                // 不再逐条调用 deleteAssetFolder（每次递归 CTE + 分批 UPDATE）
                const BATCH = 500
                for (let i = 0; i < keysToDelete.length; i += BATCH) {
                  const batch = keysToDelete.slice(i, i + BATCH)
                  const placeholders = batch.map(() => '?').join(',')
                  // 软删除文件夹
                  vaultDb
                    .prepare(
                      `UPDATE assetFolder SET isDelete = 1, updated_at = datetime('now', 'localtime') WHERE folderKey IN (${placeholders}) AND isDelete = 0`
                    )
                    .run(...batch)
                  // 软删除这些文件夹下的资产
                  vaultDb
                    .prepare(
                      `UPDATE assetData SET isDelete = 1, updated_at = datetime('now', 'localtime') WHERE folderKey IN (${placeholders}) AND isDelete = 0`
                    )
                    .run(...batch)
                }
                cleanupFolderDeleteCount = keysToDelete.length
                console.log(
                  `[NetworkVault] 清理：批量软删除 ${cleanupFolderDeleteCount} 个多余文件夹`
                )
              }
            }

            // ---- Phase 4: 同步资产（新增 + 更新 + 批量清理） ----
            {
              const manifestAssetKeys = new Set(manifest.assets.map((a) => a.key))

              // 🚀 一次性加载所有本地资产关键字段到内存（包含已软删除的），避免逐条 getAssetDataByKey
              // 🔧 修复：包含 isDelete 字段，以便检测并恢复软删除的资产
              const localAssetRows = vaultDb
                .prepare(
                  'SELECT assetKey, folderKey, assetName, className, engineVersion, softPath, imgLocalPath, customPoster, tags, isDelete FROM assetData'
                )
                .all() as {
                assetKey: string
                folderKey: string
                assetName: string
                className: string
                engineVersion: string
                softPath: string
                imgLocalPath: string
                customPoster: string
                tags: string
                isDelete: number
              }[]
              const localAssetMap = new Map(localAssetRows.map((a) => [a.assetKey, a]))

              // 🚀 内存优化：复用 Phase 0 已构建的 localFolderKeySet（不再第 4 次调 getAllAssetFolders）

              // 4a: 新增/更新 manifest 中的资产
              for (const asset of manifest.assets) {
                // 解析 folderKey（使用映射，纯内存）
                let assetFolderKey = asset.folder || 'ALL'
                if (assetFolderKey !== 'ALL') {
                  const mappedKey = manifestKeyToSqliteKey.get(assetFolderKey)
                  if (mappedKey) {
                    assetFolderKey = mappedKey
                  } else if (!localFolderKeySet.has(assetFolderKey)) {
                    assetFolderKey = 'ALL'
                  }
                }

                const existingAsset = localAssetMap.get(asset.key)

                if (!existingAsset) {
                  // 资产完全不存在，创建新记录
                  const ext = extname(asset.path).toLowerCase().replace('.', '')
                  const metaClassName = (asset.metadata?.className as string) || asset.className
                  const metaSoftPath = asset.metadata?.softPath as string | undefined
                  const metaEngineVersion =
                    (asset.metadata?.engineVersion as string) || asset.engineVersion

                  try {
                    createAssetData(vaultDb, {
                      assetKey: asset.key,
                      folderKey: assetFolderKey,
                      assetName: asset.name,
                      filePath: asset.path,
                      fileSize: asset.size,
                      fileExtension: ext,
                      originPath: `${networkPath}\\${asset.path}`,
                      ext,
                      name: asset.name,
                      assetType: metaClassName || asset.type,
                      className: metaClassName,
                      classNameCn: getAssetClassNameCn(metaClassName),
                      assetClass: extractAssetClass(metaSoftPath),
                      engineVersion: metaEngineVersion,
                      imgLocalPath: asset.thumbnail || undefined,
                      customPoster: asset.thumbnail || undefined,
                      note: asset.note,
                      tags: asset.tags ? JSON.stringify(asset.tags) : undefined,
                      modifiedTime: asset.modifiedAt || new Date().toISOString(),
                      softPath: metaSoftPath,
                      imports: asset.metadata?.imports
                        ? JSON.stringify(asset.metadata.imports)
                        : undefined
                    })
                  } catch {
                    // UNIQUE 冲突等，忽略
                  }
                } else if (existingAsset.isDelete === 1) {
                  // 🔧 修复：资产被软删除但 manifest 中仍存在，恢复它并更新元数据
                  const ext = extname(asset.path).toLowerCase().replace('.', '')
                  const metaClassName = (asset.metadata?.className as string) || asset.className
                  const metaSoftPath = asset.metadata?.softPath as string | undefined
                  const metaEngineVersion =
                    (asset.metadata?.engineVersion as string) || asset.engineVersion

                  const restoreUpdates: Record<string, unknown> = {
                    isDelete: 0,
                    folderKey: assetFolderKey,
                    assetName: asset.name,
                    name: asset.name,
                    filePath: asset.path,
                    fileSize: asset.size,
                    fileExtension: ext,
                    originPath: `${networkPath}\\${asset.path}`,
                    ext,
                    assetType: metaClassName || asset.type,
                    className: metaClassName,
                    classNameCn: getAssetClassNameCn(metaClassName),
                    assetClass: extractAssetClass(metaSoftPath),
                    engineVersion: metaEngineVersion,
                    imgLocalPath: asset.thumbnail || null,
                    customPoster: asset.thumbnail || null,
                    softPath: metaSoftPath || null,
                    imports: asset.metadata?.imports ? JSON.stringify(asset.metadata.imports) : null
                  }
                  if (asset.note !== undefined) restoreUpdates.note = asset.note
                  if (asset.tags) restoreUpdates.tags = JSON.stringify(asset.tags)

                  updateAssetData(vaultDb, asset.key, restoreUpdates)
                  metadataUpdateCount++
                  console.log(`[NetworkVault] 恢复已软删除资产: ${asset.name} (key: ${asset.key})`)
                } else {
                  // 已存在 -> 检查元数据更新（内存对比，仅有差异才写 DB）
                  const updates: Record<string, unknown> = {}

                  if (assetFolderKey !== existingAsset.folderKey) {
                    if (assetFolderKey === 'ALL' || localFolderKeySet.has(assetFolderKey)) {
                      updates.folderKey = assetFolderKey
                    }
                  }

                  if (asset.name && asset.name !== existingAsset.assetName) {
                    updates.assetName = asset.name
                    updates.name = asset.name
                  }

                  const remoteThumbnail = asset.thumbnail || null
                  const localThumbnail =
                    existingAsset.imgLocalPath || existingAsset.customPoster || null
                  if (remoteThumbnail && remoteThumbnail !== localThumbnail) {
                    updates.imgLocalPath = remoteThumbnail
                    updates.customPoster = remoteThumbnail
                  }

                  const remoteTags = asset.tags ? JSON.stringify(asset.tags) : null
                  const localTags = existingAsset.tags || null
                  if (remoteTags !== localTags) {
                    updates.tags = remoteTags
                    syncAssetTags(vaultDb, asset.key, asset.tags || [])
                  }

                  const metaClassName = (asset.metadata?.className as string) || asset.className
                  if (metaClassName && metaClassName !== existingAsset.className) {
                    updates.className = metaClassName
                    updates.assetType = metaClassName
                    updates.classNameCn = getAssetClassNameCn(metaClassName)
                  }
                  const metaEngineVersion =
                    (asset.metadata?.engineVersion as string) || asset.engineVersion
                  if (metaEngineVersion && metaEngineVersion !== existingAsset.engineVersion) {
                    updates.engineVersion = metaEngineVersion
                  }
                  const metaSoftPath = asset.metadata?.softPath as string | undefined
                  if (metaSoftPath && metaSoftPath !== existingAsset.softPath) {
                    updates.softPath = metaSoftPath
                    updates.assetClass = extractAssetClass(metaSoftPath)
                  }

                  if (Object.keys(updates).length > 0) {
                    updateAssetData(vaultDb, asset.key, updates)
                    metadataUpdateCount++
                  }
                }
              }

              // 4b: 🚀 批量清理多余的资产（一条 SQL 批量软删除）
              // 🔧 修复：只清理活跃的（isDelete=0）且不在 manifest 中的资产
              const assetKeysToDelete: string[] = []
              for (const [localKey, localAsset] of localAssetMap) {
                if (!manifestAssetKeys.has(localKey) && localAsset.isDelete === 0) {
                  assetKeysToDelete.push(localKey)
                }
              }
              if (assetKeysToDelete.length > 0) {
                const BATCH = 500
                for (let i = 0; i < assetKeysToDelete.length; i += BATCH) {
                  const batch = assetKeysToDelete.slice(i, i + BATCH)
                  const placeholders = batch.map(() => '?').join(',')
                  vaultDb
                    .prepare(
                      `UPDATE assetData SET isDelete = 1, updated_at = datetime('now', 'localtime') WHERE assetKey IN (${placeholders}) AND isDelete = 0`
                    )
                    .run(...batch)
                }
                cleanupAssetDeleteCount = assetKeysToDelete.length
                console.log(`[NetworkVault] 清理：批量软删除 ${cleanupAssetDeleteCount} 个多余资产`)
              }
            }
          })

          // 🚀 执行事务：所有操作原子提交，一次磁盘写入
          const txStart = Date.now()
          syncTransaction()
          console.log(
            `[NetworkVault] 增量扫描完成 (${Date.now() - txStart}ms): 元数据更新=${metadataUpdateCount}, 清理资产=${cleanupAssetDeleteCount}, 清理文件夹=${cleanupFolderDeleteCount}`
          )
        }
      } catch (syncError) {
        console.warn('[NetworkVault] 增量扫描同步 SQLite 失败:', syncError)
      }

      // 所有 SQLite 写入已完成，计算最终统计
      const totalChanges =
        result.newAssets.length +
        result.newFolders.length +
        (result.deletedAssets?.length || 0) +
        (result.deletedFolders?.length || 0) +
        metadataUpdateCount +
        cleanupAssetDeleteCount +
        cleanupFolderDeleteCount

      return {
        success: true,
        data: {
          newAssetCount: result.newAssets.length,
          newFolderCount: result.newFolders.length,
          deletedAssetCount: (result.deletedAssets?.length || 0) + cleanupAssetDeleteCount,
          deletedFolderCount: (result.deletedFolders?.length || 0) + cleanupFolderDeleteCount,
          metadataUpdateCount,
          totalChanges,
          newAssets: result.newAssets.map((a) => ({ key: a.key, name: a.name, path: a.path })),
          newFolders: result.newFolders.map((f) => ({ key: f.key, name: f.name })),
          deletedAssets:
            result.deletedAssets?.map((a) => ({ key: a.key, name: a.name, path: a.path })) || [],
          deletedFolders: result.deletedFolders?.map((f) => ({ key: f.key, name: f.name })) || []
        }
      }
    } catch (error) {
      console.error('[NetworkVault] 增量扫描失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeScans.delete(scanId)
    }
  })

  console.log('[IPC] 局域网协作库处理器已注册')
}
