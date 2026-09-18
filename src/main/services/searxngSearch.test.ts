import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { searchViaSearxng } from './searxngSearch'

/**
 * SearXNG 是三条路里唯一**对无意义查询老实返回 0 条**的，所以这里最要紧的
 * 用例是「没结果时说什么」—— 上游引擎全挂和真的没有结果，是两件要分开报的事。
 */

const originalFetch = globalThis.fetch
let lastUrl = ''

function stub(status: number, body: unknown): void {
  globalThis.fetch = (async (url: string) => {
    lastUrl = String(url)
    return { status, json: async () => body, text: async () => JSON.stringify(body) }
  }) as unknown as typeof fetch
}

const ROWS = [
  {
    title: '虚幻引擎事件分发器 | 虚幻引擎 5.8 文档',
    url: 'https://dev.epicgames.com/documentation/zh-cn/unreal-engine/event-dispatchers',
    content: '蓝图之间通信'
  },
  { title: 'UE4蓝图通信-事件分发器', url: 'https://blog.csdn.net/x', content: '' }
]

beforeEach(() => {
  lastUrl = ''
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('searchViaSearxng', () => {
  it('要 JSON 格式，并解析出标题、链接和摘要', async () => {
    stub(200, { results: ROWS })

    const result = await searchViaSearxng('http://localhost:8080', '事件分发器', 5)

    expect(result.success).toBe(true)
    expect(lastUrl).toContain('/search?q=')
    expect(lastUrl).toContain('format=json')
    expect(result.items?.[0].url).toBe(
      'https://dev.epicgames.com/documentation/zh-cn/unreal-engine/event-dispatchers'
    )
  })

  it('地址末尾的斜杠不会拼出双斜杠', async () => {
    stub(200, { results: ROWS })

    await searchViaSearxng('http://localhost:8080///', '事件分发器', 5)

    expect(lastUrl.startsWith('http://localhost:8080/search?')).toBe(true)
  })

  it('按 limit 截断', async () => {
    stub(200, { results: ROWS })

    const result = await searchViaSearxng('http://localhost:8080', '事件分发器', 1)

    expect(result.items).toHaveLength(1)
  })

  it('地址没填时直接说，不白跑一趟网络', async () => {
    stub(200, { results: ROWS })

    const result = await searchViaSearxng('   ', '事件分发器', 5)

    expect(result.success).toBe(false)
    expect(lastUrl).toBe('')
  })

  /**
   * 实测 10 个公共实例没有一个开着 JSON 输出，回的是 403 / 429 加一个 HTML 页。
   * 这是这条路最常见的失败，错误信息必须直接给出怎么改。
   */
  it('非 200 时把「实例没开 JSON 输出」这个最常见原因说出来', async () => {
    stub(403, {})

    const result = await searchViaSearxng('http://localhost:8080', '事件分发器', 5)

    expect(result.success).toBe(false)
    expect(result.error).toContain('403')
    expect(result.error).toContain('formats')
  })

  /** 上游引擎全挂和「真的没有结果」是两件事，混在一起就没法排查 */
  it('没有结果时把挂掉的上游引擎一起带出来', async () => {
    stub(200, {
      results: [],
      unresponsive_engines: [
        ['duckduckgo', 'CAPTCHA'],
        ['brave', 'too many requests']
      ]
    })

    const result = await searchViaSearxng('http://localhost:8080', '事件分发器', 5)

    expect(result.success).toBe(false)
    expect(result.error).toContain('duckduckgo：CAPTCHA')
    expect(result.error).toContain('brave')
  })

  it('没有结果也没有引擎报错时，就说没有结果', async () => {
    stub(200, { results: [] })

    const result = await searchViaSearxng('http://localhost:8080', 'qzxwvba83yrh9k4nmg', 5)

    expect(result.success).toBe(false)
    expect(result.error).toContain('没有返回结果')
    expect(result.error).not.toContain('引擎')
  })

  it('连不上时如实报错', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const result = await searchViaSearxng('http://localhost:8080', '事件分发器', 5)

    expect(result.success).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })
})
