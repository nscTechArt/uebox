import { nativeImage } from 'electron'
import type { NativeImage } from 'electron'

/** macOS 菜单栏需要小尺寸图标，不能直接使用应用的大图标。 */
export function prepareTrayIcon(
  iconPath: string,
  fallbackPath: string,
  platform: NodeJS.Platform
): string | NativeImage {
  if (platform !== 'darwin') return iconPath

  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createFromPath(fallbackPath)
  if (image.isEmpty()) throw new Error('Tray icon could not be loaded')
  return image.resize({ width: 18, height: 18 })
}
