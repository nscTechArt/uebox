/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ text: '{}', exists: false }))
vi.mock('electron', () => ({ app: { getPath: () => '/test-settings' } }))
vi.mock('./services', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('fs', () => ({
  existsSync: () => disk.exists,
  readFileSync: () => disk.text,
  writeFileSync: (_path: string, text: string) => {
    disk.text = text
    disk.exists = true
  }
}))

beforeEach(() => {
  vi.resetModules()
  disk.text = '{}'
  disk.exists = false
})

describe('连接插件自动安装与首次询问', () => {
  it('新装（没有配置文件）：自动安装关着，还没问过', async () => {
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getAutoEnableUnrealAgentLink()).toBe(false)
    expect(appSettingsManager.getUALinkInstallPromptShown()).toBe(false)
  })

  it('老用户升级上来（配置里没这两个字段）：保持自动安装，也不补问', async () => {
    disk.exists = true
    disk.text = '{"language":"zh-CN"}'
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getAutoEnableUnrealAgentLink()).toBe(true)
    expect(appSettingsManager.getUALinkInstallPromptShown()).toBe(true)
  })

  it('老用户明确关过自动安装：仍然关着', async () => {
    disk.exists = true
    disk.text = '{"autoEnableUnrealAgentLink":false}'
    const { appSettingsManager } = await import('./appSettingsManager')
    expect(appSettingsManager.getAutoEnableUnrealAgentLink()).toBe(false)
  })

  it('新用户改过别的设置、还没被问过：重启后照样会问', async () => {
    const { appSettingsManager: first } = await import('./appSettingsManager')
    first.setLanguage('en-US')
    vi.resetModules()
    const { appSettingsManager: restarted } = await import('./appSettingsManager')
    expect(restarted.getAutoEnableUnrealAgentLink()).toBe(false)
    expect(restarted.getUALinkInstallPromptShown()).toBe(false)
  })

  it('问过之后重启不再问', async () => {
    const { appSettingsManager: first } = await import('./appSettingsManager')
    first.setUALinkInstallPromptShown(true)
    vi.resetModules()
    const { appSettingsManager: restarted } = await import('./appSettingsManager')
    expect(restarted.getUALinkInstallPromptShown()).toBe(true)
  })
})
