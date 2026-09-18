import {
  createEmptyImportOutcome,
  filterRetriableFailures,
  type ImportFailureEntry,
  type ImportOutcomeSummary,
  type ImportSkipEntry
} from '@core/shared/assetImport'

/**
 * 导入完成事件 → 结果弹窗视图。
 *
 * 这段逻辑原来内联在 index.vue 的 handleFolderImportCompleted 里，抽出来才测得到 ——
 * 而它正是「把失败算成成功」的那一段。
 */

export interface FolderImportCompletedPayload {
  taskId: string
  vaultId?: string
  total: number
  done: number
  failedCount?: number
  failedFiles?: Array<{ fileName: string; path: string; error: string }>
  issueCount?: number
  errorReportPath?: string
  outcome?: ImportOutcomeSummary
  failures?: ImportFailureEntry[]
  skips?: ImportSkipEntry[]
  rootFolderPath?: string
  targetFolderKey?: string | null
  remoteSyncStatus?: 'committed' | 'failed' | 'partial' | 'skipped'
  /** 用户中途取消。取消事件里的 failedCount 就是真实失败数，不是「读取失败」 */
  isCancelled?: boolean
}

export interface ImportRetryContext {
  taskId: string
  vaultId?: string
  rootFolderPath: string
  targetFolderKey: string | null
}

export interface ImportResultView {
  unconfirmedCount: number
  scanIssueCount: number
  /** 是否需要弹结果框 */
  open: boolean
  isCancelled: boolean
  severity: 'success' | 'warning' | 'error'
  total: number
  successCount: number
  failedCount: number
  skippedCount: number
  /** 预处理读取失败（旧口径，弹窗里单列） */
  readFailedCount: number
  failedFiles: Array<{ fileName: string; path: string; error: string }>
  failures: ImportFailureEntry[]
  skips: ImportSkipEntry[]
  issueCount: number
  errorReportPath?: string
  /** 有可重试失败且知道来源时才给「重试」按钮 */
  retryContext?: ImportRetryContext
  retriableCount: number
}

/**
 * 硬约束：successCount **只能**来自主进程的 outcome.succeeded。
 *
 * 旧实现算的是 `done - failedCount`，而 done 把「复制失败被跳过」的文件也数了
 * 进去、failedCount 又只统计预处理失败 —— 于是 3 个文件掉了 1 个，界面照样
 * 显示「成功：3」，而且因为 failedCount === 0 连结果弹窗都不弹。
 */
export const buildImportResultView = (payload: FolderImportCompletedPayload): ImportResultView => {
  const outcome = payload.outcome ?? {
    ...createEmptyImportOutcome(payload.total || 0),
    succeeded: Math.max(0, (payload.done || 0) - (payload.failedCount || 0)),
    handled: payload.done || 0
  }
  const skips = payload.skips ?? []
  const failures: ImportFailureEntry[] = [...(payload.failures ?? [])]
  for (const skip of skips) {
    if (
      (skip.reason === 'prompt_timeout' || skip.reason === 'prompt_unavailable') &&
      !failures.some((failure) => failure.path === skip.path)
    ) {
      failures.push({
        stage: 'copy_to_network',
        fileName: skip.fileName,
        path: skip.path,
        targetPath: skip.targetPath,
        error: skip.reason,
        retriable: true
      })
    }
  }
  const retriable = filterRetriableFailures(failures)
  const isCancelled = Boolean(payload.isCancelled)
  // 取消时 failedCount 数的是真的失败掉的文件，不是预处理读取失败。
  // 混进 readFailedCount 的话，弹窗上那个数字会显示成 0 —— 明明掉了 5 个文件。
  const readFailedCount = isCancelled ? 0 : payload.failedCount || 0
  const cancelledFailedCount = isCancelled ? payload.failedCount || 0 : 0

  const retryContext: ImportRetryContext | undefined =
    retriable.length > 0 && payload.rootFolderPath
      ? {
          taskId: payload.taskId,
          vaultId: payload.vaultId,
          rootFolderPath: payload.rootFolderPath,
          targetFolderKey: payload.targetFolderKey ?? null
        }
      : undefined

  const failedCount = outcome.failed + cancelledFailedCount
  const remoteUnconfirmed =
    payload.remoteSyncStatus === 'failed' || payload.remoteSyncStatus === 'partial'
  const unconfirmedCount = outcome.unconfirmed ?? (remoteUnconfirmed ? outcome.succeeded : 0)
  const scanIssueCount = failures.filter((failure) => failure.stage === 'scan').length

  const severity: ImportResultView['severity'] =
    failedCount > 0 || remoteUnconfirmed
      ? 'error'
      : isCancelled ||
          (payload.issueCount || 0) > 0 ||
          scanIssueCount > 0 ||
          outcome.skipped > 0 ||
          readFailedCount > 0
        ? 'warning'
        : 'success'

  return {
    unconfirmedCount,
    scanIssueCount,
    open:
      (payload.issueCount || 0) > 0 ||
      isCancelled ||
      scanIssueCount > 0 ||
      remoteUnconfirmed ||
      failedCount > 0 ||
      outcome.skipped > 0 ||
      readFailedCount > 0 ||
      Boolean(payload.errorReportPath),
    isCancelled,
    severity,
    total: outcome.total,
    successCount: remoteUnconfirmed ? 0 : outcome.succeeded,
    failedCount,
    skippedCount: outcome.skipped,
    readFailedCount,
    failedFiles: payload.failedFiles ?? [],
    failures,
    skips,
    issueCount: payload.issueCount || 0,
    errorReportPath: payload.errorReportPath,
    retryContext,
    retriableCount: retriable.length
  }
}
