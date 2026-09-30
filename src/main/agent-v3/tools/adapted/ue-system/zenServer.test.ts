// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetProjectPath: () => 'D:/XG/Recent'
}))
vi.mock('fs', () => ({ existsSync: (p: string) => !p.includes('Gone') }))

import { createZenServerTool } from './zenServer'

type Routes = Record<string, unknown | Error>

function stubZen(routes: Routes): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).Accept).toBe('application/json')
    const path = new URL(url).pathname
    const body = routes[path]
    if (body instanceof Error) throw body
    if (body === undefined) return new Response('', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (input: Record<string, unknown> = {}): Promise<any> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (createZenServerTool() as any).execute(input, {})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ue_zen_server', () => {
  it('汇总命中率、占盘和工程列表', async () => {
    stubZen({
      '/stats/z$': {
        cache: { hits: 571, misses: 71, hit_ratio: 0.8894, size: { disk: 6899329071 } }
      },
      '/health/info': { BuildVersion: '5.8.13' },
      '/prj/': [
        { Id: 'Gone.1', ProjectFilePath: 'D:/Gone/Gone.uproject' },
        { Id: 'Recent.2', ProjectFilePath: 'D:/XG/Recent/Recent.uproject' }
      ]
    })

    const out = await run()

    expect(out.success).toBe(true)
    expect(out.zen_version).toBe('5.8.13')
    expect(out.cache.hit_ratio_percent).toBe(88.9)
    expect(out.projects[0].id).toBe('Recent.2')
    expect(out.message).toContain('88.9%')
    expect(out.message).toContain('6.4 GB')
    expect(out.message).toContain('其中 1 个的工程文件已不在磁盘上')
  })

  it('连不上时说清楚 Zen 随编辑器起停，而不是报网络错误', async () => {
    stubZen({ '/stats/z$': new TypeError('fetch failed') })

    const out = await run()

    expect(out.success).toBe(false)
    expect(out.error).toContain('127.0.0.1:8558')
    expect(out.error).toContain('随编辑器启动')
  })

  it('工程列表拿不到时只报缓存部分，不整个失败', async () => {
    stubZen({ '/stats/z$': { cache: { hits: 1, misses: 0, hit_ratio: 1 } } })

    const out = await run()

    expect(out.success).toBe(true)
    expect(out.projects).toBeNull()
    expect(out.message).toContain('次数太少')
    expect(out.message).toContain('工程列表没拿到')
  })

  it('用给定端口', async () => {
    const fetchMock = stubZen({ '/stats/z$': {} })

    await run({ port: 9000 })

    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:9000/stats/z$')
  })
})
