/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  // `@electron-toolkit/utils`（经 services/agentBrowser 进到这条 import 链）
  // 在模块加载时就读 `app.isPackaged`。只 mock ipcMain 的话整个文件收集不起来
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const setAgentFileAccessScope = vi.fn()
const setAgentToolSearchEnabled = vi.fn()

vi.mock('../appSettingsManager', () => ({
  appSettingsManager: {
    setAgentToolSearchEnabled: (enabled: unknown) => setAgentToolSearchEnabled(enabled),
    setAgentFileAccessScope: (scope: unknown) => setAgentFileAccessScope(scope)
  }
}))
vi.mock('../utils/UnrealPathManager', () => ({ default: {} }))

const { registerAppSettingsIPC } = await import('./appSettings')
const setAppIconTheme = vi.fn()
registerAppSettingsIPC(setAppIconTheme)

beforeEach(() => {
  setAppIconTheme.mockReset()
  setAgentFileAccessScope.mockReset()
  setAgentToolSearchEnabled.mockReset()
})

describe('应用图标主题 IPC', () => {
  it('工具搜索 Beta 只接受明确的布尔值，未提供时不改设置', async () => {
    await handlers.get('app-settings:set')!({}, { agentToolSearchEnabled: true })
    expect(setAgentToolSearchEnabled).toHaveBeenLastCalledWith(true)
    await handlers.get('app-settings:set')!({}, { agentToolSearchEnabled: false })
    expect(setAgentToolSearchEnabled).toHaveBeenLastCalledWith(false)
    setAgentToolSearchEnabled.mockClear()
    await handlers.get('app-settings:set')!({}, { agentToolSearchEnabled: 'true' })
    await handlers.get('app-settings:set')!({}, {})
    expect(setAgentToolSearchEnabled).not.toHaveBeenCalled()
  })
  it.each(['light', 'dark'] as const)('接受 %s 并更新运行中的图标', async (theme) => {
    const result = await handlers.get('app-settings:setThemeIcon')!({}, theme)

    expect(result).toEqual({ success: true, data: true })
    expect(setAppIconTheme).toHaveBeenCalledWith(theme)
  })

  it('拒绝预加载边界之外的主题值', async () => {
    const result = await handlers.get('app-settings:setThemeIcon')!({}, 'neon')

    expect(result).toMatchObject({ success: false, data: false })
    expect(setAppIconTheme).not.toHaveBeenCalled()
  })

  it('文件访问范围只认两个字面量', async () => {
    // 这个值直接决定工具能不能碰盘。一个拼错的字符串落进配置文件，
    // 下次启动会兜底成「整台电脑」—— 用户以为自己收紧了，其实没有
    await handlers.get('app-settings:set')!({}, { agentFileAccessScope: 'ue-only' })
    expect(setAgentFileAccessScope).toHaveBeenCalledWith('ue-only')

    setAgentFileAccessScope.mockReset()
    await handlers.get('app-settings:set')!({}, { agentFileAccessScope: 'ue_only' })
    expect(setAgentFileAccessScope).not.toHaveBeenCalled()
  })

  it('没传文件访问范围时不动它', async () => {
    await handlers.get('app-settings:set')!({}, {})
    expect(setAgentFileAccessScope).not.toHaveBeenCalled()
  })

  it('系统拒绝更换图标时返回可见错误', async () => {
    setAppIconTheme.mockImplementation(() => {
      throw new Error('Windows shell rejected icon')
    })

    const result = await handlers.get('app-settings:setThemeIcon')!({}, 'dark')

    expect(result).toEqual({
      success: false,
      data: false,
      error: 'Windows shell rejected icon'
    })
  })
})
