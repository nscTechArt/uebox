import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareImage, uploadImage } from './imageUpload'

const invoke = vi.fn()
beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
  Object.assign(window.api, { invoke })
})

describe('local image preparation', () => {
  it.each([prepareImage, uploadImage])(
    'prepares an inline image without a network upload',
    async (prepare) => {
      localStorage.setItem('auth-token', 'stale-test-token')
      const result = await prepare(new File(['image'], 'image.png', { type: 'image/png' }))
      expect(result.success).toBe(true)
      expect(result.url).toMatch(/^data:image\/png;base64,/)
      expect(invoke).not.toHaveBeenCalled()
    }
  )
  it('rejects a non-image file', async () => {
    await expect(
      uploadImage(new File(['x'], 'text.txt', { type: 'text/plain' }))
    ).resolves.toMatchObject({ success: false })
    expect(invoke).not.toHaveBeenCalled()
  })
})
