import type { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import type { RequestOptions } from './types'

const requestInterceptor = (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
  const url = String(config.url || '')
  const baseURL = String(config.baseURL || '')
  if (!/^https?:\/\//i.test(url) && !/^https?:\/\//i.test(baseURL)) {
    throw new Error('An explicit HTTP service URL is required')
  }
  if ((config as RequestOptions).returnRawResponse) config.validateStatus = () => true
  return config
}

const responseInterceptor = <T>(response: AxiosResponse<T>): T => {
  if ((response.config as RequestOptions).returnRawResponse) return response as unknown as T
  return response.data
}

const responseErrorInterceptor = async (error: AxiosError): Promise<never> => {
  const { response } = error
  const cfg = error.config as RequestOptions | undefined
  if (cfg?.skipGlobalErrorHandler || cfg?.returnRawResponse) {
    return Promise.reject(error)
  }

  let friendlyMessage = ''
  if (response?.data) {
    const data = response.data as Record<string, unknown>
    if (typeof data.message === 'string') {
      friendlyMessage = data.message
    }
    if (!friendlyMessage && typeof data.error === 'string') {
      friendlyMessage = data.error
    }
    if (!friendlyMessage && data.error && typeof data.error === 'object') {
      const errorObj = data.error as Record<string, unknown>
      if (typeof errorObj.message === 'string') {
        friendlyMessage = errorObj.message
      } else if (typeof errorObj.msg === 'string') {
        friendlyMessage = errorObj.msg
      }
    }
  }

  if (response) {
    switch (response.status) {
      case 401:
      case 403:
        break
      case 404:
        console.error('请求的资源不存在')
        break
      case 500:
        console.error('服务器错误')
        break
      default:
        console.error(`请求错误: ${response.status}`)
    }
  } else {
    const timeoutMs = typeof cfg?.timeout === 'number' ? cfg.timeout : undefined
    if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
      console.error(`请求超时${timeoutMs ? `: ${timeoutMs}ms` : ''}`)
    } else if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
      console.error('请求已取消')
    } else {
      console.error('网络错误')
    }
  }

  if (friendlyMessage) {
    const customError = new Error(friendlyMessage) as Error & {
      response?: typeof response
      code?: string
    }
    customError.response = response
    customError.code = error.code
    return Promise.reject(customError)
  }

  return Promise.reject(error)
}

export const setupInterceptors = (instance: AxiosInstance): void => {
  instance.interceptors.request.use(requestInterceptor)
  instance.interceptors.response.use(responseInterceptor, responseErrorInterceptor)
}
