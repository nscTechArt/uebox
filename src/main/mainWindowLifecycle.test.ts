/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import {
  keepMainWindowInTray,
  minimizeCurrentMainWindow,
  showOrCreateMainWindow
} from './mainWindowLifecycle'

interface WindowMock {
  focus: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  minimize: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
}

function createWindowMock(
  overrides: { destroyed?: boolean; minimized?: boolean } = {}
): WindowMock {
  return {
    focus: vi.fn(),
    hide: vi.fn(),
    isDestroyed: vi.fn(() => overrides.destroyed ?? false),
    isMinimized: vi.fn(() => overrides.minimized ?? false),
    minimize: vi.fn(),
    restore: vi.fn(),
    show: vi.fn()
  }
}

describe('主窗口托盘生命周期', () => {
  it('点击窗口关闭时只隐藏窗口', () => {
    const event = { preventDefault: vi.fn() }
    const mainWindow = createWindowMock()

    keepMainWindowInTray(event, mainWindow, false)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mainWindow.hide).toHaveBeenCalledOnce()
  })

  it('从托盘退出时允许窗口真正关闭', () => {
    const event = { preventDefault: vi.fn() }
    const mainWindow = createWindowMock()

    keepMainWindowInTray(event, mainWindow, true)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(mainWindow.hide).not.toHaveBeenCalled()
  })

  it('点击托盘时恢复并显示当前窗口', () => {
    const mainWindow = createWindowMock({ minimized: true })
    const createWindow = vi.fn()

    showOrCreateMainWindow(() => mainWindow, createWindow)

    expect(mainWindow.restore).toHaveBeenCalledOnce()
    expect(mainWindow.show).toHaveBeenCalledOnce()
    expect(mainWindow.focus).toHaveBeenCalledOnce()
    expect(createWindow).not.toHaveBeenCalled()
  })

  it('主窗口不存在或已销毁时重新创建', () => {
    const createMissingWindow = vi.fn()
    const createDestroyedWindow = vi.fn()
    const destroyedWindow = createWindowMock({ destroyed: true })

    showOrCreateMainWindow(() => undefined, createMissingWindow)
    showOrCreateMainWindow(() => destroyedWindow, createDestroyedWindow)

    expect(createMissingWindow).toHaveBeenCalledOnce()
    expect(createDestroyedWindow).toHaveBeenCalledOnce()
    expect(destroyedWindow.show).not.toHaveBeenCalled()
  })

  it('托盘最小化操作忽略不存在或已销毁的窗口', () => {
    const mainWindow = createWindowMock()
    const destroyedWindow = createWindowMock({ destroyed: true })

    minimizeCurrentMainWindow(() => mainWindow)
    minimizeCurrentMainWindow(() => undefined)
    minimizeCurrentMainWindow(() => destroyedWindow)

    expect(mainWindow.minimize).toHaveBeenCalledOnce()
    expect(destroyedWindow.minimize).not.toHaveBeenCalled()
  })
})
