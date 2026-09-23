/**
 * `uebox` 预设（Box Plan 的存储）在服务层的分派：调用方无感。
 * - 预设是 uebox：上传、列举、删除、测试、用量都转给套餐那边，不碰 S3
 * - 按键要链接 / 问在不在：套餐存储的键由套餐那边回答，其余照旧走自己的桶
 *   （换成套餐存储后，对话里以前传进自己桶里的对象照样能用）
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'uebox-object-storage-plan-'))

vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const secrets: Record<string, string> = { 'object-storage:secret-access-key': 'SK' }
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

const s3Touched = vi.fn()
vi.mock('./s3Client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./s3Client')>()),
  headObject: async () => s3Touched('head'),
  putObjectFromFile: async () => s3Touched('put'),
  deleteObject: async () => s3Touched('delete'),
  listObjects: async () => s3Touched('list')
}))

const PLAN_KEY = '9f86d081884c7d659a2feaa0c55ad015.mp4'
const plan = {
  isPlanStorageReady: vi.fn(async () => true),
  uploadToPlan: vi.fn(async () => ({ key: PLAN_KEY, reused: false })),
  planMediaUrl: vi.fn(async (key: string) =>
    key === PLAN_KEY ? 'https://plan.example/m/x/' + PLAN_KEY : undefined
  ),
  isPlanObjectRemoved: vi.fn(async (key: string) => (key === PLAN_KEY ? false : undefined)),
  listPlanObjects: vi.fn(async () => [{ key: PLAN_KEY, size: 1, lastModified: '' }]),
  removePlanObjects: vi.fn(async (keys: string[]) => ({ removed: keys.length, failed: [] })),
  planStorageUsage: vi.fn(async () => ({
    quotaBytes: 10,
    usedBytes: 1,
    objectCount: 1,
    retentionDays: 30
  })),
  testPlanStorage: vi.fn(async () => ({ ok: true, message: 'ok' }))
}
vi.mock('../../ai/creatorPlan/storageBackend', () => plan)

const service = await import('./objectStorageService')

/** 从自己的桶换成套餐存储：桶的字段原样留着，只换预设 */
const BUCKET = {
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
  s3Touched.mockClear()
  for (const fn of Object.values(plan)) fn.mockClear()
  await service.saveObjectStorageConfig({ ...BUCKET, preset: 'uebox' })
})

describe('预设是 uebox', () => {
  it('能不能用：开关开着才问套餐那边（只看本机）', async () => {
    expect(await service.isObjectStorageReady()).toBe(true)
    expect(plan.isPlanStorageReady).toHaveBeenCalled()
    await service.saveObjectStorageConfig({ ...BUCKET, preset: 'uebox', enabled: false })
    plan.isPlanStorageReady.mockClear()
    expect(await service.isObjectStorageReady()).toBe(false)
    expect(plan.isPlanStorageReady).not.toHaveBeenCalled()
  })

  it('上传转给套餐，按扩展名带上 content_type，不碰 S3', async () => {
    const file = path.join(userData, `clip-${Date.now()}.mp4`)
    writeFileSync(file, 'video')
    expect(await service.uploadMediaFile(file)).toEqual({ key: PLAN_KEY, reused: false })
    expect(plan.uploadToPlan).toHaveBeenCalledWith(
      file,
      'video/mp4',
      expect.any(Function),
      expect.any(Function)
    )
    expect(s3Touched).not.toHaveBeenCalled()
  })

  it('删掉之后同一个文件再拖进来：重新走套餐那边（不复用已删的键）', async () => {
    const file = path.join(userData, `again-${Date.now()}.mp4`)
    writeFileSync(file, 'video')
    await service.uploadMediaFile(file)
    await service.uploadMediaFile(file)
    expect(plan.uploadToPlan).toHaveBeenCalledTimes(1)
    await service.removeStoredObjects([PLAN_KEY])
    await service.uploadMediaFile(file)
    expect(plan.uploadToPlan).toHaveBeenCalledTimes(2)
  })

  it('列举、删除、测试、用量都转给套餐', async () => {
    expect(await service.listStoredObjects()).toHaveLength(1)
    expect(await service.removeStoredObjects([PLAN_KEY])).toEqual({ removed: 1, failed: [] })
    expect(await service.testObjectStorage({ ...BUCKET, preset: 'uebox' })).toEqual({
      ok: true,
      message: 'ok'
    })
    expect(await service.objectStorageUsage()).toMatchObject({ usedBytes: 1, retentionDays: 30 })
    expect(s3Touched).not.toHaveBeenCalled()
  })
})

describe('按键要链接', () => {
  it('套餐存储的键：用套餐记下的链接（永不改变，不换签）', async () => {
    expect(await service.mediaUrlFor(PLAN_KEY)).toBe('https://plan.example/m/x/' + PLAN_KEY)
    expect(await service.isObjectRemoved(PLAN_KEY)).toBe(false)
  })

  it('以前传进自己桶里的键：照旧签自己桶的链接', async () => {
    const url = await service.mediaUrlFor('uebox-media/abc.mp4', Date.UTC(2026, 0, 1))
    expect(url).toContain('my-bucket')
    expect(url).toContain('X-Amz-Signature=')
    expect(await service.isObjectRemoved('uebox-media/abc.mp4')).toBe(false)
  })

  it('换回自己的桶后：用量回 null', async () => {
    await service.saveObjectStorageConfig(BUCKET)
    expect(await service.objectStorageUsage()).toBeNull()
  })
})
