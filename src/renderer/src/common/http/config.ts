/**
 * HTTP请求环境配置
 */

// 环境类型
export type EnvType = 'development' | 'test' | 'production'

// 环境配置接口
export interface EnvConfig {
  baseURL: string
  timeout?: number
  headers?: Record<string, string>
}

// 获取环境变量
const getEnvValue = (key: string, defaultValue: string = ''): string => {
  return import.meta.env[key] || defaultValue
}

// 当前环境
export const currentEnv = getEnvValue('VITE_APP_ENV', 'development') as EnvType

// 当前环境配置
export const currentEnvConfig: EnvConfig = {
  baseURL: '',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
}
