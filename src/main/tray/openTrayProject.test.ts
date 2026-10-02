/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import type { OpenUprojectResult } from '../services/project/openUproject'
import { createLaunchTracker, LAUNCH_TTL_MS } from './launchTracker'
import { createTrayProjectOpener, type TrayProjectOpenerDeps } from './openTrayProject'
import type { TrayRecentProject } from './trayMenu'

/**
 * 「启动中」标记的生死：点了就挂上，打开落定（成功转「等连接」计时 / 失败摘掉）
 * 才算翻页；菜单是弹出时刻的快照，「正在启动」和「此刻已经在跑」两道拦各挡一种双开。
 */

const project: TrayRecentProject = {
  projectKey: 'k-a',
  name: 'Alpha',
  originPath: 'D:/Alpha/Alpha.uproject',
  running: false,
  launching: false
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function deps(overrides: Partial<TrayProjectOpenerDeps> = {}): {
  deps: TrayProjectOpenerDeps
  tracker: ReturnType<typeof createLaunchTracker>
  isRunning: ReturnType<typeof vi.fn>
  openFile: ReturnType<typeof vi.fn>
  report: ReturnType<typeof vi.fn>
  onStateChanged: ReturnType<typeof vi.fn>
} {
  const tracker = createLaunchTracker()
  const isRunning = vi.fn(() => false)
  const openFile = vi.fn(async (): Promise<OpenUprojectResult> => ({ success: true }))
  const report = vi.fn()
  const onStateChanged = vi.fn()
  return {
    deps: {
      tracker,
      isRunning,
      openFile,
      report,
      onStateChanged,
      ...overrides
    },
    tracker,
    isRunning,
    openFile,
    report,
    onStateChanged
  }
}

describe('createTrayProjectOpener', () => {
  it('已经在启动中：不再开第二次', async () => {
    const { deps: d, tracker, openFile, report } = deps()
    tracker.begin('k-a')
    tracker.complete('k-a', true)

    await createTrayProjectOpener(d)(project)
    expect(openFile).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('openFile 还没回来就过了 TTL：照样不开第二次（那段不吃 TTL）', async () => {
    let now = 1_000
    const tracker = createLaunchTracker({ now: () => now })
    const pending = deferred<OpenUprojectResult>()
    const openFile = vi.fn(() => pending.promise)
    const { deps: d } = deps({ tracker, openFile })
    const open = createTrayProjectOpener(d)

    const first = open(project)
    now += LAUNCH_TTL_MS + 1
    await open(project)
    expect(openFile).toHaveBeenCalledTimes(1)

    pending.resolve({ success: true })
    await first
  })

  it('打开还在进行时它连上过又断开：pending 标记摘不掉，第二下照样拦', async () => {
    const pending = deferred<OpenUprojectResult>()
    const openFile = vi.fn(() => pending.promise)
    const { deps: d, tracker } = deps({ openFile })
    const open = createTrayProjectOpener(d)

    const first = open(project)
    tracker.clearIfRunning('k-a')

    await open(project)
    expect(openFile).toHaveBeenCalledTimes(1)

    pending.resolve({ success: true })
    await first
  })

  it('点下去这一刻已经在跑（菜单快照过期）：不开第二份', async () => {
    const { deps: d, tracker, openFile, report } = deps({ isRunning: () => true })

    await createTrayProjectOpener(d)(project)
    expect(openFile).not.toHaveBeenCalled()
    expect(tracker.isLaunching('k-a')).toBe(false)
    expect(report).not.toHaveBeenCalled()
  })

  it('点开先挂标记、通知菜单重建，落定后再通知一次', async () => {
    const { deps: d, tracker, openFile, onStateChanged } = deps()

    await createTrayProjectOpener(d)(project)
    expect(tracker.isLaunching('k-a')).toBe(true)
    expect(openFile).toHaveBeenCalledWith('D:/Alpha/Alpha.uproject')
    expect(onStateChanged).toHaveBeenCalledTimes(2)
  })

  it('打开成功：标记留着（等 running / TTL 摘掉），TTL 从落定才开始算', async () => {
    let now = 1_000
    const tracker = createLaunchTracker({ now: () => now })
    const pending = deferred<OpenUprojectResult>()
    const openFile = vi.fn(() => pending.promise)
    const { deps: d } = deps({ tracker, openFile })

    const first = createTrayProjectOpener(d)(project)
    now += LAUNCH_TTL_MS + 60_000
    pending.resolve({ success: true, pluginFailure: 'X' })
    await first

    expect(tracker.isLaunching('k-a')).toBe(true)
    now += LAUNCH_TTL_MS + 1
    expect(tracker.isLaunching('k-a')).toBe(false)
  })

  it('打开失败：摘掉标记，不然这个工程要灰到永远', async () => {
    const { deps: d, tracker, openFile, onStateChanged } = deps()
    openFile.mockResolvedValue({ success: false, error: 'no' })

    await createTrayProjectOpener(d)(project)
    expect(tracker.isLaunching('k-a')).toBe(false)
    // 挂上一次 + 摘掉一次
    expect(onStateChanged).toHaveBeenCalledTimes(2)
  })

  it('打开成功：把结果交给 report', async () => {
    const { deps: d, openFile, report } = deps()
    openFile.mockResolvedValue({ success: true, pluginFailure: 'X' })

    await createTrayProjectOpener(d)(project)
    expect(report).toHaveBeenCalledWith({ success: true, pluginFailure: 'X' }, project)
  })

  it('打开失败：照样交给 report', async () => {
    const { deps: d, openFile, report } = deps()
    openFile.mockResolvedValue({ success: false, error: 'no' })

    await createTrayProjectOpener(d)(project)
    expect(report).toHaveBeenCalledWith({ success: false, error: 'no' }, project)
  })

  it('openFile 异步拒了：按打开失败处理 —— 摘标记、原因交给 report', async () => {
    const { deps: d, tracker, openFile, report, onStateChanged } = deps()
    openFile.mockRejectedValue(new Error('spawn blew up'))

    await createTrayProjectOpener(d)(project)
    expect(tracker.isLaunching('k-a')).toBe(false)
    // 挂上一次 + 摘掉一次
    expect(onStateChanged).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledWith({ success: false, error: 'spawn blew up' }, project)
  })

  it('openFile 同步抛了：一样按打开失败处理', async () => {
    const { deps: d, tracker, openFile, report } = deps()
    openFile.mockImplementation(() => {
      throw new Error('sync boom')
    })

    await createTrayProjectOpener(d)(project)
    expect(tracker.isLaunching('k-a')).toBe(false)
    expect(report).toHaveBeenCalledWith({ success: false, error: 'sync boom' }, project)
  })
})
