import request, { createAxiosInstance } from './request'
import { setupInterceptors } from './interceptors'
import type { ApiResponse, PaginationParams, PaginationData, RequestOptions } from './types'

export {
  // 请求实例和方法
  request,
  createAxiosInstance,

  // 拦截器
  setupInterceptors,

  // 类型
  ApiResponse,
  PaginationParams,
  PaginationData,
  RequestOptions
}

export default request
