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
    // 手上没有版本号，退回 idle 是对的 —— 亮一个不知道更新到哪的角标才是错的
    expect(store.phase).toBe('idle')
  })

  /**
   * 出错要退回「可更新」，不是「无事发生」。
   *
   * 原来这里一律写 idle，而 hasUpdateNews 不含 idle —— 等于把标题栏角标摘掉：
   * 后台查到新版本（角标亮着）→ 用户去关于页点一次检查 → 网络断了 →
   * 角标没了，latestVersion 还在，下一次成功检查之前没有任何东西能装回来。
   */
  it('已经知道有新版本时，出错退回「可更新」而不是清空角标', () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()

    store.init()
    listeners.available.forEach((fn) => fn({ version: '1.3.0' }))
    expect(store.phase).toBe('available')

    listeners.error.forEach((fn) => fn({ message: 'offline' }))

    expect(store.phase).toBe('available')
    expect(store.hasUpdateNews).toBe(true)
    expect(store.latestVersion).toBe('1.3.0')
  })

  /**
   * 主进程有三条分支什么都不做也返回成功（没配更新源、已有检查在跑、
   * updater 未激活），那几条路一个事件都不会来。不自己收尾的话 phase 永远
   * 卡在 checking，isChecking 永远为真，「检查更新」按钮这个会话就此报废。
   */
  it('主进程报成功却一个事件都没推时，不能卡在「检查中」', async () => {
    installUpdaterApi()
    const store = useUpdateStore()

    store.init()
    await vi.waitFor(() => expect(store.phase).toBe('idle'))

    const result = await store.check()

    expect(store.phase).not.toBe('checking')
    expect(store.isChecking).toBe(false)
    // 「没问出结果」不等于「已是最新」，调用方据此决定别谎报 upToDate
    expect(result.outcome).toBe('unknown')
  })

  it('后台例行检查不把已经亮着的角标打回「检查中」', () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()

    store.init()
    listeners.available.forEach((fn) => fn({ version: '1.3.0' }))
    listeners.checking.forEach((fn) => fn())

    expect(store.phase).toBe('available')
    expect(store.hasUpdateNews).toBe(true)
  })

  /**
   * 已下载之后漏进来的进度事件不能把状态拽回「下载中」——
   * 那会让角标变成 aria-disabled，唯一的安装入口就此点不动。
   */
  it('已下载之后迟到的进度事件不把状态拽回下载中', () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()

    store.init()
    listeners.downloaded.forEach((fn) => fn({ version: '1.3.0' }))
    listeners.progress.forEach((fn) => fn({ percent: 42, transferred: 42, total: 100 }))

    expect(store.phase).toBe('downloaded')
    expect(store.downloadPercent).toBe(100)
  })

  /**
   * 启动检查跑在渲染进程加载完之前时，事件已经丢了 —— 快照这一步必须把
   * 全局提示也补上，否则这个 Store 存在的理由在它真正要救的那条路上不成立。
   */
  it('快照补出来的新版本也要弹一次全局提示', async () => {
    installUpdaterApi({ updateAvailable: true, latestVersion: '1.2.0' })
    const store = useUpdateStore()
    const onAvailable = vi.fn()

    store.init({ onAvailable })
    await vi.waitFor(() => expect(store.phase).toBe('available'))

    expect(onAvailable).toHaveBeenCalledWith('1.2.0')
  })

  /**
   * 用户站在关于页等结果时，那一轮由面板自己弹确认框说，全局 toast 别再说一遍：
   * 否则一次点击同时出现「点标题栏右上角即可下载」和一个已经摆在眼前的
   * 「现在下载吗？」，两句话让用户去做两件不同的事。
   */
  it('手动检查那一轮不弹全局提示，但也不记名 —— 抑制掉的提示不能算说过', async () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()
    const onAvailable = vi.fn()

    store.init({ onAvailable })
    await vi.waitFor(() => expect(store.phase).toBe('idle'))

    const pending = store.check()
    listeners.available.forEach((fn) => fn({ version: '1.4.0' }))
    await pending

    // 这一轮由关于页自己弹确认框，全局 toast 让位
    expect(onAvailable).not.toHaveBeenCalled()

    /*
     * 但不能记名。抑制的前提是「关于页会说」，而那个面板是 v-else-if 挂载的：
     * 用户点完检查随手切走，面板卸载、watch 没了，于是一个字都没说出去。
     * 记了名的话，之后每一次后台检查都会撞上「这个版本提示过了」提前返回 ——
     * 整个会话再也不会提示，只剩标题栏一枚 6px 的小点。
     */
    listeners.available.forEach((fn) => fn({ version: '1.4.0' }))
    expect(onAvailable).toHaveBeenCalledWith('1.4.0')
  })

  /**
   * downloadUpdate() 要等整个下载结束才 resolve，所以 await 回来还停在
   * downloading、一个字节都没走，就说明主进程那三条静默分支之一走掉了。
   * 不退回去的话角标永远停在「下载中 0%」，而那个状态是点不动的。
   */
  it('主进程报成功却没开始下载时，退回「可更新」并如实报失败', async () => {
    const { listeners } = installUpdaterApi()
    const store = useUpdateStore()

    store.init()
    listeners.available.forEach((fn) => fn({ version: '1.3.0' }))

    const result = await store.download()

    expect(result.success).toBe(false)
    expect(store.phase).toBe('available')
    expect(store.downloadPercent).toBe(0)
  })

  it('版本号显示统一带 v 前缀，已经带的不重复加', () => {
    expect(formatUpdateVersion('1.2.0')).toBe('v1.2.0')
    expect(formatUpdateVersion('v1.2.0')).toBe('v1.2.0')
    expect(formatUpdateVersion('')).toBe('')
  })
})
