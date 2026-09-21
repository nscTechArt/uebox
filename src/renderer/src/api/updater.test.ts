/**
 * 这一层存在的理由就是「桥不在的时候别把 TypeError 丢给用户看」，
 * 所以三条失败路径都要钉住：桥不在、主进程回了空、调用直接抛。
 *
 * 还有一条同样重要：这一层自己造的失败只能给 **errorKey**，不能给成品文案。
 * 给了 `error`，调用方 `result.error || t('...')` 的兜底翻译就永远轮不到，
 * 英文用户会收到一句中文（AGENTS.md §5 规则 3）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { updaterAPI } from './updater'

type Win = { api?: { updater?: Record<string, unknown> } }
const win = globalThis as unknown as Win

function setBridge(updater: Record<string, unknown> | undefined): void {
  win.api = updater ? { updater } : {}
}

afterEach(() => {
  delete win.api
  vi.restoreAllMocks()
})

describe('updaterAPI 的失败形状', () => {
  it('桥不在时回可翻译的失败，不抛 TypeError', async () => {
    setBridge(undefined)

    const result = await updaterAPI.checkForUpdates()

    expect(result.success).toBe(false)
    expect(result.errorKey).toBe('update.unavailable')
    // 成品文案不能出现在这一层，否则调用方的 t() 兜底永远轮不到
    expect(result.error).toBeUndefined()
  })

  it('调用抛异常时收成失败，细节只进控制台', async () => {
    const boom = new Error('Error invoking remote method: channel gone')
    setBridge({ checkForUpdates: vi.fn().mockRejectedValue(boom) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await updaterAPI.checkForUpdates()

    expect(result.success).toBe(false)
    expect(result.errorKey).toBe('update.unavailable')
    // 原始的 IPC 文案不能进返回值 —— 它会被原样 message.error 弹出去
    expect(JSON.stringify(result)).not.toContain('remote method')
    expect(logged).toHaveBeenCalled()
  })

  it('主进程回空时不给文案，让调用方翻自己的兜底', async () => {
    setBridge({ downloadUpdate: vi.fn().mockResolvedValue(undefined) })

    const result = await updaterAPI.downloadUpdate()

    expect(result).toEqual({ success: false })
  })

  it('主进程的原文照原样带出去', async () => {
    setBridge({
      quitAndInstall: vi.fn().mockResolvedValue({ success: false, error: '更新尚未下载完成' })
    })

    const result = await updaterAPI.quitAndInstall()

    expect(result).toEqual({ success: false, error: '更新尚未下载完成' })
  })

  it('getStatus 读不到就回 null，不编一个空状态出来', async () => {
    setBridge(undefined)
    await expect(updaterAPI.getStatus()).resolves.toBeNull()

    setBridge({ getStatus: vi.fn().mockResolvedValue({ success: false, error: 'nope' }) })
    await expect(updaterAPI.getStatus()).resolves.toBeNull()
  })

  it('subscribe 在桥不在时回 null —— 调用方据此知道订阅没挂上', () => {
    setBridge(undefined)

    expect(
      updaterAPI.subscribe({
        onChecking: vi.fn(),
        onAvailable: vi.fn(),
        onNotAvailable: vi.fn(),
        onProgress: vi.fn(),
        onDownloaded: vi.fn(),
        onError: vi.fn()
      })
    ).toBeNull()
  })

  it('subscribe 返回的函数摘掉全部六个监听', () => {
    const offs = Array.from({ length: 6 }, () => vi.fn())
    let i = 0
    const register = (): (() => void) => offs[i++]!
    setBridge({
      onUpdateChecking: register,
      onUpdateAvailable: register,
      onUpdateNotAvailable: register,
      onDownloadProgress: register,
      onUpdateDownloaded: register,
      onUpdateError: register
    })

    const off = updaterAPI.subscribe({
      onChecking: vi.fn(),
      onAvailable: vi.fn(),
      onNotAvailable: vi.fn(),
      onProgress: vi.fn(),
      onDownloaded: vi.fn(),
      onError: vi.fn()
    })
    off?.()

    expect(offs.every((fn) => fn.mock.calls.length === 1)).toBe(true)
  })
})
