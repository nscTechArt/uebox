import { describe, expect, it } from 'vitest'
import { mediaPermissionErrorKey } from './mediaPermissionError'
import en from '../i18n/locales/en-US'
import zh from '../i18n/locales/zh-CN'

describe('Mac media permission guidance', () => {
  it('recognizes an error serialized through Electron IPC', () => {
    expect(
      mediaPermissionErrorKey(
        new Error('Error invoking remote method: MAC_SCREEN_CAPTURE_PERMISSION_DENIED'),
        'screen',
        'darwin'
      )
    ).toBe('mediaPermissions.macScreenDenied')
  })
  it('recognizes browser microphone rejection', () => {
    const error = { name: 'NotAllowedError', message: 'Permission denied' }
    expect(mediaPermissionErrorKey(error, 'microphone', 'darwin')).toBe(
      'mediaPermissions.macMicrophoneDenied'
    )
    expect(mediaPermissionErrorKey(error, 'microphone', 'win32')).toBeNull()
    expect(
      mediaPermissionErrorKey(new Error('device disconnected'), 'microphone', 'darwin')
    ).toBeNull()
  })
  it('provides the same permission keys in both languages', () => {
    expect(Object.keys(zh.mediaPermissions)).toEqual(Object.keys(en.mediaPermissions))
    expect(en.mediaPermissions.macMicrophoneDenied).toContain('Microphone')
    expect(zh.mediaPermissions.macMicrophoneDenied).toContain('麦克风')
  })
})
