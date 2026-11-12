/**
 * 渲染层凭据的加密落盘。
 *
 * 资产服务器的 API Key / 登录令牌、百度网盘令牌、WebDAV 账号密码原来明文存在
 * localStorage 里。现在放在 `<userData>/renderer-secrets.bin`，整份用 safeStorage 加密
 * （Windows DPAPI / macOS 钥匙串 / Linux 密钥环）。
 *
 * 跟 `ai/credentials.ts` 的区别：那边的密钥只在主进程用，明文不进渲染层；这几项是渲染层
 * 自己发请求要用的（资产服务器、网盘 OAuth、WebDAV），所以读接口会把值交回渲染层，
 * 这里只管「磁盘上不留明文」。
 *
 * safeStorage 不可用时拒绝写入，不降级成明文 —— 渲染层那边只在内存里留到本次运行结束。
 */

import { app, ipcMain, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { serialQueue } from './chatSessionFiles'

/** key 是白名单，渲染层不能拿它当通用加密存储随便塞东西 */
export const SECURE_STORE_KEYS = [
  'assetManagement.serverApiKey',
  'assetManagement.serverAuthToken',
  'assetManagement.serverUsername',
  'baiduyun-store',
  'webdav-store'
] as const
export type SecureStoreKey = (typeof SECURE_STORE_KEYS)[number]

export interface SecureStoreSnapshot {
  /** false 时写入会被拒绝 */
  available: boolean
  values: Partial<Record<SecureStoreKey, string>>
}

interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export function isSecureStoreKey(key: unknown): key is SecureStoreKey {
  return SECURE_STORE_KEYS.includes(key as SecureStoreKey)
}

export interface SecureStore {
  read(): Promise<SecureStoreSnapshot>
  /** value 为 null 表示删除 */
  write(key: SecureStoreKey, value: string | null): Promise<void>
}

export function createSecureStore(filePath: string, cipher: Cipher): SecureStore {
  let cache: Partial<Record<SecureStoreKey, string>> | null = null
  const enqueue = serialQueue()

  async function load(): Promise<Partial<Record<SecureStoreKey, string>>> {
    if (cache) return cache
    try {
      const bytes = await fs.readFile(filePath)
      cache = JSON.parse(cipher.decryptString(bytes))
    } catch (error) {
      // 没有文件是「还没存过」；换机器、重装系统后密文解不开也按空库处理，用户重新登录即可
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[secureStore] 读取失败，按空库处理:', error)
      }
      cache = {}
    }
    return cache!
  }

  async function read(): Promise<SecureStoreSnapshot> {
    return { available: cipher.isEncryptionAvailable(), values: { ...(await load()) } }
  }

  function write(key: SecureStoreKey, value: string | null): Promise<void> {
    return enqueue(async () => {
      if (!cipher.isEncryptionAvailable()) {
        throw new Error('safeStorage 不可用，拒绝把凭据明文写入磁盘')
      }
      const next = { ...(await load()) }
      if (value === null) delete next[key]
      else next[key] = value
      await fs.mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, cipher.encryptString(JSON.stringify(next)))
      await fs.rename(tmp, filePath)
      cache = next
    })
  }

  return { read, write }
}

export function registerSecureStoreIPC(): void {
  const store = createSecureStore(
    join(app.getPath('userData'), 'renderer-secrets.bin'),
    safeStorage
  )

  ipcMain.handle('secure-store:read', () => store.read())
  ipcMain.handle('secure-store:write', (_event, key: unknown, value: unknown) => {
    if (!isSecureStoreKey(key)) throw new Error(`未知的凭据 key: ${String(key)}`)
    return store.write(key, typeof value === 'string' ? value : null)
  })
}
