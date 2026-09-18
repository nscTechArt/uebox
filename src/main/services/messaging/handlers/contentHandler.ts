/**
 * 内容处理器
 * 处理来自 Unreal Engine 的内容相关事件（如导入文件夹）
 */
import { MessageRouter } from '../router'
import type { ReplySender } from '../replySender'
import { MessageEnvelope } from '../../types'
import { logger } from '../../logger'
import fs from 'fs/promises'
import path from 'path'
import Database from 'better-sqlite3'
import { getAppWindows } from '../../../appWindows'
import { getDatabaseManager } from '../../../sqliteDataBase'
import { createAssetFolder, getAssetFolderByKey } from '../../../sqliteDataBase/models/assetFolder'
import { AssetImportService } from '../../asset/AssetImportService'

/** ALL 文件夹常量 */
const ALL_FOLDER = 'ALL'

/**
 * 内容事件载荷接口
 */
interface ImportFolderPayload {
  real_paths?: string[]
  paths?: string[]
  engine_version?: string
  project_name?: string
  targetFolderKey?: string
  // 新增：从虚幻引擎获取的资产元数据
  asset_metadata?: Array<{
    name: string
    package: string
    class: string
    dependencies: string[]
    size?: number
    thumbnail_path?: string // 虚幻引擎临时目录中的缩略图文件路径
  }>
}

/**
 * 智能裁剪引擎版本号
 */
function trimEngineVersion(version: string): string {
  if (!version) return 'Unknown'
  // 提取 Major.Minor 并补 .0（如 "5.3.2-xxx" -> "5.3.0"）
  // UE 的 Patch 号是内部 hotfix 编号，不对应用户认知的引擎版本
  const match = version.match(/^(\d+\.\d+)/)
  if (match) return match[1] + '.0'
  const fallbackMatch = version.match(/(\d+\.\d+)/)
  if (fallbackMatch) return fallbackMatch[1] + '.0'
  return 'Unknown'
}

/**
 * 磁盘目录 → Content 相对路径（`<工程>/Content/A/B` → `A/B`）
 *
 * packageToFolderKey 的键就是这个形态（由 /Game/A/B 去掉 /Game/ 得到），
 * 两边用同一把尺子量，同名目录才不会认错。
 */
function contentRelativePath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  const match = normalized.match(/\/Content\/(.+)$/i)
  return match ? match[1] : ''
}

/** 先精确查，再忽略大小写查一次（Windows 路径大小写不敏感） */
function findFolderKeyByRelativePath(
  packageToFolderKey: Map<string, string>,
  relativePath: string
): string | undefined {
  const exact = packageToFolderKey.get(relativePath)
  if (exact) return exact
  const lower = relativePath.toLowerCase()
  for (const [key, folderKey] of packageToFolderKey.entries()) {
    if (key.toLowerCase() === lower) return folderKey
  }
  return undefined
}

/**
 * 内容处理器类
 */
export class ContentHandler {
  private send?: ReplySender
  private assetImportService: AssetImportService
  /**
   * 正在进行中的导入（键是「项目名 + 这批路径」）
   *
   * 虚幻那边点「导入到盒子」是发事件，不等回包，界面上没有任何反馈 ——
   * 用户等不到动静就会连点几次。同一批资产重复导一遍纯属白干，这里直接挡掉。
   */
  private readonly inFlightImports = new Set<string>()

  constructor() {
    this.assetImportService = new AssetImportService()
  }

  setSender(send: ReplySender): void {
    this.send = send
  }

  /**
   * 给盒子自己的每一个窗口都发一份。
   *
   * 原来这里挑的是 `getAppWindows()[0]` —— 「第一个窗口」既不保证是主窗口
   * （Spotlight、MiniChat 也在这张表里），也不保证界面挂着监听。挑错一个，
   * 用户就完全看不到导入进度，也等不到资产库刷新。
   */
  private broadcast(channel: string, payload: unknown): void {
    for (const win of getAppWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  registerRoutes(router: MessageRouter): void {
    router.register('content.import_folder', this.handleImportFolder.bind(this))
    router.register('content.import_assets', this.handleImportAssets.bind(this))
    logger.info('[ContentHandler] 已注册 content.import_folder/import_assets 事件处理器')
  }

  /**
   * 处理导入资产事件
   */
  private async handleImportAssets(envelope: MessageEnvelope, connectionId: string): Promise<void> {
    const payload = (envelope.payload || {}) as any
    // 适配参数，包含元数据
    const adaptedPayload: ImportFolderPayload = {
      real_paths: payload.asset_real_paths,
      paths: payload.asset_paths,
      engine_version: payload.engine_version,
      project_name: payload.project_name,
      asset_metadata: payload.asset_metadata // 新增：传递元数据
    }
    await this.processImportRequest(
      adaptedPayload,
      envelope.id,
      connectionId,
      'content.import_assets'
    )
  }

  /**
   * 处理导入文件夹事件
   */
  private async handleImportFolder(envelope: MessageEnvelope, connectionId: string): Promise<void> {
    const payload = (envelope.payload || {}) as ImportFolderPayload
    await this.processImportRequest(payload, envelope.id, connectionId, 'content.import_folder')
  }

  /**
   * 统一处理导入请求
   */
  private async processImportRequest(
    payload: ImportFolderPayload,
    requestId: string | undefined,
    connectionId: string,
    method: string
  ): Promise<void> {
    const realPaths = payload.real_paths || []
    const softPaths = payload.paths || []
    const engineVersion = payload.engine_version || 'Unknown'
    const projectName = payload.project_name || 'UnknownProject'
    const assetMetadata = payload.asset_metadata || []

    const trimmedVersion = trimEngineVersion(engineVersion)

    logger.info(`[ContentHandler] 处理导入请求 (${method}):`)
    logger.info(`  - 引擎版本: ${engineVersion} -> ${trimmedVersion}`)
    logger.info(`  - 项目名称: ${projectName}`)
    logger.info(`  - 路径数量: ${realPaths.length} (real) / ${softPaths.length} (soft)`)
    logger.info(`  - 元数据数量: ${assetMetadata.length}`)

    const targets = realPaths.length > 0 ? realPaths : []

    if (targets.length === 0) {
      logger.warn('[ContentHandler] 没有有效的 real_paths')
      this.sendResponse(connectionId, requestId, false, 0, '没有有效的导入路径', method)
      return
    }

    const importKey = `${projectName}::${[...targets].sort().join('|')}`
    if (this.inFlightImports.has(importKey)) {
      logger.warn(`[ContentHandler] 同一批资产正在导入中，忽略重复请求: ${targets.length} 个路径`)
      this.sendResponse(connectionId, requestId, true, 0, '同一批资产正在导入中', method)
      return
    }
    this.inFlightImports.add(importKey)
    // 单文件批量导入会先返回、后台接着跑，那条分支自己负责释放
    let releaseOnReturn = true

    // 这一趟导入在界面上的身份。用户从虚幻点进来，界面这边没有任何发起动作，
    // 所以进度挂件的任务得由主进程造出来 —— 造完之后走的就是拖拽导入那套事件，
    // 挂件、百分比、完成后刷新全都是现成的。
    const uiTaskId = `ue-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // 🔔 立刻告诉界面「开始导入了」——虚幻那边不显示任何东西，
    // 用户唯一能看到进展的地方就是盒子
    this.broadcast('asset:unrealImportStarted', {
      taskId: uiTaskId,
      count: targets.length,
      projectName
    })

    try {
      // 获取数据库
      const databaseManager = getDatabaseManager()
      const vaultInfo = databaseManager.getVaultManager().getCurrentVault()
      if (!vaultInfo) {
        throw new Error('当前保管库不存在')
      }

      const vaultDbPath = path.join(vaultInfo.path, 'vault-data.db')
      const db = new Database(vaultDbPath)

      // 辅助函数：安全创建文件夹
      const safeCreateFolder = (folderData: any) => {
        const existing = getAssetFolderByKey(db, folderData.folderKey)
        if (!existing) {
          try {
            createAssetFolder(db, folderData)
          } catch (error: any) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
              // 唯一约束冲突，说明可能处于软删除状态，恢复它
              db.prepare('UPDATE assetFolder SET isDelete = 0 WHERE folderKey = ?').run(
                folderData.folderKey
              )
            } else {
              throw error
            }
          }
        }
      }

      // 确保 ALL 文件夹存在
      safeCreateFolder({
        folderKey: ALL_FOLDER,
        fatherKey: null,
        type: 'system',
        folderName: 'ALL',
        img: ''
      })

      // 创建版本文件夹: ALL/UE {version}
      const versionFolderName = `UE${trimmedVersion}`
      const versionFolderKey = `ue_${trimmedVersion.replace(/\./g, '_')}`
      safeCreateFolder({
        folderKey: versionFolderKey,
        fatherKey: ALL_FOLDER,
        type: 'folder',
        folderName: versionFolderName,
        img: ''
      })

      // 创建项目文件夹: ALL/UE {version}/{project_name}
      const projectFolderKey = `proj_${projectName.replace(/[^a-zA-Z0-9_]/g, '_')}_${trimmedVersion.replace(/\./g, '_')}`
      safeCreateFolder({
        folderKey: projectFolderKey,
        fatherKey: versionFolderKey,
        type: 'folder',
        folderName: projectName,
        img: ''
      })

      // 🚀 根据 asset_metadata 中的 package 路径创建对应的文件夹结构
      const packageToFolderKey = new Map<string, string>()
      packageToFolderKey.set('', projectFolderKey) // 根目录映射到项目文件夹

      if (assetMetadata.length > 0) {
        // 从所有资产的 package 路径中提取唯一的目录路径
        const packageFolderPaths = new Set<string>()
        for (const meta of assetMetadata) {
          if (meta.package) {
            // 从 /Game/Asian_Village/materials/cliff_materials/M_cliff
            // 提取目录部分 /Game/Asian_Village/materials/cliff_materials
            const lastSlash = meta.package.lastIndexOf('/')
            if (lastSlash > 0) {
              const packageDir = meta.package.substring(0, lastSlash)
              // 移除 /Game 前缀，得到 Asian_Village/materials/cliff_materials
              const relativePath = packageDir.replace(/^\/Game\/?/, '')
              if (relativePath) {
                // 添加所有中间路径，确保父目录也会被创建
                const parts = relativePath.split('/')
                let currentPath = ''
                for (const part of parts) {
                  currentPath = currentPath ? `${currentPath}/${part}` : part
                  packageFolderPaths.add(currentPath)
                }
              }
            }
          }
        }

        // 按路径深度排序，确保父目录先创建
        const sortedPaths = Array.from(packageFolderPaths).sort((a, b) => {
          return a.split('/').length - b.split('/').length
        })

        logger.info(`[ContentHandler] 📁 从 package 路径提取到 ${sortedPaths.length} 个唯一目录`)

        // 递归创建文件夹结构
        for (const relativePath of sortedPaths) {
          if (packageToFolderKey.has(relativePath)) {
            continue // 已创建
          }

          const parts = relativePath.split('/')
          const folderName = parts[parts.length - 1]
          const parentPath = parts.slice(0, -1).join('/')
          const parentFolderKey = packageToFolderKey.get(parentPath) || projectFolderKey

          // 🔧 先查找是否已存在同名文件夹（在同一父目录下）
          // 避免多次导入时创建重复的文件夹
          const existingFolder = db
            .prepare(
              'SELECT folderKey FROM assetFolder WHERE fatherKey = ? AND folderName = ? AND isDelete = 0'
            )
            .get(parentFolderKey, folderName) as { folderKey: string } | undefined

          if (existingFolder) {
            // 复用已有文件夹
            packageToFolderKey.set(relativePath, existingFolder.folderKey)
            logger.info(
              `[ContentHandler] 📁 复用已有文件夹: ${relativePath} -> ${existingFolder.folderKey}`
            )
          } else {
            // 创建新文件夹
            const folderKey = `pkg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

            safeCreateFolder({
              folderKey,
              fatherKey: parentFolderKey,
              type: 'folder',
              folderName,
              img: ''
            })

            packageToFolderKey.set(relativePath, folderKey)
            logger.info(`[ContentHandler] 📁 创建文件夹: ${relativePath} -> ${folderKey}`)
          }
        }
      }

      db.close() // 关闭临时连接

      // 构建导入路径: {保管库名称}/ALL/{版本文件夹名}/{项目名称}
      const vaultName = vaultInfo.name || '默认保管库'
      const importedPath = `${vaultName}/ALL/${versionFolderName}/${projectName}`

      // 导入每个路径
      let totalImported = 0
      let totalFailed = 0

      // 🚀 优化：收集所有单文件，一次性批量导入，避免每个文件单独调用导致的性能问题
      const singleFiles: Array<{
        name: string
        path: string
        type: 'file'
        size: number
        modifiedTime: string
        depth: number
        relativePath: string
      }> = []

      logger.info(`[ContentHandler] 🔍 开始处理 ${targets.length} 个资产路径`)

      for (let i = 0; i < targets.length; i++) {
        const targetPath = targets[i]

        try {
          const stats = await fs.stat(targetPath)

          if (stats.isDirectory()) {
            // 扫描文件夹内容
            const folderContents = await this.scanFolderRecursive(targetPath)

            // 🔧 检查这个目录是否已在 package 路径阶段创建过对应的文件夹
            // 如果是，直接使用已创建的 folderKey，避免 importFolderStructureWithMetadata 再创建同名根文件夹
            //
            // ⚠️ 必须按**完整的 Content 相对路径**找，不能按目录名找：
            //    工程里 CharA/Materials 和 CharB/Materials 同名，按名字找会取到先插进
            //    map 的那一个，把 CharB 的内容整个塞进 CharA 的子树。
            const dirRelativePath = contentRelativePath(targetPath)
            let importTargetKey = projectFolderKey
            let importRootPath: string = targetPath

            const reusedFolderKey = dirRelativePath
              ? findFolderKeyByRelativePath(packageToFolderKey, dirRelativePath)
              : undefined
            if (reusedFolderKey) {
              importTargetKey = reusedFolderKey
              importRootPath = ALL_FOLDER // 扁平导入，不再创建根文件夹
              logger.info(
                `[ContentHandler] 🔧 复用已创建的文件夹: ${dirRelativePath} -> ${reusedFolderKey}`
              )
            }

            // 调用通用导入服务
            const result = await this.assetImportService.importFolderStructureWithMetadata({
              rootFolderPath: importRootPath,
              targetFolderKey: importTargetKey,
              folderContents,
              preloadedMetadata: assetMetadata, // 🚀 传递虚幻引擎预获取的元数据
              packageToFolderKey, // 🚀 传递 package 路径到文件夹的映射
              engineVersion: trimmedVersion, // 🚀 传递清理后的引擎版本号（如 5.3.0）
              onProgress: (progress) =>
                this.broadcast('asset:folderImportProgress', {
                  taskId: uiTaskId,
                  percent: progress.percent,
                  total: progress.total,
                  done: progress.done
                }),
              onStageChange: (stage) =>
                this.broadcast('asset:folderImportStage', { taskId: uiTaskId, stage })
            })

            if (result && result.success && result.data) {
              totalImported += (result.data as any).filesCreated || 0
            } else {
              totalFailed++
              logger.error(`[ContentHandler] 导入失败 ${targetPath}:`, result?.error)
            }
          } else if (stats.isFile()) {
            // 收集单文件信息，稍后批量导入
            singleFiles.push({
              name: path.basename(targetPath),
              path: targetPath,
              type: 'file',
              size: stats.size,
              modifiedTime: stats.mtime.toISOString(),
              depth: 0,
              relativePath: path.basename(targetPath)
            })
          }
        } catch (error) {
          logger.error(`[ContentHandler] 处理路径失败 ${targetPath}:`, error)
          totalFailed++
        }
      }

      // 🚀 批量导入所有单文件（一次调用，而不是每个文件单独调用）
      // 🔥 关键优化：使用 Fire-and-Forget 模式，先返回响应，再后台执行导入
      if (singleFiles.length > 0) {
        logger.info(`[ContentHandler] 批量导入 ${singleFiles.length} 个单文件资产（异步后台执行）`)

        // 🔥 后台执行导入，不阻塞这条消息的处理；
        //    回执等真正导完再发 —— 提前回 ok=true 会让虚幻弹「成功」，
        //    而后台真失败时只进日志，用户在两边都看不到任何报错。
        //    界面侧的「开始导入」提示上面已经发过了，用户不会没有反馈。
        releaseOnReturn = false
        setImmediate(async () => {
          try {
            const result = await this.assetImportService.importFolderStructureWithMetadata({
              rootFolderPath: ALL_FOLDER, // 标记为单文件导入模式
              targetFolderKey: projectFolderKey,
              folderContents: singleFiles,
              preloadedMetadata: assetMetadata, // 🚀 传递虚幻引擎预获取的元数据
              packageToFolderKey, // 🚀 传递 package 路径到文件夹的映射
              engineVersion: trimmedVersion, // 🚀 传递清理后的引擎版本号（如 5.3.0）
              onProgress: (progress) =>
                this.broadcast('asset:folderImportProgress', {
                  taskId: uiTaskId,
                  percent: progress.percent,
                  total: progress.total,
                  done: progress.done
                }),
              onStageChange: (stage) =>
                this.broadcast('asset:folderImportStage', { taskId: uiTaskId, stage })
            })

            if (result && result.success && result.data) {
              const imported = (result.data as any).filesCreated || singleFiles.length
              logger.info(`[ContentHandler] ✅ 后台批量导入完成: ${imported} 个资产`)
              this.sendResponse(
                connectionId,
                requestId,
                true,
                imported,
                undefined,
                method,
                importedPath
              )

              // 🔔 收工：挂件收尾（它自己会重载当前视图），树结构另外刷一遍
              this.broadcast('asset:folderImportCompleted', {
                taskId: uiTaskId,
                total: singleFiles.length,
                done: imported,
                failedCount: 0
              })
              this.broadcast('asset-tree:refresh', {
                parentKey: projectFolderKey,
                createdCount: imported
              })
              logger.info(`[ContentHandler] 🔔 已通知前端刷新资产树`)
            } else {
              logger.error(`[ContentHandler] ❌ 后台批量导入失败:`, result?.error)
              this.sendResponse(
                connectionId,
                requestId,
                false,
                0,
                result?.error || '导入失败',
                method
              )
              this.broadcast('asset:folderImportError', {
                taskId: uiTaskId,
                error: result?.error || '导入失败'
              })
            }
          } catch (error) {
            logger.error(`[ContentHandler] ❌ 后台批量导入异常:`, error)
            this.sendResponse(connectionId, requestId, false, 0, (error as Error).message, method)
            this.broadcast('asset:folderImportError', {
              taskId: uiTaskId,
              error: (error as Error).message
            })
          } finally {
            this.inFlightImports.delete(importKey)
          }
        })

        // 已经发送响应了，直接返回
        return
      }

      this.sendResponse(
        connectionId,
        requestId,
        totalFailed === 0,
        totalImported,
        undefined,
        method,
        importedPath
      )
      logger.info(
        `[ContentHandler] 导入完成: ${totalImported} 成功, ${totalFailed} 失败, 路径: ${importedPath}`
      )

      // 🔔 收工：挂件收尾（它自己会重载当前视图），树结构另外刷一遍
      this.broadcast('asset:folderImportCompleted', {
        taskId: uiTaskId,
        total: targets.length,
        done: totalImported,
        failedCount: totalFailed
      })
      if (totalImported > 0) {
        this.broadcast('asset-tree:refresh', {
          parentKey: projectFolderKey,
          createdCount: totalImported
        })
        logger.info(`[ContentHandler] 🔔 已通知前端刷新资产树`)
      }
    } catch (error) {
      logger.error('[ContentHandler] 导入失败:', error)
      this.sendResponse(connectionId, requestId, false, 0, (error as Error).message, method)
      this.broadcast('asset:folderImportError', {
        taskId: uiTaskId,
        error: (error as Error).message
      })
    } finally {
      if (releaseOnReturn) {
        this.inFlightImports.delete(importKey)
      }
    }
  }

  /**
   * 递归扫描文件夹 (适配 AssetImportService 需要的格式)
   */
  private async scanFolderRecursive(folderPath: string): Promise<
    Array<{
      name: string
      path: string
      type: 'folder' | 'file'
      size: number | null
      modifiedTime: string
      depth: number
      relativePath: string
    }>
  > {
    const results: Array<{
      name: string
      path: string
      type: 'folder' | 'file'
      size: number | null
      modifiedTime: string
      depth: number
      relativePath: string
    }> = []

    const queue: Array<{ path: string; depth: number }> = [{ path: folderPath, depth: 0 }]

    while (queue.length > 0) {
      const { path: currentPath, depth: currentDepth } = queue.shift()!

      try {
        const items = await fs.readdir(currentPath, { withFileTypes: true })

        for (const item of items) {
          const fullPath = path.join(currentPath, item.name)

          try {
            const stats = await fs.stat(fullPath)
            const fileInfo = {
              name: item.name,
              path: fullPath,
              type: (item.isDirectory() ? 'folder' : 'file') as 'folder' | 'file',
              size: item.isFile() ? stats.size : null,
              modifiedTime: stats.mtime.toISOString(),
              depth: currentDepth,
              relativePath: fullPath.replace(folderPath, '').replace(/^[\\/]/, '')
            }

            results.push(fileInfo)

            if (item.isDirectory()) {
              queue.push({ path: fullPath, depth: currentDepth + 1 })
            }
          } catch {
            // 跳过无法访问的文件
          }
        }
      } catch {
        // 跳过无法访问的目录
      }
    }

    // 排序
    results.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return results
  }

  /**
   * 发送响应
   * @param connectionId - 连接ID
   * @param requestId - 请求ID
   * @param ok - 是否成功
   * @param count - 导入数量
   * @param error - 错误信息（可选）
   * @param method - 方法名
   * @param importedPath - 导入到的路径，例如 "默认保管库/ALL/UE5.0/UALinkDev"
   */
  private sendResponse(
    connectionId: string,
    requestId: string | undefined,
    ok: boolean,
    count: number,
    error?: string,
    method: string = 'content.import_folder',
    importedPath?: string
  ): void {
    this.send?.(connectionId, {
      ver: '1.0',
      type: 'res',
      method,
      id: requestId,
      payload: { ok, count, error, importedPath },
      time: Date.now()
    })
  }
}
