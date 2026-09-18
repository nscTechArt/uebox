/**
 * 资产导入的结果契约（主进程与渲染进程共用）。
 *
 * 唯一目的：任何一次导入结束后，都必须能回答「这些文件到底进没进库」。
 *
 * 在这份契约出现之前，SMB 网络库导入时复制失败的文件会被计进 processedFiles，
 * 界面照常报「导入完成」—— 2000 个文件的素材包中途网络抖一下丢 37 个，用户
 * 一个月后清理源文件才会真正失去它们，而那时已经无从追溯。
 */

/** 文件没进库时，是在哪一步掉的 */
export type ImportFailureStage =
  | 'scan'
  | 'backup'
  | 'copy_to_network' // SMB：复制到网络保管库失败
  | 'local_db_write' // 写本地 SQLite 失败

/** 文件被跳过的原因。跳过 ≠ 成功，必须单独报出来 */
export type ImportSkipReason =
  | 'user_skip' // 用户在覆盖确认里点了「跳过」
  | 'user_skip_all' // 用户点了「全部跳过」
  | 'prompt_timeout' // 覆盖确认超时未响应，按安全默认跳过
  | 'prompt_unavailable' // 窗口已关闭，无法弹窗，按安全默认跳过
  | 'preprocess_ignored' // 解析失败且用户选择忽略，最终没有写入资产行

export interface ImportFailureEntry {
  stage: ImportFailureStage
  fileName: string
  path: string
  /** 网络库模式下的目标路径，便于用户自己去核对 */
  targetPath?: string
  error: string
  /** 系统错误码：ETIMEDOUT / EBUSY / ENOSPC / ENOENT … */
  code?: string
  /** 实际尝试轮数（每一轮内部还有 copyFileWithRetry 的退避阶梯） */
  attempts?: number
  /** 是否值得重试：网络抖动/文件占用 = true；磁盘满/源文件消失 = false */
  retriable: boolean
}

export interface ImportSkipEntry {
  reason: ImportSkipReason
  fileName: string
  path: string
  targetPath?: string
}

export interface ImportOutcomeSummary {
  unconfirmed?: number
  /** 本次导入的文件总数 */
  total: number
  /** 真正写进资产库的文件数 */
  succeeded: number
  /** 没进库、且是「出错」导致的 */
  failed: number
  /** 没进库、且是「有意跳过」导致的 */
  skipped: number
  /** 本次实际处理的条目数（断点续传时可能 < total） */
  handled: number
}

/** 导入入口的可选行为开关 */
export interface FolderImportOptions {
  vaultId?: string
  scanIssues?: Array<{ path: string; reason: string }>

  /** 本次导入是针对哪个任务的失败重试 */
  retryOfTaskId?: string
  /** 目标已存在且内容不同时直接覆盖，不再弹窗（重试链路默认 true） */
  forceOverwrite?: boolean
}

export const createEmptyImportOutcome = (total = 0): ImportOutcomeSummary => ({
  total,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  handled: 0
})

/** 只有可重试的失败才值得给用户「重试」按钮 */
export const filterRetriableFailures = (
  failures: readonly ImportFailureEntry[]
): ImportFailureEntry[] => failures.filter((failure) => failure.retriable)
