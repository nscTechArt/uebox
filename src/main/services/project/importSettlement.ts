import type { PackageCopyConflict, PackageCopyFailure } from './packageCopyQueue'
import {
  MAX_REPORT_ROWS,
  MAX_REPORT_SAMPLE,
  type ConflictRow,
  type FileFailureRow,
  type ImportFailureReason,
  type ImportFailureReport,
  type MissingDependencyRow,
  type PlanErrorRow,
  type MissingDependencyState
} from '../../../shared/projectImport'

export type {
  ConflictRow,
  FileFailureRow,
  ImportFailureReport,
  MissingDependencyRow,
  PlanErrorRow,
  MissingDependencyState
}
/** 结算里沿用旧名字，对外就是 `ImportFailureReason` */
export type FailureReason = ImportFailureReason

/**
 * 一批导入跑完之后的结算。
 *
 * ## 为什么单独一个文件、而且是纯函数
 *
 * 「这个资产到底算成功还是失败」有**三条互相影响**的归因路径：
 *
 * 1. 排了队的文件没写进去（磁盘满、文件被占用）
 * 2. 依赖压根找不到（这时候一个字节都不会拷，也就一个拷贝失败都没有）
 * 3. 依赖闭包没走完（超预算），无法证明这个资产是完整的
 *
 * 评审第 8、9、10 轮的问题全部出在这三条的**交叉处**，而它们原来散在
 * `importUAssetsBatchToProject` 的收尾里，只能靠端到端测试（要建工程、写文件、跑队列）
 * 去碰。放进纯函数之后交叉情况可以直接穷举。
 *
 * 所有 IO 留在外面：依赖闭包的展开（要查库）、缺失依赖在不在保管库里（要查库 + stat）
 * 都由调用方算好再传进来。
 */

/** 规划阶段（`planAssetImport` 那一轮）对一个资产的结论 */
export type PlannedAsset = {
  /** 在这批 sources 里的下标，也是 targetOwners 里的所有者标识 */
  index: number
  assetKey: string
  assetName: string
  planned: 'imported' | 'existing' | 'failed'
  /** 规划阶段就失败了（版本不符、源文件不存在……），原样带给用户 */
  error?: string
  errorCode?: 'engine-version'
  /** 这个资产的主包写到了工程的哪儿 */
  primaryTarget?: string
}

export type MissingDependencyFact = {
  state: MissingDependencyState
  /** 资产名，没查到就用软路径最后一段 */
  name: string
}

export type SettlementInput = {
  assets: PlannedAsset[]
  /** 工程的 Content 目录，用来把依赖的软路径换算成目标路径 */
  contentBase: string
  /** 目标包（去掉扩展名）→ 哪些资产需要它。闭包展开之后的完整版 */
  targetOwners: ReadonlyMap<string, ReadonlySet<number>>
  /** 依赖闭包没走完的资产下标 */
  closureIncomplete: ReadonlySet<number>
  /** 整批范围内没能找到的依赖软路径 */
  missingDependencies: ReadonlySet<string>
  missingFacts: ReadonlyMap<string, MissingDependencyFact>
  queueFailures: readonly PackageCopyFailure[]
  queueConflicts: readonly PackageCopyConflict[]
  /**
   * 目标路径 → 和 `targetOwners` 同一套键。
   * 传进来而不是在这儿算：大小写敏感性归拷贝队列管，这里不该知道。
   */
  packageKeyOf: (target: string) => string
  /** 把绝对路径拼出来。默认按 posix/win 通吃的方式拼，测试里可替换 */
  joinPath?: (base: string, relative: string) => string
  /** 取文件名。默认按 `/` 和 `\` 一起切 */
  basename?: (filePath: string) => string
}

export type SettledAsset = {
  index: number
  assetKey: string
  assetName: string
  status: 'imported' | 'existing' | 'failed'
  reason?: FailureReason
  error?: string
  /**
   * 这个资产的主包（.uasset/.umap）写到了工程的哪儿。
   *
   * 只留主包，不留 .uexp/.ubulk 那一串：调用方要的是「它在引擎里叫什么」，
   * 一万个资产各带一串分片路径只会把返回值撑爆。
   */
  primaryTarget?: string
}

export type SettlementResult = {
  succeeded: number
  existing: number
  failed: number
  assets: SettledAsset[]
  report: ImportFailureReport
  /** 结算阶段产生的警告，调用方拼在规划阶段的警告后面 */
  warnings: string[]
}

const MAX_ROWS = MAX_REPORT_ROWS
const MAX_SAMPLE = MAX_REPORT_SAMPLE

const defaultBasename = (filePath: string): string => {
  const unified = filePath.split('\\').join('/')
  const cut = unified.lastIndexOf('/')
  return cut < 0 ? unified : unified.slice(cut + 1)
}

const defaultJoin = (base: string, relative: string): string =>
  `${base.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`

/**
 * 一个资产可能同时踩中几条：既有文件没写进去，又有依赖找不到。
 * 报最有信息量的那条 —— 「连查都没查完」比「缺哪个依赖」更该先说，
 * 「缺依赖」比「文件没写进去」更具体（和重构前那串三元表达式的优先级一致）。
 */
const REASON_RANK: Record<FailureReason, number> = {
  unconfirmed: 3,
  'missing-dependency': 2,
  'file-not-written': 1,
  'plan-error': 0
}

/**
 * `candidate` 是不是比 `current` 更该报出来。
 *
 * 单独导出是为了能直接测：它写在 `settleImportBatch` 里的时候，三个降级块恰好
 * 就是按 rank 升序排的，于是「后写覆盖先写」也能得出同样的结果 —— 优先级表成了
 * 够不着的死代码，唯一测它的用例其实测的是块的顺序。谁哪天把「先查闭包」挪到
 * 前面，报出来的原因就会从「没能确认是否导全」变成一句具体但错误的「缺 T_X」。
 */
export const isStrongerReason = (candidate: FailureReason, current: FailureReason): boolean =>
  REASON_RANK[candidate] > REASON_RANK[current]

const capped = <T>(rows: T[]): { rows: T[]; truncated: number } =>
  rows.length <= MAX_ROWS
    ? { rows, truncated: 0 }
    : { rows: rows.slice(0, MAX_ROWS), truncated: rows.length - MAX_ROWS }

export const settleImportBatch = (input: SettlementInput): SettlementResult => {
  const basename = input.basename ?? defaultBasename
  const join = input.joinPath ?? defaultJoin
  const warnings: string[] = []

  const byIndex = new Map<number, PlannedAsset>()
  for (const asset of input.assets) byIndex.set(asset.index, asset)

  /** 规划阶段判成「进了工程」的资产（成功 + 已存在），只有它们会被降级 */
  const survivors = new Set<number>()
  for (const asset of input.assets) {
    if (asset.planned !== 'failed') survivors.add(asset.index)
  }

  const nameOf = (index: number): string =>
    byIndex.get(index)?.assetName || byIndex.get(index)?.assetKey || `#${index}`

  const ownersOf = (target: string): number[] =>
    Array.from(input.targetOwners.get(input.packageKeyOf(target)) ?? [])

  const sampleOf = (owners: number[]): string[] => owners.slice(0, MAX_SAMPLE).map(nameOf)

  /** 最终判失败的资产 → 为什么 */
  const demoted = new Map<number, FailureReason>()
  const demote = (index: number, reason: FailureReason): void => {
    if (!survivors.has(index)) return
    const current = demoted.get(index)
    if (current && !isStrongerReason(reason, current)) return
    demoted.set(index, reason)
  }

  // ── 1. 排了队却没写进去的文件 ────────────────────────────────────
  const fileFailureRows: FileFailureRow[] = []
  let orphanFileFailures = 0
  for (const failure of input.queueFailures) {
    warnings.push(`复制失败 ${basename(failure.source)}: ${failure.error}`)
    const owners = ownersOf(failure.target)
    // 归不到任何资产头上的（依赖文件没有 assetKey）单独计数，不能装作整批都成功
    if (owners.length === 0) orphanFileFailures++
    for (const owner of owners) demote(owner, 'file-not-written')
    fileFailureRows.push({
      name: basename(failure.target),
      target: failure.target,
      error: failure.error,
      affectedCount: owners.length,
      affectedSample: sampleOf(owners)
    })
  }

  // ── 2. 找不到的依赖，摊给所有用到它的资产 ────────────────────────
  //
  // 共享依赖只会在**第一个**用到它的资产那一轮被解析到（后面的资产走已处理去重），
  // 所以不能只看那一轮的返回值 —— 否则两个模型共用一张缺失贴图会报成
  // 「成功 1、失败 1」，其实两个都残（评审第 8 轮第 2 条）。
  const missingRows: MissingDependencyRow[] = []
  let unattributedMissing = 0
  for (const softPath of input.missingDependencies) {
    /*
     * 这里进来的不一定是 `/Game/...` 开头。
     *
     * 两种来源：`noteMissingDependency` 在 `deriveSoftPathFromRealPath` 认不出来时
     * 会原样登记**真实磁盘路径**；而它**认出来**的那份也不一定带 `/Game` 前缀 ——
     * 匹配到 `/Game/` 这个 marker 时它返回的是 `/${suffix}`（见 `softPathResolver.ts`）。
     *
     * 所以绝不能按「是不是 /Game 开头」决定要不要查归属：那会把 `/Meshes/SM_A`
     * 这种合法软路径一起挡掉，用到它的资产就不再被降级，界面上那个资产看着没事、
     * 底下却写着「0 个资产用到它」。原样拼、原样查就行 —— 真实磁盘路径自然匹配
     * 不上任何 owner，不需要额外加闸。
     */
    const relative = String(softPath).replace(/^\/Game\/?/, '')
    if (!relative) continue
    const owners = ownersOf(join(input.contentBase, relative))
    // 摊不到任何资产头上：没人会被降级，那整批就不能报成功 —— 见 unattributedMissing
    if (owners.length === 0) unattributedMissing++
    for (const owner of owners) demote(owner, 'missing-dependency')

    const fact = input.missingFacts.get(softPath)
    missingRows.push({
      softPath,
      name: fact?.name || basename(softPath),
      state: fact?.state ?? 'not-in-vault',
      affectedCount: owners.length,
      affectedSample: sampleOf(owners)
    })
  }

  // ── 3. 闭包没走完的资产 ──────────────────────────────────────────
  //
  // 只要这一批有文件没落盘**或者有依赖没找到**，这些资产就无法证明自己是完整的 ——
  // 「没查过」不等于「查过没事」（评审第 9 轮第 3 条）。
  const unconfirmed: string[] = []
  if (input.queueFailures.length > 0 || input.missingDependencies.size > 0) {
    for (const index of input.closureIncomplete) {
      if (!survivors.has(index)) continue
      demote(index, 'unconfirmed')
      unconfirmed.push(nameOf(index))
    }
  }

  // ── 4. 结算 ──────────────────────────────────────────────────────
  const reasonText: Record<FailureReason, string> = {
    'plan-error': '导入失败',
    'missing-dependency': '依赖不完整',
    'file-not-written': '文件未能写入工程',
    unconfirmed: '依赖过多，未能确认是否导全'
  }

  const assets: SettledAsset[] = input.assets.map((asset) => {
    if (asset.planned === 'failed') {
      return {
        index: asset.index,
        assetKey: asset.assetKey,
        assetName: asset.assetName,
        status: 'failed',
        reason: 'plan-error',
        error: asset.error,
        primaryTarget: asset.primaryTarget
      }
    }
    const reason = demoted.get(asset.index)
    if (reason) {
      return {
        index: asset.index,
        assetKey: asset.assetKey,
        assetName: asset.assetName,
        status: 'failed',
        reason,
        primaryTarget: asset.primaryTarget
      }
    }
    return {
      index: asset.index,
      assetKey: asset.assetKey,
      assetName: asset.assetName,
      status: asset.planned,
      primaryTarget: asset.primaryTarget
    }
  })

  // 降级的按原来的顺序报警告：只报被降下来的，规划期就失败的那批警告在调用方那边已经有了
  for (const asset of assets) {
    const reason = demoted.get(asset.index)
    if (reason) warnings.push(`导入失败（${reasonText[reason]}）：${asset.assetName}`)
  }

  if (unattributedMissing > 0) {
    warnings.push(
      `另有 ${unattributedMissing} 个依赖没找到，且没能确定是哪些资产在用它，相关资产在引擎里可能不完整`
    )
  }

  if (orphanFileFailures > 0) {
    warnings.push(`另有 ${orphanFileFailures} 个依赖文件没能写入工程，相关资产在引擎里可能不完整`)
  }

  const conflictRows: ConflictRow[] = input.queueConflicts.map((conflict) => ({
    name: basename(conflict.target),
    target: conflict.target,
    keptSource: conflict.keptSource,
    rejectedSource: conflict.rejectedSource
  }))
  for (const conflict of conflictRows) {
    warnings.push(
      `目标路径冲突，只保留了先到的那个：${conflict.name}` +
        `（另一个来源 ${conflict.rejectedSource}）`
    )
  }

  // 规划期就没开始的那批也得进报告。
  //
  // 这一格原来是空的，于是「版本太高」「源文件不在」这类最常见的失败
  // 产出一份「干净」的报告 —— 界面据此不给「查看详情」，用户对着一张
  // 红卡片读不到任何原因。
  const planErrorRows: PlanErrorRow[] = input.assets
    .filter((a) => a.planned === 'failed')
    .map((a) => ({
      assetName: a.assetName,
      error: a.error || '导入失败',
      ...(a.errorCode ? { code: a.errorCode } : {})
    }))

  const cappedPlanErrors = capped(planErrorRows)
  const cappedMissing = capped(missingRows)
  const cappedFailures = capped(fileFailureRows)
  const cappedConflicts = capped(conflictRows)
  const cappedUnconfirmed = capped(unconfirmed)

  return {
    succeeded: assets.filter((a) => a.status === 'imported').length,
    existing: assets.filter((a) => a.status === 'existing').length,
    failed: assets.filter((a) => a.status === 'failed').length,
    assets,
    warnings,
    report: {
      planErrors: cappedPlanErrors.rows,
      missingDependencies: cappedMissing.rows,
      fileFailures: cappedFailures.rows,
      conflicts: cappedConflicts.rows,
      unconfirmed: cappedUnconfirmed.rows,
      orphanFileFailures,
      unattributedMissing,
      truncated: {
        planErrors: cappedPlanErrors.truncated,
        missingDependencies: cappedMissing.truncated,
        fileFailures: cappedFailures.truncated,
        conflicts: cappedConflicts.truncated,
        unconfirmed: cappedUnconfirmed.truncated
      }
    }
  }
}
