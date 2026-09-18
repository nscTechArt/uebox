import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternalMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(async (): Promise<void> => undefined)
}))

vi.mock('electron', () => ({
  shell: { openExternal: openExternalMock }
}))

import {
  isSafeExternalUrl,
  isTrustedRendererUrl,
  openSafeExternalUrl,
  protectRendererWindow
} from './security'

type NavigationEvent = { preventDefault: () => void }
type NavigationHandler = (event: NavigationEvent, targetUrl: string) => void
type OpenHandler = (details: { url: string }) => { action: 'deny' }

describe('Electron renderer security boundaries', () => {
  beforeEach(() => {
    openExternalMock.mockClear()
  })

  it('only accepts credential-free HTTP(S) external URLs', () => {
    expect(isSafeExternalUrl('https://ue5box.com/docs?q=1')).toBe(true)
    expect(isSafeExternalUrl('http://127.0.0.1:8766/health')).toBe(true)
    expect(isSafeExternalUrl('https://user:password@example.com')).toBe(false)
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })

  it('opens safe URLs and rejects unsafe protocols', async () => {
    await openSafeExternalUrl('https://ue5box.com/')
    expect(openExternalMock).toHaveBeenCalledWith('https://ue5box.com/')

    await expect(openSafeExternalUrl('file:///C:/secret.txt')).rejects.toThrow(
      '仅允许打开 http 或 https 链接'
    )
    expect(openExternalMock).toHaveBeenCalledTimes(1)
  })

  it('trusts only the configured renderer origin in development', () => {
    const rendererFile = 'H:\\UnrealAgent\\unreal-agent-app\\out\\renderer\\index.html'
    const developmentUrl = 'http://127.0.0.1:5173'

    expect(
      isTrustedRendererUrl('http://127.0.0.1:5173/#/assistant', rendererFile, developmentUrl)
    ).toBe(true)
    expect(
      isTrustedRendererUrl('http://127.0.0.1:5174/#/assistant', rendererFile, developmentUrl)
    ).toBe(false)
    expect(
      isTrustedRendererUrl('https://ue5box.com/#/assistant', rendererFile, developmentUrl)
    ).toBe(false)
  })

  it('trusts only the packaged renderer file in production', () => {
    const rendererFile = 'H:\\UnrealAgent\\unreal-agent-app\\out\\renderer\\index.html'

    expect(
      isTrustedRendererUrl(
        'file:///H:/UnrealAgent/unreal-agent-app/out/renderer/index.html#/assistant',
        rendererFile
      )
    ).toBe(true)
    expect(
      isTrustedRendererUrl(
        'file:///H:/UnrealAgent/unreal-agent-app/out/renderer/other.html',
        rendererFile
      )
    ).toBe(false)
  })

  it('blocks untrusted navigation and denies every child window', async () => {
    let navigationHandler: NavigationHandler | undefined
    let openHandler: OpenHandler | undefined
    const webContents = {
      on: vi.fn((eventName: string, handler: NavigationHandler): void => {
        if (eventName === 'will-navigate') navigationHandler = handler
      }),
      setWindowOpenHandler: vi.fn((handler: OpenHandler): void => {
        openHandler = handler
      })
    }
    const window = { webContents } as unknown as BrowserWindow
    const rendererFile = 'H:\\UnrealAgent\\unreal-agent-app\\out\\renderer\\index.html'

    protectRendererWindow(window, rendererFile, 'http://127.0.0.1:5173')

    const trustedEvent = { preventDefault: vi.fn() }
    navigationHandler?.(trustedEvent, 'http://127.0.0.1:5173/#/home')
    expect(trustedEvent.preventDefault).not.toHaveBeenCalled()

    const untrustedEvent = { preventDefault: vi.fn() }
    navigationHandler?.(untrustedEvent, 'https://attacker.example/')
    expect(untrustedEvent.preventDefault).toHaveBeenCalledOnce()

    expect(openHandler?.({ url: 'https://ue5box.com/docs' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(openExternalMock).toHaveBeenCalledWith('https://ue5box.com/docs'))

    expect(openHandler?.({ url: 'file:///C:/secret.txt' })).toEqual({ action: 'deny' })
    expect(openExternalMock).toHaveBeenCalledTimes(1)
  })
})
