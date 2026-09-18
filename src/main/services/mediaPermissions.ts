import { systemPreferences } from 'electron'

export function assertScreenCaptureAllowed(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') return
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'denied' || status === 'restricted') {
    throw new Error('MAC_SCREEN_CAPTURE_PERMISSION_DENIED')
  }
  // not-determined: desktopCapturer triggers the native consent flow on first use.
}
