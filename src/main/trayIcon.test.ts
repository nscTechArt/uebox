/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeImage } from 'electron'
import { prepareTrayIcon } from './trayIcon'

vi.mock('electron', () => ({ nativeImage: { createFromPath: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

describe('菜单栏托盘图标', () => {
  it('Mac 将大图标缩放到菜单栏尺寸', () => {
    const resized = {}
    const image = { isEmpty: () => false, resize: vi.fn(() => resized) }
    vi.mocked(nativeImage.createFromPath).mockReturnValue(image as never)
    expect(prepareTrayIcon('icon.png', 'fallback.png', 'darwin')).toBe(resized)
    expect(image.resize).toHaveBeenCalledWith({ width: 18, height: 18 })
  })

  it('路径不可用时回退到随应用打包的资源', () => {
    const resized = {}
    vi.mocked(nativeImage.createFromPath)
      .mockReturnValueOnce({ isEmpty: () => true } as never)
      .mockReturnValueOnce({ isEmpty: () => false, resize: () => resized } as never)
    expect(prepareTrayIcon('missing.png', 'fallback.png', 'darwin')).toBe(resized)
    expect(nativeImage.createFromPath).toHaveBeenLastCalledWith('fallback.png')
  })

  it('所有资源缺失时报错，交给已有托盘错误处理', () => {
    vi.mocked(nativeImage.createFromPath).mockReturnValue({ isEmpty: () => true } as never)
    expect(() => prepareTrayIcon('missing.png', 'missing.png', 'darwin')).toThrow(
      'Tray icon could not be loaded'
    )
  })

  it.each(['win32', 'linux'] as const)('%s 保持原来的图标路径', (platform) => {
    expect(prepareTrayIcon('icon.ico', 'fallback.png', platform)).toBe('icon.ico')
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
  })
})
