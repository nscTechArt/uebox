/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browser = vi.hoisted(() => ({
  constructed: vi.fn(),
  destroyed: vi.fn(),
  loadURL: vi.fn(),
  execute: vi.fn(),
  clear: vi.fn(),
  permission: vi.fn(),
  check: vi.fn(),
  popup: vi.fn(),
  on: vi.fn(),
  handle: vi.fn(),
  unhandle: vi.fn(),
  fetch: vi.fn()
}))
vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: browser.permission,
      setPermissionCheckHandler: browser.check,
      clearStorageData: browser.clear,
      protocol: { handle: browser.handle, unhandle: browser.unhandle },
      fetch: browser.fetch
    })
  },
  BrowserWindow: class {
    constructor(options: unknown) {
      browser.constructed(options)
    }
    webContents = {
      executeJavaScript: browser.execute,
      setWindowOpenHandler: browser.popup,
      on: browser.on
    }
    loadURL = browser.loadURL
    isDestroyed = (): boolean => false
    destroy = browser.destroyed
  }
}))

const { getZCodeVerification, invalidateZCodeVerification } = await import('./zcodeCaptcha')
const config = (captcha: unknown): Response => Response.json({ data: { configs: { captcha } } })
beforeEach(() => {
  vi.clearAllMocks()
  invalidateZCodeVerification()
  browser.loadURL.mockResolvedValue(undefined)
  browser.execute.mockResolvedValue('verified')
  browser.clear.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ZCode dynamic verification', () => {
  it.each([{ enabled: false }, { enabled: true, skip_model_request: true }])(
    'honors server instructions and does not launch a browser: %j',
    async (captcha) => {
      const fetchImpl = vi.fn().mockResolvedValue(config(captcha))
      vi.stubGlobal('fetch', fetchImpl)
      expect(await getZCodeVerification()).toBeUndefined()
      expect(await getZCodeVerification()).toBeUndefined()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(fetchImpl.mock.calls[0][0]).toBe('https://zcode.z.ai/api/v1/client/configs')
      expect(browser.constructed).not.toHaveBeenCalled()
    }
  )

  it('uses an isolated browser only when required, deduplicates and clears its storage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        config({
          enabled: true,
          sceneId: 'scene',
          region: 'cn',
          prefix: 'prefix'
        })
      )
    )
    expect(await Promise.all([getZCodeVerification(), getZCodeVerification()])).toEqual([
      'verified',
      'verified'
    ])
    expect(browser.constructed).toHaveBeenCalledTimes(1)
    expect(browser.constructed).toHaveBeenCalledWith({
      show: false,
      webPreferences: expect.objectContaining({
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true
      })
    })
    expect(browser.loadURL).toHaveBeenCalledWith('https://zcode.z.ai/__uebox_verification__')
    const html = await browser.handle.mock.calls[0][1](
      new Request('https://zcode.z.ai/__uebox_verification__')
    )
    expect(await html.text()).not.toContain('<script')
    expect(browser.fetch).not.toHaveBeenCalled()
    expect(browser.popup.mock.calls[0][0]()).toEqual({ action: 'deny' })
    expect(browser.check.mock.calls[0][0]()).toBe(false)
    expect(browser.destroyed).toHaveBeenCalledTimes(1)
    expect(browser.clear).toHaveBeenCalledTimes(1)
    expect(browser.unhandle).toHaveBeenCalledWith('https')
    expect(await getZCodeVerification()).toBe('verified')
    expect(browser.constructed).toHaveBeenCalledTimes(1)
  })

  it('cleans up failed verification and allows a later retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        config({
          enabled: true,
          sceneId: 'scene',
          region: 'cn',
          prefix: 'prefix'
        })
      )
    )
    browser.execute.mockRejectedValueOnce(new Error('SDK unavailable'))
    await expect(getZCodeVerification()).rejects.toThrow('ZCode verification failed')
    expect(browser.destroyed).toHaveBeenCalledTimes(1)
    expect(browser.clear).toHaveBeenCalledTimes(1)
    expect(await getZCodeVerification()).toBe('verified')
  })

  it('does not guess verification parameters when upstream is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(config({ enabled: true }))
    )
    await expect(getZCodeVerification()).rejects.toThrow('HTTP 503')
    await expect(getZCodeVerification()).rejects.toThrow('incomplete')
    expect(browser.constructed).not.toHaveBeenCalled()
  })
})
