/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { initializeDockIcon } from './dockIcon'

vi.mock('electron', () => ({ app: { dock: { setIcon: vi.fn() } } }))

afterEach(() => vi.restoreAllMocks())

describe('Dock 图标', () => {
  it('将应用资源路径交给 Dock，保留路径中的空格和中文', () => {
    const iconPath = '/Applications/虚幻盒子 Dev.app/Contents/Resources/icon.png'
    initializeDockIcon(iconPath)
    expect(app.dock?.setIcon).toHaveBeenCalledWith(iconPath)
  })

  it('Windows 和 Linux 没有 Dock 时正常跳过', () => {
    vi.spyOn(app, 'dock', 'get').mockReturnValue(undefined)
    expect(() => initializeDockIcon('/resources/icon.png')).not.toThrow()
  })
})
