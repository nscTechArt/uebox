import { randomUUID } from 'node:crypto'
import { existsSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'

import type {
  ImportFailureEntry,
  ImportSkipEntry,
  ImportSkipReason
} from '../../../../shared/assetImport'
import { calculateFullFileHash, copyFileWithRetry } from './fileUtils'

/**
 * SMB 网络保管库的文件复制。
 *
 * 从导入 handler 里抽出来的三条铁律（原实现三条都不满足）：
 *   1. **只有确实落盘的文件才进 networkPaths** —— 上游据此决定要不要写库。
 *      原来 catch 里照样往 assetKeyMap 写，是「失败也像成功」的源头之一。
 *   2. **失败和跳过一律留痕**，绝不 console.warn 了事。原来复制失败只打一条
 *      警告，计数器却把它算进「成功处理」，界面报「导入完成」。
 *   3. **复制中断留下的半截文件必须删掉** —— 它比「文件不存在」更危险，
 *      因为下次导入会认为目标已存在。
 */

/** 网络抖动、文件被占用 —— 等一会儿再来就好 */
const RETRIABLE_CODES = new Set([
  'EBUSY',
  'EPERM',
  'EACCES',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'EIO',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ESTALE',
  'EAGAIN',
  'UNKNOWN'
])

/** 再试一万次也是这个结果，而且通常意味着整批都会失败 */
const FATAL_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS'])

const DEFAULT_SWEEP_ROUNDS = 2
const SWEEP_BASE_DELAY_MS = 2000
const SWEEP_MAX_DELAY_MS = 30_000
const PROGRESS_STEP = 50
/** 覆盖已有文件时先写这个后缀，成功后再 rename —— 失败也不会把旧文件毁成半截 */
const PARTIAL_SUFFIX = '.ubx-part'

export interface NetworkCopyFile {
  name: string
  path: string
  size?: number | null
}

export type OverwriteDecision =
  | { action: 'overwrite'; applyToAll?: boolean }
  | { action: 'skip'; applyToAll?: boolean; reason?: ImportSkipReason }

export interface NetworkVaultCopyParams {
  signal?: AbortSignal
  files: readonly NetworkCopyFile[]
  /** SMB 保管库根路径 */
  networkPath: string
  /** 导入源根目录；'ALL' 表示散文件导入 */
  rootFolderPath: string
  /** 目标文件夹在网络库中的相对路径，可为空串 */
  targetFolderFullPath: string
  concurrency: number
  /** 主循环跑完后，对「可重试的失败」再扫几轮。默认 2 */
  sweepRounds?: number
  /** 目标已存在且内容不同时直接覆盖，不询问 */
  forceOverwrite?: boolean
}

export interface NetworkVaultCopyDeps {
  copyFile: (src: string, dest: string) => Promise<void>
  mkdir: (dir: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  removeFile: (path: string) => Promise<void>
  fileExists: (path: string) => boolean
  fileSize: (path: string) => Promise<number>
  hashFile: (path: string) => Promise<string>
  confirmOverwrite: (file: NetworkCopyFile, targetPath: string) => Promise<OverwriteDecision>
  onProgress: (done: number, total: number) => void
  sleep: (ms: number) => Promise<void>
}

export interface NetworkVaultCopyReport {
  total: number
  /** 实际复制成功 */
  copied: number
  /** 目标已存在且内容一致，省掉物理复制（算成功） */
  identical: number
  skipped: number
  failed: number
  /** 源路径 → 网络目标路径。**只包含确实落盘的文件** */
  networkPaths: Map<string, string>
  failures: ImportFailureEntry[]
  skips: ImportSkipEntry[]
  /**
   * forceOverwrite（重试链路）下被**无条件覆盖掉**的已有文件。
   *
   * 覆盖本身是有意的取舍：重试面对的通常是自己上次写坏的半截文件，停下来问用户
   * 会让无人值守的重试卡死。但从复制失败到点重试之间，同事完全可能更新过网络盘上
   * 那个文件 —— 那份内容就这么没了。所以至少要留痕，让用户事后查得到。
   */
  forcedOverwrites: Array<{ fileName: string; path: string; targetPath: string }>
  /** 是否因致命错误（磁盘满 / 共享失联）提前中止 */
  aborted: boolean
  abortReason?: string
}

export interface CopyErrorClass {
  code: string
  retriable: boolean
  fatal: boolean
}

export const getErrorCode = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : ''
}

export const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const classifyCopyError = (error: unknown): CopyErrorClass => {
  const code = getErrorCode(error) || 'UNKNOWN'
  if (FATAL_CODES.has(code)) return { code, retriable: false, fatal: true }
  if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENAMETOOLONG') {
    return { code, retriable: false, fatal: false }
  }
  return { code, retriable: RETRIABLE_CODES.has(code), fatal: false }
}

/**
 * 源文件路径 → 网络库目标路径。
 *
 * 逻辑与原来内联在 copyOneFile 里的版本逐字等价，只是抽出来能单测了。
 */
export const createNetworkTargetPathResolver = (
  networkPath: string,
  rootFolderPath: string,
  targetFolderFullPath: string
): ((file: NetworkCopyFile) => string) => {
  const normalizedRootPath = rootFolderPath.replace(/\\/g, '/')
  const rootFolderName = normalizedRootPath.split('/').pop() || ''
  const rootParentPath = normalizedRootPath.substring(0, normalizedRootPath.lastIndexOf('/'))

  return (file: NetworkCopyFile): string => {
    const normalizedFilePath = file.path.replace(/\\/g, '/')
    let relativePath = file.name

    if (rootParentPath && normalizedFilePath.startsWith(rootParentPath + '/')) {
      relativePath = normalizedFilePath.substring(rootParentPath.length + 1)
    } else if (normalizedFilePath.startsWith(normalizedRootPath + '/')) {
      relativePath =
        rootFolderName + '/' + normalizedFilePath.substring(normalizedRootPath.length + 1)
    } else if (normalizedFilePath.startsWith(normalizedRootPath)) {
      const remaining = normalizedFilePath.substring(normalizedRootPath.length)
      relativePath = rootFolderName + (remaining.startsWith('/') ? remaining : '/' + remaining)
    }

    return targetFolderFullPath
      ? join(networkPath, targetFolderFullPath, relativePath)
      : join(networkPath, relativePath)
  }
}

export const createDefaultNetworkVaultCopyDeps = (
  overrides: Pick<NetworkVaultCopyDeps, 'confirmOverwrite' | 'onProgress'> &
    Partial<NetworkVaultCopyDeps>
): NetworkVaultCopyDeps => ({
  copyFile: (src, dest) => copyFileWithRetry(src, dest),
  mkdir: async (dir) => {
    await fsp.mkdir(dir, { recursive: true })
  },
  rename: (from, to) => fsp.rename(from, to),
  removeFile: (path) => fsp.rm(path, { force: true }),
  fileExists: (path) => existsSync(path),
  fileSize: async (path) => (await fsp.stat(path)).size,
  hashFile: (path) => calculateFullFileHash(path),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ...overrides
})

const destinationTails = new Map<string, Promise<void>>()

type CopyAttemptResult =
  | { status: 'copied'; targetPath: string }
  | { status: 'identical'; targetPath: string }
  | { status: 'skipped'; targetPath: string; reason: ImportSkipReason }
  | { status: 'failed'; targetPath: string; error: unknown; klass: CopyErrorClass }

/**
 * 把一批文件复制到 SMB 保管库，并如实回答每个文件的下场。
 */
export const runNetworkVaultCopy = async (
  params: NetworkVaultCopyParams,
  deps: NetworkVaultCopyDeps
): Promise<NetworkVaultCopyReport> => {
  const total = params.files.length
  const report: NetworkVaultCopyReport = {
    total,
    copied: 0,
    identical: 0,
    skipped: 0,
    failed: 0,
    networkPaths: new Map<string, string>(),
    failures: [],
    skips: [],
    forcedOverwrites: [],
    aborted: false
  }
  if (total === 0) return report

  const resolveTargetPath = createNetworkTargetPathResolver(
    params.networkPath,
    params.rootFolderPath,
    params.targetFolderFullPath
  )

  const dirTasks = new Map<string, Promise<void>>()
  const settledPaths = new Set<string>()
  const attemptsByPath = new Map<string, number>()
  let overwriteAllChoice: boolean | null = params.forceOverwrite ? true : null
  let decisionTail: Promise<unknown> = Promise.resolve()
  let settled = 0

  const markSettled = (path: string): void => {
    settledPaths.add(path)
    settled++
    if (settled % PROGRESS_STEP === 0 || settled === total) {
      deps.onProgress(settled, total)
    }
  }

  /**
   * 缓存的是 Promise 而不是布尔标志：并发 worker 命中同一目录时会等同一次
   * mkdir，而不是各自 mkdir 一遍（旧代码的竞态）。失败则丢弃缓存留给 sweep 重试。
   */
  const ensureTargetDir = (targetDir: string): Promise<void> => {
    let task = dirTasks.get(targetDir)
    if (!task) {
      task = deps.mkdir(targetDir).catch((error: unknown) => {
        dirTasks.delete(targetDir)
        throw error
      })
      dirTasks.set(targetDir, task)
    }
    return task
  }

  const isIdentical = async (file: NetworkCopyFile, targetPath: string): Promise<boolean> => {
    try {
      const [srcSize, dstSize] = await Promise.all([
        deps.fileSize(file.path),
        deps.fileSize(targetPath)
      ])
      if (srcSize !== dstSize) return false
      const [srcHash, dstHash] = await Promise.all([
        deps.hashFile(file.path),
        deps.hashFile(targetPath)
      ])
      return srcHash === dstHash
    } catch {
      // stat / 哈希失败（占用、网络抖动）→ 当作「不确定」，走覆盖确认
      return false
    }
  }

  const decideOverwriteNow = async (
    file: NetworkCopyFile,
    targetPath: string
  ): Promise<{ copy: boolean; reason?: ImportSkipReason }> => {
    if (overwriteAllChoice !== null) {
      return overwriteAllChoice ? { copy: true } : { copy: false, reason: 'user_skip_all' }
    }
    const decision = await deps.confirmOverwrite(file, targetPath)
    if (decision.applyToAll) overwriteAllChoice = decision.action === 'overwrite'
    if (decision.action === 'overwrite') return { copy: true }
    return {
      copy: false,
      reason: decision.reason ?? (decision.applyToAll ? 'user_skip_all' : 'user_skip')
    }
  }

  const decideOverwrite = (
    file: NetworkCopyFile,
    targetPath: string
  ): Promise<{ copy: boolean; reason?: ImportSkipReason }> => {
    const decision = decisionTail.then(() => {
      params.signal?.throwIfAborted()
      return decideOverwriteNow(file, targetPath)
    })
    decisionTail = decision.catch(() => undefined)
    return decision
  }

  const attemptCopy = async (file: NetworkCopyFile): Promise<CopyAttemptResult> => {
    const targetPath = resolveTargetPath(file)
    attemptsByPath.set(file.path, (attemptsByPath.get(file.path) || 0) + 1)
    const targetDir = dirname(targetPath)
    const writePath = `${targetPath}.${randomUUID()}${PARTIAL_SUFFIX}`

    try {
      params.signal?.throwIfAborted()
      await ensureTargetDir(targetDir)

      if (deps.fileExists(targetPath)) {
        if (await isIdentical(file, targetPath)) {
          return { status: 'identical', targetPath }
        }
        const decision = await decideOverwrite(file, targetPath)
        if (!decision.copy) {
          return { status: 'skipped', targetPath, reason: decision.reason ?? 'user_skip' }
        }
        // 没问过用户就覆盖了一个内容不同的已有文件 —— 留痕（见 forcedOverwrites 的注释）
        if (params.forceOverwrite) {
          report.forcedOverwrites.push({ fileName: file.name, path: file.path, targetPath })
        }
        // 覆盖已有文件：先写临时文件再 rename。中途断了旧文件还在，不会变半截。
      }

      params.signal?.throwIfAborted()
      await deps.copyFile(file.path, writePath)
      if (writePath !== targetPath) {
        await deps.rename(writePath, targetPath)
      }
      return { status: 'copied', targetPath }
    } catch (error) {
      // writePath 是「本次导入自己写出来的东西」，删干净
      try {
        await deps.removeFile(writePath)
      } catch {
        /* 本来就不存在，忽略 */
      }
      return { status: 'failed', targetPath, error, klass: classifyCopyError(error) }
    }
  }

  const recordFailure = (
    file: NetworkCopyFile,
    targetPath: string,
    error: unknown,
    klass: CopyErrorClass
  ): void => {
    report.failed++
    report.failures.push({
      stage: 'copy_to_network',
      fileName: file.name,
      path: file.path,
      targetPath,
      error: errorMessageOf(error),
      code: klass.code,
      attempts: attemptsByPath.get(file.path) || 1,
      retriable: klass.retriable
    })
    markSettled(file.path)
  }

  const runPass = async (
    queue: readonly NetworkCopyFile[],
    concurrency: number,
    isFinalPass: boolean
  ): Promise<NetworkCopyFile[]> => {
    const retryQueue: NetworkCopyFile[] = []
    let index = 0
    const workerCount = Math.max(1, Math.min(concurrency, queue.length))

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (index < queue.length && !report.aborted && !params.signal?.aborted) {
          const file = queue[index++]
          const destination = resolveTargetPath(file).replace(/\\/g, '/').toLowerCase()
          const previous = destinationTails.get(destination) || Promise.resolve()
          let release!: () => void
          const tail = new Promise<void>((resolve) => {
            release = resolve
          })
          destinationTails.set(destination, tail)
          await previous
          let result: CopyAttemptResult
          try {
            result = await attemptCopy(file)
          } finally {
            release()
            if (destinationTails.get(destination) === tail) destinationTails.delete(destination)
          }

          if (result.status === 'copied' || result.status === 'identical') {
            report.networkPaths.set(file.path, result.targetPath)
            if (result.status === 'copied') report.copied++
            else report.identical++
            markSettled(file.path)
            continue
          }

          if (result.status === 'skipped') {
            report.skipped++
            report.skips.push({
              reason: result.reason,
              fileName: file.name,
              path: file.path,
              targetPath: result.targetPath
            })
            markSettled(file.path)
            continue
          }

          if (result.klass.fatal) {
            report.aborted = true
            report.abortReason = `${result.klass.code}: ${errorMessageOf(result.error)}`
            console.error(`❌ [networkVaultCopy] 致命错误，中止剩余复制: ${report.abortReason}`)
            recordFailure(file, result.targetPath, result.error, result.klass)
            return
          }

          if (result.klass.retriable && !isFinalPass) {
            retryQueue.push(file) // 先不定论，等 sweep
            continue
          }

          recordFailure(file, result.targetPath, result.error, result.klass)
        }
      })
    )

    return retryQueue
  }

  const sweepRounds = params.sweepRounds ?? DEFAULT_SWEEP_ROUNDS
  let queue: readonly NetworkCopyFile[] = params.files

  for (let round = 0; round <= sweepRounds; round++) {
    if (params.signal?.aborted) break
    if (round > 0) {
      const delayMs = Math.min(SWEEP_MAX_DELAY_MS, SWEEP_BASE_DELAY_MS * Math.pow(2, round - 1))
      console.warn(
        `⏳ [networkVaultCopy] 第 ${round}/${sweepRounds} 轮补扫：${queue.length} 个文件将在 ${delayMs}ms 后重试`
      )
      await deps.sleep(delayMs)
    }
    // 补扫串行跑：网络已经在抖了，再并发压只会更糟
    queue = await runPass(
      queue,
      round === 0 ? Math.max(1, params.concurrency) : 1,
      round === sweepRounds
    )
    if (queue.length === 0 || report.aborted) break
  }

  if (params.signal?.aborted) {
    report.aborted = true
    report.abortReason = '已取消导入'
  }

  // 中止时还没轮到的文件也必须有下场，不能凭空消失
  if (report.aborted) {
    for (const file of params.files) {
      if (settledPaths.has(file.path)) continue
      report.failed++
      report.failures.push({
        stage: 'copy_to_network',
        fileName: file.name,
        path: file.path,
        targetPath: resolveTargetPath(file),
        error: `导入已中止：${report.abortReason || '未知原因'}`,
        code: 'ABORTED',
        attempts: attemptsByPath.get(file.path) || 0,
        retriable: true
      })
      settledPaths.add(file.path)
    }
  }

  deps.onProgress(total, total)
  console.log(
    `🌐 [networkVaultCopy] 复制结束: copied=${report.copied}, identical=${report.identical}, ` +
      `skipped=${report.skipped}, failed=${report.failed}, total=${report.total}` +
      (report.aborted ? `, aborted=${report.abortReason}` : '')
  )
  return report
}
