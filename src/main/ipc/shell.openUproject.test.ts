/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「打开工程后隐藏主界面」的判定在主进程这一侧，覆盖所有从盒子启动工程的入口
 * （项目卡片双击、合集里双击、右键菜单的「启动」）——放在某个页面的双击回调里
 * 只能盖住其中一条路径。
 *
 * 两条不能破的线：设置关着时绝不动窗口；启动失败时也绝不动窗口（否则用户面对
 * 一个空桌面：编辑器没起来，那句错误提示也跟着窗口一起没了）。
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const openPath = vi.fn<(path: string) => Promise<string>>()
const existsSync = vi.fn<(path: string) => boolean>()
const getHideWindowOnProjectLaunch = vi.fn<() => boolean>()
const hide = vi.fn()
const isDestroyed = vi.fn<() => boolean>()
const findMainWindow = vi.fn<() => unknown>()

vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: () => '', getPath: () => '', getAppPath: () => '' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  shell: {
    openPath: (path: string) => openPath(path),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn()
  }
}))

vi.mock('fs', () => ({ existsSync: (path: string) => existsSync(path) }))

vi.mock('../appSettingsManager', () => ({
  appSettingsManager: {
    getAutoEnableUnrealAgentLink: () => false,
    getHideWindowOnProjectLaunch: () => getHideWindowOnProjectLaunch()
  }
}))
vi.mock('../appWindows', () => ({ findMainWindow: () => findMainWindow() }))
vi.mock('../sqliteDataBase/ipc/project', () => ({ ensureUnrealAgentLinkPlugin: vi.fn() }))
vi.mock('../security', () => ({ openSafeExternalUrl: vi.fn() }))

const { registerShellIPC } = await import('./shell')
registerShellIPC()

beforeEach(() => {
  vi.clearAllMocks()
  openPath.mockResolvedValue('')
  existsSync.mockReturnValue(true)
  isDestroyed.mockReturnValue(false)
  findMainWindow.mockReturnValue({ hide, isDestroyed })
})

async function openUproject(): Promise<unknown> {
  return handlers.get('shell:openUproject')!({}, 'D:/Demo/Demo.uproject')
}

describe('shell:openUproject · 打开工程后隐藏主界面', () => {
  it('设置开着时把主界面收起来', async () => {
    getHideWindowOnProjectLaunch.mockReturnValue(true)

    await expect(openUproject()).resolves.toEqual({ success: true })
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('设置关着时不碰窗口', async () => {
    getHideWindowOnProjectLaunch.mockReturnValue(false)

    await expect(openUproject()).resolves.toEqual({ success: true })
    expect(hide).not.toHaveBeenCalled()
  })

  it('工程没打开成功就不藏 —— 否则错误提示跟着窗口一起消失', async () => {
    getHideWindowOnProjectLaunch.mockReturnValue(true)
    openPath.mockResolvedValue('没有程序关联 .uproject')

    await expect(openUproject()).resolves.toEqual({
      success: false,
      error: '没有程序关联 .uproject'
    })
    expect(hide).not.toHaveBeenCalled()
  })

  it('工程被删了要报「文件不存在」，不能把系统那句 Failed to open path 甩给用户', async () => {
    getHideWindowOnProjectLaunch.mockReturnValue(true)
    existsSync.mockReturnValue(false)

    await expect(openUproject()).resolves.toEqual({
      success: false,
      error: '工程文件不存在',
      pathNotFound: true
    })
    // 文件都没了就别再去改 .uproject 装插件，也别碰窗口
    expect(openPath).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
  })

  it('主窗口已经不在了也不报错', async () => {
    getHideWindowOnProjectLaunch.mockReturnValue(true)
    findMainWindow.mockReturnValue(undefined)

    await expect(openUproject()).resolves.toEqual({ success: true })
    expect(hide).not.toHaveBeenCalled()
  })
})
