/**
 * 直连远端资产服务器的启动探测。
 *
 * 红灯用例是第一条：探测请求必须带上 X-API-Key。缺了它，服务端 v3 的
 * `GET /api/vaults` 直接 401，切库时判定离线、SyncClient 不启动 ——
 * 用户填对配对码也没用，重启一次应用直连库就永久离线。
 */
import { describe, it, expect, vi } from 'vitest'

import { buildRemoteVaultProbeHeaders, probeRemoteVault } from './remoteVaultProbe'

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('buildRemoteVaultProbeHeaders', () => {
  it('带上资产库访问码', () => {
    expect(buildRemoteVaultProbeHeaders({ apiKey: '7K3M-9QRT-0XZ2-8VNB' })).toEqual({
      'X-API-Key': '7K3M-9QRT-0XZ2-8VNB'
    })
  })

  it('空串与纯空白视为没有凭据', () => {
    expect(buildRemoteVaultProbeHeaders({ apiKey: '   ' })).toEqual({})
  })
})

describe('probeRemoteVault', () => {
  it('把访问码发给服务器（缺了它 = 重启后永久离线）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: [] }))

    const result = await probeRemoteVault({
      probeUrl: 'http://192.168.1.5:18900/api/vaults',
      apiKey: '7K3M-9QRT-0XZ2-8VNB',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://192.168.1.5:18900/api/vaults')
    expect(init.headers).toMatchObject({ 'X-API-Key': '7K3M-9QRT-0XZ2-8VNB' })
  })

  it('没存过码时提示去填配对码，而不是笼统的「认证失败」', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { success: false, errorCode: 'AUTH_REQUIRED' }))

    const result = await probeRemoteVault({
      probeUrl: 'http://192.168.1.5:18900/api/vaults',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.authFailed).toBe(true)
    expect(result.status).toBe(401)
    expect(result.error).toContain('配对码')
  })

  it('码不对（主机轮换过）时说清楚要重新填', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { success: false, errorCode: 'AUTH_INVALID' }))

    const result = await probeRemoteVault({
      probeUrl: 'http://192.168.1.5:18900/api/vaults',
      apiKey: 'STALE-CODE',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.authFailed).toBe(true)
    expect(result.error).toContain('轮换')
  })

  it('被限流时如实报限流，不误导成码填错了', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(429, { success: false, errorCode: 'AUTH_RATE_LIMITED' }))

    const result = await probeRemoteVault({
      probeUrl: 'http://192.168.1.5:18900/api/vaults',
      apiKey: 'CODE',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('限流')
  })

  it('404 指向服务器版本，不算认证失败', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { success: false }))

    const result = await probeRemoteVault({
      probeUrl: 'http://192.168.1.5:18900/api/vaults',
      apiKey: 'CODE',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.authFailed).toBeUndefined()
    expect(result.error).toContain('服务器版本')
  })

  it('超时报超时，且不把 AbortError 当成服务器响应', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const result = await probeRemoteVault({
      probeUrl: 'http://192.168.1.5:18900/api/vaults',
      apiKey: 'CODE',
      timeoutMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('连接超时')
  })

  it('网络不可达时带上原始错误，方便排查', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await probeRemoteVault({
      probeUrl: 'http://192.168.1.5:18900/api/vaults',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('响应体不是 JSON 也不能让探测崩掉', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 403 }))

    const result = await probeRemoteVault({
      probeUrl: 'http://192.168.1.5:18900/api/vaults',
      apiKey: 'CODE',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.authFailed).toBe(true)
    expect(result.error).toContain('HTTP 403')
  })
})
