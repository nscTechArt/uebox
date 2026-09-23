/**
 * 服务层守三件事：
 * - 链接在同一个换签格子里逐字相同（对话每轮重发，字节一变前缀缓存就断）。
 * - 拖进来就开传、发送时又要一次：两边拿到的是同一次上传，不传第二遍。
 * - 清理掉的对象记下来，发请求时换成说明。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'uebox-object-storage-'))

vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const secrets: Record<string, string> = {}
vi.mock('../../ai/credentials', () => ({
  saveLiteralKey: async (id: string, value: string) => {
    secrets[id] = value
  },
  deleteLiteralKey: async (id: string) => {
    delete secrets[id]
  },
  resolveApiKey: async (ref: { id: string }) => {
    if (!secrets[ref.id]) throw new Error('missing')
    return secrets[ref.id]
  }
}))

const headObject = vi.fn(async () => false)
const putObjectFromFile = vi.fn(async () => {})
const deleteObject = vi.fn(async () => {})
const listObjects = vi.fn(
  async (): Promise<Array<{ key: string; size: number; lastModified: string }>> => []
)
vi.mock('./s3Client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./s3Client')>()),
  headObject: (...args: unknown[]) => headObject(...(args as [])),
  putObjectFromFile: (...args: unknown[]) => putObjectFromFile(...(args as [])),
  deleteObject: (...args: unknown[]) => deleteObject(...(args as [])),
  listObjects: (...args: unknown[]) => listObjects(...(args as []))
}))

const service = await import('./objectStorageService')

const CONFIG = {
  enabled: true,
  preset: 'aliyun' as const,
  endpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
  region: 'cn-hangzhou',
  bucket: 'my-bucket',
  accessKeyId: 'AK',
  prefix: 'uebox-media',
  forcePathStyle: false,
  publicBaseUrl: '',
  autoCleanDays: 7
}

beforeEach(async () => {
  vi.clearAllMocks()
  await service.saveObjectStorageConfig({ ...CONFIG, secretAccessKey: 'SK' })
})

describe('配置', () => {
  it('Secret 只进不出，读回来只有「有没有」', async () => {
    const view = await service.getObjectStorageView()
    expect(view.hasSecret).toBe(true)
    expect(JSON.stringify(view)).not.toContain('SK')
    // 前缀规范化成以 / 结尾，清理时按前缀判断才不会误伤 `uebox-media-old/`
    expect(view.prefix).toBe('uebox-media/')
  })

  it('endpoint 末尾多带的桶名去掉（R2 控制台给的地址就带着）', async () => {
    const view = await service.saveObjectStorageConfig({
      ...CONFIG,
      preset: 'r2',
      endpoint: 'https://acc.r2.cloudflarestorage.com/my-bucket/',
      forcePathStyle: true
    })
    expect(view.endpoint).toBe('https://acc.r2.cloudflarestorage.com')
  })

  it('开着、配完整了才算可用', async () => {
    expect(await service.isObjectStorageReady()).toBe(true)
    await service.saveObjectStorageConfig({ ...CONFIG, enabled: false })
    expect(await service.isObjectStorageReady()).toBe(false)
  })
})

describe('链接', () => {
  const day = 24 * 3600 * 1000

  it('同一个 6 天格子里逐字相同，跨格才换签', async () => {
    // 1970 起第 3334 个 6 天格子的开头，往后挪几天仍在同一格
    const windowStart = 3334 * 6 * day
    const a = await service.mediaUrlFor('uebox-media/x.mp4', windowStart + 1000)
    const b = await service.mediaUrlFor('uebox-media/x.mp4', windowStart + 5 * day)
    const c = await service.mediaUrlFor('uebox-media/x.mp4', windowStart + 6 * day + 1000)

    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })

  it('配了公开域名就直接拼，永不过期', async () => {
    await service.saveObjectStorageConfig({ ...CONFIG, publicBaseUrl: 'https://cdn.example.com/' })
    expect(await service.mediaUrlFor('uebox-media/a b.mp4')).toBe(
      'https://cdn.example.com/uebox-media/a%20b.mp4'
    )
  })
})

describe('上传', () => {
  it('按内容哈希取键；同一个文件两次调用只传一遍', async () => {
    const file = path.join(userData, 'clip.mp4')
    writeFileSync(file, 'fake video bytes')

    const [first, second] = await Promise.all([
      service.uploadMediaFile(file),
      service.uploadMediaFile(file)
    ])

    expect(first.key).toMatch(/^uebox-media\/[0-9a-f]{32}\.mp4$/)
    expect(second.key).toBe(first.key)
    expect(putObjectFromFile).toHaveBeenCalledTimes(1)
  })

  it('拖进来时已经传完：发送时静默复用，不再报「等它传完」', async () => {
    const file = path.join(userData, 'dragged.mp4')
    writeFileSync(file, 'dragged video bytes')
    await service.uploadMediaFile(file)

    const notes: string[] = []
    await service.uploadMediaFile(file, (note) => notes.push(note))

    expect(notes).toEqual([])
    expect(putObjectFromFile).toHaveBeenCalledTimes(1)
  })

  it('还在传时接上的调用方看到的是真实阶段，并跟着往下走', async () => {
    const file = path.join(userData, 'joining.mp4')
    writeFileSync(file, 'joining video bytes')
    let answer: (exists: boolean) => void = () => {}
    headObject.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))

    const first = service.uploadMediaFile(file)
    await vi.waitFor(() => expect(headObject).toHaveBeenCalled())
    const notes: string[] = []
    const second = service.uploadMediaFile(file, (note) => notes.push(note))
    await vi.waitFor(() => expect(notes.length).toBeGreaterThan(0))
    answer(true)
    await Promise.all([first, second])

    expect(notes).toEqual([
      '正在确认对象存储里有没有 joining.mp4…',
      '对象存储里已经有 joining.mp4，直接复用'
    ])
  })

  it('桶里已经有了就不传', async () => {
    const file = path.join(userData, 'again.mp4')
    writeFileSync(file, 'another fake video')
    headObject.mockResolvedValueOnce(true)

    const result = await service.uploadMediaFile(file)

    expect(result.reused).toBe(true)
    expect(putObjectFromFile).not.toHaveBeenCalled()
  })
})

describe('清理', () => {
  it('删掉的记为已清理；前缀外的不动', async () => {
    const result = await service.removeStoredObjects(['uebox-media/gone.mp4', 'other/keep.mp4'])

    expect(result.removed).toBe(1)
    expect(result.failed).toEqual([{ key: 'other/keep.mp4', error: '不是盒子传的对象，不动' }])
    expect(deleteObject).toHaveBeenCalledTimes(1)
    expect(await service.isObjectRemoved('uebox-media/gone.mp4')).toBe(true)
    expect(await service.isObjectRemoved('other/keep.mp4')).toBe(false)
  })

  it('前缀留空：列举和清理只认盒子按哈希起名的对象，桶里别的数据不碰', async () => {
    await service.saveObjectStorageConfig({ ...CONFIG, prefix: '' })
    const own = `${'a'.repeat(32)}.mp4`
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    listObjects.mockResolvedValueOnce([
      { key: own, size: 1, lastModified: old },
      { key: 'backups/db.sql', size: 1, lastModified: old },
      { key: 'photo.jpg', size: 1, lastModified: old }
    ])

    const result = await service.cleanOlderThan(7)

    expect(result.removed).toBe(1)
    expect(deleteObject).toHaveBeenCalledTimes(1)
    expect(deleteObject.mock.calls[0]).toContain(own)
  })

  it('清理过的文件再拖进来，重新确认桶里有没有，不拿已删的键', async () => {
    const file = path.join(userData, 'cleaned.mp4')
    writeFileSync(file, 'cleaned video bytes')
    const { key } = await service.uploadMediaFile(file)
    await service.removeStoredObjects([key])

    await service.uploadMediaFile(file)

    expect(putObjectFromFile).toHaveBeenCalledTimes(2)
    expect(await service.isObjectRemoved(key)).toBe(false)
  })

  it('同一个文件再用一次也记成「刚用过」', async () => {
    const file = path.join(userData, 'touched.mp4')
    writeFileSync(file, 'touched video bytes')
    const { key } = await service.uploadMediaFile(file)
    const tenDays = 10 * 24 * 3600 * 1000
    vi.useFakeTimers({ now: Date.now() + tenDays, toFake: ['Date'] })
    try {
      await service.uploadMediaFile(file)
      listObjects.mockResolvedValueOnce([
        { key, size: 1, lastModified: new Date(Date.now() - tenDays).toISOString() }
      ])
      expect((await service.cleanOlderThan(7)).removed).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('两个上传同时收尾，登记里两条都在', async () => {
    const a = path.join(userData, 'race-a.mp4')
    const b = path.join(userData, 'race-b.mp4')
    writeFileSync(a, 'race a bytes')
    writeFileSync(b, 'race b bytes')
    const [first, second] = await Promise.all([
      service.uploadMediaFile(a),
      service.uploadMediaFile(b)
    ])
    const saved = JSON.parse(
      readFileSync(path.join(userData, 'object-storage-index.json'), 'utf-8')
    )
    const keys = saved.uploads.map((item: { key: string }) => item.key)
    expect(keys).toEqual(expect.arrayContaining([first.key, second.key]))
  })

  it('按最后一次用到的时间算：去重复用过的旧文件不清', async () => {
    const file = path.join(userData, 'reused.mp4')
    writeFileSync(file, 'reused video bytes')
    headObject.mockResolvedValueOnce(true)
    const { key } = await service.uploadMediaFile(file)
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
    listObjects.mockResolvedValueOnce([
      { key, size: 1, lastModified: tenDaysAgo },
      { key: 'uebox-media/stale.mp4', size: 1, lastModified: tenDaysAgo }
    ])

    const result = await service.cleanOlderThan(7)

    expect(result.removed).toBe(1)
    expect(deleteObject).toHaveBeenCalledTimes(1)
    expect(deleteObject.mock.calls[0]).toContain('uebox-media/stale.mp4')
  })
})

describe('isPrivateEndpoint', () => {
  it('本机和内网地址厂商访问不到，测试连接要说出来', () => {
    expect(service.isPrivateEndpoint('http://127.0.0.1:9000')).toBe(true)
    expect(service.isPrivateEndpoint('http://localhost:9000')).toBe(true)
    expect(service.isPrivateEndpoint('http://192.168.1.20:9000')).toBe(true)
    expect(service.isPrivateEndpoint('http://172.20.0.5')).toBe(true)
    expect(service.isPrivateEndpoint('https://s3.oss-cn-hangzhou.aliyuncs.com')).toBe(false)
    expect(service.isPrivateEndpoint('https://8.8.8.8')).toBe(false)
    // 自己 NAS 上的 MinIO 走 Tailscale、或者 IPv6 唯一本地地址：厂商一样访问不到
    expect(service.isPrivateEndpoint('http://100.101.2.3:9000')).toBe(true)
    expect(service.isPrivateEndpoint('http://[fd12::5]:9000')).toBe(true)
    expect(service.isPrivateEndpoint('http://169.254.10.1')).toBe(true)
  })
})
