export function mediaPermissionErrorKey(
  error: unknown,
  kind: 'screen' | 'microphone',
  platform: string
): string | null {
  const message = error instanceof Error ? error.message : String(error)
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  const denied =
    message.includes('MAC_SCREEN_CAPTURE_PERMISSION_DENIED') ||
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError'
  if (platform !== 'darwin' || !denied) return null
  return kind === 'screen'
    ? 'mediaPermissions.macScreenDenied'
    : 'mediaPermissions.macMicrophoneDenied'
}
