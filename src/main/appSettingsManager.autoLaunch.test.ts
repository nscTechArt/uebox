/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ text: null as string | null }))
const login = vi.hoisted(() => ({
  set: vi.fn(),
  /** 系统里这一项会不会真的开机启动（任务管理器里禁用了就是 false） */
  willLaunch: false,
  get: vi.fn()
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => '/test-settings',
    setLoginItemSettings: login.set,
    getLoginItemSettings: login.get
  }
}))
vi.mock('./services', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('fs', () => ({
  existsSync: () => disk.text !== null,
  readFileSync: () => disk.text,
  writeFileSync: (_path: string, text: string) => {
    disk.text = text
  }
}))

const platform = process.platform

beforeEach(() => {
  vi.resetModules()
  disk.text = null
  login.set.mockReset()
  login.willLaunch = false
  login.get.mockReset()
  login.get.mockImplementation((options?: { args?: string[] }) => ({
    // 跟 Electron 一致：带 --hidden 登记的项，不带参数查 openAtLogin 是 false
    openAtLogin: login.willLaunch && options?.args?.includes('--hidden') === true,
    executableWillLaunchAtLogin: login.willLaunch
  }))
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

describe('开机自启', () => {
  it('默认关：第一次启动不登记', async () => {
    const { appSettingsManager } = await import('./appSettingsManager')
    appSettingsManager.ensureAutoLaunchSetting()
    expect(appSettingsManager.getSettings().autoLaunch).toBe(false)
    expect(login.set).not.toHaveBeenCalled()
  })

  it('用户在设置页打开：带 --hidden 登记', async () => {
    const { appSettingsManager } = await import('./appSettingsManager')
    appSettingsManager.setAutoLaunch(true)
    expect(login.set).toHaveBeenCalledWith(
      expect.objectContaining({ openAtLogin: true, args: ['--hidden'] })
    )
    expect(JSON.parse(disk.text!).autoLaunch).toBe(true)
  })

  it('用户在任务管理器 / 360 里禁用后，下次启动不往回写，设置跟着变成关', async () => {
    disk.text = '{"autoLaunch":true}'
    login.willLaunch = false
    const { appSettingsManager } = await import('./appSettingsManager')
    appSettingsManager.ensureAutoLaunchSetting()
    expect(login.set).not.toHaveBeenCalled()
    expect(JSON.parse(disk.text!).autoLaunch).toBe(false)
  })

  it('已经登记着的照旧，不重写', async () => {
    disk.text = '{"autoLaunch":true}'
    login.willLaunch = true
    const { appSettingsManager } = await import('./appSettingsManager')
    appSettingsManager.ensureAutoLaunchSetting()
    expect(login.set).not.toHaveBeenCalled()
  })

  it('Windows 上设置页读到的是真实状态（登记时带了 --hidden 也认）', async () => {
    disk.text = '{"autoLaunch":true}'
    login.willLaunch = true
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getAutoLaunchStatus()).toBe(true)
    login.willLaunch = false
    expect(appSettingsManager.getAutoLaunchStatus()).toBe(false)
  })
})
