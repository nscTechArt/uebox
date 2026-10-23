import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { searchViaDeepseek } from './deepseekSearch'

/**
 * DeepSeek 检索（`POST /v1/tools/search`）。最要紧的是两件事：
 * 请求形状和文档对得上，以及 401 / 402 / 429 各自说清下一步该做什么。
 */

const originalFetch = globalThis.fetch
let lastUrl = ''
let lastInit: RequestInit | undefined

function stub(status: number, body: unknown): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    lastUrl = String(url)
    lastInit = init
    return { status, json: async () => body }
  }) as unknown as typeof fetch
}

const ROWS = [
  {
    rerank_score: 2.1,
    title: '虚幻引擎事件分发器 | 虚幻引擎 5.8 文档',
    url: 'https://dev.epicgames.com/documentation/zh-cn/unreal-engine/event-dispatchers',
    snippet: '蓝图之间通信',
    summary: '更长的摘要',
    content: '',
    date: '2026-09-01T00:00:00Z'
  },
  { title: 'UE4蓝图通信-事件分发器', url: 'https://blog.csdn.net/x', snippet: '' }
]

beforeEach(() => {
  lastUrl = ''
  lastInit = undefined
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('searchViaDeepseek', () => {
  it('POST /v1/tools/search，带 Bearer Key、query 和 count', async () => {
    stub(200, { results: ROWS })

    const result = await searchViaDeepseek('https://api.deepseek.com', 'sk-test', '事件分发器', 5)

    expect(lastUrl).toBe('https://api.deepseek.com/v1/tools/search')
    expect(lastInit?.method).toBe('POST')
    expect((lastInit?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(String(lastInit?.body))).toEqual({ query: '事件分发器', count: 5 })
    expect(result.success).toBe(true)
    expect(result.items?.[0]).toEqual({
      title: '虚幻引擎事件分发器 | 虚幻引擎 5.8 文档',
      url: 'https://dev.epicgames.com/documentation/zh-cn/unreal-engine/event-dispatchers',
      snippet: '蓝图之间通信',
      publishedAt: '2026-09-01T00:00:00Z'
    })
    expect(result.items?.[1].publishedAt).toBeUndefined()
  })

  it('地址留空用官方地址；填成带 /v1 或末尾斜杠的也不会拼错', async () => {
    stub(200, { results: ROWS })

    await searchViaDeepseek('', 'k', '事件分发器', 5)
    expect(lastUrl).toBe('https://api.deepseek.com/v1/tools/search')

    await searchViaDeepseek('https://api.deepseek.com/v1/', 'k', '事件分发器', 5)
    expect(lastUrl).toBe('https://api.deepseek.com/v1/tools/search')
  })

  it('查询超过 128 个字符时按字符截断，不让整个请求 400', async () => {
    stub(200, { results: ROWS })

    await searchViaDeepseek('', 'k', '蓝'.repeat(200), 5)

    expect(Array.from(JSON.parse(String(lastInit?.body)).query as string)).toHaveLength(128)
  })

  it('按 limit 截断', async () => {
    stub(200, { results: ROWS })

    const result = await searchViaDeepseek('', 'k', '事件分发器', 1)

    expect(result.items).toHaveLength(1)
  })

  it('空结果如实说没有', async () => {
    stub(200, { results: [] })

    const result = await searchViaDeepseek('', 'k', '事件分发器', 5)

    expect(result.success).toBe(false)
    expect(result.error).toContain('没有返回结果')
  })

  it.each([
    [401, 'Key 无效'],
    [402, '余额不足'],
    [429, '频率限制']
  ])('HTTP %i 说清下一步', async (status, expected) => {
    stub(status, { error: { message: 'upstream says no', param: null } })

    const result = await searchViaDeepseek('', 'k', '事件分发器', 5)

    expect(result.success).toBe(false)
    expect(result.error).toContain(expected)
    expect(result.error).toContain('upstream says no')
  })

  it('连不上时报连接失败，不抛出去', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const result = await searchViaDeepseek('', 'k', '事件分发器', 5)

    expect(result.success).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })
})
