import { PersistenceOptions } from 'pinia-plugin-persistedstate'

/**
 * 创建自定义持久化配置的hook
 * @param options 持久化配置选项
 * @returns 持久化配置对象
 */
export function usePersistOptions<S>(options?: {
  key?: string
  paths?: Array<keyof S>
  storage?: 'localStorage' | 'sessionStorage'
  serializer?: {
    serialize: (value: any) => string
    deserialize: (value: string) => any
  }
}): PersistenceOptions {
  // 默认配置
  const defaultOptions: PersistenceOptions = {
    storage: localStorage,
    key: 'pinia-store'
  }

  // 合并配置
  const mergedOptions: PersistenceOptions = {
    ...defaultOptions,
    ...(options?.key && { key: options.key }),
    ...(options?.paths && { paths: options.paths as string[] }),
    ...(options?.storage && {
      storage: options.storage === 'sessionStorage' ? sessionStorage : localStorage
    }),
    ...(options?.serializer && { serializer: options.serializer })
  }

  return mergedOptions
}
