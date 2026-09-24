/** @vitest-environment node */
/**
 * `uebox` 预设的后端：
 * - 申请 → 上传 → 确认；命中 exists 不传
 * - 链接记在本机，要链接时不联网；没到期不问服务端，过期了问一次，没了换成说明
 * - 清单说单个文件超限的，不发请求
 * - 没连接时一个请求都不发
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatorPlanManifest } from '../../../shared/creatorPlan'
import type { PlanState } from './planState'

let userData = mkdtempSync(path.join(tmpdir(), 'uebox-plan-storage-'))
let planState: PlanState
let apiKey: string | null = 'ubx-sk-local'

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../credentials', () => ({
  resolveApiKey: async () => {
    if (!apiKey) throw new Error('missing')
    return apiKey
  }
}))
vi.mock('./planState', () => ({ readPlanState: async () => planState }))

const backend = await import('./storageBackend')

const KEY = '9f86d081884c7d659a2feaa0c55ad015.mp4'
const LINK = `https://plan.example/m/a7Kx2q/${KEY}`
const FUTURE = '2099-01-01T00:00:00Z'
const PAST = '2000-01-01T00:00:00Z'

function manifest(
  storage: Partial<NonNullable<CreatorPlanManifest['storage']>> = {}
): CreatorPlanManifest {
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
      enabled: true,
      quota_bytes: 10 * 1024 ** 3,
      used_bytes: 0,
      max_object_bytes: 1024,
      retention_days: 30,
      ...storage
    }
  }
}

type Route = (url: URL, init: RequestInit) => Response
function fakeFetch(route: Route): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fn = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push(`${init.method ?? 'GET'} ${url.pathname}`)
    return route(url, init)
  }) as unknown as typeof fetch
  return { fetch: fn, calls }
}
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

function writeFile(name: string, bytes: number): string {
  const file = path.join(userData, name)
  writeFileSync(file, Buffer.alloc(bytes, 7))
  return file
}

const noop = (): void => {}

beforeEach(() => {
  rmSync(userData, { recursive: true, force: true })
  userData = mkdtempSync(path.join(tmpdir(), 'uebox-plan-storage-'))
  backend.resetPlanStorageIndexCache()
  planState = { originals: {}, etag: null, manifest: manifest(), unauthorized: false }
  apiKey = 'ubx-sk-local'
})

describe('上传', () => {
  it('没传过：申请 → 按上传地址 PUT → 确认，链接记在本机', async () => {
    const put = vi.fn(async () => {})
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/storage/uploads') {
        return json(200, {
          exists: false,
          key: KEY,
          url: LINK,
          upload: {
            method: 'PUT',
            url: 'http://staging.example/x',
            headers: { 'Content-Type': 'video/mp4' }
          }
        })
      }
      return json(200, { key: KEY, url: LINK, size: 100, expires_at: FUTURE })
    })
    const percents: number[] = []
    const result = await backend.uploadToPlan(
      writeFile('clip.mp4', 100),
      'video/mp4',
      noop,
      (p) => percents.push(p.percent),
      { fetch, put }
    )
    expect(result).toMatchObject({ key: KEY, reused: false })
    expect(calls).toEqual(['POST /v1/storage/uploads', `POST /v1/storage/uploads/${KEY}/complete`])
    expect(put).toHaveBeenCalledWith(
      { method: 'PUT', url: 'http://staging.example/x', headers: { 'Content-Type': 'video/mp4' } },
      expect.stringContaining('clip.mp4'),
      100,
      expect.any(Function)
    )
    expect(percents.at(-1)).toBe(100)
    expect(await backend.planMediaUrl(KEY)).toBe(LINK)
    // 没到期：问存活不联网
    expect(await backend.isPlanObjectRemoved(KEY, { fetch })).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('已传过（exists）：不上传、不确认，直接用返回的链接', async () => {
    const put = vi.fn(async () => {})
    const { fetch, calls } = fakeFetch(() =>
      json(200, { exists: true, key: KEY, url: LINK, expires_at: FUTURE })
    )
    const result = await backend.uploadToPlan(writeFile('clip.mp4', 10), 'video/mp4', noop, noop, {
      fetch,
      put
    })
    expect(result).toMatchObject({ key: KEY, reused: true })
    expect(put).not.toHaveBeenCalled()
    expect(calls).toEqual(['POST /v1/storage/uploads'])
    expect(await backend.planMediaUrl(KEY)).toBe(LINK)
  })

  it('续期时服务端说对象不在了、重传又失败：错误上标出来，调用方不能再拿旧键顶上', async () => {
    const { fetch } = fakeFetch(() =>
      json(200, {
        exists: false,
        key: KEY,
        url: LINK,
        upload: { method: 'PUT', url: 'http://staging.example/x', headers: {} }
      })
    )
    const put = vi.fn(async () => {
      throw new Error('存储满了')
    })
    await expect(
      backend.uploadToPlan(writeFile('clip.mp4', 10), 'video/mp4', noop, noop, {
        fetch,
        put,
        sha256: 'a'.repeat(64)
      })
    ).rejects.toMatchObject({ message: '存储满了', planObjectGone: true })
  })

  it('给了算过的指纹：不再读文件，照它申请；回的结果带着指纹', async () => {
    let sent: Record<string, unknown> = {}
    const { fetch, calls } = fakeFetch((_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return json(200, { exists: true, key: KEY, url: LINK, expires_at: FUTURE })
    })
    const notes: string[] = []
    const result = await backend.uploadToPlan(
      writeFile('clip.mp4', 10),
      'video/mp4',
      (note) => notes.push(note),
      noop,
      { fetch, sha256: 'a'.repeat(64) }
    )
    expect(result).toEqual({ key: KEY, reused: true, sha256: 'a'.repeat(64) })
    expect(sent.sha256).toBe('a'.repeat(64))
    expect(notes.some((note) => note.includes('指纹'))).toBe(false)
    expect(calls).toEqual(['POST /v1/storage/uploads'])
  })

  it('超过清单的单个文件上限：不发请求，直接说清楚', async () => {
    const { fetch, calls } = fakeFetch(() => json(500, {}))
    await expect(
      backend.uploadToPlan(writeFile('big.mp4', 2048), 'video/mp4', noop, noop, { fetch })
    ).rejects.toThrow(/单个文件上限/)
    expect(calls).toEqual([])
  })

  it('容量满了：402 storage_quota_exceeded 的提示原样抛给调用方（promptMedia 会退回旧路）', async () => {
    const { fetch } = fakeFetch(() =>
      json(402, { error: { code: 'storage_quota_exceeded', message: 'full' } })
    )
    await expect(
      backend.uploadToPlan(writeFile('a.png', 10), 'image/png', noop, noop, { fetch })
    ).rejects.toThrow(/空间用满/)
  })

  it('没连接（没有 Key）：不发请求', async () => {
    apiKey = null
    const { fetch, calls } = fakeFetch(() => json(200, {}))
    await expect(
      backend.uploadToPlan(writeFile('a.png', 10), 'image/png', noop, noop, { fetch })
    ).rejects.toThrow(/没连接/)
    expect(calls).toEqual([])
    expect(await backend.isPlanStorageReady()).toBe(false)
  })
})

describe('能不能用', () => {
  it('连着、清单带存储才算能用；清单 storage.enabled 为假不用', async () => {
    expect(await backend.isPlanStorageReady()).toBe(true)
    planState = { ...planState, manifest: manifest({ enabled: false }) }
    expect(await backend.isPlanStorageReady()).toBe(false)
    planState = { ...planState, manifest: null }
    expect(await backend.isPlanStorageReady()).toBe(false)
  })
})

describe('链接与存活', () => {
  async function seed(expiresAt: string): Promise<void> {
    const { fetch } = fakeFetch(() =>
      json(200, { exists: true, key: KEY, url: LINK, expires_at: expiresAt })
    )
    await backend.uploadToPlan(writeFile('clip.mp4', 10), 'video/mp4', noop, noop, { fetch })
  }

  it('不是套餐存储的键回 undefined，交给自己的桶那条路', async () => {
    expect(await backend.planMediaUrl('uebox-media/abc.mp4')).toBeUndefined()
    expect(await backend.isPlanObjectRemoved('uebox-media/abc.mp4')).toBeUndefined()
  })

  it('过了到期时间问一次：404 记成已删，链接换成说明', async () => {
    await seed(PAST)
    const { fetch, calls } = fakeFetch(() => json(404, { error: { code: 'not_found' } }))
    expect(await backend.isPlanObjectRemoved(KEY, { fetch })).toBe(true)
    expect(calls).toEqual([`GET /v1/storage/objects/${KEY}`])
    expect(await backend.planMediaUrl(KEY)).toBeNull()
    // 记下来了：下次不再问
    expect(await backend.isPlanObjectRemoved(KEY, { fetch })).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('过了到期时间、服务端说还在（别处续过期）：更新到期时间，照发链接', async () => {
    await seed(PAST)
    const { fetch, calls } = fakeFetch(() =>
      json(200, { key: KEY, url: LINK, size: 10, expires_at: FUTURE })
    )
    expect(await backend.isPlanObjectRemoved(KEY, { fetch })).toBe(false)
    expect(await backend.isPlanObjectRemoved(KEY, { fetch })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('断开了、过了到期时间：问不了，就当没了', async () => {
    await seed(PAST)
    apiKey = null
    const { fetch, calls } = fakeFetch(() => json(200, {}))
    expect(await backend.isPlanObjectRemoved(KEY, { fetch })).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('管理', () => {
  it('列表按游标翻完；「最后用到」= 到期时间往回推保留天数', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      const cursor = url.searchParams.get('cursor')
      const item = (key: string): Record<string, unknown> => ({
        key,
        url: `https://plan.example/m/x/${key}`,
        size: 5,
        file_name: `${key}.src`,
        created_at: '2026-01-01T00:00:00Z',
        expires_at: '2026-03-02T00:00:00Z'
      })
      return cursor
        ? json(200, { data: [item('b.png')], has_more: false })
        : json(200, { data: [item('a.png')], has_more: true, next_cursor: 'c1' })
    })
    const entries = await backend.listPlanObjects({ fetch })
    expect(calls).toHaveLength(2)
    expect(entries.map((e) => e.key)).toEqual(['a.png', 'b.png'])
    expect(entries[0]).toMatchObject({ size: 5, fileName: 'a.png.src' })
    expect(entries[0].lastModified).toBe('2026-01-31T00:00:00.000Z')
    // 别的机器传的也登记下来，对话里认得出是套餐存储的
    expect(await backend.planMediaUrl('b.png')).toBe('https://plan.example/m/x/b.png')
  })

  it('删除：成功和 404 都算删掉，之后链接换成说明；失败的逐个报', async () => {
    await (async () => {
      const { fetch } = fakeFetch(() =>
        json(200, { exists: true, key: KEY, url: LINK, expires_at: FUTURE })
      )
      await backend.uploadToPlan(writeFile('clip.mp4', 10), 'video/mp4', noop, noop, { fetch })
    })()
    const { fetch } = fakeFetch((url) => {
      if (url.pathname.endsWith('/gone.png')) return json(404, {})
      if (url.pathname.endsWith('/bad.png')) return json(500, {})
      return new Response(null, { status: 204 })
    })
    const result = await backend.removePlanObjects([KEY, 'gone.png', 'bad.png'], { fetch })
    expect(result.removed).toBe(2)
    expect(result.failed.map((f) => f.key)).toEqual(['bad.png'])
    expect(await backend.planMediaUrl(KEY)).toBeNull()
    expect(await backend.isPlanObjectRemoved(KEY)).toBe(true)
  })

  it('用量带上清单里的保留天数', async () => {
    const { fetch } = fakeFetch(() =>
      json(200, { quota_bytes: 100, used_bytes: 40, object_count: 3 })
    )
    expect(await backend.planStorageUsage({ fetch })).toEqual({
      quotaBytes: 100,
      usedBytes: 40,
      objectCount: 3,
      retentionDays: 30
    })
  })
})
