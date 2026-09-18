// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { status } = vi.hoisted(() => ({ status: vi.fn() }))
vi.mock('electron', () => ({ systemPreferences: { getMediaAccessStatus: status } }))
import { assertScreenCaptureAllowed } from './mediaPermissions'
beforeEach(() => status.mockReset())

describe('screen capture permissions', () => {
  it.each(['denied', 'restricted'])('blocks %s Mac capture with a recognizable error', (value) => {
    status.mockReturnValue(value)
    expect(() => assertScreenCaptureAllowed('darwin')).toThrow(
      'MAC_SCREEN_CAPTURE_PERMISSION_DENIED'
    )
  })
  it.each(['granted', 'not-determined', 'unknown'])(
    'allows %s consent to be handled by macOS',
    (value) => {
      status.mockReturnValue(value)
      expect(() => assertScreenCaptureAllowed('darwin')).not.toThrow()
    }
  )
  it('does not call a Mac-only API on Windows', () => {
    assertScreenCaptureAllowed('win32')
    expect(status).not.toHaveBeenCalled()
  })
})
