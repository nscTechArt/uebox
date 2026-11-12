/**
 * 凭据的同步存储接口，背后是主进程的加密文件（main/ipc/secureStore.ts）。
 *
 * pinia 的 storage 和 `localStorage.getItem` 都是同步的，所以跟 chatHistoryStorage 一样：
 * 启动时 `preload()` 把凭据读进内存，之后读走内存，写改内存并异步落盘。
 *
 * 迁移：加密文件里没有、localStorage 里有的 key，读进来写进加密文件，写成功后才删掉
 * localStorage 里的明文。safeStorage 不可用（少数没有密钥环的 Linux）时不迁移、不写盘：
 * 旧的明文原样留着照常能用；一旦改写或删除，就只在内存里留到本次运行结束 —— 不把凭据明文写盘。
 */

import { secureStoreAPI } from '@renderer/api/secureStore'

/** 与 main/ipc/secureStore.ts 的白名单一致 */
const SECURE_KEYS = [
  'assetManagement.serverApiKey',
  'assetManagement.serverAuthToken',
  'assetManagement.serverUsername',
  'baiduyun-store',
  'webdav-store'
]

export class SecureStorage implements Storage {
  private cache = new Map<string, string>()
  private available = false

  get length(): number {
    return this.cache.size
  }

  key(index: number): string | null {
    return [...this.cache.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.cache.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.cache.set(key, value)
    this.persist(key, value)
  }

  removeItem(key: string): void {
    this.cache.delete(key)
    this.persist(key, null)
  }

  clear(): void {
    for (const key of [...this.cache.keys()]) this.removeItem(key)
  }

  /** 必须在任何用到凭据的 store 或页面之前 await 完 */
  async preload(): Promise<void> {
    let snapshot
    try {
      snapshot = await secureStoreAPI.read()
    } catch (error) {
      console.error('[secureStorage] 读取加密凭据失败，本次只用 localStorage 里的旧值:', error)
      snapshot = { available: false, values: {} }
    }
    this.available = snapshot.available

    const toMigrate: string[] = []
    for (const key of SECURE_KEYS) {
      const stored = snapshot.values[key]
      if (typeof stored === 'string') {
        this.cache.set(key, stored)
        // 上次迁移写好了加密副本、却没来得及删明文
        if (this.available) localStorage.removeItem(key)
        continue
      }
      const legacy = localStorage.getItem(key)
      if (legacy !== null) {
        this.cache.set(key, legacy)
        toMigrate.push(key)
      }
    }

    if (!this.available) return
    for (const key of toMigrate) {
      try {
        await secureStoreAPI.write(key, this.cache.get(key) as string)
        localStorage.removeItem(key)
      } catch (error) {
        console.error(`[secureStorage] ${key} 迁移失败，明文留在原处，下次启动再试:`, error)
      }
    }
  }

  private persist(key: string, value: string | null): void {
    // 不可用时也清掉旧明文：否则改过或退出登录之后，重启又读回旧值
    if (!this.available) {
      localStorage.removeItem(key)
      return
    }
    // 加密副本已经写好或已删除之后，才清掉可能残留的旧明文
    secureStoreAPI
      .write(key, value)
      .then(() => localStorage.removeItem(key))
      .catch((error) => console.error(`[secureStorage] ${key} 写入失败:`, error))
  }
}

export const secureStorage = new SecureStorage()
