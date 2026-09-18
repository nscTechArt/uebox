import { beginAssetImport, finishAssetImport } from '../../services/asset/importControl'
import { ipcMain } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join, basename } from 'path'

import { getDatabaseManager, getPublicDatabase } from '../index'
import { transaction } from '../dbUtils'
import {
  createAssetData,
  getAssetDataByKey,
  updateAssetData,
  type AssetData
} from '../models/assetData'
import { createAssetFolder, getAssetFolderByKey } from '../models/assetFolder'
import { FileProcessorManager } from '../../utils/fileProcessor/FileProcessorManager'
import { ALL_FOLDER } from '../../init/constants'
import { AssetBackupManager, type BackupAssetInfo } from '../../utils/assetBackup'
import { AssetDependencyResolver } from '../../utils/assetDependency/AssetDependencyResolver'
import { VaultServiceManager } from '../../networkV2/VaultServiceManager'

import { PathManager } from '../../utils/PathManager'
import { createImportTask, updateImportTask, getImportTaskByTaskId } from '../models/importTask'
import { getAssetClassNameCn, getAssetClassColor } from '../../utils/assetClassUtils'
import {
  createAssetImportRuntimeState,
  getImportPromptQueue,
  isRecoverablePreprocessWarning,
  registerAssetImportConfigIPC,
  waitForImportErrorResolution
} from './assetData/importRuntime'
import { registerAssetThumbnailIPC } from './assetData/thumbnails'
import { registerAssetDataCrudIPC } from './assetData/crud'
import { registerAssetFsIPC } from './assetData/fsHandlers'
import { findExistingAssetRow, findIdenticalLocalAssets } from './assetData/importDedup'
import { LocalBackupSession } from './assetData/localBackupSession'
import {
  buildImportThumbnail,
  copyPluginIconThumbnail,
  prefetchFolderTypes,
  readUpluginInfo
} from './assetData/importAssetMedia'
import {
  createDefaultNetworkVaultCopyDeps,
  runNetworkVaultCopy,
  type NetworkCopyFile,
  type OverwriteDecision
} from './assetData/networkVaultCopy'
import type {
  FolderImportOptions,
  ImportFailureEntry,
  ImportOutcomeSummary,
  ImportSkipEntry
} from '../../../shared/assetImport'
import { registerAssetDependencyIPC } from './assetData/dependencyHandlers'
import { registerAssetMetadataIPC } from './assetData/metadataHandlers'
import {
  rollbackRemoteImportLocalRows,
  shouldRollbackRemoteImportLocalRows,
  type RemoteImportLocalRollbackResult
} from './assetData/remoteImportLocalRollback'
import {
  buildRemoteImportFilePath,
  findActiveRemoteAssetByPath
} from './assetData/remoteImportPath'
import {
  dropThumbnailRef,
  resolveAssetThumbnailRefs,
  type ThumbnailRefField
} from './assetData/remoteThumbnailRefs'
import { buildImportFolderTree, normalizeImportFolderPath } from './assetData/importFolderTree'
export { calculateFastFileHash } from './assetData/fileUtils'
import { generateSafeAssetKey, calculateFastFileHash } from './assetData/fileUtils'
import { captureImportDiagnostic } from '../../services/system/ImportDiagnosticsService'
import {
  buildImportRecoveryContext,
  linkImportRecoveryDiagnostic,
  saveImportRecoveryContext
} from '../../services/asset/ImportRecoveryContextService'
import { getAssetNameFromFileName, stripPathLeafExtension } from '../../utils/assetName'

const importRuntime = createAssetImportRuntimeState()
registerAssetImportConfigIPC(importRuntime)

/**
 * 注册资产数据相关的 IPC 处理函数
 */
export const registerAssetDataIPC = (): void => {
  class WriterQueue {
    private chain: Promise<unknown> = Promise.resolve()

    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const next = this.chain.then(task)
      this.chain = next.catch(() => {})
      return next
    }
  }

  class AsyncSemaphore {
    private active = 0
    private waiters: Array<() => void> = []

    constructor(private limit: number) {}

    setLimit(limit: number): void {
      this.limit = Math.max(1, limit)
      this.drainWaiters()
    }

    async acquire(): Promise<() => void> {
      if (this.active < this.limit) {
        this.active++
        return () => this.release()
      }

      await new Promise<void>((resolve) => {
        this.waiters.push(() => {
          resolve()
        })
      })

      return () => this.release()
    }

    private release(): void {
      this.active = Math.max(0, this.active - 1)
      this.drainWaiters()
    }

    private drainWaiters(): void {
      while (this.active < this.limit && this.waiters.length > 0) {
        const next = this.waiters.shift()
        if (!next) break
        this.active++
        next()
      }
    }
  }

  const writerQueue = new WriterQueue()
  const activeRemoteImportCounts = new Map<string, number>()
  const vaultsPendingRemotePull = new Set<string>()
  const remoteImportSessionSemaphores = new Map<string, AsyncSemaphore>()
  const activeRemoteSessionConcurrency =
    parseInt(process.env.V2_IMPORT_ACTIVE_SESSION_CONCURRENCY || '', 10) || 3
  const remoteImportPullTimeoutMs =
    parseInt(process.env.V2_IMPORT_PULL_TIMEOUT_MS || '', 10) || 30_000

  const getRemoteImportSemaphore = (vaultId: string, requestedLimit?: number): AsyncSemaphore => {
    let semaphore = remoteImportSessionSemaphores.get(vaultId)
    const effectiveLimit =
      Number.isFinite(requestedLimit) && (requestedLimit || 0) > 0
        ? Math.max(1, Math.floor(requestedLimit!))
        : Math.max(1, activeRemoteSessionConcurrency)
    if (!semaphore) {
      semaphore = new AsyncSemaphore(effectiveLimit)
      remoteImportSessionSemaphores.set(vaultId, semaphore)
    } else {
      semaphore.setLimit(effectiveLimit)
    }
    return semaphore
  }

  const runWithRemoteImportPermit = async <T>(
    vaultId: string,
    label: string,
    requestedLimit: number | undefined,
    task: () => Promise<T>
  ): Promise<T> => {
    const waitStartedAt = Date.now()
    const effectiveLimit =
      Number.isFinite(requestedLimit) && (requestedLimit || 0) > 0
        ? Math.max(1, Math.floor(requestedLimit!))
        : Math.max(1, activeRemoteSessionConcurrency)
    const release = await getRemoteImportSemaphore(vaultId, effectiveLimit).acquire()
    const waitedMs = Date.now() - waitStartedAt
    console.log(
      `[ImportWithMetadata] remote import permit acquired: vault=${vaultId}, label=${label}, ` +
        `limit=${effectiveLimit}, waitedMs=${waitedMs}`
    )
    try {
      return await task()
    } finally {
      release()
      console.log(
        `[ImportWithMetadata] remote import permit released: vault=${vaultId}, label=${label}`
      )
    }
  }

  const beginRemoteImportSession = (vaultId: string): void => {
    activeRemoteImportCounts.set(vaultId, (activeRemoteImportCounts.get(vaultId) || 0) + 1)
  }

  const markRemotePullNeeded = (vaultId: string): void => {
    vaultsPendingRemotePull.add(vaultId)
  }

  const hasCommittedRemoteChanges = (
    remoteSyncStatus: 'committed' | 'failed' | 'partial' | 'skipped',
    remoteSyncFailureDetails: any
  ): boolean => {
    if (remoteSyncStatus === 'committed' || remoteSyncStatus === 'partial') {
      return true
    }

    if (remoteSyncStatus !== 'failed' || !remoteSyncFailureDetails) {
      return false
    }

    return (
      Number(remoteSyncFailureDetails.committedAssets || 0) > 0 ||
      Number(remoteSyncFailureDetails.committedFolders || 0) > 0 ||
      Number(remoteSyncFailureDetails.committedFiles || 0) > 0 ||
      Number(remoteSyncFailureDetails.committedThumbnails || 0) > 0
    )
  }

  const finishRemoteImportSession = async (vaultId: string): Promise<void> => {
    const currentCount = activeRemoteImportCounts.get(vaultId) || 0
    if (currentCount <= 1) {
      activeRemoteImportCounts.delete(vaultId)
      if (vaultsPendingRemotePull.has(vaultId)) {
        vaultsPendingRemotePull.delete(vaultId)
        const client = VaultServiceManager.getInstance().getClient(vaultId)
        if (client) {
          let timer: ReturnType<typeof setTimeout> | null = null
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Remote pull timed out after ${remoteImportPullTimeoutMs}ms`))
            }, remoteImportPullTimeoutMs)
          })
          void Promise.race([client.pullChanges(), timeoutPromise])
            .catch((pullErr) => {
              console.error(
                `[ImportWithMetadata] 远程导入批次结束后回拉失败: vault=${vaultId}`,
                pullErr
              )
            })
            .finally(() => {
              if (timer) {
                clearTimeout(timer)
                timer = null
              }
            })
        }
      }
      return
    }

    activeRemoteImportCounts.set(vaultId, currentCount - 1)
  }

  registerAssetThumbnailIPC()
  registerAssetDataCrudIPC()
  registerAssetFsIPC()
  registerAssetDependencyIPC()
  registerAssetMetadataIPC()

  ipcMain.handle(
    'db:importFolderStructureWithMetadata',
    async (
      event,
      folderContents: any[],
      rootFolderPath: string,
      targetFolderKey?: string,
      importConcurrency?: number,
      providedTaskId?: string,
      importOptions?: FolderImportOptions
    ) => {
      void event
      const retryOfTaskId = importOptions?.retryOfTaskId
      /** 重试也要确认内容冲突，不能覆盖两次尝试之间更新过的文件。 */
      const forceOverwrite = importOptions?.forceOverwrite ?? false
      let importController: AbortController | undefined
      // ── 权威记账 ──
      // 三个都提到最外层：导入报告是在这之后的任意时刻生成的（包括中途取消），
      // 放在内层块里会让报告撞上 TDZ，或者只能写出旧口径的数字。
      let succeededFileCount = 0
      let failedFileCount = 0
      let skippedFileCount = 0
      let remoteMode = false
      let localBackup: LocalBackupSession | undefined
      let cancelRemoteLocalWrites: (() => Promise<unknown>) | undefined
      let progressInterval: NodeJS.Timeout | null = null
      let remoteImportSessionVaultId: string | null = null
      let diagnosticVaultId = ''
      let diagnosticServerUrl: string | undefined
      let diagnosticRemoteVaultId: string | undefined
      let diagnosticSessionId: string | undefined
      let recoveryContextPath: string | undefined
      let publicDb: ReturnType<typeof getPublicDatabase> | null = null
      /**
       * 导入专用的保管库连接。
       *
       * 必须在这一层声明，才能让下面的 finally 无条件关掉它。原来它声明在 try 里、
       * 只有成功路径 close —— 暂停、取消、抛异常全都漏。泄漏的句柄让 WAL 一直长，
       * 而且在 Windows 上会压住库文件：删库时先删了注册记录再 rm 目录，
       * rm 撞 EBUSY 重试五次后抛错 → **保管库在界面上消失了，磁盘上几十 GB
       * 一个字节没释放，也没法再从界面管理它**。
       */
      let importDb: { close?: () => void } | null = null
      const taskId =
        typeof providedTaskId === 'string' && providedTaskId.trim().length > 0
          ? providedTaskId.trim()
          : rootFolderPath
      let buildImportIssueReport = async (
        _remoteSyncStatus: 'committed' | 'failed' | 'partial' | 'skipped',
        _remoteSyncError?: string,
        _remoteSyncFailureDetails?: any
      ): Promise<{ reportPath?: string; issueCount: number }> => ({ issueCount: 0 })
      try {
        importController = beginAssetImport(taskId)
        const signal = importController.signal
        const databaseManager = getDatabaseManager()
        const vaultInfo = databaseManager.getVaultManager().getCurrentVault()
        if (importOptions?.vaultId && vaultInfo?.id !== importOptions.vaultId) {
          throw new Error('原保管库已切换，请切回原保管库后重试')
        }
        if (!vaultInfo) {
          throw new Error('当前保管库不存在')
        }
        const vaultDbPath = require('node:path').join(vaultInfo.path, 'vault-data.db')
        const Database = require('better-sqlite3')
        const db = new Database(vaultDbPath)
        importDb = db
        try {
          db.pragma('journal_mode = WAL')
          db.pragma('busy_timeout = 5000')
        } catch {}
        if (
          targetFolderKey &&
          targetFolderKey !== 'ALL' &&
          !getAssetFolderByKey(db, targetFolderKey)
        ) {
          throw new Error('原目标文件夹已不存在，请重新选择导入位置')
        }
        const fileProcessor = new FileProcessorManager()

        // 获取当前保管库信息，判断是备份模式还是引用模式
        const currentVault = vaultInfo
        diagnosticVaultId = currentVault?.id || ''
        const isBackupMode = currentVault?.vaultType === 'backup'
        // isNetworkMode 仅对 SMB 共享路径生效（文件直接复制到网络路径）
        // HTTP 资产服务器（http://）通过 SyncClient API 同步，不走文件系统复制
        const isNetworkMode =
          currentVault?.vaultType === 'network' &&
          !!currentVault?.networkPath &&
          !currentVault.networkPath.startsWith('http')
        // isRemoteServerMode: HTTP 资产服务器模式 — 导入后需通过 SyncClient 推送到远端
        const isRemoteServerMode =
          currentVault?.vaultType === 'network' &&
          !!currentVault?.networkPath &&
          currentVault.networkPath.startsWith('http')
        remoteMode = Boolean(isRemoteServerMode)
        const networkPath = currentVault?.networkPath
        // 收集远程推送用的数据（仅 isRemoteServerMode 时使用）
        const remoteSyncFolders: Record<string, unknown>[] = []
        const remoteSyncAssets: Record<string, unknown>[] = []
        const remoteSyncThumbnails: Array<{ localPath: string; remotePath: string }> = []
        const remoteQueuedAssetKeys = new Set<string>()
        const remoteQueuedThumbnailPaths = new Set<string>()
        /**
         * 本地缩略图目录里找不到的引用。
         *
         * 本地没有 ≠ 引用悬空：网络库的缩略图本来就可能只在服务器上。这里先攒着，
         * 推送前统一问一次服务器，两边都没有的那些才摘掉。
         */
        const unresolvedThumbnailRefs: Array<{
          record: Record<string, unknown>
          field: ThumbnailRefField
          assetKey: string
          assetName: string
          fileName: string
        }> = []
        const localRemoteImportCreatedAssetKeys = new Set<string>()
        const localRemoteImportCreatedFolderKeys = new Set<string>()
        const previousRemoteAssets = new Map<string, Record<string, unknown>>()
        if (isRemoteServerMode) {
          cancelRemoteLocalWrites = () =>
            writerQueue.enqueue(() =>
              transaction(db, (rollbackDb) =>
                rollbackRemoteImportLocalRows(rollbackDb, {
                  assetKeys: localRemoteImportCreatedAssetKeys,
                  folderKeys: localRemoteImportCreatedFolderKeys,
                  previousAssets: previousRemoteAssets.values()
                })
              )
            )
        }
        const pm = PathManager.getInstance()
        const thumbnailExistsLocally = (fileName: string): boolean =>
          existsSync(pm.getThumbnailFilePath(fileName))
        const queueRemoteSyncAsset = (asset: Record<string, unknown>): void => {
          if (!isRemoteServerMode) return

          const assetKey = typeof asset.assetKey === 'string' ? asset.assetKey : ''
          if (assetKey) {
            if (remoteQueuedAssetKeys.has(assetKey)) return
            remoteQueuedAssetKeys.add(assetKey)
          }

          // 发出去的元数据只能引用这次真的会上传的缩略图。理由见 remoteThumbnailRefs.ts
          // —— 少对上一条，服务端就驳回整单，而且「继续完成」补不回来。
          const refs = resolveAssetThumbnailRefs(asset, thumbnailExistsLocally)
          remoteSyncAssets.push(refs.asset)

          for (const fileName of refs.queued) {
            const thumbLocalPath = pm.getThumbnailFilePath(fileName)
            if (remoteQueuedThumbnailPaths.has(thumbLocalPath)) continue
            remoteQueuedThumbnailPaths.add(thumbLocalPath)
            remoteSyncThumbnails.push({
              localPath: thumbLocalPath,
              remotePath: `.thumbnails/${fileName}`
            })
          }

          for (const ref of refs.pending) {
            unresolvedThumbnailRefs.push({
              record: refs.asset,
              field: ref.field,
              assetKey,
              assetName: typeof asset.assetName === 'string' ? asset.assetName : assetKey,
              fileName: ref.fileName
            })
          }
        }
        const requestedRemoteImportConcurrency =
          Number.isFinite(importConcurrency) && (importConcurrency || 0) > 0
            ? Math.max(1, Math.floor(importConcurrency!))
            : undefined
        const resolveRemoteImportTargetFolderKey = (folderKey?: string): string => {
          if (!folderKey || folderKey === ALL_FOLDER) return ALL_FOLDER
          if (folderKey === 'generated-models') {
            const modelFolderExists = db
              .prepare('SELECT isDelete FROM assetFolder WHERE folderKey = ?')
              .get('AIGC_model') as { isDelete: number } | undefined
            return modelFolderExists ? 'AIGC_model' : ALL_FOLDER
          }
          const targetExists = db
            .prepare('SELECT isDelete FROM assetFolder WHERE folderKey = ?')
            .get(folderKey) as { isDelete: number } | undefined
          if (!targetExists) return ALL_FOLDER
          return folderKey
        }
        const remoteImportTargetFolderKey = resolveRemoteImportTargetFolderKey(targetFolderKey)
        const remoteServerApiKey =
          isRemoteServerMode && currentVault?.id
            ? getDatabaseManager().getVaultManager().getNetworkVaultApiKey(currentVault.id)
            : undefined

        if (isRemoteServerMode && currentVault?.id) {
          remoteImportSessionVaultId = currentVault.id
          beginRemoteImportSession(remoteImportSessionVaultId)
        }

        console.log('🚀 [ImportWithMetadata] 开始导入文件夹结构', Date.now())
        console.log('🚀 [ImportWithMetadata] 当前保管库:', currentVault)
        console.log('🚀 [ImportWithMetadata] 是否备份模式:', isBackupMode)
        console.log(
          '🚀 [ImportWithMetadata] 是否网络模式:',
          isNetworkMode,
          '网络路径:',
          networkPath
        )
        console.log('🚀 [ImportWithMetadata] 根文件夹路径:', rootFolderPath)
        console.log('🚀 [ImportWithMetadata] 目标文件夹:', targetFolderKey)
        console.log('🚀 [ImportWithMetadata] 文件夹内容数量:', folderContents.length)

        // 先处理所有 .uasset 和 .umap 文件的元数据
        const processedMetadata = new Map<string, any>()

        // 分离文件夹和文件（保持原有排序逻辑）
        const sortedContents = folderContents.sort((a, b) => {
          const depthA = a.depth || 0
          const depthB = b.depth || 0
          if (depthA !== depthB) return depthA - depthB
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

        const files = sortedContents.filter((item) => item.type === 'file')
        // 🚀 OOM修复：sortedContents 和 folderContents 不再需要，释放引用让 GC 回收
        // folderContents 是入参（数百/数千项），sortedContents 是其排序视图
        // @ts-ignore - 允许置空入参以释放内存
        folderContents = null as any
        // sortedContents 是 const 不能置空，但 filter 后 files/folders 是独立数组
        console.log('📁 [ImportWithMetadata] 文件数量:', files.length)

        if (isRemoteServerMode && networkPath) {
          const lastSlash = networkPath.lastIndexOf('/')
          const serverUrl = networkPath.substring(0, lastSlash)
          const remoteVaultId = networkPath.substring(lastSlash + 1)
          diagnosticServerUrl = serverUrl
          diagnosticRemoteVaultId = remoteVaultId
          const expectedUploadBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
          const clientId = `${require('os').hostname()}-${require('os').userInfo().username}`
          const { checkV2ImportReadiness } = await import('../../services/asset/importFeatureFlag')
          const readiness = await checkV2ImportReadiness(
            serverUrl,
            remoteVaultId,
            clientId,
            remoteImportTargetFolderKey,
            expectedUploadBytes,
            { bypassCapabilityCache: true, apiKey: remoteServerApiKey }
          )
          if (!readiness.supported || !readiness.ready) {
            throw new Error(
              readiness.userMessage ||
                (readiness.errorCode === 'CLIENT_UPDATE_REQUIRED'
                  ? '请更新客户端后再导入'
                  : '当前 NAS 服务器版本过旧，请更新 NAS V2 服务端后再导入')
            )
          }
        }

        const totalFilesForProgress = files.length
        let handledFilesForProgress = 0

        // 进度权重配置
        const PARSING_WEIGHT = isRemoteServerMode ? 5 : 10
        // 动态调整权重：备份/网络模式下，预处理占40%，备份/复制占30%；非备份模式下，预处理占70%
        // 网络模式也需要复制文件到网络路径，所以使用与备份模式相同的权重分配
        // 🚀 远程服务器模式：上传阶段占大头（60%），其他阶段压缩
        const needsCopyPhase = isBackupMode || isNetworkMode
        const PREPROCESS_WEIGHT = isRemoteServerMode ? 15 : needsCopyPhase ? 40 : 70
        const BACKUP_WEIGHT = isRemoteServerMode ? 0 : needsCopyPhase ? 30 : 0
        const WRITING_WEIGHT = isRemoteServerMode ? 10 : 20
        const UPLOADING_WEIGHT = isRemoteServerMode ? 60 : 0 // 🚀 仅远程服务器模式
        let lastProgressTime = 0
        const PROGRESS_INTERVAL = 200 // 200ms 发送一次进度

        /**
         * 发送加权进度
         * @param current 当前阶段处理数量
         * @param total 总数量
         * @param basePercent 基础百分比
         * @param weight 当前阶段权重
         * @param stage 当前阶段名称
         * @param force 是否强制发送
         */
        const sendWeightedProgress = (
          current: number,
          total: number,
          basePercent: number,
          weight: number,
          stage: string,
          force = false
        ) => {
          const now = Date.now()
          if (!force && now - lastProgressTime < PROGRESS_INTERVAL && current < total) {
            return
          }
          lastProgressTime = now

          const currentStagePercent = total > 0 ? current / total : 0
          const globalPercent = Math.min(
            100,
            Math.round(basePercent + currentStagePercent * weight)
          )

          try {
            event.sender.send('asset:folderImportProgress', {
              taskId,
              total: total,
              done: current,
              percent: globalPercent
            })

            // 更新数据库任务状态
            const persistedDoneItems =
              stage === 'parsing' ||
              stage === 'preprocessing' ||
              stage === 'writing' ||
              stage === 'backup'
                ? Math.min(totalFilesForProgress, current)
                : Math.min(totalFilesForProgress, handledFilesForProgress)

            updateImportTask(publicDb, taskId, {
              percent: globalPercent,
              doneItems: persistedDoneItems,
              totalItems: totalFilesForProgress,
              stage: stage
            })
          } catch (e) {
            console.warn('发送进度失败:', e)
          }
        }

        publicDb = getPublicDatabase()
        const vaultId = currentVault?.id || ''
        createImportTask(publicDb, {
          taskId,
          vaultId,
          rootPath: rootFolderPath,
          targetFolderKey: targetFolderKey || null,
          status: 'parsing',
          stage: 'parsing',
          percent: PARSING_WEIGHT, // 初始化时直接设为遍历完成状态
          totalItems: totalFilesForProgress,
          doneItems: 0,
          pauseRequested: 0,
          resumeCursor: 0
        })

        buildImportIssueReport = async (
          remoteSyncStatus: 'committed' | 'failed' | 'partial' | 'skipped',
          remoteSyncError?: string,
          remoteSyncFailureDetails?: any
        ): Promise<{ reportPath?: string; issueCount: number }> => {
          const issueEntries = [
            ...failedFiles.map((item) => ({ stage: 'preprocess', ...item })),
            ...importIssueEntries
          ]
          const issueCount = issueEntries.length
          const shouldWriteReport =
            issueCount > 0 || remoteSyncStatus === 'failed' || remoteSyncStatus === 'partial'

          if (!shouldWriteReport) {
            return { issueCount }
          }

          const reportDir = join(vaultInfo.path, '.import-reports')
          const safeRootName = (basename(rootFolderPath) || 'import')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .slice(0, 80)
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
          const reportPath = join(reportDir, `${timestamp}-${safeRootName}.json`)

          const dedupedIssues = issueEntries.filter((entry, index, array) => {
            const key = `${entry.stage}|${entry.path}|${entry.error}`
            return (
              array.findIndex(
                (candidate) => `${candidate.stage}|${candidate.path}|${candidate.error}` === key
              ) === index
            )
          })

          const reportPayload = {
            generatedAt: new Date().toISOString(),
            vaultId,
            localVaultId: currentVault?.id || vaultId,
            serverUrl: diagnosticServerUrl || null,
            remoteVaultId: diagnosticRemoteVaultId || null,
            sessionId: diagnosticSessionId || null,
            taskId,
            rootFolderPath,
            isCancelled: signal.aborted,
            targetFolderKey: targetFolderKey || null,
            summary: {
              totalItems: totalFilesForProgress,
              doneItems: handledFilesForProgress,
              // 权威口径：这三个才回答「到底进没进库」，和界面上的成功/失败/跳过一致
              succeeded: succeededFileCount,
              failed: failedFileCount,
              skipped: skippedFileCount,
              // 旧口径，读作「虚幻资产 / 其它文件」而不是「成功 / 跳过」。
              // 一个 .png 正常入库也会记进 skippedFiles，别拿它判断成败。
              processedFiles,
              skippedFiles,
              preprocessFailedCount: failedFiles.length,
              issueCount: dedupedIssues.length,
              remoteSyncStatus,
              remoteSyncError: remoteSyncError || null,
              remoteSyncFailureDetails: remoteSyncFailureDetails || null
            },
            issues: dedupedIssues
          }

          await fs.mkdir(reportDir, { recursive: true })
          await fs.writeFile(reportPath, JSON.stringify(reportPayload, null, 2), 'utf-8')
          console.warn(
            `[ImportWithMetadata] import issue report generated: taskId=${taskId}, issues=${dedupedIssues.length}, path=${reportPath}`
          )
          return { reportPath, issueCount: dedupedIssues.length }
        }

        // 发送初始进度事件
        try {
          event.sender.send('asset:folderImportProgress', {
            taskId,
            total: totalFilesForProgress,
            done: 0,
            percent: PARSING_WEIGHT
          })
        } catch {}

        // 定义 shouldPause 函数，检查任务是否被请求暂停
        // 🚀 优化：使用节流策略，每 10 个文件才检查一次数据库，减少 I/O 开销
        let pauseCheckCounter = 0
        let cachedPauseState = false
        const PAUSE_CHECK_INTERVAL = 10
        const shouldPause = (): boolean => {
          pauseCheckCounter++
          if (pauseCheckCounter >= PAUSE_CHECK_INTERVAL) {
            pauseCheckCounter = 0
            const task = getImportTaskByTaskId(publicDb, taskId)
            cachedPauseState = task?.pauseRequested === 1
          }
          return cachedPauseState
        }

        updateImportTask(publicDb, taskId, { status: 'preprocessing', stage: 'preprocessing' })
        try {
          event.sender.send('asset:folderImportStage', {
            taskId,
            stage: 'preprocessing'
          })
        } catch {}

        // 🚀 性能优化：统计需要解析的 uasset/umap 文件数量
        const uassetFiles = files.filter((f) => {
          const ext = f.name.split('.').pop()?.toLowerCase() || ''
          return ext === 'uasset' || ext === 'umap'
        })
        const totalUassets = uassetFiles.length
        let processedUassets = 0 // 仅用于日志
        let processedPreprocessCount = 0 // 用于进度条

        // 错误处理状态
        const failedFiles: Array<{ fileName: string; path: string; error: string }> = []
        /** SMB 复制阶段的失败清单 —— 这些文件没进网络库，也不会写库 */
        const copyFailures: ImportFailureEntry[] = []
        /** 有意跳过的清单（用户选择 / 弹窗超时 / 窗口已关）*/
        const copySkips: ImportSkipEntry[] = []
        /** 写库阶段的失败清单 */
        const writeFailures: ImportFailureEntry[] = []
        const importIssueEntries: Array<{
          stage: string
          severity?: string
          fileName: string
          path: string
          error: string
        }> = []
        for (const issue of importOptions?.scanIssues || []) {
          importIssueEntries.push({
            stage: 'scan',
            fileName: basename(issue.path),
            path: issue.path,
            error: issue.reason
          })
        }
        const failedFilePaths = new Set<string>()
        let ignoreAllErrors = false
        let importCancelled = false
        const importErrorPromptQueue = getImportPromptQueue(event.sender)

        const waitForUserImportErrorAction = async (
          file: any,
          errorMsg: string,
          failedCount: number
        ): Promise<string> => {
          return importErrorPromptQueue.run(async () => {
            if (importCancelled || signal.aborted) return 'cancel'
            if (ignoreAllErrors) return 'ignore_all'

            // 窗口已经没了就别问了，直接按「全部忽略」把导入跑完
            if (event.sender.isDestroyed()) {
              ignoreAllErrors = true
              importIssueEntries.push({
                stage: 'preprocess_prompt_abandoned',
                severity: 'warning',
                fileName: file.name,
                path: file.path,
                error: `窗口已关闭，无人可确认，按「忽略」继续：${errorMsg}`
              })
              return 'ignore_all'
            }

            try {
              event.sender.send('asset:importErrorOccurred', {
                taskId,
                fileName: file.name,
                path: file.path,
                error: errorMsg,
                failedCount
              })
            } catch (e) {
              console.warn('发送导入错误事件失败:', e)
            }

            return waitForImportErrorResolution(importRuntime, taskId, {
              isAbandoned: () => event.sender.isDestroyed() || signal.aborted,
              onFallback: (reason) => {
                // 替用户做的决定必须留痕，不能静默
                ignoreAllErrors = true
                importIssueEntries.push({
                  stage: 'preprocess_prompt_timeout',
                  severity: 'warning',
                  fileName: file.name,
                  path: file.path,
                  error:
                    reason === 'window_gone'
                      ? `窗口已关闭，无人可确认，按「忽略」继续：${errorMsg}`
                      : `等待确认超时，按「忽略」继续：${errorMsg}`
                })
                console.warn(
                  `[ImportWithMetadata] 解析错误确认${reason === 'window_gone' ? '窗口已关闭' : '超时'}，按忽略继续: ${file.name}`
                )
              }
            }).finally(() => {
              if (!event.sender.isDestroyed())
                event.sender.send('asset:importErrorSettled', { taskId })
            })
          })
        }

        // 预处理所有 .uasset 和 .umap 文件的元数据
        // 显式发送初始进度
        sendWeightedProgress(
          0,
          totalFilesForProgress,
          PARSING_WEIGHT,
          PREPROCESS_WEIGHT,
          'preprocessing',
          true
        )

        // 🚀 并发预处理：使用工人池模式并行解析 uasset/umap 文件
        //
        // 这个数**不该跟着核数走**，也不该让用户填。下面这些"工人"是同一条主进程
        // 事件循环上的 N 个 async 循环：`fd.read` 能重叠，但读完之后在 buffer 上
        // 跑的解析是同步 JS，无论 N 多大都排队执行。所以并发只买到"藏住磁盘寻道
        // 延迟"这一件事，加到 8、10 不增吞吐。
        //
        // 而代价是实打实的：`analyzeFromFile` 每个文件 `Buffer.alloc(元数据区大小)`，
        // 单文件上限 1 GiB，峰值内存约等于 N × 元数据区。这条链路已经因为 OOM
        // 打过补丁（下面每 2000 文件一次 GC），内存是绑定约束，不是 CPU。
        //
        // 4：够把机械盘/网络盘的寻道藏在解析后面，又把内存峰值压在小倍数上。
        const PREPROCESS_CONCURRENCY = 4
        let preprocessIndex = 0
        let pauseDetected = false // 标记是否检测到暂停请求

        // 🛡️ 分级超时策略（根据文件大小动态调整）
        const getTimeoutMs = (size: number): number => {
          if (size > 500 * 1024 * 1024) return 120000 // >500MB: 120秒
          if (size > 100 * 1024 * 1024) return 60000 // >100MB: 60秒
          if (size > 50 * 1024 * 1024) return 30000 // >50MB: 30秒
          return 15000 // 默认 15秒
        }

        // 处理单个文件的预处理逻辑
        const preprocessOneFile = async (file: any): Promise<void> => {
          const fileExtension = file.name.split('.').pop()?.toLowerCase() || ''
          if (fileExtension === 'uasset' || fileExtension === 'umap') {
            // 解析 uasset/umap 文件，添加边界保护
            let isError = false
            let errorMsg = ''
            const fileSize = file.size || 0

            // 🛡️ 边界保护：超大文件警告（>500MB 可能导致内存压力）
            if (fileSize > 500 * 1024 * 1024) {
              console.warn(
                `⚠️ [ImportWithMetadata] 超大文件预警: ${file.name} (${(fileSize / 1024 / 1024).toFixed(1)}MB)，解析可能耗时较长`
              )
            }

            const timeoutMs = getTimeoutMs(fileSize)

            try {
              // 🛡️ 添加超时保护，避免单文件解析卡死整个导入
              const fileMetadata = await Promise.race([
                fileProcessor.processFile(file.path),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`解析超时 (${timeoutMs / 1000}秒)`)), timeoutMs)
                )
              ])

              if (fileMetadata && fileMetadata.metadata) {
                // 检查是否为无效资产
                if (fileMetadata.assetType === 'InvalidAsset' || fileMetadata.metadata.error) {
                  isError = true
                  errorMsg = fileMetadata.metadata.error || 'Invalid Asset'
                } else {
                  processedMetadata.set(file.path, fileMetadata)
                }
              }
            } catch (error) {
              isError = true
              errorMsg = error instanceof Error ? error.message : String(error)
              // 🛡️ 超时或错误时，添加基础元数据确保文件仍能被导入
              const nameWithoutExt = getAssetNameFromFileName(file.name)
              processedMetadata.set(file.path, {
                processorType: 'UnrealAsset',
                assetType: 'UnrealAsset',
                metadata: {
                  name: nameWithoutExt,
                  originPath: file.path,
                  ext: fileExtension,
                  size: fileSize,
                  parseError: errorMsg.substring(0, 200)
                }
              })
            }

            if (isError) {
              if (isRecoverablePreprocessWarning(errorMsg)) {
                const warningMessage = '详细元数据解析超时，已使用基础元数据继续导入'
                importIssueEntries.push({
                  stage: 'preprocess_warning',
                  severity: 'warning',
                  fileName: file.name,
                  path: file.path,
                  error: warningMessage
                })
                console.warn(
                  `⚠️ [ImportWithMetadata] 预处理降级 ${file.name}: ${warningMessage} (${errorMsg})`
                )
              } else {
                failedFiles.push({ fileName: file.name, path: file.path, error: errorMsg })
                failedFilePaths.add(file.path)
                console.warn(`⚠️ [ImportWithMetadata] 预处理失败 ${file.name}: ${errorMsg}`)

                // 如果没有选择"全部忽略"，则暂停并通知前端
                if (!ignoreAllErrors) {
                  const action = await waitForUserImportErrorAction(
                    file,
                    errorMsg,
                    failedFiles.length
                  )

                  if (action === 'cancel') {
                    importCancelled = true
                  } else if (action === 'ignore_all') {
                    ignoreAllErrors = true
                  }
                  // 如果是 'ignore'，则继续
                }
              }
            }

            // 📊 更新解析进度
            processedUassets++
            if (
              totalUassets > 0 &&
              (processedUassets % 500 === 0 || processedUassets === totalUassets)
            ) {
              const percent = Math.round((processedUassets / totalUassets) * 100)
              console.log(
                `📊 [ImportWithMetadata] 预处理进度: ${processedUassets}/${totalUassets} (${percent}%)`
              )
            }
          }

          // 🚀 更新预处理总进度（包括跳过的非uasset文件）
          processedPreprocessCount++
          sendWeightedProgress(
            processedPreprocessCount,
            totalFilesForProgress,
            PARSING_WEIGHT,
            PREPROCESS_WEIGHT,
            'preprocessing'
          )

          // 🛡️ OOM修复: 预处理分批 GC
          // 每 2000 文件让出事件循环并尝试 GC，降低内存峰值
          if (processedPreprocessCount % 2000 === 0 && processedPreprocessCount > 0) {
            console.log(
              `🛡️ [ImportWithMetadata] 预处理批次 ${processedPreprocessCount / 2000} 完成，触发 GC`
            )
            await new Promise((r) => setImmediate(r))
            ;(global as any).gc?.()
          }
        }

        // 🚀 并发执行预处理（最多 PREPROCESS_CONCURRENCY 个并行）
        console.log(`🚀 [ImportWithMetadata] 开始并发预处理，并发数: ${PREPROCESS_CONCURRENCY}`)
        const runConcurrentPreprocess = async (): Promise<void> => {
          const workers: Promise<void>[] = []
          for (let w = 0; w < PREPROCESS_CONCURRENCY; w++) {
            workers.push(
              (async () => {
                while (preprocessIndex < files.length) {
                  if (importCancelled || signal.aborted) break
                  // 检查暂停请求
                  if (shouldPause()) {
                    pauseDetected = true
                    break
                  }
                  const idx = preprocessIndex++
                  if (idx >= files.length) break
                  await preprocessOneFile(files[idx])
                }
              })()
            )
          }
          await Promise.all(workers)
        }

        await runConcurrentPreprocess()
        if (importCancelled) importController.abort(new Error('已取消导入'))
        signal.throwIfAborted()

        // 暂停处理：如果检测到暂停请求，发送暂停事件并返回
        if (pauseDetected && !importCancelled) {
          updateImportTask(publicDb, taskId, { status: 'paused', stage: 'preprocessing' })
          try {
            const currentStagePercent =
              totalFilesForProgress > 0 ? processedPreprocessCount / totalFilesForProgress : 0
            const globalPercent = Math.round(
              PARSING_WEIGHT + currentStagePercent * PREPROCESS_WEIGHT
            )
            event.sender.send('asset:folderImportPaused', {
              taskId,
              total: totalFilesForProgress,
              done: processedPreprocessCount,
              percent: globalPercent
            })
          } catch {}
          return { success: true, data: JSON.stringify({ paused: true }) }
        }

        // 🛡️ 释放预处理阶段的大型原始数据，减少内存压力
        for (const [, meta] of processedMetadata) {
          if (meta?.metadata?._rawData) {
            delete meta.metadata._rawData
          }
        }

        // 检查是否已取消
        if (importCancelled) {
          try {
            event.sender.send('asset:folderImportCancelled', {
              taskId,
              failedCount: failedFiles.length,
              failedFiles: failedFiles
            })
          } catch {}
          return { success: false, error: '用户取消导入', cancelled: true, failedFiles }
        }
        // 初始化资产备份管理器和预处理备份信息（仅在备份模式下）
        const backupManager = isBackupMode ? new AssetBackupManager() : null

        console.log(
          '💾 [ImportWithMetadata] 备份管理器初始化:',
          backupManager ? '成功' : '跳过（非备份模式）'
        )

        // 预处理需要备份的资产信息
        const backupAssets: BackupAssetInfo[] = []
        if ((isBackupMode && backupManager) || (isNetworkMode && networkPath)) {
          // 开始预处理备份资产信息

          for (const file of files) {
            // 🚫 分类功能已禁用 - 所有文件都保留用户拖入时的原始目录结构
            // 不再使用元数据中的 softPath，始终使用文件相对于导入根目录的原始路径
            const normalizedFilePath = file.path.replace(/\\/g, '/')
            const normalizedRootPath = rootFolderPath.replace(/\\/g, '/')

            // 🔧 修复：获取根文件夹名称，确保备份路径包含完整目录结构
            const rootFolderNameForBackup = normalizedRootPath.split('/').pop() || ''
            const rootParentPathForBackup = normalizedRootPath.substring(
              0,
              normalizedRootPath.lastIndexOf('/')
            )

            // 获取相对路径（基于根文件夹的父目录，保留根文件夹名称）
            let relativePath = normalizedFilePath
            if (
              rootParentPathForBackup &&
              normalizedFilePath.startsWith(rootParentPathForBackup + '/')
            ) {
              // 从父目录开始截取，保留根文件夹名称
              relativePath = normalizedFilePath.substring(rootParentPathForBackup.length)
              // 确保以 / 开头
              if (!relativePath.startsWith('/')) {
                relativePath = '/' + relativePath
              }
            } else if (normalizedFilePath.startsWith(normalizedRootPath + '/')) {
              // 回退逻辑：手动添加根文件夹名称
              relativePath =
                '/' +
                rootFolderNameForBackup +
                normalizedFilePath.substring(normalizedRootPath.length)
            } else if (normalizedFilePath.startsWith(normalizedRootPath)) {
              // 兼容文件直接在根目录下的情况
              const remaining = normalizedFilePath.substring(normalizedRootPath.length)
              relativePath =
                '/' +
                rootFolderNameForBackup +
                (remaining.startsWith('/') ? remaining : '/' + remaining)
            }

            // 使用元数据中的 softPath，或者回退到相对路径
            let softPath = stripPathLeafExtension(relativePath)

            // 尝试从 processedMetadata 获取 softPath
            // 注意：files 循环中的 file.path 必须与 processedMetadata 中的 key 匹配
            const meta = processedMetadata.get(file.path)
            if (meta?.metadata?.softPath && meta.metadata.softPath.startsWith('/Game/')) {
              softPath = meta.metadata.softPath
              // console.log(`🎯 [ImportWithMetadata] 使用元数据 softPath: ${softPath}`)
            }

            // 生成 assetKey
            const assetKey = generateSafeAssetKey(file.name)

            backupAssets.push({
              sourcePath: file.path,
              softPath,
              assetKey,
              // 传递依赖信息，以便后续递归解析
              imports: meta?.metadata?.imports,
              importsStrong: meta?.metadata?.importsStrong,
              name: file.name
            })

            // 添加备份资产日志已隐藏
          }

          // 🏷️ 递归依赖解析（如果用户导入的是单个或多个uasset文件）
          // 🛡️ 性能保护：网络资产库导入文件夹时跳过递归依赖解析
          // 乐观假设：导入文件夹时，相关依赖都已在文件夹中，无需递归查找
          {
            try {
              console.log(
                `🔄 [ImportWithMetadata] 开始解析依赖... 初始文件数: ${backupAssets.length}`
              )

              // 转换为 DependencyInfo 格式
              const initialAssets = backupAssets.map((ba) => ({
                assetKey: ba.assetKey,
                softPath: ba.softPath,
                realPath: ba.sourcePath,
                originPath: ba.sourcePath,
                imports: Array.isArray(ba.imports) ? ba.imports : [],
                importsStrong: Array.isArray(ba.importsStrong) ? ba.importsStrong : [],
                classKey: 'uasset', // 暂时假设
                name: ba.name || require('path').basename(ba.sourcePath)
              }))

              // 🔧 关键修复：AssetDependencyResolver 默认 onAssetFound = (() => {})（truthy），
              // 导致 useStreamMode = true，resolveDependencies() 返回空数组。
              // 解决方案：使用 onAssetFound 回调收集新发现的依赖。
              const initialSourcePaths = new Set(backupAssets.map((ba) => ba.sourcePath))
              // 🛡️ 使用 Set 做 O(1) 去重，替代原来的 backupAssets.some() O(n²) 线性扫描
              const addedSourcePaths = new Set(initialSourcePaths)
              const resolver = new AssetDependencyResolver({
                enableCache: true,
                maxIterations: 20,
                enableCircularDependencyDetection: true,
                isCancelled: () => signal.aborted,
                errorCallback: (error) => {
                  importIssueEntries.push({
                    stage: 'resolve_dependency',
                    severity: 'warning',
                    fileName: basename(error.affectedPaths[0] || rootFolderPath),
                    path: error.affectedPaths[0] || rootFolderPath,
                    error: error.message
                  })
                },
                onAssetFound: async (asset) => {
                  signal.throwIfAborted()
                  // 跳过已添加的资产（使用 Set O(1) 查找）
                  if (addedSourcePaths.has(asset.originPath)) return
                  addedSourcePaths.add(asset.originPath)

                  const assetKey = generateSafeAssetKey(basename(asset.originPath))
                  console.log(
                    `📦 [ImportWithMetadata] 发现依赖: ${asset.name} → ${asset.originPath}`
                  )

                  backupAssets.push({
                    sourcePath: asset.originPath,
                    softPath: asset.softPath,
                    assetKey,
                    imports: asset.imports,
                    importsStrong: asset.importsStrong,
                    name: asset.name
                  })
                }
              })

              await resolver.resolveDependencies(initialAssets)
              signal.throwIfAborted()
              const newDepCount = backupAssets.length - initialSourcePaths.size
              console.log(`✅ [ImportWithMetadata] 依赖解析完成: 发现 ${newDepCount} 个新依赖文件`)
            } catch (error) {
              signal.throwIfAborted()
              console.error('❌ [ImportWithMetadata] 依赖解析失败:', error)
              importIssueEntries.push({
                stage: 'resolve_dependency',
                severity: 'warning',
                fileName: basename(rootFolderPath),
                path: rootFolderPath,
                error: String(error)
              })
            }
          } // end of SKIP_DEP_THRESHOLD else

          // 备份资产总数日志已隐藏
        }

        // 初始化路径映射和资产键映射
        const backupPathMap = new Map<string, string>()
        const assetKeyMap = new Map<string, string>()
        const networkPathMap = new Map<string, string>()

        // 执行批量备份（仅在备份模式下）
        if (isBackupMode && backupManager && backupAssets.length > 0) {
          // 开始执行备份操作
          updateImportTask(publicDb, taskId, { status: 'preprocessing', stage: 'backing_up' })
          try {
            event.sender.send('asset:folderImportStage', {
              taskId,
              stage: 'backing_up'
            })
          } catch {}

          try {
            localBackup = new LocalBackupSession(vaultInfo.path)
            await localBackup.prepare(
              files.map((file) => file.path),
              backupAssets,
              db.prepare('SELECT filePath, originPath FROM assetData WHERE isDelete = 0').all(),
              signal,
              (current, total) => {
                sendWeightedProgress(
                  current,
                  total,
                  PARSING_WEIGHT + PREPROCESS_WEIGHT,
                  BACKUP_WEIGHT,
                  'backing_up'
                )
              }
            )
            for (const [key, path] of localBackup.paths) backupPathMap.set(key, path)
            copyFailures.push(...localBackup.failures)
            // 软引用找不到不拦截导入，但要留痕：用户得知道这批资产有弱引用没跟进来
            for (const missing of localBackup.softMisses) {
              importIssueEntries.push({
                stage: 'resolve_dependency',
                severity: 'warning',
                fileName: basename(missing),
                path: missing,
                error: `软引用的资产不在本次导入范围内：${missing}`
              })
            }
            // 建立源路径到资产键的映射
            backupAssets.forEach((asset) => {
              assetKeyMap.set(asset.sourcePath, asset.assetKey)
            })
            // 备份路径映射创建完成
          } catch (error) {
            console.error('❌ [ImportWithMetadata] 备份操作失败:', error)
            signal.throwIfAborted()
            for (const file of files) {
              copyFailures.push({
                stage: 'backup',
                fileName: file.name,
                path: file.path,
                error: String(error),
                retriable: true
              })
            }
          }
        } else if (isNetworkMode && networkPath) {
          signal.throwIfAborted()
          // 网络库模式：复制文件到网络路径
          console.log('🌐 [ImportWithMetadata] 网络库模式: 开始复制文件到网络路径')
          updateImportTask(publicDb, taskId, {
            status: 'preprocessing',
            stage: 'copying_to_network'
          })
          try {
            event.sender.send('asset:folderImportStage', {
              taskId,
              stage: 'copying_to_network'
            })
          } catch {}

          const fsPromises = require('fs').promises
          const nodePath = require('path')
          // 拷进局域网（SMB）库：这一段是真的 I/O 等待。**只有这一档会走到这里** ——
          // isNetworkMode 排除了 http（远端库走 runRemoteImport，上传自己有
          // UPLOAD_CONCURRENCY），本地库 needsCopyPhase 为假。
          //
          // 值随导入请求传进来（渲染层只在 SMB 那一档传，见 copyConcurrencyForMain）。
          // **不能再套 Math.max(…, 3)：** 那个下限会把刻意的 1 抬回 3，而「别拿多路并发
          // 去压一个特意限到 1 的 SMB 共享」正是删掉用户可调项时给的理由。没传值才回落到 3。
          const CONCURRENCY = Math.max(1, requestedRemoteImportConcurrency ?? 3)

          // 目标文件夹在网络库中的相对路径。
          // 动态递归构建，避免使用可能过时的 fullPath 字段。
          let targetFolderFullPath = ''
          if (targetFolderKey && targetFolderKey !== 'ALL') {
            const buildFolderPath = (fKey: string): string => {
              const folder = getAssetFolderByKey(db, fKey)
              if (!folder) return ''
              if (!folder.fatherKey || folder.fatherKey === 'ALL') {
                return folder.folderName
              }
              const parentPath = buildFolderPath(folder.fatherKey)
              return parentPath ? `${parentPath}/${folder.folderName}` : folder.folderName
            }

            const dynamicPath = buildFolderPath(targetFolderKey)
            if (dynamicPath) {
              targetFolderFullPath = dynamicPath.replace(/\//g, nodePath.sep)
              console.log(
                `🌐 [ImportWithMetadata] 目标文件夹路径(动态构建): ${targetFolderFullPath}`
              )
            }
          }

          /**
           * 覆盖确认弹窗必须**串行**。
           *
           * 旧代码在 CONCURRENCY≥3 的复制循环里直接 send，而渲染层
           * overwriteConfirmData 只有一个 ref —— 后到的弹窗会顶掉前一个，
           * 被顶掉的那次必然跑满超时然后被静默跳过。批量导入时这不是边角
           * 情况，是常态。
           */
          const overwritePromptQueue = getImportPromptQueue(event.sender)
          const OVERWRITE_PROMPT_TIMEOUT_MS = 120_000
          let overwriteBatchChoice: OverwriteDecision | undefined

          const requestOverwriteDecision = (
            file: NetworkCopyFile,
            targetPath: string
          ): Promise<OverwriteDecision> =>
            overwritePromptQueue.run(async () => {
              if (event.sender.isDestroyed() || signal.aborted) {
                // 窗口没了，没人能回答 —— 立刻按安全默认收敛，不必空等两分钟
                return { action: 'skip', reason: 'prompt_unavailable' } as OverwriteDecision
              }
              if (overwriteBatchChoice) return overwriteBatchChoice

              const confirmId = `overwrite_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
              return await new Promise<OverwriteDecision>((resolve) => {
                let timer: NodeJS.Timeout | null = null
                let settled = false
                const finish = (decision: OverwriteDecision): void => {
                  if (settled) return
                  settled = true
                  if (timer) {
                    clearTimeout(timer)
                    timer = null
                  }
                  signal.removeEventListener('abort', onCancel)
                  ipcMain.removeListener('asset:confirmOverwriteResponse', handler)
                  try {
                    event.sender.send('asset:overwriteSettled', { confirmId })
                  } catch {
                    /* Renderer may have closed while settling. */
                  }
                  resolve(decision)
                }
                const handler = (
                  _sender: unknown,
                  payload: { confirmId: string; confirmed: boolean; applyToAll?: boolean }
                ): void => {
                  if (payload?.confirmId !== confirmId) return
                  if (payload.applyToAll) {
                    overwriteBatchChoice = payload.confirmed
                      ? { action: 'overwrite', applyToAll: true }
                      : { action: 'skip', applyToAll: true, reason: 'user_skip_all' }
                  }
                  finish(
                    payload.confirmed
                      ? { action: 'overwrite', applyToAll: payload.applyToAll }
                      : {
                          action: 'skip',
                          applyToAll: payload.applyToAll,
                          reason: payload.applyToAll ? 'user_skip_all' : 'user_skip'
                        }
                  )
                }

                const onCancel = (): void =>
                  finish({ action: 'skip', reason: 'prompt_unavailable' })
                signal.addEventListener('abort', onCancel, { once: true })
                ipcMain.on('asset:confirmOverwriteResponse', handler)
                try {
                  event.sender.send('asset:confirmOverwrite', {
                    confirmId,
                    taskId,
                    fileName: file.name,
                    targetPath,
                    timeoutMs: OVERWRITE_PROMPT_TIMEOUT_MS
                  })
                } catch (sendErr) {
                  console.warn('[ImportWithMetadata] 发送覆盖确认失败:', sendErr)
                  finish({ action: 'skip', reason: 'prompt_unavailable' })
                  return
                }

                timer = setTimeout(() => {
                  console.warn(
                    `⚠️ [ImportWithMetadata] 覆盖确认超时（${OVERWRITE_PROMPT_TIMEOUT_MS}ms），` +
                      `按安全默认「跳过」处理，并计为未导入: ${targetPath}`
                  )
                  finish({ action: 'skip', reason: 'prompt_timeout' })
                }, OVERWRITE_PROMPT_TIMEOUT_MS)
              })
            })

          const copyReport = await runNetworkVaultCopy(
            {
              files: files as NetworkCopyFile[],
              networkPath,
              rootFolderPath,
              targetFolderFullPath,
              concurrency: CONCURRENCY,
              forceOverwrite,
              signal
            },
            createDefaultNetworkVaultCopyDeps({
              confirmOverwrite: requestOverwriteDecision,
              onProgress: (done, totalCopy) =>
                sendWeightedProgress(
                  done,
                  totalCopy,
                  PARSING_WEIGHT + PREPROCESS_WEIGHT,
                  BACKUP_WEIGHT,
                  'copying_to_network'
                )
            })
          )

          // ⚠️ 只有确实落盘的文件才建立映射。
          // 旧代码在 catch 里照样写 assetKeyMap，正是「失败也像成功」的源头。
          for (const file of files) {
            const targetPath = copyReport.networkPaths.get(file.path)
            if (!targetPath) continue
            networkPathMap.set(file.path, targetPath)
            assetKeyMap.set(file.path, generateSafeAssetKey(file.name))
          }

          signal.throwIfAborted()
          copyFailures.push(...copyReport.failures)
          copySkips.push(...copyReport.skips)

          // 失败进异常报告 JSON
          for (const failure of copyReport.failures) {
            importIssueEntries.push({
              stage: 'copy_to_network',
              fileName: failure.fileName,
              path: failure.path,
              error: `${failure.code ? `${failure.code}: ` : ''}${failure.error}`
            })
          }
          // 重试链路没问用户就覆盖掉的已有文件：覆盖是有意的，但不能不告诉人
          for (const overwritten of copyReport.forcedOverwrites) {
            importIssueEntries.push({
              stage: 'forced_overwrite',
              severity: 'warning',
              fileName: overwritten.fileName,
              path: overwritten.path,
              error: `重试导入直接覆盖了内容不同的已有文件：${overwritten.targetPath}`
            })
          }
          // 用户主动跳过不算异常；超时 / 窗口不可用算 —— 那是我们替用户做的决定
          for (const skip of copyReport.skips) {
            if (skip.reason === 'user_skip' || skip.reason === 'user_skip_all') continue
            importIssueEntries.push({
              stage: 'copy_to_network_skipped',
              fileName: skip.fileName,
              path: skip.path,
              error: `覆盖确认未完成（${skip.reason}），文件未导入`
            })
          }

          console.log(
            `🌐 [ImportWithMetadata] 网络库复制完成: 成功 ${copyReport.copied + copyReport.identical}/${copyReport.total}` +
              `（其中 ${copyReport.identical} 个内容相同自动跳过），失败 ${copyReport.failed}，跳过 ${copyReport.skipped}`
          )

          // 🔧 将依赖文件复制到 .dependency 目录
          const depFiles = backupAssets.filter((ba) => !files.some((f) => f.path === ba.sourcePath))
          if (depFiles.length > 0) {
            console.log(
              `🔗 [ImportWithMetadata] 开始复制 ${depFiles.length} 个依赖文件到 .dependency 目录`
            )
            let depCopied = 0
            let depCopyIndex = 0
            let depFailed = 0

            /**
             * 依赖文件复制失败以前只 console.warn 一句，既不进失败清单也不进异常报告：
             * 主资产全绿，而 .dependency 目录里缺文件，导出到 UE 工程时引用断裂，
             * 用户完全无从追查。缺依赖不该让整次导入判失败，但必须留痕。
             */
            const recordDepIssue = (
              depAsset: { name?: string; sourcePath?: string },
              error: string
            ): void => {
              depFailed++
              importIssueEntries.push({
                stage: 'copy_dependency',
                severity: 'warning',
                fileName: String(depAsset?.name || basename(String(depAsset?.sourcePath || ''))),
                path: String(depAsset?.sourcePath || ''),
                error
              })
            }

            // 🚀 并发复制依赖文件
            const copyOneDep = async (depAsset: any): Promise<void> => {
              try {
                if (!existsSync(depAsset.sourcePath)) {
                  console.warn(`⚠️ [ImportWithMetadata] 依赖文件不存在: ${depAsset.sourcePath}`)
                  recordDepIssue(depAsset, '依赖文件不存在（源文件已被移动或删除）')
                  return
                }
                // 使用 softPath 构建网络目标路径，存放到 .dependency 目录
                let depRelativePath = depAsset.name || basename(depAsset.sourcePath)
                if (depAsset.softPath && depAsset.softPath.startsWith('/')) {
                  // softPath 格式: /Game/Materials/M_2 → Materials/M_2.uasset
                  const cleanSoftPath = depAsset.softPath.replace(/^\/Game\/?/, '')
                  const ext = depAsset.sourcePath.split('.').pop() || 'uasset'
                  depRelativePath = cleanSoftPath + '.' + ext
                }
                // 🔧 关键：依赖文件存放到 .dependency 目录，不与主资产混在一起
                const depTargetPath = nodePath.join(networkPath!, '.dependency', depRelativePath)
                const dependencyCopy = await runNetworkVaultCopy(
                  {
                    files: [{ name: nodePath.basename(depTargetPath), path: depAsset.sourcePath }],
                    networkPath: nodePath.dirname(depTargetPath),
                    rootFolderPath: 'ALL',
                    targetFolderFullPath: '',
                    concurrency: 1,
                    forceOverwrite,
                    signal
                  },
                  createDefaultNetworkVaultCopyDeps({
                    confirmOverwrite: requestOverwriteDecision,
                    onProgress: () => undefined
                  })
                )
                if (!dependencyCopy.networkPaths.has(depAsset.sourcePath)) {
                  recordDepIssue(
                    depAsset,
                    dependencyCopy.failures[0]?.error || '依赖文件未保存，资产包不完整'
                  )
                  return
                }
                networkPathMap.set(depAsset.sourcePath, depTargetPath)
                const depAssetKey = generateSafeAssetKey(
                  depAsset.name || basename(depAsset.sourcePath)
                )
                assetKeyMap.set(depAsset.sourcePath, depAssetKey)
                depCopied++
                console.log(
                  `✅ [ImportWithMetadata] 依赖文件已复制: ${depAsset.name} → ${depTargetPath}`
                )
              } catch (depErr) {
                console.warn(`⚠️ [ImportWithMetadata] 复制依赖文件失败: ${depAsset.name}`, depErr)
                recordDepIssue(depAsset, depErr instanceof Error ? depErr.message : String(depErr))
              }
            }

            const depWorkers: Promise<void>[] = []
            for (let w = 0; w < CONCURRENCY; w++) {
              depWorkers.push(
                (async () => {
                  while (!signal.aborted && depCopyIndex < depFiles.length) {
                    const idx = depCopyIndex++
                    if (idx >= depFiles.length) break
                    await copyOneDep(depFiles[idx])
                  }
                })()
              )
            }
            await Promise.all(depWorkers)
            signal.throwIfAborted()

            console.log(
              `🔗 [ImportWithMetadata] 依赖文件复制完成: ${depCopied}/${depFiles.length}` +
                (depFailed > 0 ? `，失败 ${depFailed}（已记入异常报告）` : '')
            )
          }

          // 🚀 OOM修复：网络复制完成后，释放 backupAssets（不再被引用）
          // backupAssets 保存了 1284+ 项的 sourcePath/name/softPath 等
          backupAssets.length = 0

          // 确保网络缩略图目录存在
          // 注意：由于 PathManager.getThumbnailsPath() 对网络库已返回网络路径，
          // 预处理阶段的缩略图已经直接保存到 networkPath/.thumbnails/ 目录了，
          // 这里只需要确保目录存在即可，无需额外复制
          const networkThumbnailsDir = nodePath.join(networkPath, '.thumbnails')
          await fsPromises.mkdir(networkThumbnailsDir, { recursive: true })
          console.log(`🖼️ [ImportWithMetadata] 网络缩略图目录已确认: ${networkThumbnailsDir}`)

          // 注意：网络库清单（index.json）的更新已移至 folderInit 之后，
          // 在资产写入时同步更新，以确保使用正确的 folderKey
        } else {
          // 跳过备份操作日志已隐藏

          // 非备份模式下，为每个文件生成 assetKey
          files.forEach((file) => {
            // 非备份模式下的 assetKey 生成也需要覆盖所有文件类型
            const assetKey = generateSafeAssetKey(file.name)
            assetKeyMap.set(file.path, assetKey)
          })
        }

        updateImportTask(publicDb, taskId, { status: 'writing', stage: 'writing' })
        try {
          event.sender.send('asset:folderImportStage', { taskId, stage: 'writing' })
        } catch {}

        // ── 事务外：批量预取文件夹类型与图标 ──────────────────────────
        // detectFolderTypeWithIcon 是 stat + readdir（网络库上是网络 I/O），
        // 原本逐个 await 在下面的事务里，等于把整库写锁按文件夹数量占住。
        // 它只看磁盘路径、不读数据库，提到事务外后顺带把串行改成有界并发。
        const folderTypes = await prefetchFolderTypes(
          [
            rootFolderPath,
            ...sortedContents.filter((item) => item.type === 'folder').map((item) => item.path)
          ],
          isNetworkMode
        )

        const folderInit = await writerQueue.enqueue(() =>
          transaction(db, (db) => {
            const allFolderKey = ALL_FOLDER
            const folderBlueprints = new Map<
              string,
              {
                folderKey: string
                fatherKey: string | null
                type: string
                folderName: string
                img: string
              }
            >()
            const allFolder = getAssetFolderByKey(db, allFolderKey)
            if (!allFolder) {
              createAssetFolder(db, {
                folderKey: allFolderKey,
                fatherKey: null,
                type: 'system',
                folderName: 'ALL',
                img: ''
              })
            }
            folderBlueprints.set(allFolderKey, {
              folderKey: allFolderKey,
              fatherKey: null,
              type: allFolder?.type || 'system',
              folderName: allFolder?.folderName || 'ALL',
              img: allFolder?.img || ''
            })
            const isFileImportToAll = rootFolderPath === ALL_FOLDER
            if (targetFolderKey && targetFolderKey !== allFolderKey) {
              const targetExists = db
                .prepare('SELECT isDelete FROM assetFolder WHERE folderKey = ?')
                .get(targetFolderKey) as { isDelete: number } | undefined
              if (!targetExists) {
                if (targetFolderKey === 'generated-models') {
                  // 特殊处理AIGC模型文件夹
                  // 创建 AIGC 根文件夹
                  const aigcFolderKey = 'AIGC'
                  const aigcFolderExists = db
                    .prepare('SELECT isDelete FROM assetFolder WHERE folderKey = ?')
                    .get(aigcFolderKey) as { isDelete: number } | undefined
                  if (!aigcFolderExists) {
                    createAssetFolder(db, {
                      folderKey: aigcFolderKey,
                      folderName: 'AIGC',
                      fatherKey: null,
                      type: 'system',
                      img: ''
                    })
                    if (isRemoteServerMode) {
                      localRemoteImportCreatedFolderKeys.add(aigcFolderKey)
                    }
                  }
                  // 创建 模型 子文件夹
                  const modelFolderKey = 'AIGC_model'
                  const modelFolderExists = db
                    .prepare('SELECT isDelete FROM assetFolder WHERE folderKey = ?')
                    .get(modelFolderKey) as { isDelete: number } | undefined
                  if (!modelFolderExists) {
                    createAssetFolder(db, {
                      folderKey: modelFolderKey,
                      folderName: '模型',
                      fatherKey: aigcFolderKey,
                      type: 'folder',
                      img: ''
                    })
                    if (isRemoteServerMode) {
                      localRemoteImportCreatedFolderKeys.add(modelFolderKey)
                    }
                  }
                  // 使用模型文件夹作为目标
                  targetFolderKey = modelFolderKey
                } else {
                  targetFolderKey = allFolderKey
                }
              } else if (targetExists.isDelete === 1) {
                db.prepare('UPDATE assetFolder SET isDelete = 0 WHERE folderKey = ?').run(
                  targetFolderKey
                )
              }
              const targetFolder = getAssetFolderByKey(db, targetFolderKey)
              if (targetFolder) {
                folderBlueprints.set(targetFolderKey, {
                  folderKey: targetFolder.folderKey,
                  fatherKey: targetFolder.fatherKey || null,
                  type: targetFolder.type,
                  folderName: targetFolder.folderName,
                  img: targetFolder.img || ''
                })
              }
            }
            const folders = sortedContents.filter((item) => item.type === 'folder')
            const { rootFolderKey, pathToKeyMap, createdFolderKeys } = buildImportFolderTree(db, {
              rootFolderPath,
              rootParentKey: (targetFolderKey || allFolderKey) as string,
              isFileImportToAll,
              folders,
              folderTypes,
              folderBlueprints
            })

            if (isRemoteServerMode) {
              for (const folderKey of createdFolderKeys) {
                localRemoteImportCreatedFolderKeys.add(folderKey)
                // 从 DB 回读完整记录（含 pathArray/fullPath/depth/ancestorKeys）——
                // createAssetFolder 内部算了这些字段，但不会写回传进去的对象
                const created = getAssetFolderByKey(db, folderKey)
                if (created) {
                  remoteSyncFolders.push(created as unknown as Record<string, unknown>)
                }
              }
            }

            // 🔧 将创建的 rootFolderKey 发送回渲染进程，
            // 用作 import task → 真实文件夹 的稳定关联标识
            try {
              event.sender.send('asset:folderImportStage', {
                taskId,
                stage: 'writing',
                rootFolderKey
              })
            } catch {}

            return {
              rootFolderKey,
              pathToKeyMap,
              isFileImportToAll,
              foldersCount: folders.length,
              folderBlueprints
            }
          })
        )

        const normalizeImportPath = normalizeImportFolderPath
        const selectFolderRowAnyStmt = db.prepare(
          'SELECT folderKey, fatherKey, img, type, folderName, isDelete FROM assetFolder WHERE folderKey = ? LIMIT 1'
        )
        const reviveFolderStmt = db.prepare(`
          UPDATE assetFolder
          SET fatherKey = ?, img = ?, type = ?, folderName = ?, isDelete = 0, updated_at = datetime('now', 'localtime')
          WHERE folderKey = ?
        `)
        const folderBlueprints = folderInit.folderBlueprints
        const getFolderRowAny = (
          folderKey: string
        ):
          | {
              folderKey: string
              fatherKey: string | null
              img?: string
              type: string
              folderName: string
              isDelete: number
            }
          | undefined =>
          selectFolderRowAnyStmt.get(folderKey) as
            | {
                folderKey: string
                fatherKey: string | null
                img?: string
                type: string
                folderName: string
                isDelete: number
              }
            | undefined
        const ensureImportedFolderAvailable = (folderKey: string): boolean => {
          const existing = getFolderRowAny(folderKey)
          if (existing && existing.isDelete === 0) {
            return true
          }

          const blueprint = folderBlueprints.get(folderKey)
          if (!blueprint) {
            return !!existing
          }

          if (blueprint.fatherKey) {
            ensureImportedFolderAvailable(blueprint.fatherKey)
          }

          const current = getFolderRowAny(folderKey)
          if (current) {
            reviveFolderStmt.run(
              blueprint.fatherKey,
              blueprint.img,
              blueprint.type,
              blueprint.folderName,
              blueprint.folderKey
            )
          } else {
            createAssetFolder(db, {
              folderKey: blueprint.folderKey,
              fatherKey: blueprint.fatherKey,
              type: blueprint.type,
              folderName: blueprint.folderName,
              img: blueprint.img
            })
            if (isRemoteServerMode) {
              localRemoteImportCreatedFolderKeys.add(blueprint.folderKey)
            }
          }

          const ensured = getFolderRowAny(folderKey)
          const ok = !!ensured && ensured.isDelete === 0
          if (!ok) {
            console.warn(
              `[ImportWithMetadata] failed to repair missing folder row: folderKey=${folderKey}, folderName=${blueprint.folderName}`
            )
          }
          return ok
        }
        const ensureFolderForImportedFile = (
          currentFolderKey: string,
          filePath: string
        ): string => {
          if (ensureImportedFolderAvailable(currentFolderKey)) {
            return currentFolderKey
          }

          if (!folderInit.isFileImportToAll) {
            const normalizedFilePath = normalizeImportPath(filePath)
            const parentPath = normalizedFilePath.substring(0, normalizedFilePath.lastIndexOf('/'))
            const mappedFolderKey = folderInit.pathToKeyMap.get(parentPath)
            if (mappedFolderKey && ensureImportedFolderAvailable(mappedFolderKey)) {
              if (mappedFolderKey !== currentFolderKey) {
                console.warn(
                  `[ImportWithMetadata] repaired file folder mapping: file=${filePath}, from=${currentFolderKey}, to=${mappedFolderKey}`
                )
              }
              return mappedFolderKey
            }
          }

          if (ensureImportedFolderAvailable(folderInit.rootFolderKey)) {
            if (folderInit.rootFolderKey !== currentFolderKey) {
              console.warn(
                `[ImportWithMetadata] fallback to root folder for file write: file=${filePath}, from=${currentFolderKey}, root=${folderInit.rootFolderKey}`
              )
            }
            return folderInit.rootFolderKey
          }

          return currentFolderKey
        }

        const buildFolderRelativePath = (fKey?: string): string => {
          if (!fKey || fKey === ALL_FOLDER) return ''
          const folder = getAssetFolderByKey(db, fKey)
          if (!folder) return ''
          if (!folder.fatherKey || folder.fatherKey === ALL_FOLDER) {
            return folder.folderName
          }
          const parentPath = buildFolderRelativePath(folder.fatherKey)
          return parentPath ? `${parentPath}/${folder.folderName}` : folder.folderName
        }
        const remoteTargetFolderPath = buildFolderRelativePath(targetFolderKey)

        if (
          isRemoteServerMode &&
          folderInit.isFileImportToAll &&
          targetFolderKey &&
          targetFolderKey !== ALL_FOLDER
        ) {
          const targetFolder = getAssetFolderByKey(db, targetFolderKey)
          if (targetFolder) {
            remoteSyncFolders.push(targetFolder as unknown as Record<string, unknown>)
          }
        }

        // processedFiles / skippedFiles 是「虚幻资产 / 其它文件」的旧口径，
        // 保持不动以免影响既有调用方；权威的三个计数在最外层声明。
        const copyFailedPaths = new Set(copyFailures.map((entry) => entry.path))
        const copySkippedPaths = new Set(copySkips.map((entry) => entry.path))

        let processedFiles = 0

        let skippedFiles = 0

        const startCursor = getImportTaskByTaskId(publicDb, taskId)?.resumeCursor || 0
        for (let i = startCursor; i < files.length; i++) {
          signal.throwIfAborted()
          if (shouldPause()) {
            updateImportTask(publicDb, taskId, {
              status: 'paused',
              stage: 'writing',
              resumeCursor: i,
              doneItems: handledFilesForProgress,
              percent: Math.round(
                PARSING_WEIGHT +
                  PREPROCESS_WEIGHT +
                  BACKUP_WEIGHT +
                  (handledFilesForProgress / Math.max(1, totalFilesForProgress)) * WRITING_WEIGHT
              )
            })

            try {
              const currentStagePercent =
                totalFilesForProgress > 0 ? handledFilesForProgress / totalFilesForProgress : 0
              const globalPercent = Math.round(
                PARSING_WEIGHT +
                  PREPROCESS_WEIGHT +
                  BACKUP_WEIGHT +
                  currentStagePercent * WRITING_WEIGHT
              )

              event.sender.send('asset:folderImportPaused', {
                taskId,
                total: totalFilesForProgress,
                done: handledFilesForProgress,
                percent: globalPercent
              })
            } catch {}
            return { success: true, data: JSON.stringify({ paused: true }) }
          }
          const file = files[i]

          // 网络库模式：文件没落到网络路径 —— **绝不能算「已处理」**。
          // 原来这里无条件 processedFiles++，于是「没进网络库、没进数据库」
          // 被计成成功，界面照常报「导入完成」。
          if (isNetworkMode && networkPath && !networkPathMap.has(file.path)) {
            if (copyFailedPaths.has(file.path)) {
              failedFileCount++
              console.warn(
                `❌ [ImportWithMetadata] 复制失败，跳过入库并计为失败: ${file.name} (${file.path})`
              )
            } else {
              skippedFileCount++
              if (!copySkippedPaths.has(file.path)) {
                // 既不在成功里、也不在失败/跳过清单里 —— 兜底留痕，
                // 别再让任何一个文件悄悄消失
                copySkips.push({ reason: 'user_skip', fileName: file.name, path: file.path })
              }
              console.log(`⏭️ [ImportWithMetadata] 跳过未复制文件的数据库写入: ${file.name}`)
            }
            handledFilesForProgress++
            continue
          }

          let folderKey: string
          if (folderInit.isFileImportToAll) {
            folderKey = folderInit.rootFolderKey
          } else {
            const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/')
            const normalizedFilePath = normalizePath(file.path)
            const parentPath = normalizedFilePath.substring(0, normalizedFilePath.lastIndexOf('/'))
            folderKey = folderInit.pathToKeyMap.get(parentPath) || folderInit.rootFolderKey
          }
          const remoteImportFilePath = isRemoteServerMode
            ? buildRemoteImportFilePath(file, rootFolderPath, remoteTargetFolderPath)
            : undefined
          const existingRemoteAsset = remoteImportFilePath
            ? findActiveRemoteAssetByPath(db, remoteImportFilePath)
            : undefined
          const assetKey =
            existingRemoteAsset?.assetKey ||
            assetKeyMap.get(file.path) ||
            `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          assetKeyMap.set(file.path, assetKey)
          const fileExtension = file.name.split('.').pop()?.toLowerCase() || ''
          // 移除后缀
          const nameWithoutExt = getAssetNameFromFileName(file.name)
          const isUnrealAsset = ['uasset', 'umap', 'ubulk', 'uexp'].includes(fileExtension)
          const backupPath = backupPathMap.get(assetKey)
          if (isBackupMode && !backupPath) {
            failedFileCount++
            handledFilesForProgress++
            if (!copyFailures.some((failure) => failure.path === file.path)) {
              copyFailures.push({
                stage: 'backup',
                fileName: file.name,
                path: file.path,
                error: '文件或依赖备份未完成，资产未入库',
                retriable: true
              })
            }
            continue
          }
          const finalFilePath =
            remoteImportFilePath || (isBackupMode ? backupPath || file.path : file.path)

          // 🔍 计算文件快速哈希并检查是否已存在相同文件
          // 🚀 性能优化：网络库模式跳过 MD5 去重（文件已复制到网络路径，无需去重）
          let fileMd5: string | undefined = undefined
          let verifiedLocalAssets: AssetData[] = []
          if (!isNetworkMode) {
            try {
              const sourceFilePath = file.path
              const normalizedSourcePath = sourceFilePath ? join(sourceFilePath) : sourceFilePath
              const pathsToTry = [normalizedSourcePath, sourceFilePath]
              let actualFilePath: string | null = null

              for (const pathToTry of pathsToTry) {
                if (pathToTry && existsSync(pathToTry)) {
                  actualFilePath = pathToTry
                  break
                }
              }

              if (actualFilePath) {
                fileMd5 = await calculateFastFileHash(actualFilePath)
                if (!isRemoteServerMode) {
                  verifiedLocalAssets = await findIdenticalLocalAssets(
                    db,
                    actualFilePath,
                    fileMd5,
                    vaultInfo.path
                  )
                }
              }
            } catch (hashError) {
              console.error(`❌ [ImportWithMetadata] 计算文件哈希失败 ${file.path}:`, hashError)
            }
          }

          // ── 事务外：先把慢 I/O 做完 ──────────────────────────────────
          // 缩略图压缩（sharp）和 .uplugin 读取原本内联在下面的写库事务里，
          // 一张 4K 贴图就能把整库写锁占住几百毫秒。它们只依赖 file / assetKey /
          // fileExtension，不读任何数据库状态，所以提到事务外是行为等价的。
          // Image filtering and thumbnail caching are shared by both import entry points.
          const thumbnailFileName = await buildImportThumbnail(file.path, assetKey, fileExtension)
          const pluginIconFileName =
            isBackupMode && fileExtension === 'uplugin'
              ? await copyPluginIconThumbnail(file.path, assetKey)
              : undefined
          const upluginInfo =
            fileExtension === 'uplugin'
              ? await readUpluginInfo(file.path, nameWithoutExt)
              : undefined

          try {
            const writeOutcome = await writerQueue.enqueue(() =>
              transaction(db, (db) => {
                folderKey = ensureFolderForImportedFile(folderKey, file.path)
                const ensuredFolder = getFolderRowAny(folderKey)
                if (!ensuredFolder) {
                  throw new Error(
                    `Folder mapping missing after repair: folderKey=${folderKey}, path=${file.path}`
                  )
                }

                // 三条写库分支统一走同一个去重入口，见 importDedup.ts 的注释。
                // folderKey 在上面刚被 ensureFolderForImportedFile 修正过，用修正后的值
                const findExistingRow = (targetOriginPath?: string): AssetData | undefined => {
                  const existing = findExistingAssetRow(db, {
                    existingRemoteAsset,
                    isNetworkMode,
                    originPath: isNetworkMode ? targetOriginPath : file.path,
                    fileMd5,
                    folderKey,
                    verifiedLocalAssets
                  })
                  if (
                    isRemoteServerMode &&
                    existing &&
                    !localRemoteImportCreatedAssetKeys.has(existing.assetKey) &&
                    !previousRemoteAssets.has(existing.assetKey)
                  ) {
                    previousRemoteAssets.set(
                      existing.assetKey,
                      db
                        .prepare('SELECT * FROM assetData WHERE assetKey = ?')
                        .get(existing.assetKey)
                    )
                  }
                  return existing
                }

                if (isUnrealAsset && (fileExtension === 'uasset' || fileExtension === 'umap')) {
                  const fileMetadata = processedMetadata.get(file.path)
                  if (fileMetadata) {
                    // 网络库模式使用复制后的网络路径
                    const targetOriginPath =
                      networkPathMap.get(file.path) || fileMetadata.metadata?.originPath

                    const existingByPath = findExistingRow(targetOriginPath)

                    const data = {
                      assetKey: existingByPath?.assetKey || assetKey, // 使用已有的 assetKey
                      folderKey,
                      assetName: nameWithoutExt,
                      filePath: finalFilePath,
                      fileSize: file.size || 0,
                      fileExtension,
                      modifiedTime: file.modifiedTime,
                      processorType: fileMetadata.processorType,
                      assetType: fileMetadata.assetType,
                      engineVersion: fileMetadata.engineVersion,
                      classKey: fileMetadata.metadata?.classKey,
                      name: fileMetadata.metadata?.name,
                      originPath: targetOriginPath,
                      ext: fileMetadata.metadata?.ext,
                      folderName: fileMetadata.metadata?.folderName,
                      softPath: fileMetadata.metadata?.softPath,
                      assetClass: fileMetadata.metadata?.assetClass,
                      className: fileMetadata.metadata?.className,
                      classNameCn: getAssetClassNameCn(
                        fileMetadata.metadata?.className ||
                          (fileExtension === 'umap' ? 'World' : undefined)
                      ),
                      classColor: getAssetClassColor(
                        fileMetadata.metadata?.className ||
                          (fileExtension === 'umap' ? 'World' : undefined)
                      ),
                      imports: fileMetadata.metadata?.imports
                        ? JSON.stringify(fileMetadata.metadata.imports)
                        : undefined,
                      imgLocalPath: fileMetadata.metadata?.imgLocalPath,
                      size: fileMetadata.metadata?.size,
                      assetConfig: fileMetadata.metadata?.assetConfig,
                      assetConfigPath: fileMetadata.metadata?.assetConfigPath,
                      fileMd5: fileMd5 // 添加MD5值
                    }
                    console.log(
                      `🔍 [ImportWithMetadata] DB写入: assetKey=${data.assetKey}, assetName=${data.assetName}, imgLocalPath=${data.imgLocalPath || '(空)'}`
                    )

                    // 如果已存在则更新，否则创建
                    if (existingByPath) {
                      updateAssetData(db, existingByPath.assetKey, data)
                    } else {
                      createAssetData(db, data)
                      if (isRemoteServerMode) {
                        localRemoteImportCreatedAssetKeys.add(String(data.assetKey))
                      }
                    }
                    queueRemoteSyncAsset(data as unknown as Record<string, unknown>)
                    processedFiles++
                  } else {
                    // 如果文件在失败列表中，直接跳过
                    if (failedFilePaths.has(file.path)) {
                      skippedFiles++
                      return 'skipped' as const
                    }

                    // 解析失败的 uasset 以前连 originPath 都不写，重导时既查不出旧行、
                    // 也没法被将来的去重认出来
                    const targetOriginPath = networkPathMap.get(file.path) || file.path
                    const existingByPath = findExistingRow(targetOriginPath)
                    const effectiveKey = existingByPath?.assetKey || assetKey

                    const data = {
                      assetKey: effectiveKey,
                      folderKey,
                      assetName: nameWithoutExt,
                      filePath: finalFilePath,
                      originPath: targetOriginPath,
                      fileSize: file.size || 0,
                      fileExtension,
                      modifiedTime: file.modifiedTime,
                      processorType: 'UnrealAsset',
                      assetType: 'UnrealAsset',
                      engineVersion: undefined,
                      classNameCn: getAssetClassNameCn(
                        fileExtension === 'umap' ? 'World' : undefined
                      ),
                      classColor: getAssetClassColor(
                        fileExtension === 'umap' ? 'World' : undefined
                      ),
                      fileMd5: fileMd5 // 添加MD5值
                    }
                    if (existingByPath) {
                      updateAssetData(db, existingByPath.assetKey, data)
                    } else {
                      createAssetData(db, data)
                      if (isRemoteServerMode) {
                        localRemoteImportCreatedAssetKeys.add(effectiveKey)
                      }
                    }
                    const createdAsset = getAssetDataByKey(db, effectiveKey)
                    if (createdAsset) {
                      queueRemoteSyncAsset(createdAsset as unknown as Record<string, unknown>)
                    }
                    skippedFiles++
                  }
                } else {
                  // 🔧 修复：非虚幻资产也需要设置 originPath，使用网络路径（如果是网络模式）
                  const targetOriginPath = networkPathMap.get(file.path) || file.path
                  const existingByPath = findExistingRow(targetOriginPath)
                  const effectiveKey = existingByPath?.assetKey || assetKey
                  const data: any = {
                    assetKey: effectiveKey,
                    folderKey,
                    assetName: nameWithoutExt,
                    filePath: finalFilePath,
                    originPath: targetOriginPath, // 添加缺失的 originPath 字段
                    fileSize: file.size || 0,
                    fileExtension,
                    modifiedTime: file.modifiedTime,
                    processorType: isUnrealAsset ? 'UnrealAsset' : 'FileSystem',
                    assetType: isUnrealAsset ? 'UnrealAsset' : 'File',
                    engineVersion: undefined,
                    classNameCn: isUnrealAsset
                      ? getAssetClassNameCn('Asset')
                      : ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tga', 'dds'].includes(
                            fileExtension
                          )
                        ? '纹理2D'
                        : '资产',
                    classColor: isUnrealAsset
                      ? getAssetClassColor('Asset')
                      : ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tga', 'dds'].includes(
                            fileExtension
                          )
                        ? '#c04040'
                        : '#888888',
                    fileMd5: fileMd5 // 添加MD5值
                  }
                  // 缩略图 / 插件图标 / 插件元数据都在事务外算好了，这里只落库
                  if (thumbnailFileName || pluginIconFileName) {
                    data.imgLocalPath = thumbnailFileName || pluginIconFileName
                  }
                  if (upluginInfo) {
                    // 更新资产类型和显示信息
                    data.assetType = 'Plugin'
                    data.processorType = 'UnrealAsset'
                    data.classNameCn = '插件'
                    data.classColor = '#8B5CF6' // 紫色
                    data.engineVersion = upluginInfo.engineVersion
                    data.pluginInfo = upluginInfo.pluginInfo
                  }
                  if (existingByPath) {
                    updateAssetData(db, existingByPath.assetKey, data)
                  } else {
                    createAssetData(db, data)
                    if (isRemoteServerMode) {
                      localRemoteImportCreatedAssetKeys.add(effectiveKey)
                    }
                  }
                  const createdAsset = getAssetDataByKey(db, effectiveKey)
                  queueRemoteSyncAsset((createdAsset || data) as unknown as Record<string, unknown>)
                  if (isUnrealAsset) processedFiles++
                  else skippedFiles++
                }
                return 'written' as const
              })
            )
            if (writeOutcome === 'written') {
              localBackup?.retain(file.path)
              succeededFileCount++
            } else {
              // 解析失败且被忽略 —— 这条路没写任何资产行，不能算成功
              skippedFileCount++
              copySkips.push({
                reason: 'preprocess_ignored',
                fileName: file.name,
                path: file.path
              })
            }
          } catch (writeErr) {
            const message = writeErr instanceof Error ? writeErr.message : String(writeErr)
            console.error(`[ImportWithMetadata] local DB write failed: ${file.path}`, writeErr)
            importIssueEntries.push({
              stage: 'local_db_write',
              fileName: file.name,
              path: file.path,
              error: message
            })
            writeFailures.push({
              stage: 'local_db_write',
              fileName: file.name,
              path: file.path,
              error: message,
              retriable: true
            })
            failedFileCount++
            skippedFiles++ // 旧口径，保持兼容
          }
          handledFilesForProgress++

          processedMetadata.delete(file.path)

          sendWeightedProgress(
            handledFilesForProgress,
            totalFilesForProgress,
            PARSING_WEIGHT + PREPROCESS_WEIGHT + BACKUP_WEIGHT,
            WRITING_WEIGHT,
            'writing'
          )

          // 🚀 性能优化：resumeCursor 写入节流，每 50 个文件更新一次
          if (handledFilesForProgress % 50 === 0 || i === files.length - 1) {
            updateImportTask(publicDb, taskId, {
              resumeCursor: i + 1
            })
          }

          // 🛡️ OOM修复: 每 500 文件触发 GC
          if (handledFilesForProgress % 500 === 0 && handledFilesForProgress > 0) {
            await new Promise((r) => setImmediate(r))
            ;(global as any).gc?.()
          } else {
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        }

        // 注意：依赖文件不创建 DB 记录（避免 UI 显示混乱和扫描冲突）
        // 依赖文件仅存储在 .dependency/ 目录，导出到 UE 时由 projectImport.ts 直接从该目录查找

        // V2: 资产已直接写入 SQLite，ChangeTracker 自动跟踪变更
        // 无需再同步到 V1 manifest/journal

        // ─── 远程同步状态跟踪变量（hoisted for remoteSyncStatus 判定） ───
        let remoteSyncFailed = false
        let remoteSyncPartial = false
        let remoteSyncError = ''
        let remoteSyncFailureDetails: any = null
        let thumbUploadFailCount = 0
        let fileUploadFailCountOuter = 0
        let finalResultExtra: { importMode?: string; sessionId?: string } = {}

        // ─── 远程服务器模式：推送创建的文件夹、资产和缩略图到服务器 ───
        if (isRemoteServerMode && currentVault) {
          // From here the normal remote settlement owns rollback, including cancellation.
          cancelRemoteLocalWrites = undefined
          console.log(
            `🌐 [ImportWithMetadata] 远程服务器模式: 开始推送 ${remoteSyncFolders.length} 个文件夹 + ${remoteSyncAssets.length} 个资产到服务器`
          )

          // 收集所有已创建的资产记录
          // 从本地 DB 读取刚写入的资产，确保数据完整
          try {
            for (let i = 0; i < files.length; i++) {
              const file = files[i]
              const fileAssetKey = assetKeyMap.get(file.path)
              if (!fileAssetKey) continue
              const record = getAssetDataByKey(db, fileAssetKey)
              if (record) {
                // 缩略图也在这里面一并收：引用得上就进上传清单，引用不上就把引用摘掉
                queueRemoteSyncAsset(record as unknown as Record<string, unknown>)
              }
            }
          } catch (collectErr) {
            console.warn('[ImportWithMetadata] 收集远程同步数据失败:', collectErr)
          }

          // ─── 本地找不到的缩略图引用：先问服务器，两边都没有才算悬空 ───
          //
          // 只凭本地 existsSync 就把字段抹掉是会出人命的：换台机器打开同一个网络库，
          // 本机 thumbnails/ 目录一张都没有，整批资产会被以「无缩略图」整条 upsert
          // 上去，把所有人的封面一起洗掉。服务器上有，就说明引用是好的，别动。
          if (unresolvedThumbnailRefs.length > 0) {
            const { remoteFileExists } = await import('./assetData/thumbnails')
            const checked = new Map<string, boolean>()
            const dropped: typeof unresolvedThumbnailRefs = []

            for (const ref of unresolvedThumbnailRefs) {
              let onServer = checked.get(ref.fileName)
              if (onServer === undefined) {
                onServer = await remoteFileExists(`.thumbnails/${ref.fileName}`).catch(() => false)
                checked.set(ref.fileName, onServer)
              }
              if (onServer) continue
              dropThumbnailRef(ref.record, ref.field)
              dropped.push(ref)
            }

            if (dropped.length > 0) {
              // 本地那行也要一起清掉，否则下一次改个标签、重命名、挪位置，
              // NetworkSyncBridge.pushAssetUpdate 会整行重读再推一遍，把刚摘掉的
              // 悬空引用又送回服务器 —— 这次修的东西当场失效。
              //
              // 注意这只做了 thumbnails.ts 里 repairAssetRow 的最后一招（抹字段）。
              // 它的前两招是「从源文件重新生成」和「重新导入取图」，那两招放在一次
              // 两万条的导入里跑不动，留给那条修复流程。
              try {
                await writerQueue.enqueue(() =>
                  transaction(db, (writeDb) => {
                    for (const ref of dropped) {
                      if (!ref.assetKey) continue
                      updateAssetData(writeDb, ref.assetKey, { [ref.field]: '' })
                    }
                  })
                )
              } catch (clearErr) {
                console.warn('[ImportWithMetadata] 清理本地悬空缩略图引用失败:', clearErr)
              }

              // 说出来。以前这件事是全程静默的 —— 清单里少了多少张，界面上照样显示
              // 「缺失缩略图 0 个」，因为那个 0 数的是清单自己，不是元数据引用的那批。
              console.warn(
                `⚠️ [ImportWithMetadata] ${dropped.length} 张缩略图本地和服务器上都没有，` +
                  `已从上传的元数据里摘掉引用（这些资产在服务器上将没有缩略图）`
              )
              for (const ref of dropped) {
                importIssueEntries.push({
                  stage: 'thumbnail_missing',
                  severity: 'warning',
                  fileName: ref.assetName,
                  path: pm.getThumbnailFilePath(ref.fileName),
                  error: '缩略图文件本地和服务器上都不存在，该资产以「无缩略图」上传'
                })
              }
            }
          }

          // ─── V2 Import Session / V1 Batch 统一入口 ───
          try {
            const { runRemoteImport } = await import('../../services/asset/RemoteImportService')

            // 从 networkPath 解析 serverUrl 和 remoteVaultId
            // 格式: http://host:port/remoteVaultId
            const np = networkPath!
            const lastSlash = np.lastIndexOf('/')
            const serverUrl = np.substring(0, lastSlash)
            const remoteVaultId = np.substring(lastSlash + 1)
            diagnosticServerUrl = serverUrl
            diagnosticRemoteVaultId = remoteVaultId
            const clientId = `${require('os').hostname()}-${require('os').userInfo().username}`
            const importTraceLabel =
              `root=${rootFolderPath} ` +
              `rootKey=${folderInit.rootFolderKey} ` +
              `target=${remoteTargetFolderPath || 'ALL'} ` +
              `folders=${remoteSyncFolders.length} assets=${remoteSyncAssets.length} ` +
              `files=${files.length} thumbs=${remoteSyncThumbnails.length}`

            // 发送上传阶段事件
            updateImportTask(publicDb, taskId, { status: 'uploading', stage: 'uploading' })
            try {
              event.sender.send('asset:folderImportStage', {
                taskId,
                stage: 'uploading',
                mode: 'detecting'
              })
            } catch {
              /* IPC send may fail if window closed */
            }

            console.log(
              `[ImportWithMetadata] remote import start: vault=${remoteVaultId}, ${importTraceLabel}`
            )
            const importStartedAt = Date.now()
            const importResult = await runWithRemoteImportPermit(
              remoteVaultId,
              importTraceLabel,
              requestedRemoteImportConcurrency,
              () =>
                runRemoteImport({
                  serverUrl,
                  vaultId: remoteVaultId,
                  clientId,
                  folders: remoteSyncFolders,
                  assets: remoteSyncAssets,
                  thumbnails: remoteSyncThumbnails,
                  files,
                  rootFolderPath,
                  targetFolderPath: remoteTargetFolderPath,
                  targetFolderKey: remoteImportTargetFolderKey,
                  apiKey: remoteServerApiKey,
                  signal,
                  onStage: (stage, progress, total, meta) => {
                    sendWeightedProgress(
                      progress,
                      total,
                      PARSING_WEIGHT + PREPROCESS_WEIGHT + BACKUP_WEIGHT + WRITING_WEIGHT,
                      UPLOADING_WEIGHT,
                      stage
                    )
                    try {
                      event.sender.send('asset:folderImportStage', {
                        taskId,
                        mode: meta?.mode || 'v2-session',
                        stage,
                        sessionId: meta?.sessionId,
                        stageProgress: progress,
                        stageTotal: total
                      })
                    } catch {
                      /* IPC send may fail */
                    }
                  }
                })
            )

            console.log(
              `[ImportWithMetadata] 远程导入完成: mode=${importResult.mode}, status=${importResult.status}`
            )

            // 映射到外层状态变量
            remoteSyncFailed =
              importResult.status === 'failed' || importResult.status === 'fallback_v1_failed'
            console.log(
              `[ImportWithMetadata] remote import done: vault=${remoteVaultId}, ${importTraceLabel}, ` +
                `mode=${importResult.mode}, status=${importResult.status}, sessionId=${importResult.sessionId || '-'}, ` +
                `filesUploaded=${importResult.filesUploaded}, filesFailed=${importResult.filesFailed}, ` +
                `filesSkippedLarge=${importResult.filesSkippedLarge}, thumbsUploaded=${importResult.thumbsUploaded}, ` +
                `thumbsFailed=${importResult.thumbsFailed}, durationMs=${Date.now() - importStartedAt}`
            )
            remoteSyncFailed =
              importResult.status === 'failed' || importResult.status === 'fallback_v1_failed'
            remoteSyncPartial =
              importResult.status === 'partial' || importResult.status === 'fallback_v1_partial'
            remoteSyncError = importResult.error || ''
            remoteSyncFailureDetails =
              importResult.errorCode ||
              importResult.committedAssets !== undefined ||
              importResult.expectedAssets !== undefined ||
              importResult.committedFolders !== undefined ||
              importResult.expectedFolders !== undefined ||
              importResult.committedFiles !== undefined ||
              importResult.expectedFiles !== undefined ||
              importResult.committedThumbnails !== undefined ||
              importResult.expectedThumbnails !== undefined ||
              importResult.reconcile ||
              importResult.commitAttempted
                ? {
                    errorCode: importResult.errorCode || undefined,
                    commitAttempted: importResult.commitAttempted || undefined,
                    committedAssets: importResult.committedAssets,
                    expectedAssets: importResult.expectedAssets,
                    committedFolders: importResult.committedFolders,
                    expectedFolders: importResult.expectedFolders,
                    committedFiles: importResult.committedFiles,
                    uploadedFiles: importResult.filesUploaded,
                    expectedFiles: importResult.expectedFiles,
                    committedThumbnails: importResult.committedThumbnails,
                    uploadedThumbnails: importResult.thumbsUploaded,
                    expectedThumbnails: importResult.expectedThumbnails,
                    reconcile: importResult.reconcile || undefined
                  }
                : null
            thumbUploadFailCount = importResult.thumbsFailed
            fileUploadFailCountOuter = importResult.filesFailed
            if (Array.isArray(importResult.issueEntries) && importResult.issueEntries.length > 0) {
              importIssueEntries.push(...importResult.issueEntries)
            }

            // 保存 sessionId 和 mode 供 folderImportCompleted 事件使用
            ;(finalResultExtra as any) = {
              importMode: importResult.mode,
              sessionId: importResult.sessionId
            }
            diagnosticSessionId = importResult.sessionId
            if (importResult.mode === 'v2-session' && importResult.sessionId && currentVault?.id) {
              try {
                recoveryContextPath = await saveImportRecoveryContext(
                  buildImportRecoveryContext({
                    taskId,
                    localVaultId: currentVault.id,
                    serverUrl,
                    remoteVaultId,
                    sessionId: importResult.sessionId,
                    rootFolderPath,
                    targetFolderKey: remoteImportTargetFolderKey,
                    targetFolderPath: remoteTargetFolderPath,
                    files,
                    thumbnails: remoteSyncThumbnails
                  })
                )
              } catch (recoveryErr) {
                console.warn('[ImportWithMetadata] failed to save recovery context:', recoveryErr)
              }
            }
          } catch (remoteImportErr) {
            remoteSyncFailed = true
            remoteSyncError =
              remoteImportErr instanceof Error ? remoteImportErr.message : String(remoteImportErr)
            console.error(
              `[ImportWithMetadata] remote import failed: vault=${currentVault.id}, ` +
                `root=${rootFolderPath}, rootKey=${folderInit.rootFolderKey}, target=${remoteTargetFolderPath || 'ALL'}`,
              remoteImportErr
            )
            console.error(
              '[ImportWithMetadata] ❌ 远程导入流程失败（本地导入正常完成）:',
              remoteImportErr
            )
          }
        }

        const importOutcome: ImportOutcomeSummary = {
          total: totalFilesForProgress,
          succeeded: succeededFileCount,
          failed: failedFileCount,
          skipped: skippedFileCount,
          handled: handledFilesForProgress
        }
        const importFailures: ImportFailureEntry[] = [
          ...copyFailures,
          ...writeFailures,
          ...(importOptions?.scanIssues || []).map((issue) => ({
            stage: 'scan' as const,
            fileName: basename(issue.path),
            path: issue.path,
            error: issue.reason,
            retriable: true
          }))
        ]

        const finalResult = {
          rootFolderKey: folderInit.rootFolderKey,
          foldersCreated: folderInit.isFileImportToAll ? 0 : folderInit.foldersCount + 1,
          filesCreated: files.length,
          processedFiles,
          skippedFiles,
          pathMappings: folderInit.pathToKeyMap.size,
          failedCount: failedFiles.length,
          failedFiles: failedFiles,
          outcome: importOutcome,
          failures: importFailures,
          skips: copySkips,
          rootFolderPath,
          vaultId: vaultInfo.id,
          targetFolderKey: targetFolderKey || null,
          retryOfTaskId: retryOfTaskId || null,
          localRollback: undefined as RemoteImportLocalRollbackResult | undefined
        }

        // ─── remoteSyncStatus 判定（单一真相源）───
        let remoteSyncStatus: 'committed' | 'failed' | 'partial' | 'skipped' = 'skipped'
        if (isRemoteServerMode && currentVault) {
          if (remoteSyncFailed) {
            remoteSyncStatus = 'failed'
          } else if (
            remoteSyncPartial ||
            fileUploadFailCountOuter > 0 ||
            thumbUploadFailCount > 0
          ) {
            remoteSyncStatus = 'partial'
          } else {
            remoteSyncStatus = 'committed'
          }
        }
        const remoteCommittedChanges = hasCommittedRemoteChanges(
          remoteSyncStatus,
          remoteSyncFailureDetails
        )
        const remoteCommitOutcomeUnknown =
          remoteSyncStatus === 'failed' &&
          Boolean(remoteSyncFailureDetails?.commitAttempted) &&
          !remoteCommittedChanges

        if (isRemoteServerMode && remoteSyncStatus !== 'committed') {
          importOutcome.unconfirmed = importOutcome.succeeded
          importOutcome.succeeded = 0
        }

        if (
          isRemoteServerMode &&
          currentVault &&
          shouldRollbackRemoteImportLocalRows({
            remoteSyncStatus,
            remoteCommittedChanges,
            createdAssetCount: localRemoteImportCreatedAssetKeys.size + previousRemoteAssets.size,
            createdFolderCount: localRemoteImportCreatedFolderKeys.size
          })
        ) {
          try {
            const rollbackResult = await writerQueue.enqueue(() =>
              transaction(db, (rollbackDb) =>
                rollbackRemoteImportLocalRows(rollbackDb, {
                  assetKeys: localRemoteImportCreatedAssetKeys,
                  folderKeys: localRemoteImportCreatedFolderKeys,
                  previousAssets: previousRemoteAssets.values()
                })
              )
            )
            finalResult.localRollback = rollbackResult
            console.warn(
              `[ImportWithMetadata] rolled back optimistic local rows after remote failure: ` +
                `assets=${rollbackResult.deletedAssets}, folders=${rollbackResult.deletedFolders}, ` +
                `vault=${currentVault.id}`
            )
          } catch (rollbackErr) {
            console.error(
              '[ImportWithMetadata] failed to roll back optimistic local rows:',
              rollbackErr
            )
            importIssueEntries.push({
              stage: 'local_remote_failure_rollback',
              fileName: '',
              path: rootFolderPath,
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
            })
          }
        }

        let importIssueReportPath: string | undefined
        let importIssueCount = 0
        try {
          const report = await buildImportIssueReport(
            remoteSyncStatus,
            remoteSyncError,
            remoteSyncFailureDetails
          )
          importIssueReportPath = report.reportPath
          importIssueCount = report.issueCount
        } catch (reportErr) {
          console.error('[ImportWithMetadata] failed to write import issue report:', reportErr)
        }

        if (remoteSyncStatus === 'failed' || remoteSyncStatus === 'partial') {
          void (async () => {
            const diagnosticId = await captureImportDiagnostic({
              vaultId: vaultId || diagnosticVaultId,
              taskId,
              rootFolderPath,
              targetFolderKey: targetFolderKey || null,
              remoteSyncStatus,
              remoteSyncError,
              remoteSyncFailureDetails: remoteSyncFailureDetails || null,
              reportPath: importIssueReportPath,
              serverUrl: diagnosticServerUrl,
              remoteVaultId: diagnosticRemoteVaultId,
              sessionId: diagnosticSessionId || finalResultExtra?.sessionId
            })
            if (diagnosticId && recoveryContextPath) {
              linkImportRecoveryDiagnostic(taskId, diagnosticId)
            }
            try {
              event.sender.send('asset:folderImportNeedsRecovery', {
                taskId,
                diagnosticId: diagnosticId || undefined,
                sessionId: diagnosticSessionId || finalResultExtra?.sessionId || undefined,
                errorCode: remoteSyncFailureDetails?.errorCode || undefined,
                remoteSyncStatus,
                remoteSyncError: remoteSyncError || undefined,
                remoteSyncFailureDetails: remoteSyncFailureDetails || undefined,
                expectedFiles: remoteSyncFailureDetails?.expectedFiles,
                uploadedFiles:
                  remoteSyncFailureDetails?.uploadedFiles ??
                  remoteSyncFailureDetails?.committedFiles,
                expectedThumbnails: remoteSyncFailureDetails?.expectedThumbnails,
                uploadedThumbnails:
                  remoteSyncFailureDetails?.uploadedThumbnails ??
                  remoteSyncFailureDetails?.committedThumbnails,
                localRollback: finalResult.localRollback,
                canResume: Boolean(
                  recoveryContextPath && (diagnosticSessionId || finalResultExtra?.sessionId)
                ),
                errorReportPath: importIssueReportPath,
                mode: finalResultExtra?.importMode || undefined
              })
            } catch {}
          })().catch((diagnosticErr) => {
            console.warn('[ImportWithMetadata] diagnostic capture failed:', diagnosticErr)
          })
        }

        // 持久化任务状态（区分远端结果）
        const persistStatus =
          remoteSyncStatus === 'failed'
            ? 'completed_remote_failed'
            : remoteSyncStatus === 'partial'
              ? 'completed_remote_partial'
              : 'completed'
        const persistStage =
          remoteSyncStatus === 'failed'
            ? 'remote_failed'
            : remoteSyncStatus === 'partial'
              ? 'remote_partial'
              : 'completed'
        updateImportTask(publicDb, taskId, {
          status: persistStatus,
          stage: persistStage,
          percent: 100,
          doneItems: Math.min(totalFilesForProgress, handledFilesForProgress),
          totalItems: totalFilesForProgress,
          errorMessage:
            remoteSyncStatus === 'failed' || remoteSyncStatus === 'partial'
              ? importIssueReportPath || remoteSyncError || null
              : null,
          completed_at: new Date().toISOString()
        })

        if (isRemoteServerMode && currentVault?.id) {
          if (remoteCommittedChanges || remoteCommitOutcomeUnknown) {
            markRemotePullNeeded(currentVault.id)
          } else {
            console.log(
              `[ImportWithMetadata] skip remote pull: vault=${currentVault.id}, ` +
                `remoteSyncStatus=${remoteSyncStatus}, no committed remote changes detected`
            )
          }
        }

        try {
          if (progressInterval) {
            clearInterval(progressInterval)
            progressInterval = null
          }
          event.sender.send('asset:folderImportCompleted', {
            taskId,
            total: totalFilesForProgress,
            done: handledFilesForProgress,
            percent: Math.round(
              (handledFilesForProgress / Math.max(1, totalFilesForProgress)) * 100
            ),
            failedCount: failedFiles.length,
            failedFiles: failedFiles,
            // ── 新契约：界面据此决定要不要弹结果框、显示多少成功 ──
            outcome: importOutcome,
            failures: importFailures,
            skips: copySkips,
            rootFolderPath,
            vaultId: vaultInfo.id,
            isCancelled: signal.aborted,
            targetFolderKey: targetFolderKey || null,
            remoteSyncStatus,
            remoteSyncError: remoteSyncError || undefined,
            remoteSyncFailureDetails: remoteSyncFailureDetails || undefined,
            errorReportPath: importIssueReportPath,
            issueCount: importIssueCount,
            mode: finalResultExtra?.importMode || undefined,
            sessionId: finalResultExtra?.sessionId || undefined,
            localRollback: finalResult.localRollback,
            needsRecovery: remoteSyncStatus === 'failed' || remoteSyncStatus === 'partial',
            canResume: Boolean(
              recoveryContextPath && (diagnosticSessionId || finalResultExtra?.sessionId)
            ),
            recoveryContextPath
          })
        } catch {}

        return { success: true, data: JSON.stringify(finalResult) }
      } catch (error) {
        if (importController?.signal.aborted) {
          await cancelRemoteLocalWrites?.()
          const saved = remoteMode ? 0 : succeededFileCount
          if (publicDb)
            updateImportTask(publicDb, taskId, {
              status: 'cancelled',
              stage: 'cancelled',
              doneItems: saved,
              completed_at: new Date().toISOString()
            })
          const failures: ImportFailureEntry[] = folderContents
            .filter((item) => item.type === 'file')
            .map((item) => ({
              stage: 'local_db_write',
              fileName: item.name,
              path: item.path,
              error: '导入已取消，可重新检查并补齐',
              retriable: true
            }))
          event.sender.send('asset:folderImportCompleted', {
            taskId,
            vaultId: importOptions?.vaultId || diagnosticVaultId,
            total: failures.length,
            done: saved,
            rootFolderPath,
            targetFolderKey,
            isCancelled: true,
            failures,
            outcome: {
              total: failures.length,
              succeeded: saved,
              failed: 0,
              skipped: 0,
              handled: saved
            }
          })
          return { success: true, data: JSON.stringify({ cancelled: true }) }
        }
        console.error('导入文件夹结构并处理元数据失败:', error)
        let importIssueReportPath: string | undefined
        try {
          const report = await buildImportIssueReport(
            'failed',
            error instanceof Error ? error.message : String(error)
          )
          importIssueReportPath = report.reportPath
        } catch (reportErr) {
          console.error(
            '[ImportWithMetadata] failed to write fatal import issue report:',
            reportErr
          )
        }
        if (importIssueReportPath) {
          void (async () => {
            const diagnosticId = await captureImportDiagnostic({
              vaultId: diagnosticVaultId,
              taskId,
              rootFolderPath,
              targetFolderKey: targetFolderKey || null,
              remoteSyncStatus: 'failed',
              remoteSyncError: error instanceof Error ? error.message : String(error),
              reportPath: importIssueReportPath,
              serverUrl: diagnosticServerUrl,
              remoteVaultId: diagnosticRemoteVaultId,
              sessionId: diagnosticSessionId,
              stage: 'fatal_import'
            })
            if (diagnosticId && recoveryContextPath) {
              linkImportRecoveryDiagnostic(taskId, diagnosticId)
            }
            try {
              event.sender.send('asset:folderImportNeedsRecovery', {
                taskId,
                diagnosticId: diagnosticId || undefined,
                sessionId: diagnosticSessionId,
                remoteSyncStatus: 'failed',
                remoteSyncError: error instanceof Error ? error.message : String(error),
                canResume: Boolean(recoveryContextPath && diagnosticSessionId),
                errorReportPath: importIssueReportPath,
                mode: 'v2-session'
              })
            } catch {}
          })().catch((diagnosticErr) => {
            console.warn('[ImportWithMetadata] fatal diagnostic capture failed:', diagnosticErr)
          })
        }
        try {
          if (publicDb) {
            updateImportTask(publicDb, taskId, {
              status: 'failed',
              stage: 'failed',
              errorMessage:
                importIssueReportPath || (error instanceof Error ? error.message : String(error)),
              completed_at: new Date().toISOString()
            })
          }
        } catch {}
        try {
          if (progressInterval) {
            clearInterval(progressInterval)
            progressInterval = null
          }
        } catch {}
        try {
          event.sender.send('asset:folderImportError', {
            taskId,
            message: error instanceof Error ? error.message : String(error),
            vaultId: importOptions?.vaultId || diagnosticVaultId,
            rootFolderPath,
            targetFolderKey,
            errorReportPath: importIssueReportPath
          })
        } catch (e) {
          console.warn('发送文件夹导入错误事件失败:', e)
        }
        return { success: false, error: (error as Error).message }
      } finally {
        try {
          await localBackup?.cleanup()
        } catch (error) {
          console.error('[ImportWithMetadata] 未采用的备份文件清理失败:', error)
          try {
            event.sender.send('asset:folderImportError', {
              taskId,
              vaultId: diagnosticVaultId,
              rootFolderPath,
              targetFolderKey,
              message: `未采用的备份文件清理失败：${String(error)}`
            })
          } catch {
            /* Window may be closed. */
          }
        }
        if (progressInterval) clearInterval(progressInterval)
        if (remoteImportSessionVaultId) {
          try {
            await finishRemoteImportSession(remoteImportSessionVaultId)
          } catch (pullErr) {
            console.error('[ImportWithMetadata] 并发导入收尾时回拉本地 SQLite 失败:', pullErr)
          }
        }
        // 成功、取消、暂停、抛异常 —— 每条路都走到这里
        try {
          importDb?.close?.()
        } catch (closeErr) {
          console.warn('[ImportWithMetadata] 关闭导入数据库连接失败:', closeErr)
        }
        importDb = null
        if (importController) finishAssetImport(taskId, importController)
      }
    }
  )
}
