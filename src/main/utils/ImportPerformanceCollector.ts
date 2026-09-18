import type {
  ImportPhase,
  PhaseTiming,
  ParseDistribution,
  ErrorCategory,
  ErrorDetail,
  SlowFileRecord,
  ImportPerformanceReport,
  PerformanceCollector
} from '../types/importPerformance'

/**
 * 导入性能采集器
 * 用于在资产导入过程中收集性能数据
 */
export class ImportPerformanceCollector implements PerformanceCollector {
  private taskId: string
  private startTime: number

  // 阶段计时
  private phaseStartTimes: Map<ImportPhase, number> = new Map()
  private phaseTiming: PhaseTiming[] = []

  // 解析耗时分布
  private parseDistribution: ParseDistribution = {
    under10ms: 0,
    under100ms: 0,
    under1s: 0,
    under10s: 0,
    over10s: 0
  }

  // 慢文件列表 (保留 Top 20)
  private slowFiles: SlowFileRecord[] = []
  private readonly MAX_SLOW_FILES = 20

  // 错误记录
  private errors: ErrorDetail[] = []

  // 统计
  private totalFiles = 0
  private totalSize = 0

  constructor(taskId: string) {
    this.taskId = taskId
    this.startTime = Date.now()
  }

  /**
   * 开始记录阶段
   */
  startPhase(phase: ImportPhase): void {
    this.phaseStartTimes.set(phase, Date.now())
  }

  /**
   * 结束记录阶段
   */
  endPhase(phase: ImportPhase, itemCount: number): void {
    const startTime = this.phaseStartTimes.get(phase)
    if (startTime === undefined) {
      console.warn(`[PerformanceCollector] 阶段 ${phase} 未开始`)
      return
    }

    const duration = Date.now() - startTime
    this.phaseTiming.push({ phase, duration, itemCount })
    this.phaseStartTimes.delete(phase)
  }

  /**
   * 记录单文件解析耗时
   */
  recordParseTime(duration: number): void {
    if (duration < 10) {
      this.parseDistribution.under10ms++
    } else if (duration < 100) {
      this.parseDistribution.under100ms++
    } else if (duration < 1000) {
      this.parseDistribution.under1s++
    } else if (duration < 10000) {
      this.parseDistribution.under10s++
    } else {
      this.parseDistribution.over10s++
    }
  }

  /**
   * 记录慢文件
   */
  recordSlowFile(file: SlowFileRecord): void {
    // 只保留耗时最长的 TOP 20
    if (this.slowFiles.length < this.MAX_SLOW_FILES) {
      this.slowFiles.push(file)
      this.slowFiles.sort((a, b) => b.duration - a.duration)
    } else if (file.duration > this.slowFiles[this.MAX_SLOW_FILES - 1].duration) {
      this.slowFiles[this.MAX_SLOW_FILES - 1] = file
      this.slowFiles.sort((a, b) => b.duration - a.duration)
    }
  }

  /**
   * 记录错误
   */
  recordError(error: ErrorDetail): void {
    this.errors.push(error)
  }

  /**
   * 设置文件统计
   */
  setFileStats(totalFiles: number, totalSize: number): void {
    this.totalFiles = totalFiles
    this.totalSize = totalSize
  }

  /**
   * 生成完整性能报告
   */
  generateReport(): ImportPerformanceReport {
    const totalDuration = Date.now() - this.startTime

    // 计算瓶颈阶段
    let bottleneck: ImportPhase | string = 'unknown'
    let bottleneckDuration = 0
    for (const phase of this.phaseTiming) {
      if (phase.duration > bottleneckDuration) {
        bottleneckDuration = phase.duration
        bottleneck = phase.phase
      }
    }
    const bottleneckPercent =
      totalDuration > 0 ? Math.round((bottleneckDuration / totalDuration) * 100) : 0

    // 计算错误统计
    const errorsByCategory: Record<ErrorCategory, number> = {
      parseError: 0,
      timeout: 0,
      unsupportedVersion: 0,
      corruptedFile: 0,
      permissionDenied: 0,
      outOfMemory: 0,
      unknown: 0
    }
    for (const error of this.errors) {
      errorsByCategory[error.errorCategory]++
    }

    const errorRate = this.totalFiles > 0 ? this.errors.length / this.totalFiles : 0

    return {
      taskId: this.taskId,
      phaseTiming: this.phaseTiming,
      totalDuration,
      bottleneck,
      bottleneckPercent,
      totalFiles: this.totalFiles,
      totalSize: this.totalSize,
      parseDistribution: this.parseDistribution,
      slowestFiles: this.slowFiles,
      errorSummary: {
        totalErrors: this.errors.length,
        errorRate,
        byCategory: errorsByCategory
      },
      errorDetails: this.errors,
      createdAt: new Date().toISOString()
    }
  }
}

/**
 * 根据错误信息分类错误类型
 */
export function classifyError(errorMessage: string): ErrorCategory {
  const msg = errorMessage.toLowerCase()

  if (msg.includes('timeout') || msg.includes('超时')) {
    return 'timeout'
  }
  if (msg.includes('unsupported') || msg.includes('不支持') || msg.includes('version')) {
    return 'unsupportedVersion'
  }
  if (msg.includes('corrupt') || msg.includes('损坏') || msg.includes('invalid')) {
    return 'corruptedFile'
  }
  if (msg.includes('permission') || msg.includes('access') || msg.includes('权限')) {
    return 'permissionDenied'
  }
  if (msg.includes('memory') || msg.includes('内存') || msg.includes('heap')) {
    return 'outOfMemory'
  }
  if (msg.includes('parse') || msg.includes('解析')) {
    return 'parseError'
  }

  return 'unknown'
}
