import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, ipcMain: {}, safeStorage: {} }))

const { createSecureStore, isSecureStoreKey } = await import('./secureStore')

/** 「加密」= 反转再 base64：够让测试分辨出磁盘上不是明文 */
function fakeCipher(available = true): Parameters<typeof createSecureStore>[1] {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from([...plain].reverse().join('')).toString('base64'),
    decryptString: (bytes: Buffer) =>
      [...Buffer.from(bytes.toString(), 'base64').toString()].reverse().join('')
  } as unknown as Parameters<typeof createSecureStore>[1]
}

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'secure-store-')), 'secrets.bin')

describe('secureStore', () => {
  it('写入后能读回，磁盘上没有明文', async () => {
    const file = tempFile()
    const store = createSecureStore(file, fakeCipher())
    await store.write('webdav-store', '{"password":"hunter2"}')

    expect(readFileSync(file, 'utf8')).not.toContain('hunter2')
    const reopened = createSecureStore(file, fakeCipher())
    expect(await reopened.read()).toEqual({
      available: true,
      values: { 'webdav-store': '{"password":"hunter2"}' }
    })
  })

  it('写 null 删除这一项，其他项保留', async () => {
    const store = createSecureStore(tempFile(), fakeCipher())
    await store.write('baiduyun-store', 'token')
    await store.write('assetManagement.serverApiKey', 'key')
    await store.write('baiduyun-store', null)

    expect((await store.read()).values).toEqual({ 'assetManagement.serverApiKey': 'key' })
  })

  it('safeStorage 不可用时拒绝写入，不留文件', async () => {
    const file = tempFile()
    const store = createSecureStore(file, fakeCipher(false))

    await expect(store.write('webdav-store', 'x')).rejects.toThrow('safeStorage')
    expect(existsSync(file)).toBe(false)
    expect(await store.read()).toEqual({ available: false, values: {} })
  })

  it('密文解不开时按空库处理', async () => {
    const file = tempFile()
    writeFileSync(file, 'garbage')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await createSecureStore(file, fakeCipher()).read()).values).toEqual({})
  })

  it('只接受白名单里的 key', () => {
    expect(isSecureStoreKey('webdav-store')).toBe(true)
    expect(isSecureStoreKey('ai-config-store')).toBe(false)
    expect(isSecureStoreKey(undefined)).toBe(false)
  })
})
