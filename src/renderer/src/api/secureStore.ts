/**
 * 渲染层凭据的加密存储；见 main/ipc/secureStore.ts。
 *
 * 不走 unwrapResult：主进程直接返回数据、出错时 invoke 本身 reject，没有 `{ success }` 外壳。
 * 调用方只有 utils/secureStorage.ts，失败由它决定是保留旧数据还是只留在内存里。
 */

export interface SecureStoreSnapshot {
  available: boolean
  values: Record<string, string>
}

export const secureStoreAPI = {
  read: (): Promise<SecureStoreSnapshot> => window.api.secureStore.read(),
  write: (key: string, value: string | null): Promise<void> =>
    window.api.secureStore.write(key, value)
}
