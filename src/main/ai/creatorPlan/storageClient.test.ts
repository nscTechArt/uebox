/** @vitest-environment node */
/**
 * 套餐对象存储的协议客户端（10-storage.md）：
 * - 地址全从参数来，带 Key；申请带 Idempotency-Key = sha256
 * - 已传过（exists）不给上传地址；没传过给原样的 method / url / headers
 * - 402 两种、413、401 翻成用户知道下一步做什么的话
 * - 列表按 next_cursor 翻页；删除 404 算已经删掉
 */
import { describe, expect, it } from 'vitest'
import {
  PlanStorageError,
  completeUpload,
  deleteObject,
  describePlanStorageError,
  getObject,
  getUsage,
  listObjectsPage,
  requestUpload
} from './storageClient'

const conn = { baseUrl: 'https://plan.example/v1', apiKey: 'ubx-sk-local' }
const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const KEY = '9f86d081884c7d659a2feaa0c55ad015.mp4'
const URL_ = `https://plan.example/m/a7Kx2q/${KEY}`

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetch(respond: (seen: Seen) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fn = (async (input: string, init?: RequestInit) => {
    const entry = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    seen.push(entry)
    return respond(entry)
  }) as unknown as typeof fetch
  return { fetch: fn, seen }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const apiError = (status: number, code: string): Response =>
  json(status, { error: { type: 'x', code, message: `server says ${code}` } })

describe('requestUpload', () => {
  it('申请：地址来自 base_url，带 Key 和 Idempotency-Key；已传过直接回链接', async () => {
    const { fetch, seen } = fakeFetch(() =>
      json(200, { exists: true, key: KEY, url: URL_, expires_at: '2026-10-23T08:00:00Z' })
    )
    const ticket = await requestUpload(
      conn,
      { sha256: SHA, size: 42, contentType: 'video/mp4', fileName: '镜头012.mp4' },
      {},
      fetch
    )
    expect(ticket).toEqual({
      exists: true,
      key: KEY,
      url: URL_,
      expiresAt: '2026-10-23T08:00:00Z'
    })
    expect(seen[0].url).toBe('https://plan.example/v1/storage/uploads')
    expect(seen[0].method).toBe('POST')
    expect(seen[0].headers.authorization).toBe('Bearer ubx-sk-local')
    expect(seen[0].headers['idempotency-key']).toBe(SHA)
    expect(seen[0].body).toEqual({
      sha256: SHA,
      size: 42,
      content_type: 'video/mp4',
      file_name: '镜头012.mp4'
    })
  })

  it('没传过：原样带回上传的 method / url / headers', async () => {
    const { fetch } = fakeFetch(() =>
      json(200, {
        exists: false,
        key: KEY,
        url: URL_,
        upload: {
          method: 'PUT',
          url: 'https://bucket.example/staging/x?X-Amz-Signature=abc',
          headers: { 'Content-Type': 'video/mp4' },
          expires_in: 3600
        }
      })
    )
    const ticket = await requestUpload(
      conn,
      { sha256: SHA, size: 42, contentType: 'video/mp4' },
      {},
      fetch
    )
    expect(ticket.exists).toBe(false)
    expect(ticket.upload).toEqual({
      method: 'PUT',
      url: 'https://bucket.example/staging/x?X-Amz-Signature=abc',
      headers: { 'Content-Type': 'video/mp4' }
    })
  })

  it.each([
    [402, 'storage_quota_exceeded', 'storage_quota_exceeded', /空间用满/],
    [402, 'subscription_inactive', 'subscription_inactive', /没有生效的订阅/],
    [413, 'payload_too_large', 'payload_too_large', /单个文件上限（500MB）/],
    [401, 'unauthorized', 'unauthorized', /重新连接/]
  ])('HTTP %s %s 翻成明确的提示', async (status, code, expected, text) => {
    const { fetch } = fakeFetch(() => apiError(status, code))
    const error = await requestUpload(
      conn,
      { sha256: SHA, size: 42, contentType: 'video/mp4' },
      { maxObjectBytes: 500 * 1024 * 1024 },
      fetch
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlanStorageError)
    expect((error as PlanStorageError).code).toBe(expected)
    expect((error as PlanStorageError).message).toMatch(text)
  })

  it('网络错误带上连的是哪', async () => {
    const fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }) as unknown as typeof fetch
    await expect(
      requestUpload(conn, { sha256: SHA, size: 1, contentType: 'image/png' }, {}, fetch)
    ).rejects.toThrow('https://plan.example，ECONNREFUSED')
  })
})

describe('其余接口', () => {
  it('确认：键做路径编码，回链接和到期时间', async () => {
    const { fetch, seen } = fakeFetch(() =>
      json(200, { key: KEY, url: URL_, size: 42, expires_at: '2026-10-23T08:00:00Z' })
    )
    const done = await completeUpload(conn, KEY, fetch)
    expect(seen[0].url).toBe(`https://plan.example/v1/storage/uploads/${KEY}/complete`)
    expect(seen[0].method).toBe('POST')
    expect(done).toMatchObject({ key: KEY, url: URL_, size: 42, expiresAt: '2026-10-23T08:00:00Z' })
  })

  it('查单个对象：404 回 null', async () => {
    const { fetch } = fakeFetch(() => apiError(404, 'not_found'))
    expect(await getObject(conn, KEY, fetch)).toBeNull()
  })

  it('列表：has_more 时回 next_cursor，游标原样带回去', async () => {
    const { fetch, seen } = fakeFetch(() =>
      json(200, {
        object: 'list',
        data: [
          {
            key: KEY,
            url: URL_,
            size: 42,
            file_name: 'a.mp4',
            created_at: '2026-09-01T00:00:00Z',
            expires_at: '2026-10-01T00:00:00Z'
          }
        ],
        has_more: true,
        next_cursor: 'MjAyNi0+/='
      })
    )
    const page = await listObjectsPage(conn, 'prev+cursor=', 100, fetch)
    expect(page.nextCursor).toBe('MjAyNi0+/=')
    expect(page.data[0]).toMatchObject({ key: KEY, fileName: 'a.mp4', size: 42 })
    expect(new URL(seen[0].url).searchParams.get('cursor')).toBe('prev+cursor=')
    expect(new URL(seen[0].url).searchParams.get('limit')).toBe('100')
  })

  it('删除：204 回 true，404 回 false（本来就不在了）', async () => {
    let status = 204
    const { fetch, seen } = fakeFetch(() => new Response(null, { status }))
    expect(await deleteObject(conn, KEY, fetch)).toBe(true)
    expect(seen[0].method).toBe('DELETE')
    status = 404
    expect(await deleteObject(conn, KEY, fetch)).toBe(false)
  })

  it('用量', async () => {
    const { fetch, seen } = fakeFetch(() =>
      json(200, { quota_bytes: 100, used_bytes: 40, object_count: 3 })
    )
    expect(await getUsage(conn, fetch)).toEqual({ quotaBytes: 100, usedBytes: 40, objectCount: 3 })
    expect(seen[0].url).toBe('https://plan.example/v1/storage/usage')
  })

  it('没有错误体的 402 也按订阅失效提示', () => {
    expect(describePlanStorageError(402, undefined, undefined).code).toBe('subscription_inactive')
  })
})
