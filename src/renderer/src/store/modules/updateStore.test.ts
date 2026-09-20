import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { formatUpdateVersion, useUpdateStore } from './updateStore'

/** 攒下主进程各个事件的回调，测试里手动触发 */
type Listeners = {
  checking: Array<() => void>
  available: Array<(data: { version: string }) => void>
  notAvailable: Array<() => void>
  progress: Array<(data: { percent: number; transferred: number; total: number }) => void>
  downloaded: Array<(data: { version: string }) => void>
  error: Array<(data: { message?: string; code?: string }) => void>
}

type Status = {
  checking: boolean
  updateAvailable: boolean
  updateDownloaded: boolean
  currentVersion: string
  latestVersion?: string
}

function installUpdaterApi(status: Partial<Status> = {}): {
  listeners: Listeners
  downloadUpdate: ReturnType<typeof vi.fn>
} {
  const listeners: Listeners = {
    checking: [],
    available: [],
    notAvailable: [],
    progress: [],
    downloaded: [],
    error: []
  }

  const register =
    <T extends keyof Listeners>(key: T) =>
    (callback: Listeners[T][number]) => {
      ;(listeners[key] as Array<typeof callback>).push(callback)
      return () => {
        const list = listeners[key] as Array<typeof callback>
        list.splice(list.indexOf(callback), 1)
      }
    }

  const downloadUpdate = vi.fn().mockResolvedValue({ success: true })

  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ...(globalThis as unknown as { window?: Record<string, unknown> }).window,
    api: {
      updater: {
        checkForUpdates: vi.fn().mockResolvedValue({ success: true }),
        downloadUpdate,
        quitAndInstall: vi.fn().mockResolvedValue({ success: true }),
        getStatus: vi.fn().mockResolvedValue({
          success: true,
          data: {
            checking: false,
            updateAvailable: false,
            updateDownloaded: false,
            currentVersion: '1.0.0',
            ...status
          }
        }),
        onUpdateChecking: register('checking'),
        onUpdateAvailable: register('available'),
        onUpdateNotAvailable: register('notAvailable'),
        onDownloadProgress: register('progress'),
        onUpdateDownloaded: register('downloaded'),
        onUpdateError: register('error')
      }
    }
  }

  return { listeners, downloadUpdate }
}

describe('updateStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('订阅之后补拉一次状态 —— 启动检查往往早于渲染进程加载完', async () => {
    installUpdaterApi({ updateAvailable: true, latestVersion: '1.2.0' })
    const store = useUpdateStore()

    store.init()
    await vi.waitFor(() => expect(store.phase).toBe('available'))

    // 这是这次改动的核心：没有这一步，启动时查到的新版本在本次会话里永远看不见
    expect(store.latestVersion).toBe('1.2.0')
    expect(store.hasUpdateNews).toBe(true)
  })

  it('同一个版本只提示一次，换了版本再提示一次', () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()
    const onAvailable = vi.fn()

    store.init({ onAvailable })
    listeners.available.forEach((fn) => fn({ version: '1.2.0' }))
    listeners.available.forEach((fn) => fn({ version: '1.2.0' }))
    listeners.available.forEach((fn) => fn({ version: '1.3.0' }))

    expect(onAvailable.mock.calls.map(([version]) => version)).toEqual(['1.2.0', '1.3.0'])
  })

  it('下载中撞上例行检查，不会被打回「有新版本」', () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()

    store.init()
    listeners.available.forEach((fn) => fn({ version: '1.2.0' }))
    listeners.progress.forEach((fn) => fn({ percent: 42.6, transferred: 1, total: 2 }))
    expect(store.phase).toBe('downloading')
    expect(store.downloadPercent).toBe(43)

    // 4 小时一次的后台检查落在下载中间
    listeners.checking.forEach((fn) => fn())
    listeners.available.forEach((fn) => fn({ version: '1.2.0' }))

    expect(store.phase).toBe('downloading')
  })

  it('已下载的状态不会被后续的检查或错误抹掉 —— 那是唯一的安装入口', () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()

    store.init()
    listeners.downloaded.forEach((fn) => fn({ version: '1.2.0' }))
    expect(store.phase).toBe('downloaded')

    listeners.checking.forEach((fn) => fn())
    listeners.notAvailable.forEach((fn) => fn())
    listeners.error.forEach((fn) => fn({ message: 'boom' }))

    expect(store.phase).toBe('downloaded')
  })

  it('下载失败退回「可更新」，让用户能再点一次', async () => {
    const { downloadUpdate } = installUpdaterApi()
    downloadUpdate.mockResolvedValue({ success: false, error: 'boom' })
    const store = useUpdateStore()

    store.init()
    store.phase = 'available'
    const result = await store.download()

    expect(result.success).toBe(false)
    expect(store.phase).toBe('available')
  })

  it('错误只报给调用方一次，静默检查由主进程自己拦掉', () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()
    const onError = vi.fn()

    store.init({ onError })
    listeners.error.forEach((fn) => fn({ code: 'UPDATE_NETWORK_ERROR', message: 'offline' }))

    expect(onError).toHaveBeenCalledTimes(1)
    expect(store.lastError?.code).toBe('UPDATE_NETWORK_ERROR')
    expect(store.phase).toBe('idle')
  })

  it('版本号显示统一带 v 前缀，已经带的不重复加', () => {
    expect(formatUpdateVersion('1.2.0')).toBe('v1.2.0')
    expect(formatUpdateVersion('v1.2.0')).toBe('v1.2.0')
    expect(formatUpdateVersion('')).toBe('')
  })
})
