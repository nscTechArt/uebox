import { app } from 'electron'
import AdmZip from 'adm-zip'
import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import os from 'os'
import { join } from 'path'

import { getLogFilePath } from '../electronLog'

/**
 * 导入诊断包（**纯本地**）。
 *
 * 网络库导入失败时，把这次导入的报告、日志尾部和一份结构化说明打成一个 zip，
 * 落在 `userData/diagnostics/<diagnosticId>.zip`。界面上把这个 id 给用户，
 * 他自己决定要不要把这个包交给谁。
 *
 * ## 这里为什么一个网络调用都没有
 *
 * 这个模块以前叫 `DiagnosticUploadService`，行为是「导入一失败就自动上传」：
 * 打好包直接 POST 到服务端，失败进 SQLite 重试队列，**开机再刷一遍**。包里除了
 * 日志还带着 `platformUserId` 和一个由 `hostname + CPU 型号 + 内存` 哈希出来的
 * 设备指纹。没有开关，也不问用户。
 *
 * 那是商业版的形状：设备指纹是座席绑定用的，自动上传服务的是「厂商能看到现场」。
 * 社区版对用户的承诺是装完完全离线、不上报（README 第一句、AGENTS.md §1），
 * 所以整条上传链路连同重试队列、缓存表和设备指纹一起删掉了，只留下打包。
 *
 * **别把上传加回来。** 需要「把现场给别人看」时，正确的做法是让用户拿着这个
 * zip 自己发出去 —— 那是他的选择，不是应用替他做的决定。
 */

const MAX_PACKAGE_BYTES = 5 * 1024 * 1024
const DEFAULT_LOG_TAIL_BYTES = 1 * 1024 * 1024
const SMALL_LOG_TAIL_BYTES = 128 * 1024
const MAX_REPORT_BYTES = 2 * 1024 * 1024

type RemoteSyncStatus = 'committed' | 'failed' | 'partial' | 'skipped'

export interface CaptureImportDiagnosticOptions {
  vaultId: string
  taskId: string
  rootFolderPath: string
  targetFolderKey?: string | null
  remoteSyncStatus: RemoteSyncStatus
  remoteSyncError?: string | null
  remoteSyncFailureDetails?: Record<string, unknown> | null
  reportPath?: string
  serverUrl?: string
  remoteVaultId?: string
  platformNodeId?: string
  sessionId?: string
  stage?: string
}

interface DiagnosticPayload {
  diagnosticId: string
  occurredAt: string
  stage: string
  severity: 'error' | 'fatal'
  message: string
  fingerprint: string
  app: {
    name: string
    version: string
    electron: string
    node: string
  }
  /**
   * 运行环境。
   *
   * 只有排查问题真正用得上的那几项，**没有一项能指向具体某台机器** ——
   * 不带主机名，也不带那个由硬件哈希出来的设备 ID。
   */
  runtime: {
    platform: string
    release: string
    arch: string
    cpuCount: number
    totalMemoryBytes: number
    freeMemoryBytes: number
  }
  import: {
    vaultId: string
    taskId: string
    rootFolderPath: string
    targetFolderKey?: string | null
    remoteSyncStatus: RemoteSyncStatus
    remoteSyncFailureDetails?: Record<string, unknown> | null
    serverUrl?: string
    remoteVaultId?: string
    platformNodeId?: string
    sessionId?: string
  }
  summary: Record<string, unknown>
  package: {
    redacted: true
    maxBytes: number
    logTailBytes: number
  }
}

interface BuildPackageResult {
  payload: DiagnosticPayload
  packagePath: string
}

type Sanitizer = (value: string) => string

function getAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    // 只在没有 Electron 环境时走到（单测），版本号缺了不影响诊断包本身
    return 'unknown'
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createSanitizer(rootFolderPath: string): Sanitizer {
  const replacements: Array<{ pattern: RegExp; target: string }> = []
  const addReplacement = (source: string | undefined, target: string): void => {
    const clean = String(source || '').trim()
    if (!clean) return
    const variants = new Set([clean, clean.replace(/\\/g, '/')])
    for (const variant of variants) {
      replacements.push({ pattern: new RegExp(escapeRegex(variant), 'gi'), target })
    }
  }

  addReplacement(rootFolderPath, '[IMPORT_ROOT]')
  addReplacement(os.homedir(), '[USER_HOME]')

  return (value: string): string => {
    let next = value
    for (const replacement of replacements) {
      next = next.replace(replacement.pattern, replacement.target)
    }
    return next
  }
}

function sanitizeObject<T>(value: T, sanitize: Sanitizer): T {
  if (typeof value === 'string') {
    return sanitize(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item, sanitize)) as T
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sanitizeObject(item, sanitize)
    }
    return output as T
  }
  return value
}

function deriveErrorCode(
  options: CaptureImportDiagnosticOptions,
  report: Record<string, unknown> | null
): string {
  const details = options.remoteSyncFailureDetails || {}
  if (typeof details.errorCode === 'string' && details.errorCode) return details.errorCode

  const issues = Array.isArray(report?.issues) ? (report?.issues as Record<string, unknown>[]) : []
  const issueCode = issues.find((issue) => typeof issue.errorCode === 'string')?.errorCode
  if (typeof issueCode === 'string' && issueCode) return issueCode

  if (options.remoteSyncStatus === 'partial') return 'REMOTE_IMPORT_PARTIAL'
  if (options.remoteSyncStatus === 'failed') return 'REMOTE_IMPORT_FAILED'
  return 'IMPORT_FAILED'
}

function buildFingerprint(stage: string, errorCode: string, message: string): string {
  const stableMessage = message.replace(/\d+\/\d+/g, 'N/N').slice(0, 240)
  return createHash('sha1')
    .update(`${stage}|${errorCode}|${stableMessage}`)
    .digest('hex')
    .slice(0, 16)
}

async function safeReadJson(filePath?: string): Promise<Record<string, unknown> | null> {
  if (!filePath || !existsSync(filePath)) return null
  try {
    const stat = await fs.stat(filePath)
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (stat.size <= MAX_REPORT_BYTES) return parsed
    return {
      ...parsed,
      diagnosticTruncated: true,
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 200) : parsed.issues
    }
  } catch (error) {
    return {
      diagnosticReadError: error instanceof Error ? error.message : String(error)
    }
  }
}

async function readLogTail(maxBytes: number, sanitize: Sanitizer): Promise<string> {
  try {
    const logPath = getLogFilePath()
    if (!logPath || !existsSync(logPath)) return ''
    const stat = await fs.stat(logPath)
    const start = Math.max(0, stat.size - maxBytes)
    const handle = await fs.open(logPath, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      await handle.read(buffer, 0, buffer.length, start)
      return sanitize(buffer.toString('utf-8'))
    } finally {
      await handle.close()
    }
  } catch (error) {
    return `[diagnostic] failed to read log tail: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** 把诊断包的位置写回导入报告，用户照着报告就能找到那个 zip */
async function writeReportPackagePointer(
  reportPath: string | undefined,
  info: Record<string, unknown>
): Promise<void> {
  if (!reportPath || !existsSync(reportPath)) return
  try {
    const raw = await fs.readFile(reportPath, 'utf-8')
    const report = JSON.parse(raw) as Record<string, unknown>
    report.diagnosticPackage = {
      createdAt: new Date().toISOString(),
      ...info
    }
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8')
  } catch (error) {
    console.warn('[ImportDiagnostics] failed to update import report:', error)
  }
}

function packageDir(): string {
  return join(app.getPath('userData'), 'diagnostics')
}

async function buildZipBuffer(entries: {
  diagnosticJson: unknown
  importReport: Record<string, unknown> | null
  logTail: string
}): Promise<Buffer> {
  const zip = new AdmZip()
  zip.addFile(
    'diagnostic.json',
    Buffer.from(JSON.stringify(entries.diagnosticJson, null, 2), 'utf-8')
  )
  if (entries.importReport) {
    zip.addFile(
      'import-report.json',
      Buffer.from(JSON.stringify(entries.importReport, null, 2), 'utf-8')
    )
  }
  if (entries.logTail) {
    zip.addFile('app-log-tail.txt', Buffer.from(entries.logTail, 'utf-8'))
  }
  return zip.toBuffer()
}

export class ImportDiagnosticsService {
  private static instance: ImportDiagnosticsService | null = null

  static getInstance(): ImportDiagnosticsService {
    if (!ImportDiagnosticsService.instance) {
      ImportDiagnosticsService.instance = new ImportDiagnosticsService()
    }
    return ImportDiagnosticsService.instance
  }

  async captureImportDiagnostic(options: CaptureImportDiagnosticOptions): Promise<string | null> {
    try {
      const built = await this.buildDiagnosticPackage(options)
      await writeReportPackagePointer(options.reportPath, {
        diagnosticId: built.payload.diagnosticId,
        packagePath: built.packagePath,
        fingerprint: built.payload.fingerprint
      })
      return built.payload.diagnosticId
    } catch (error) {
      // 打包失败不能把导入的错误盖掉 —— 导入那条错误才是用户要看的
      console.warn('[ImportDiagnostics] failed to build diagnostic package:', error)
      return null
    }
  }

  private async buildDiagnosticPackage(
    options: CaptureImportDiagnosticOptions
  ): Promise<BuildPackageResult> {
    const sanitize = createSanitizer(options.rootFolderPath)
    const report = await safeReadJson(options.reportPath)
    const sanitizedReport = report ? sanitizeObject(report, sanitize) : null
    const errorCode = deriveErrorCode(options, report)
    const stage = options.stage || 'nas_v2_import'
    const message =
      options.remoteSyncError ||
      String((options.remoteSyncFailureDetails || {}).error || '') ||
      `${options.remoteSyncStatus} import diagnostic`
    const occurredAt = new Date().toISOString()
    const diagnosticId = `diag_${Date.now()}_${randomUUID()}`
    const fingerprint = buildFingerprint(stage, errorCode, message)

    const payload: DiagnosticPayload = sanitizeObject(
      {
        diagnosticId,
        occurredAt,
        stage,
        severity: options.remoteSyncStatus === 'failed' ? 'fatal' : 'error',
        message,
        fingerprint,
        app: {
          name: app.getName(),
          version: getAppVersion(),
          electron: process.versions.electron || 'unknown',
          node: process.versions.node
        },
        runtime: {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          cpuCount: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          freeMemoryBytes: os.freemem()
        },
        import: {
          vaultId: options.vaultId,
          taskId: options.taskId,
          rootFolderPath: options.rootFolderPath,
          targetFolderKey: options.targetFolderKey || null,
          remoteSyncStatus: options.remoteSyncStatus,
          remoteSyncFailureDetails: options.remoteSyncFailureDetails || null,
          serverUrl: options.serverUrl,
          remoteVaultId: options.remoteVaultId,
          platformNodeId: options.platformNodeId,
          sessionId: options.sessionId
        },
        summary: {
          errorCode,
          reportPath: options.reportPath,
          reportIssueCount: Array.isArray(report?.issues) ? report?.issues.length : 0,
          reportSummary: report?.summary || null
        },
        package: {
          redacted: true,
          maxBytes: MAX_PACKAGE_BYTES,
          logTailBytes: DEFAULT_LOG_TAIL_BYTES
        }
      },
      sanitize
    )

    let logTail = await readLogTail(DEFAULT_LOG_TAIL_BYTES, sanitize)
    let buffer = await buildZipBuffer({
      diagnosticJson: payload,
      importReport: sanitizedReport,
      logTail
    })

    if (buffer.length > MAX_PACKAGE_BYTES) {
      payload.package.logTailBytes = SMALL_LOG_TAIL_BYTES
      logTail = await readLogTail(SMALL_LOG_TAIL_BYTES, sanitize)
      buffer = await buildZipBuffer({
        diagnosticJson: payload,
        importReport: sanitizedReport,
        logTail
      })
    }

    if (buffer.length > MAX_PACKAGE_BYTES) {
      payload.package.logTailBytes = 0
      buffer = await buildZipBuffer({
        diagnosticJson: payload,
        importReport: sanitizedReport,
        logTail: ''
      })
    }

    if (buffer.length > MAX_PACKAGE_BYTES) {
      const compactReport = sanitizedReport
        ? {
            generatedAt: sanitizedReport.generatedAt,
            vaultId: sanitizedReport.vaultId,
            taskId: sanitizedReport.taskId,
            summary: sanitizedReport.summary,
            issues: Array.isArray(sanitizedReport.issues)
              ? sanitizedReport.issues.slice(0, 50)
              : sanitizedReport.issues,
            diagnosticTruncated: true
          }
        : null
      buffer = await buildZipBuffer({
        diagnosticJson: payload,
        importReport: compactReport,
        logTail: ''
      })
    }

    if (buffer.length > MAX_PACKAGE_BYTES) {
      throw new Error(`Diagnostic package exceeds 5MB after truncation: ${buffer.length}`)
    }

    const dir = packageDir()
    await fs.mkdir(dir, { recursive: true })
    const packagePath = join(dir, `${diagnosticId}.zip`)
    await fs.writeFile(packagePath, buffer)
    return { payload, packagePath }
  }
}

export const captureImportDiagnostic = async (
  options: CaptureImportDiagnosticOptions
): Promise<string | null> => {
  return ImportDiagnosticsService.getInstance().captureImportDiagnostic(options)
}
