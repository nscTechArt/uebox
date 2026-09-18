/**
 * 导入工程的**结果形状**，主进程和界面共用。
 *
 * 放在 shared 里而不是主进程那边：界面要照着它渲染「导入结果」详情，
 * 类型从 `src/main` 里横着 import 过来只会越缠越紧。
 * 结算逻辑本身在 `src/main/services/project/importSettlement.ts`。
 */

/**
 * 一条依赖找不到，究竟是哪种「找不到」。
 *
 * 三种情况的下一步完全不同，不能都说成「找不到依赖」：
 * - `not-in-vault`：保管库里根本没这条记录 → 去要这个素材，或者换个保管库
 * - `source-missing`：库里有记录、源文件丢了 → 素材曾经在，得去修保管库
 * - `unresolved`：库里有、源文件也在，却没能定位到 → 这是解析这边的问题，如实说出来，
 *   别让用户对着「找不到」去翻自己的素材
 */
export type MissingDependencyState = 'not-in-vault' | 'source-missing' | 'unresolved'

/** 每个资产最终为什么失败。界面按这个分组，不靠解析中文字符串 */
export type ImportFailureReason =
  | 'plan-error'
  | 'missing-dependency'
  | 'file-not-written'
  | 'unconfirmed'

export type MissingDependencyRow = {
  softPath: string
  name: string
  state: MissingDependencyState
  /** 有多少个资产用到它 */
  affectedCount: number
  /** 前几个资产名，够用户认出是哪一批就行 */
  affectedSample: string[]
}

export type FileFailureRow = {
  name: string
  target: string
  error: string
  affectedCount: number
  affectedSample: string[]
}

/**
 * 规划阶段就没能开始的资产。
 *
 * 版本不符、源文件不在、库里没有这条记录 —— 这些在依赖解析之前就定了，
 * 拷贝队列一个字节都没排。它们**必须**在报告里有一格：不然「查看详情」
 * 会因为报告「干净」而根本不出现，用户拿到一张红卡片却读不到任何原因。
 */
export type PlanErrorRow = {
  code?: 'engine-version'
  assetName: string
  error: string
}

export type ConflictRow = {
  name: string
  target: string
  keptSource: string
  rejectedSource: string
}

/**
 * 出了什么问题、影响了谁。
 *
 * 每组封顶（见 `MAX_REPORT_ROWS`）：一万个资产的批次里失败可能上千，
 * 全塞进 IPC 载荷既撑大消息也没人读得完。超出的只留计数。
 */
export type ImportFailureReport = {
  /** 连开始都没开始的：版本不符、源文件不在、库里没这条记录 */
  planErrors: PlanErrorRow[]
  missingDependencies: MissingDependencyRow[]
  fileFailures: FileFailureRow[]
  conflicts: ConflictRow[]
  /** 依赖太多、没能确认是否导全的资产名 */
  unconfirmed: string[]
  /** 没写进去、但归不到任何资产头上的文件数（依赖文件没有 assetKey） */
  orphanFileFailures: number
  /**
   * 找不到、又摊不到任何资产头上的依赖数。
   *
   * 归属靠的是「软路径 → 目标包路径」这条换算。软路径没解析出来（登记的是真实
   * 磁盘路径）、或者用到它的那个资产自己在规划期就失败了，都会算出零个所有者。
   * 那时候没有任何资产会被降级 —— 要是整批就这么报成功，就等于说
   * 「这条依赖找不到，但没人受影响」，而它明明是被谁引用才会被解析到的。
   */
  unattributedMissing: number
  /** 各组被截掉多少条 */
  truncated: {
    planErrors: number
    missingDependencies: number
    fileFailures: number
    conflicts: number
    unconfirmed: number
  }
}

/** 每组最多带回多少条 */
export const MAX_REPORT_ROWS = 50
/** 每条最多列几个受影响的资产名 */
export const MAX_REPORT_SAMPLE = 5

export const emptyImportFailureReport = (): ImportFailureReport => ({
  planErrors: [],
  missingDependencies: [],
  fileFailures: [],
  conflicts: [],
  unconfirmed: [],
  orphanFileFailures: 0,
  unattributedMissing: 0,
  truncated: {
    planErrors: 0,
    missingDependencies: 0,
    fileFailures: 0,
    conflicts: 0,
    unconfirmed: 0
  }
})

/** 报告里一条问题都没有 —— 界面据此决定要不要给「查看详情」 */
export const isCleanImportReport = (report: ImportFailureReport | undefined | null): boolean =>
  !report ||
  (report.planErrors.length === 0 &&
    report.missingDependencies.length === 0 &&
    report.fileFailures.length === 0 &&
    report.conflicts.length === 0 &&
    report.unconfirmed.length === 0 &&
    report.orphanFileFailures === 0 &&
    report.unattributedMissing === 0)
