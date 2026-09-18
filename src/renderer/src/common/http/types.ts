import type { AxiosRequestConfig } from 'axios'

/**
 * 通用响应结构
 */
export interface ApiResponse<T = any> {
  code: number
  data: T
  message: string
  success: boolean
}

/**
 * 分页请求参数
 */
export interface PaginationParams {
  page: number
  pageSize: number
}

/**
 * 分页响应数据
 */
export interface PaginationData<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

/**
 * 扩展的请求配置
 */
export interface RequestOptions extends AxiosRequestConfig {
  // 是否显示错误提示
  showError?: boolean
  // 是否显示加载状态
  showLoading?: boolean
  // 自定义错误处理
  customErrorHandler?: (error: any) => void
  // 是否直接返回原始响应（AxiosResponse），跳过统一数据拦截
  returnRawResponse?: boolean
  // 是否跳过全局错误处理（例如401清理token等）
  skipGlobalErrorHandler?: boolean
}
