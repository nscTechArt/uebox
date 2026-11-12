import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const read = vi.fn()
const write = vi.fn()
vi.mock('@renderer/api/secureStore', () => ({ secureStoreAPI: { read, write } }))

const { SecureStorage } = await import('./secureStorage')

describe('secureStorage', () => {
  beforeEach(() => {
    localStorage.clear()
    read.mockReset()
    write.mockReset().mockResolvedValue(undefined)
  })

  it('把 localStorage 里的旧明文搬进加密存储，写成功后才删明文', async () => {
    localStorage.setItem('webdav-store', 'legacy')
    localStorage.setItem('app-theme', 'dark')
    read.mockResolvedValue({ available: true, values: {} })

    const storage = new SecureStorage()
    await storage.preload()

    expect(write).toHaveBeenCalledWith('webdav-store', 'legacy')
    expect(storage.getItem('webdav-store')).toBe('legacy')
    expect(localStorage.getItem('webdav-store')).toBeNull()
    // 不在白名单里的 key 不碰
    expect(localStorage.getItem('app-theme')).toBe('dark')
  })

  it('迁移写入失败时明文留在原处，下次启动再试', async () => {
    localStorage.setItem('baiduyun-store', 'legacy')
    read.mockResolvedValue({ available: true, values: {} })
    write.mockRejectedValue(new Error('disk full'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const storage = new SecureStorage()
    await storage.preload()

    expect(storage.getItem('baiduyun-store')).toBe('legacy')
    expect(localStorage.getItem('baiduyun-store')).toBe('legacy')
  })

  it('加密存储里已有的值优先，并清掉残留的明文', async () => {
    localStorage.setItem('assetManagement.serverApiKey', 'stale')
    read.mockResolvedValue({ available: true, values: { 'assetManagement.serverApiKey': 'k' } })

    const storage = new SecureStorage()
    await storage.preload()

    expect(storage.getItem('assetManagement.serverApiKey')).toBe('k')
    expect(localStorage.getItem('assetManagement.serverApiKey')).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('写入和删除同步改内存，再异步写进加密存储', async () => {
    read.mockResolvedValue({ available: true, values: {} })
    const storage = new SecureStorage()
    await storage.preload()

    storage.setItem('assetManagement.serverAuthToken', 't')
    expect(storage.getItem('assetManagement.serverAuthToken')).toBe('t')
    storage.removeItem('assetManagement.serverAuthToken')
    expect(storage.getItem('assetManagement.serverAuthToken')).toBeNull()
    await flushPromises()

    expect(write.mock.calls).toEqual([
      ['assetManagement.serverAuthToken', 't'],
      ['assetManagement.serverAuthToken', null]
    ])
  })

  it('safeStorage 不可用时：旧明文照常可读、不迁移；改写后只留在内存，不写明文', async () => {
    localStorage.setItem('webdav-store', 'legacy')
    read.mockResolvedValue({ available: false, values: {} })

    const storage = new SecureStorage()
    await storage.preload()
    expect(storage.getItem('webdav-store')).toBe('legacy')
    expect(localStorage.getItem('webdav-store')).toBe('legacy')

    storage.setItem('webdav-store', 'new')
    await flushPromises()

    expect(storage.getItem('webdav-store')).toBe('new')
    expect(localStorage.getItem('webdav-store')).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })
})
