/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendToAppWindows = vi.fn()
vi.mock('../../appWindows', () => ({
  sendToAppWindows: (channel: string, ...args: unknown[]) => sendToAppWindows(channel, ...args)
}))
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

const { notifyProjectLibraryChanged, notifyProjectLibraryListeners, onProjectLibraryChanged } =
  await import('./projectLibraryEvents')

const listeners: Array<() => void> = []

function subscribe(listener: () => void): void {
  listeners.push(onProjectLibraryChanged(listener))
}

describe('projectLibraryEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendToAppWindows.mockReset()
    while (listeners.length) listeners.pop()!()
  })

  it('通知时广播给界面，也叫醒主进程订阅者', () => {
    const listener = vi.fn()
    subscribe(listener)

    notifyProjectLibraryChanged()

    expect(sendToAppWindows).toHaveBeenCalledWith('db:project:library-changed')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('广播抛错：订阅者照样被叫醒，通知本身不外抛', () => {
    sendToAppWindows.mockImplementation(() => {
      throw new Error('webContents destroyed')
    })
    const listener = vi.fn()
    subscribe(listener)

    expect(() => notifyProjectLibraryChanged()).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('一个订阅者抛错不拖累别的', () => {
    const ok = vi.fn()
    subscribe(() => {
      throw new Error('boom')
    })
    subscribe(ok)

    expect(() => notifyProjectLibraryChanged()).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('退订之后不再通知', () => {
    const listener = vi.fn()
    subscribe(listener)
    listeners.pop()!()

    notifyProjectLibraryChanged()
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifyProjectLibraryListeners 只叫订阅者，不广播给界面', () => {
    const listener = vi.fn()
    subscribe(listener)

    notifyProjectLibraryListeners()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(sendToAppWindows).not.toHaveBeenCalled()
  })

  it('notifyProjectLibraryListeners 下一个订阅者抛错也不拖累别的', () => {
    const ok = vi.fn()
    subscribe(() => {
      throw new Error('boom')
    })
    subscribe(ok)

    expect(() => notifyProjectLibraryListeners()).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })
})
