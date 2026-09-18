// 应用控制通用类型定义

export interface AppControlSuccessResult {
  success: true
  message?: string
  count?: number
  [key: string]: unknown
}

export interface AppControlErrorResult {
  success: false
  error: string
}

export type AppControlResult = AppControlSuccessResult | AppControlErrorResult
