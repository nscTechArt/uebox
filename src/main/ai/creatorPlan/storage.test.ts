/** @vitest-environment node */
/**
 * 套餐连接和对象存储：
 * - 清单不带存储，预览里没有这一项
 * - 没开的默认勾，自己配好了桶的默认不勾
 * - 勾了：先记原配置再换成 `uebox`；还是套餐存储时重新导入不覆盖那份记录
 * - 取消勾选 / 断开 / 套餐明确不带存储了：还是套餐存储的照原样还原；用户自己换过的不动
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatorPlanManifest } from '../../../shared/creatorPlan'
import {
  DEFAULT_OBJECT_STORAGE_CONFIG,
  type ObjectStorageConfig,
  type ObjectStorageSaveInput
} from '../../../shared/objectStorage'
import type { PlanState } from './planState'

let config: ObjectStorageConfig
let hasSecret = false
let planState: PlanState
const saves: ObjectStorageSaveInput[] = []

vi.mock('../../services/objectStorage/objectStorageService', () => ({
  readObjectStorageConfig: async () => config,
  getObjectStorageView: async () => ({ ...config, hasSecret }),
  saveObjectStorageConfig: async (input: ObjectStorageSaveInput) => {
    saves.push(input)
    const rest = { ...input }
    delete rest.secretAccessKey
    config = rest
    return { ...config, hasSecret }
  }
}))
vi.mock('./planState', () => ({
  readPlanState: async () => planState,
  writePlanState: async (next: PlanState) => {
    planState = next
  }
}))

const { applyPlanStorage, planStoragePreview, releaseDroppedStorage, restorePlanStorage } =
  await import('./storage')

const MY_BUCKET: ObjectStorageConfig = {
  ...DEFAULT_OBJECT_STORAGE_CONFIG,
  enabled: true,
  preset: 'r2',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'my-bucket',
  accessKeyId: 'AK'
}

function manifest(enabled = true): CreatorPlanManifest {
  return {
    schema: 1,
    etag: 'p-1',
    plan: {
      product: 'Box Plan',
      tier: 'pro',
      tier_name: 'Pro',
      status: 'active',
      interval: 'month',
      current_period_end: null,
      cancel_at_period_end: false,
      quota_resets_at: null,
      manage_url: 'https://plan.example/account/billing'
    },
    quotas: {},
    api: { base_url: 'https://plan.example/v1' },
    roles: {},
    storage: {
      enabled,
      quota_bytes: 10 * 1024 ** 3,
      used_bytes: 0,
      max_object_bytes: 500 * 1024 ** 2,
      retention_days: 30
    }
  }
}

beforeEach(() => {
  config = { ...DEFAULT_OBJECT_STORAGE_CONFIG }
  hasSecret = false
  planState = { originals: {}, etag: null, manifest: null, unauthorized: false }
  saves.length = 0
})

describe('导入预览', () => {
  it('清单 storage.enabled 为假：没有这一项', async () => {
    expect(await planStoragePreview(manifest(false))).toBeNull()
  })

  it('没开对象存储：默认勾', async () => {
    expect(await planStoragePreview(manifest())).toMatchObject({
      current: { kind: 'none' },
      defaultSelected: true,
      quotaBytes: 10 * 1024 ** 3,
      retentionDays: 30
    })
  })

  it('自己配好了桶：列出来，默认不勾', async () => {
    config = { ...MY_BUCKET }
    hasSecret = true
    expect(await planStoragePreview(manifest())).toMatchObject({
      current: { kind: 'own', preset: 'r2', bucket: 'my-bucket' },
      defaultSelected: false
    })
  })

  it('已经是套餐存储：默认勾', async () => {
    config = { ...MY_BUCKET, preset: 'uebox' }
    expect(await planStoragePreview(manifest())).toMatchObject({
      current: { kind: 'plan' },
      defaultSelected: true
    })
  })
})

describe('导入与还原', () => {
  it('勾了：先记原配置，再只换预设、打开开关；桶的字段原样留着，不碰 Secret', async () => {
    config = { ...MY_BUCKET, enabled: false }
    await applyPlanStorage(manifest(), true)
    expect(planState.storageOriginal).toEqual({ ...MY_BUCKET, enabled: false })
    expect(config).toEqual({ ...MY_BUCKET, enabled: true, preset: 'uebox' })
    expect(saves.every((s) => s.secretAccessKey === undefined)).toBe(true)
  })

  it('重新导入不覆盖最初那份；断开还原并丢掉记录', async () => {
    config = { ...MY_BUCKET }
    await applyPlanStorage(manifest(), true)
    await applyPlanStorage(manifest(), true)
    expect(planState.storageOriginal).toEqual(MY_BUCKET)
    await restorePlanStorage()
    expect(config).toEqual(MY_BUCKET)
    expect(planState.storageOriginal).toBeUndefined()
  })

  it('重新导入时取消勾选：换回原来的', async () => {
    await applyPlanStorage(manifest(), true)
    expect(config.preset).toBe('uebox')
    await applyPlanStorage(manifest(), false)
    expect(config).toEqual(DEFAULT_OBJECT_STORAGE_CONFIG)
  })

  it('这次导入没带这一项（undefined）：不动', async () => {
    config = { ...MY_BUCKET }
    await applyPlanStorage(manifest(), undefined)
    expect(saves).toEqual([])
    expect(planState.storageOriginal).toBeUndefined()
  })

  it('中间换成了自己的新桶再重新导入：记录按新桶重记，断开回到新桶', async () => {
    config = { ...MY_BUCKET }
    await applyPlanStorage(manifest(), true)
    config = { ...MY_BUCKET, bucket: 'another' }
    await applyPlanStorage(manifest(), true)
    expect(planState.storageOriginal).toEqual({ ...MY_BUCKET, bucket: 'another' })
    await restorePlanStorage()
    expect(config).toEqual({ ...MY_BUCKET, bucket: 'another' })
  })

  it('套餐不再带存储（预览里没这一项）：还是套餐存储的照原来那份还原', async () => {
    config = { ...MY_BUCKET }
    await applyPlanStorage(manifest(), true)
    await applyPlanStorage(manifest(false), undefined)
    expect(config).toEqual(MY_BUCKET)
    expect(planState.storageOriginal).toBeUndefined()
  })

  it('清单里没有 storage 字段（服务端没说）：这次导入没带这一项就不动', async () => {
    config = { ...MY_BUCKET }
    await applyPlanStorage(manifest(), true)
    const silent = manifest()
    delete silent.storage
    await applyPlanStorage(silent, undefined)
    expect(config.preset).toBe('uebox')
  })

  it('清单刷新：订阅还在、套餐明确不带存储了，不等重新导入就还原', async () => {
    config = { ...MY_BUCKET }
    await applyPlanStorage(manifest(), true)
    const withRoles = (m: CreatorPlanManifest): CreatorPlanManifest => ({
      ...m,
      roles: { tts: { model: 'uebox-tts' } }
    })
    // 清单里一个角色都没有：不完整的清单，不据此动配置
    await releaseDroppedStorage(manifest(false))
    expect(config.preset).toBe('uebox')
    await releaseDroppedStorage(withRoles(manifest(false)))
    expect(config).toEqual(MY_BUCKET)
    // 订阅失效时不算「不带」：什么都不动
    await applyPlanStorage(manifest(), true)
    const lapsed: CreatorPlanManifest = {
      ...withRoles(manifest(false)),
      plan: { ...manifest().plan, status: 'canceled' }
    }
    await releaseDroppedStorage(lapsed)
    expect(config.preset).toBe('uebox')
  })

  it('用户在设置页自己换回了桶：断开时不动，只丢记录', async () => {
    await applyPlanStorage(manifest(), true)
    config = { ...MY_BUCKET, bucket: 'another' }
    saves.length = 0
    await restorePlanStorage()
    expect(saves).toEqual([])
    expect(config.bucket).toBe('another')
    expect(planState.storageOriginal).toBeUndefined()
  })

  it('状态文件丢了却还是套餐存储：关掉开关、预设回默认', async () => {
    config = { ...MY_BUCKET, preset: 'uebox' }
    await restorePlanStorage()
    expect(config).toMatchObject({ enabled: false, preset: 'aliyun', bucket: 'my-bucket' })
  })
})
