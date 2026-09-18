import type { BrowserWindow } from 'electron'
import { shell } from 'electron'
import { pathToFileURL } from 'url'

const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:'])

export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false

  try {
    const url = new URL(value)
    return EXTERNAL_PROTOCOLS.has(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

export async function openSafeExternalUrl(value: unknown): Promise<void> {
  if (!isSafeExternalUrl(value)) {
    throw new Error('仅允许打开 http 或 https 链接')
  }
  await shell.openExternal(value)
}

export function isTrustedRendererUrl(
  targetUrl: string,
  rendererFilePath: string,
  developmentRendererUrl?: string
): boolean {
  try {
    const target = new URL(targetUrl)
    if (developmentRendererUrl) {
      const development = new URL(developmentRendererUrl)
      return target.origin === development.origin
    }

    const rendererFile = new URL(pathToFileURL(rendererFilePath).toString())
    return target.protocol === 'file:' && target.pathname === rendererFile.pathname
  } catch {
    return false
  }
}

export function protectRendererWindow(
  window: BrowserWindow,
  rendererFilePath: string,
  developmentRendererUrl?: string
): void {
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl, rendererFilePath, developmentRendererUrl)) {
      event.preventDefault()
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void openSafeExternalUrl(url)
    }
    return { action: 'deny' }
  })
}
