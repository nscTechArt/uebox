/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app', getVersion: () => '1.0.0' },
  BrowserWindow: class {}
}))
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./updateFeed', () => ({
  describeUpdateFeed: () => '',
  readAppMetadata: () => ({}),
  resolveUpdateFeeds: () => []
}))

import { setQuitGuard } from '../../tray/quitGuard'
import { AutoUpdaterService } from './autoUpdater'

/**
 * 重启装包也是退出：还有会话操作没收摊时，和托盘「退出」问同一个框，
 * 用户确认了才真的装
 */

interface Internals {
  status: { updateDownloaded: boolean }
  updater: { quitAndInstall: ReturnType<typeof vi.fn> }
  mainWindow: { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }
}

function downloadedService(): { service: AutoUpdaterService; internals: Internals } {
  const service = new AutoUpdaterService()
  const internals = service as unknown as Internals
  internals.status.updateDownloaded = true
  internals.updater = { quitAndInstall: vi.fn() }
  internals.mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return { service, internals }
}

describe('quitAndInstall 过退出确认', () => {
  let pending: Array<{ proceed: () => void; reason: string }>

  beforeEach(() => {
    pending = []
  })
  afterEach(() => setQuitGuard(null))

  it('没下载完：直接报错，不去问也不装', () => {
    const guard = vi.fn()
    setQuitGuard(guard)
    const { service, internals } = downloadedService()
    internals.status.updateDownloaded = false

    expect(service.quitAndInstall().success).toBe(false)
    expect(guard).not.toHaveBeenCalled()
  })

  it('不用问：当场装，结果原样回', () => {
    setQuitGuard((proceed) => proceed())
    const { service, internals } = downloadedService()

    expect(service.quitAndInstall()).toEqual({ success: true })
    expect(internals.updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('不用问但装不上：失败照样从返回值带回去', () => {
    setQuitGuard((proceed) => proceed())
    const { service, internals } = downloadedService()
    internals.updater.quitAndInstall.mockImplementation(() => {
      throw new Error('boom')
    })

    expect(service.quitAndInstall()).toEqual({ success: false, error: 'boom' })
  })

  it('有会话操作要问：以 update 的名义去问，先不装；确认了才装', () => {
    setQuitGuard((proceed, reason) => pending.push({ proceed, reason }))
    const { service, internals } = downloadedService()

    expect(service.quitAndInstall()).toEqual({ success: true })
    expect(pending).toHaveLength(1)
    expect(pending[0].reason).toBe('update')
    expect(internals.updater.quitAndInstall).not.toHaveBeenCalled()

    pending[0].proceed()
    expect(internals.updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('确认之后才装不上：IPC 早回过了，走 update-error 让界面报', () => {
    setQuitGuard((proceed, reason) => pending.push({ proceed, reason }))
    const { service, internals } = downloadedService()
    internals.updater.quitAndInstall.mockImplementation(() => {
      throw new Error('boom')
    })

    service.quitAndInstall()
    pending[0].proceed()

    expect(internals.mainWindow.webContents.send).toHaveBeenCalledWith(
      'updater:update-error',
      expect.objectContaining({ message: 'boom' })
    )
  })

  it('托盘没起来：照原样直接装', () => {
    const { service, internals } = downloadedService()

    expect(service.quitAndInstall()).toEqual({ success: true })
    expect(internals.updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
