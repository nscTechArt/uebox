/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `onProjectsChanged` 是托盘菜单拿「工程连接变了」信号的口子：
 * 加、离线、删除、清空都要通知到，退订之后不再通知，
 * 一个监听器炸了不拖累别的。
 */

const sendToAppWindows = vi.fn()
vi.mock('../../appWindows', () => ({
  sendToAppWindows: (channel: string, payload: unknown) => sendToAppWindows(channel, payload)
}))
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

const { ProjectManager } = await import('./projectManager')

const info = {
  projectName: 'Demo',
  projectVersion: '1.0.0',
  engineVersion: '5.5',
  projectPath: 'D:/Demo',
  defaultMap: ''
}

describe('projectManager.onProjectsChanged', () => {
  let manager: InstanceType<typeof ProjectManager>

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new ProjectManager()
  })

  it('加工程时通知', () => {
    const listener = vi.fn()
    manager.onProjectsChanged(listener)

    manager.addProject('conn-1', info)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('标记离线时通知', () => {
    manager.addProject('conn-1', info)
    const listener = vi.fn()
    manager.onProjectsChanged(listener)

    manager.removeProject('conn-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('删除工程时通知', () => {
    manager.addProject('conn-1', info)
    const listener = vi.fn()
    manager.onProjectsChanged(listener)

    manager.deleteProject('conn-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('清空时通知', () => {
    manager.addProject('conn-1', info)
    const listener = vi.fn()
    manager.onProjectsChanged(listener)

    manager.clear()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('退订之后不再通知', () => {
    const listener = vi.fn()
    const unsubscribe = manager.onProjectsChanged(listener)
    unsubscribe()

    manager.addProject('conn-1', info)
    expect(listener).not.toHaveBeenCalled()
  })

  it('一个监听器抛错不拖累别的，也不拖累通知本身', () => {
    const ok = vi.fn()
    manager.onProjectsChanged(() => {
      throw new Error('boom')
    })
    manager.onProjectsChanged(ok)

    expect(() => manager.addProject('conn-1', info)).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
    // 渲染进程那份广播照样发出去了
    expect(sendToAppWindows).toHaveBeenCalledWith('ws:projects-changed', expect.any(Array))
  })

  it('广播抛错（关窗途中 webContents 已销毁）：监听器照样被叫醒，通知不外抛', () => {
    sendToAppWindows.mockImplementationOnce(() => {
      throw new Error('webContents destroyed')
    })
    const listener = vi.fn()
    manager.onProjectsChanged(listener)

    expect(() => manager.addProject('conn-1', info)).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
