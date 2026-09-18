/**
 * 导入性能追踪类型定义
 * 用于瓶颈分析和错误率追踪
 */

/**
 * 导入阶段名称
 */
export type ImportPhase =
  | 'fileDiscovery'
  | 'metadataScan'
  | 'assetParsing'
  | 'thumbnailExtract'
  | 'dbTransaction'
  | 'indexBuilding'

/**
 * 阶段耗时记录
 */
export interface PhaseTiming {
  /** 阶段名称 */
  phase: ImportPhase
  /** 耗时(毫秒) */
  duration: number
  /** 处理项数量 */
  itemCount: number
}

/**
 * 解析耗时分布统计
 */
export interface ParseDistribution {
  /** <10ms 的文件数 */
  under10ms: number
  /** 10-100ms 的文件数 */
  under100ms: number
  /** 100ms-1s 的文件数 */
  under1s: number
  /** 1-10s 的文件数 */
  under10s: number
  /** >10s 的文件数 */
  over10s: number
}

/**
 * 错误分类
 */
export type ErrorCategory =
  | 'parseError'
  | 'timeout'
  | 'unsupportedVersion'
  | 'corruptedFile'
  | 'permissionDenied'
  | 'outOfMemory'
  | 'unknown'

/**
 * 错误详情
 */
export interface ErrorDetail {
  /** 文件路径 */
  filePath: string
  /** 文件名 */
  fileName: string
  /** 文件大小(字节) */
  fileSize: number
  /** 错误分类 */
  errorCategory: ErrorCategory
  /** 错误信息 */
  errorMessage: string
  /** 尝试耗时(毫秒) */
  duration: number
  /** UE版本(如果能识别) */
  ueVersion?: string
  /** 资产类型(如果能识别) */
  assetClass?: string
}

/**
 * 慢文件记录
 */
export interface SlowFileRecord {
  /** 文件路径 */
  filePath: string
  /** 文件大小(字节) */
  fileSize: number
  /** 解析耗时(毫秒) */
  duration: number
  /** 资产类型 */
  assetType: string
}

/**
 * 错误统计汇总
 */
export interface ErrorSummary {
  /** 总错误数 */
  totalErrors: number
  /** 错误率 (0-1) */
  errorRate: number
  /** 按分类统计 */
  byCategory: Record<ErrorCategory, number>
}

/**
 * 完整的导入性能报告
 */
export interface ImportPerformanceReport {
  /** 导入任务ID */
  taskId: string

  // ===== 阶段耗时 =====
  /** 各阶段耗时明细 */
  phaseTiming: PhaseTiming[]
  /** 总耗时(毫秒) */
  totalDuration: number
  /** 瓶颈阶段 */
  bottleneck: ImportPhase | string
  /** 瓶颈阶段占比(0-100) */
  bottleneckPercent: number

  // ===== 资产统计 =====
  /** 总文件数 */
  totalFiles: number
  /** 总大小(字节) */
  totalSize: number
  /** 解析耗时分布 */
  parseDistribution: ParseDistribution
  /** 最慢的文件列表(Top 20) */
  slowestFiles: SlowFileRecord[]

  // ===== 错误统计 =====
  /** 错误汇总 */
  errorSummary: ErrorSummary
  /** 错误详情列表 */
  errorDetails: ErrorDetail[]

  /** 创建时间 */
  createdAt: string
}

/**
 * 性能采集器状态
 */
export interface PerformanceCollector {
  /** 开始采集 */
  startPhase(phase: ImportPhase): void
  /** 结束采集 */
  endPhase(phase: ImportPhase, itemCount: number): void
  /** 记录单文件解析耗时 */
  recordParseTime(duration: number): void
  /** 记录慢文件 */
  recordSlowFile(file: SlowFileRecord): void
  /** 记录错误 */
  recordError(error: ErrorDetail): void
  /** 生成报告 */
  generateReport(): ImportPerformanceReport
}
