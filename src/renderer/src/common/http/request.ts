import axios from 'axios'
import type { AxiosInstance, AxiosRequestConfig } from 'axios'
import { setupInterceptors } from './interceptors'
import { currentEnvConfig } from './config'

/**
 * 创建axios实例
 * @param config - axios配置
 */
export const createAxiosInstance = (config?: AxiosRequestConfig): AxiosInstance => {
  const instance = axios.create({
    baseURL: currentEnvConfig.baseURL, // 使用当前环境的baseURL
    timeout: currentEnvConfig.timeout || 30000, // 使用当前环境的超时设置或默认值
    headers: {
      'Content-Type': 'application/json',
      ...currentEnvConfig.headers // 合并当前环境的headers配置
    },
    ...config
  })

  // 设置拦截器
  setupInterceptors(instance)

  return instance
}

// 为返回值进行类型重载，使各请求方法返回服务端数据体 T
export interface TypedAxiosInstance extends AxiosInstance {
  request<T = any, D = any>(config: AxiosRequestConfig<D>): Promise<T>
  get<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<T>
  delete<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<T>
  head<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<T>
  options<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<T>
  post<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<T>
  put<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<T>
  patch<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<T>
}

// 创建默认实例并以重载类型导出
const request = createAxiosInstance() as TypedAxiosInstance

export default request
