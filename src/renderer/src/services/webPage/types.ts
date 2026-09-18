/**
 * 网页生成服务类型定义
 * 用于把知识库内容做成一个单页网页
 */

/**
 * 网页生成状态
 */
export type WebPageStatus = 'idle' | 'analyzing' | 'generating' | 'completed' | 'failed'

/**
 * 网页状态接口
 */
export interface WebPageState {
  /** 当前状态 */
  status: WebPageStatus
  /** 生成进度 (0-100) */
  progress: number
  /** 状态消息 */
  message: string
  /** 错误信息 */
  error?: string
  /** 生成的 HTML 内容 */
  htmlContent?: string
}
