/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Menu } from 'electron'

import type { Shortcut } from '../sqliteDataBase/models/shortcut'

/**
 * 假的 globalShortcut：用一个 Set 记录当前注册了哪些快捷键。
 *
 * 这个测试要守的是**跨模块**的行为：globalShortcut 是全进程共享的，
 * MiniChat 之类的模块也往里注册自己的快捷键，所以「注销」的范围必须精确。
 */
const registry = new Set<string>()
const unregisterAllSpy = vi.fn()

vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn((accelerator: string) => {
      registry.add(accelerator)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      registry.delete(accelerator)
    }),
    unregisterAll: vi.fn(() => {
      unregisterAllSpy()
      registry.clear()
    })
  },
  BrowserWindow: { getAllWindows: () => [] },
  Menu: {
    buildFromTemplate: vi.fn(() => ({})),
    setApplicationMenu: vi.fn()
  }
}))

let shortcutsEnabled = true
let shortcutRows: Shortcut[] = []

vi.mock('../sqliteDataBase', () => ({
  getPublicDatabase: () => ({})
}))

vi.mock('../sqliteDataBase/models/shortcut', () => ({
  getAllShortcuts: () => shortcutRows
}))

vi.mock('../sqliteDataBase/models/settings', () => ({
  getSetting: () => shortcutsEnabled
}))

vi.mock('../spotlightManager', () => ({
  spotlightManager: { toggle: vi.fn() }
}))

const setMiniChatShortcutEnabled = vi.fn()

vi.mock('../miniChatManager', () => ({
  miniChatManager: {
    setGlobalShortcutEnabled: (enabled: boolean) => {
      setMiniChatShortcutEnabled(enabled)
      // 跟真实实现一样：关掉就从注册表里摘掉，打开就放回去
      if (enabled) registry.add('CommandOrControl+Shift+M')
      else registry.delete('CommandOrControl+Shift+M')
    }
  }
}))

function globalShortcutRow(actionKey: string, accelerator: string): Shortcut {
  return {
    action_key: actionKey,
    accelerator,
    type: 'global',
    enabled: true,
    description: '',
    is_locked: false
  }
}

async function loadService(): Promise<{ registerGlobalShortcuts: () => void }> {
  vi.resetModules()
  const { ShortcutService } = await import('./shortcutService')
  return ShortcutService.getInstance()
}

beforeEach(() => {
  vi.mocked(Menu.buildFromTemplate).mockClear()
  registry.clear()
  unregisterAllSpy.mockClear()
  setMiniChatShortcutEnabled.mockClear()
  shortcutsEnabled = true
  shortcutRows = []
})

afterEach(() => vi.restoreAllMocks())

describe('ShortcutService 重建全局快捷键', () => {
  it.each([true, false])('Mac 重建菜单保留系统退出入口，快捷键启用=%s', async (enabled) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    shortcutsEnabled = enabled
    const service = await loadService()
    service.registerGlobalShortcuts()
    service.registerGlobalShortcuts()

    for (const [template] of vi.mocked(Menu.buildFromTemplate).mock.calls) {
      expect(template[0]).toEqual({ role: 'appMenu' })
    }
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(2)
  })

  it('Windows 不添加 Mac 应用菜单', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const service = await loadService()
    service.registerGlobalShortcuts()
    expect(vi.mocked(Menu.buildFromTemplate).mock.calls[0][0][0]).toEqual({ role: 'fileMenu' })
  })
  it('不碰别的模块注册的快捷键', async () => {
    // MiniChat 在 ShortcutService 之前就注册好了自己的快捷键（真实启动顺序如此）
    registry.add('CommandOrControl+Shift+M')
    shortcutRows = [globalShortcutRow('app.toggle_main_window', 'Alt+`')]

    const service = await loadService()
    service.registerGlobalShortcuts()

    // 回归点：以前这里用 unregisterAll()，把 MiniChat 的快捷键一起干掉了，
    // 而且再没人注册回来 —— Ctrl+Shift+M 从开机那一刻起就是废的
    expect(unregisterAllSpy).not.toHaveBeenCalled()
    expect(registry.has('CommandOrControl+Shift+M')).toBe(true)
    expect(registry.has('Alt+`')).toBe(true)
  })

  it('会注销自己上一轮注册的快捷键，不留幽灵', async () => {
    const service = await loadService()

    shortcutRows = [globalShortcutRow('app.toggle_main_window', 'Alt+`')]
    service.registerGlobalShortcuts()
    expect(registry.has('Alt+`')).toBe(true)

    // 用户把快捷键改成了别的，重新注册一轮
    shortcutRows = [globalShortcutRow('app.toggle_main_window', 'Alt+1')]
    service.registerGlobalShortcuts()

    expect(registry.has('Alt+`')).toBe(false)
    expect(registry.has('Alt+1')).toBe(true)
  })

  it('全局禁用快捷键时，MiniChat 的那个也一起关掉', async () => {
    registry.add('CommandOrControl+Shift+M')
    shortcutsEnabled = false
    shortcutRows = [globalShortcutRow('app.toggle_main_window', 'Alt+`')]

    const service = await loadService()
    service.registerGlobalShortcuts()

    expect(setMiniChatShortcutEnabled).toHaveBeenCalledWith(false)
    expect(registry.has('CommandOrControl+Shift+M')).toBe(false)
    expect(registry.has('Alt+`')).toBe(false)
  })
})
