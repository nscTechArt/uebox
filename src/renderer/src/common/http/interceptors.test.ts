import axios, { AxiosError, AxiosHeaders, type AxiosInstance } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupInterceptors } from './interceptors'

beforeEach(() => localStorage.clear())

describe('explicit service HTTP requests', () => {
  const createClient = (): { client: AxiosInstance; adapter: ReturnType<typeof vi.fn> } => {
    const adapter = vi.fn(async (config) => ({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    }))
    const client = axios.create({ adapter })
    setupInterceptors(client)
    return { client, adapter }
  }

  it('requires an explicit service address', async () => {
    const { client, adapter } = createClient()
    await expect(client.get('/api/profile')).rejects.toThrow('explicit HTTP service URL')
    expect(adapter).not.toHaveBeenCalled()
  })

  it('does not send legacy app credentials to a configured service', async () => {
    localStorage.setItem('auth-token', 'legacy-test-token')
    localStorage.setItem('auth-refresh-token', 'legacy-refresh')
    const { client, adapter } = createClient()
    await expect(client.get('https://user-server.example/data')).resolves.toEqual({ ok: true })
    expect(adapter.mock.calls[0][0].headers.has('Authorization')).toBe(false)
  })

  it('preserves credentials explicitly supplied by a user service client', async () => {
    const { client, adapter } = createClient()
    await client.get('/data', {
      baseURL: 'https://user-server.example',
      headers: { Authorization: 'Bearer own-service-token' }
    })
    expect(adapter.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer own-service-token')
  })

  it('returns the service error without refreshing an app session or navigating away', async () => {
    const adapter = vi.fn(async (config) => {
      throw new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, undefined, {
        config,
        status: 401,
        statusText: 'Unauthorized',
        headers: new AxiosHeaders(),
        data: { message: 'Service key expired' }
      })
    })
    const client = axios.create({ adapter })
    setupInterceptors(client)
    const location = window.location.href
    await expect(client.get('https://user-server.example/data')).rejects.toThrow(
      'Service key expired'
    )
    expect(adapter).toHaveBeenCalledOnce()
    expect(window.location.href).toBe(location)
  })
})
