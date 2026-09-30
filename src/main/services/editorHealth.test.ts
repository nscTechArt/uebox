// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRequest: vi.fn(),
  getConnectionCount: vi.fn(() => 1)
}))

vi.mock('./index', () => ({
  serviceManager: {
    getWebSocketService: () => ({
      callRequest: mocks.callRequest,
      getConnectionCount: mocks.getConnectionCount
    })
  }
}))

import { EDITOR_HEALTH_METHOD, fetchEditorHealth } from './editorHealth'

function stubZen(body: unknown | Error): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (body instanceof Error) throw body
      return new Response(JSON.stringify(body), { status: 200 })
    })
  )
}

beforeEach(() => {
  mocks.callRequest.mockReset()
  mocks.getConnectionCount.mockReset().mockReturnValue(1)
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchEditorHealth', () => {
  it('问插件要原始测量，加上 Zen 的两块占盘，按预期值判', async () => {
    mocks.callRequest.mockResolvedValue({ startup_seconds: 200, local_ddc_hit_pct: 98 })
    stubZen({ cache: { size: { disk: 6e9 } }, cid: { size: { total: 1.5e9 } } })

    const r = await fetchEditorHealth('conn-1')

    expect(mocks.callRequest).toHaveBeenCalledWith(EDITOR_HEALTH_METHOD, {}, 'conn-1', 10000)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.report.issueCount).toBe(1)
    expect(r.report.items.find((i) => i.id === 'cacheDisk')?.value).toBe(7.5e9)
  })

  it('Zen 没在跑：占盘是空，其余照常', async () => {
    mocks.callRequest.mockResolvedValue({ startup_seconds: 100 })
    stubZen(new TypeError('fetch failed'))

    const r = await fetchEditorHealth('conn-1')

    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.report.items.find((i) => i.id === 'cacheDisk')?.value).toBeNull()
  })

  it('插件回 404（没有这条命令）：认成插件太旧，不当成出错', async () => {
    mocks.callRequest.mockResolvedValue({ ok: false, code: 404, error: 'Unknown method' })
    stubZen(new TypeError('fetch failed'))

    expect(await fetchEditorHealth('conn-1')).toEqual({ status: 'plugin_outdated' })
  })

  it('一个编辑器都没连：不发请求', async () => {
    mocks.getConnectionCount.mockReturnValue(0)

    expect(await fetchEditorHealth()).toEqual({ status: 'not_connected' })
    expect(mocks.callRequest).not.toHaveBeenCalled()
  })
})
