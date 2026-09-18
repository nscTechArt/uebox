import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hasAvailableImageModel,
  isImageGenerationConfigured,
  resolveImageGenerationAccess
} from './imageGenerationAccess'
const getSettings = vi.fn()
function settings(hasImageProvider = true): unknown {
  return {
    providers: [
      {
        id: 'local-images',
        displayName: 'Local Images',
        kind: hasImageProvider ? 'image' : 'chat',
        protocol: 'openai-completions',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: { kind: 'none' },
        models: [{ id: 'flux' }]
      }
    ],
    roles: {},
    path: 'C:\\models.json',
    encryptionAvailable: true,
    configured: true
  }
}

beforeEach(() => {
  localStorage.clear()
  getSettings.mockReset()
  Object.assign(window.api, { aiProvider: { getSettings } })
})
describe('configured image models', () => {
  it('allows choosing a model without a global role binding', async () => {
    getSettings.mockResolvedValue(settings())
    expect(await resolveImageGenerationAccess()).toEqual({ ok: true })
    expect(await isImageGenerationConfigured()).toBe(true)
  })
  it('a stale app credential cannot unlock image generation without a model', async () => {
    localStorage.setItem('auth-token', 'legacy-test-token')
    getSettings.mockResolvedValue(settings(false))
    expect(await resolveImageGenerationAccess()).toEqual({
      ok: false,
      reasonKey: 'aigcImagePanel.access.noImageModel'
    })
    expect(await isImageGenerationConfigured()).toBe(false)
  })
  it('reports an unavailable configuration without throwing into the view', async () => {
    getSettings.mockRejectedValue(new Error('IPC disconnected'))
    expect(await hasAvailableImageModel()).toBe(false)
  })
})
