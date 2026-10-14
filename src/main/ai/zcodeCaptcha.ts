import { BrowserWindow, session } from 'electron'
import { ZCODE_ORIGIN } from './zcode'

/** Only loaded on an explicit ZCode model request. No credentials enter this browser. */
let cached: { value: string | undefined; until: number } | undefined
let pending: Promise<string | undefined> | undefined

export function invalidateZCodeVerification(): void {
  cached = undefined
}

export async function getZCodeVerification(): Promise<string | undefined> {
  if (cached && cached.until > Date.now()) return cached.value
  if (pending) return pending
  pending = verify()
    .then((value) => {
      cached = { value, until: Date.now() + 45_000 }
      return value
    })
    .finally(() => {
      pending = undefined
    })
  return pending
}

async function verify(): Promise<string | undefined> {
  // Verified 2026-10-13: the old app_version/platform query now returns HTTP 400.
  const response = await fetch(`${ZCODE_ORIGIN}/api/v1/client/configs`, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error'
  })
  if (!response.ok)
    throw new Error(`ZCode verification configuration failed (HTTP ${response.status}).`)
  const payload = (await response.json()) as {
    data?: {
      configs?: {
        captcha?: {
          enabled?: boolean
          skip_model_request?: boolean
          sceneId?: string
          region?: string
          prefix?: string
        }
      }
    }
  }
  const config = payload?.data?.configs?.captcha
  if (config?.enabled === false || config?.skip_model_request === true) return undefined
  if (!config?.sceneId || !config.region || !config.prefix) {
    throw new Error('ZCode verification configuration is incomplete. Please try again later.')
  }

  // Use Chromium's real browser APIs, not the reference project's jsdom fingerprint stubs.
  // A fresh, nonpersistent session cannot access the app's cookies, storage or preload bridge.
  const isolated = session.fromPartition('zcode-verification')
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  // Serve only a minimal SDK host at the required origin, not the site's application/analytics.
  const pageUrl = `${ZCODE_ORIGIN}/__uebox_verification__`
  isolated.protocol.handle('https', (request) =>
    request.url === pageUrl
      ? new Response(
          '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
          {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          }
        )
      : isolated.fetch(request, { bypassCustomProtocolHandlers: true })
  )
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async (): Promise<string> => {
        await window.loadURL(pageUrl)
        const value: unknown = await window.webContents
          .executeJavaScript(`new Promise((resolve, reject) => {
          const config = ${JSON.stringify({ sceneId: config.sceneId, region: config.region, prefix: config.prefix })};
          const element = document.createElement('div');
          element.id = 'uebox-zcode-verification';
          document.body.appendChild(element);
          const button = document.createElement('button');
          button.id = 'uebox-zcode-verify-button';
          document.body.appendChild(button);
          const start = () => window.initAliyunCaptcha({
            SceneId: config.sceneId, region: config.region, prefix: config.prefix, mode: 'popup',
            element: '#uebox-zcode-verification', button: '#uebox-zcode-verify-button',
            getInstance: (instance) => {
              if (typeof instance.startTracelessVerification !== 'function') {
                reject(new Error('Interactive verification required')); return;
              }
              instance.startTracelessVerification();
            },
            success: resolve,
            fail: () => reject(new Error('Verification rejected')),
            onError: () => reject(new Error('Verification failed'))
          });
          if (typeof window.initAliyunCaptcha === 'function') start();
          else {
            const script = document.createElement('script');
            script.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
            script.onload = start;
            script.onerror = () => reject(new Error('Verification SDK unavailable'));
            document.head.appendChild(script);
          }
        })`)
        if (typeof value !== 'string' || !value || value.length > 64_000) {
          throw new Error('Invalid verification response')
        }
        return value
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Verification timed out')), 40_000)
      })
    ])
  } catch {
    throw new Error('ZCode verification failed. Open ZCode to complete verification, then retry.')
  } finally {
    clearTimeout(timer)
    if (!window.isDestroyed()) window.destroy()
    isolated.protocol.unhandle('https')
    await isolated.clearStorageData()
  }
}
