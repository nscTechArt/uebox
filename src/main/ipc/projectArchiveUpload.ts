/**
 * 工程整包的 IPC 入口：上传（asset:uploadProjectArchive）与取回（asset:pullProjectArchive）。
 *
 * 只服务 HTTP 资产服务器库：把一个工程目录（或现成压缩包）作为一个文件送上去，
 * 同事再把它整包下回来、自动解开。
 * 进度复用文件夹导入那套事件（asset:folderImportStage / Progress / Completed / Error），
 * 界面上就是同一张任务卡，不另起一套 UI。
 */
import { ipcMain } from 'electron'
import os from 'os'
import { vaultAccessKeyHeadersFromUrl } from '../networkV2/vaultAccessKeys'
import {
  buildVaultFileUrl,
  pullProjectArchive,
  type ProjectArchivePullResult
} from '../services/asset/projectArchivePull'
import { getDatabaseManager, getPublicDatabase, getVaultDatabase } from '../sqliteDataBase'
import { getAssetFolderByKey } from '../sqliteDataBase/models/assetFolder'
import { createImportTask, updateImportTask } from '../sqliteDataBase/models/importTask'
import { VaultServiceManager } from '../networkV2/VaultServiceManager'
import { buildNetworkFolderRelPath } from '../sqliteDataBase/services/networkFolderPath'
import { ALL_FOLDER } from '../init/constants'
import {
  uploadProjectArchive,
  type ProjectArchiveUploadResult
} from '../services/asset/projectArchiveUpload'

const REMOTE_PULL_TIMEOUT_MS = 30_000

type VaultDb = ReturnType<typeof getVaultDatabase>

/**
 * 库内相对路径。走 buildNetworkFolderRelPath，不要自己再递归一遍 ——
 * 那个函数专门修过两件事：父文件夹软删时不能把路径截短（getAssetFolderByKey 带
 * `isDelete = 0`，一截就把包传到浅一层的同名目录去），以及 fatherKey 成环时不能栈溢出。
 *
 * 算不出来时返回 null，调用方必须当成错误而不是「根目录」—— 传到错地方比传不上去糟糕。
 */
function buildFolderRelativePath(db: VaultDb, folderKey?: string | null): string | null {
  if (!folderKey || folderKey === ALL_FOLDER) return ''
  return buildNetworkFolderRelPath(db, folderKey)
}

function parseRemoteTarget(networkPath: string): { serverUrl: string; remoteVaultId: string } {
  const lastSlash = networkPath.lastIndexOf('/')
  return {
    serverUrl: networkPath.substring(0, lastSlash),
    remoteVaultId: networkPath.substring(lastSlash + 1)
  }
}

/**
 * 任务记录只是留痕，写不动不能反过来把正事判成失败：
 * 几个 G 传完了却因为库被锁了半秒而报错，是最冤的那种失败。
 *
 * `quiet` 给进度用 —— 它一次传输要写上百次，库真坏了会把日志刷爆。
 */
function safeTaskWrite(label: string, write: () => void, quiet = false): void {
  try {
    write()
  } catch (err) {
    if (!quiet) console.warn(`[ProjectArchive] ${label}失败（不影响本次结果）:`, err)
  }
}

async function pullRemoteChanges(localVaultId: string): Promise<void> {
  const client = VaultServiceManager.getInstance().getClient(localVaultId)
  if (!client) return
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Remote pull timed out after ${REMOTE_PULL_TIMEOUT_MS}ms`)),
      REMOTE_PULL_TIMEOUT_MS
    )
  })
  try {
    await Promise.race([client.pullChanges(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

ipcMain.handle(
  'asset:uploadProjectArchive',
  async (
    event,
    sourcePath: string,
    targetFolderKey?: string | null,
    providedTaskId?: string
  ): Promise<{ success: boolean; data?: ProjectArchiveUploadResult; error?: string }> => {
    const taskId =
      typeof providedTaskId === 'string' && providedTaskId.trim()
        ? providedTaskId.trim()
        : `archive:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const send = (channel: string, payload: Record<string, unknown>): void => {
      try {
        event.sender.send(channel, { taskId, ...payload })
      } catch {
        /* 窗口已关，进度没人看了 */
      }
    }

    let publicDb: ReturnType<typeof getPublicDatabase> | null = null
    try {
      const currentVault = getDatabaseManager().getCurrentVault()
      const networkPath = currentVault?.networkPath
      if (!currentVault || !networkPath || !networkPath.startsWith('http')) {
        throw new Error('整包上传只支持 HTTP 资产服务器库，请先切换到服务器资产库')
      }
      const { serverUrl, remoteVaultId } = parseRemoteTarget(networkPath)
      const manager = getDatabaseManager()
      const apiKey = manager.getVaultManager().getNetworkVaultApiKey(currentVault.id)
      const db = getVaultDatabase()
      const folderKey =
        targetFolderKey && targetFolderKey !== ALL_FOLDER ? targetFolderKey : ALL_FOLDER
      const targetFolderRecord =
        folderKey !== ALL_FOLDER ? getAssetFolderByKey(db, folderKey) : null
      // 两处查folder用的是不同口径：getAssetFolderByKey 带 isDelete = 0，算路径的那个不带。
      // 目标文件夹被软删时前者拿不到记录、后者照样算得出路径 —— 那样传上去的资产
      // 会挂在一个服务端不存在的 folderKey 下，变成谁都看不见的孤儿。宁可不传。
      if (folderKey !== ALL_FOLDER && !targetFolderRecord) {
        throw new Error(`目标文件夹已不在库里（可能被删了）：${folderKey}，已中止上传`)
      }
      const targetFolderPath = buildFolderRelativePath(db, folderKey)
      if (targetFolderPath === null) {
        throw new Error(
          `算不出目标文件夹在库里的路径（父文件夹链断了、成环，或某一级名字里带分隔符）：` +
            `${folderKey}，已中止上传`
        )
      }
      const clientId = `${os.hostname()}-${os.userInfo().username}`

      publicDb = getPublicDatabase()
      safeTaskWrite('建任务记录', () =>
        createImportTask(publicDb!, {
          taskId,
          vaultId: currentVault.id,
          rootPath: sourcePath,
          targetFolderKey: folderKey,
          status: 'uploading',
          stage: 'pack_upload',
          percent: 0,
          totalItems: 1,
          doneItems: 0,
          pauseRequested: 0,
          resumeCursor: 0
        })
      )

      let lastPersistedPercent = -1
      const result = await uploadProjectArchive({
        serverUrl,
        vaultId: remoteVaultId,
        clientId,
        apiKey,
        sourcePath,
        targetFolderKey: folderKey,
        targetFolderPath,
        targetFolderRecord: (targetFolderRecord as unknown as Record<string, unknown>) || null,
        onStage: (stage, progress, total, meta) => {
          const isByteStage = stage === 'pack_upload'
          send('asset:folderImportStage', {
            stage,
            mode: 'v2-session',
            sessionId: meta?.sessionId,
            // 字节阶段按 MB 报，界面只会拼成 (已传/总量)
            stageProgress: isByteStage ? Math.floor(progress / 1e6) : progress,
            stageTotal: isByteStage ? Math.max(1, Math.ceil(total / 1e6)) : total
          })
        },
        onBytes: (sent, total) => {
          const percent = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0
          send('asset:folderImportProgress', { percent, total: 1, done: 0 })
          if (publicDb && percent !== lastPersistedPercent) {
            lastPersistedPercent = percent
            safeTaskWrite('记进度', () => updateImportTask(publicDb!, taskId, { percent }), true)
          }
        }
      })

      if (result.status !== 'committed') {
        safeTaskWrite('标记任务失败', () =>
          updateImportTask(publicDb!, taskId, {
            status: 'failed',
            percent: 0,
            errorMessage: result.error || result.errorCode || 'archive upload failed'
          })
        )
        send('asset:folderImportError', {
          message: result.error || result.errorCode || '整包上传失败'
        })
        return { success: false, error: result.error || result.errorCode, data: result }
      }

      // 活儿已经干完了，任务记录写不动不能反过来把它判成失败
      safeTaskWrite('任务记录收尾', () =>
        updateImportTask(publicDb!, taskId, {
          status: 'completed',
          stage: 'completed',
          percent: 100,
          doneItems: 1
        })
      )

      // 服务端已提交，把新记录拉回本地镜像库，界面刷新时才看得到那张卡
      try {
        await pullRemoteChanges(currentVault.id)
      } catch (pullErr) {
        console.warn('[ProjectArchiveUpload] 提交后回拉远端变更失败:', pullErr)
      }

      // 不回传 mode：渲染层看到 mode 会再弹一条通用的「导入完成」，而整包上传自己
      // 已经弹了一条带文件数和速率的，两条会叠在一起。failed/partial 分支只看
      // remoteSyncStatus，所以留着它不影响出错时的提示。
      send('asset:folderImportCompleted', {
        total: 1,
        done: 1,
        failedCount: 0,
        remoteSyncStatus: 'committed',
        sessionId: result.sessionId,
        rootFolderPath: sourcePath,
        targetFolderKey: folderKey
      })
      return { success: true, data: result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[ProjectArchiveUpload] failed:', error)
      if (publicDb) {
        safeTaskWrite('标记任务失败', () =>
          updateImportTask(publicDb!, taskId, { status: 'failed', errorMessage: message })
        )
      }
      send('asset:folderImportError', { message })
      return { success: false, error: message }
    }
  }
)

// ─── 取回：把服务器上的整包下到本地并解开 ────────────────────────

export interface PullProjectArchiveParams {
  /** 资产记录里的 filePath，即服务器库内相对路径 */
  remotePath: string
  /** 落地文件名，一般就是 remotePath 的最后一段 */
  fileName: string
  /** 用户选的目标目录；zip 解开后工程目录出现在它下面 */
  destDir: string
  taskId?: string
}

ipcMain.handle(
  'asset:pullProjectArchive',
  async (
    event,
    params: PullProjectArchiveParams
  ): Promise<{ success: boolean; data?: ProjectArchivePullResult; error?: string }> => {
    const taskId =
      typeof params?.taskId === 'string' && params.taskId.trim()
        ? params.taskId.trim()
        : `archive-pull:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const send = (channel: string, payload: Record<string, unknown>): void => {
      try {
        event.sender.send(channel, { taskId, ...payload })
      } catch {
        /* 窗口已关 */
      }
    }

    let publicDb: ReturnType<typeof getPublicDatabase> | null = null
    try {
      const currentVault = getDatabaseManager().getCurrentVault()
      const networkPath = currentVault?.networkPath
      if (!currentVault || !networkPath || !networkPath.startsWith('http')) {
        throw new Error('只有 HTTP 资产服务器库才需要取回；本地库直接打开文件即可')
      }
      const { serverUrl, remoteVaultId } = parseRemoteTarget(networkPath)
      const apiKey = getDatabaseManager().getVaultManager().getNetworkVaultApiKey(currentVault.id)
      const fileUrl = buildVaultFileUrl(serverUrl, remoteVaultId, String(params?.remotePath || ''))
      const headers: Record<string, string> = {
        ...vaultAccessKeyHeadersFromUrl(fileUrl),
        ...(apiKey ? { 'X-API-Key': apiKey } : {})
      }

      // 取回和上传一样是长活儿，一样要留痕：崩在半路时得有人知道它跑过
      publicDb = getPublicDatabase()
      safeTaskWrite('建任务记录', () =>
        createImportTask(publicDb!, {
          taskId,
          vaultId: currentVault.id,
          rootPath: String(params?.destDir || ''),
          targetFolderKey: null,
          status: 'downloading',
          stage: 'download',
          percent: 0,
          totalItems: 1,
          doneItems: 0,
          pauseRequested: 0,
          resumeCursor: 0
        })
      )

      let lastPersistedPercent = -1
      const result = await pullProjectArchive({
        fileUrl,
        headers,
        fileName: String(params?.fileName || params?.remotePath || ''),
        destDir: String(params?.destDir || ''),
        onStage: (stage, progress, total) =>
          send('asset:folderImportStage', { stage, stageProgress: progress, stageTotal: total }),
        onPercent: (percent) => {
          send('asset:folderImportProgress', { percent, total: 1, done: 0 })
          if (publicDb && percent !== lastPersistedPercent) {
            lastPersistedPercent = percent
            safeTaskWrite('记进度', () => updateImportTask(publicDb!, taskId, { percent }), true)
          }
        }
      })

      safeTaskWrite('任务记录收尾', () =>
        updateImportTask(publicDb!, taskId, {
          status: 'completed',
          stage: 'completed',
          percent: 100,
          doneItems: 1
        })
      )
      send('asset:folderImportCompleted', { total: 1, done: 1, failedCount: 0 })
      return { success: true, data: result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[ProjectArchivePull] failed:', error)
      if (publicDb) {
        safeTaskWrite('标记任务失败', () =>
          updateImportTask(publicDb!, taskId, { status: 'failed', errorMessage: message })
        )
      }
      send('asset:folderImportError', { message })
      return { success: false, error: message }
    }
  }
)
