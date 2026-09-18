/**
 * 「解析出错，忽略还是取消」这个弹窗的等待逻辑。
 *
 * 红灯用例是后两条：原实现无限期等待、也不监听窗口关闭 ——
 * 主进程把事件发出去就原地等，用户此时关掉或刷新窗口，这个 Promise 永远不兑现，
 * **导入永远停在预处理阶段，进度条不动，只能重启应用**。
 * 并发工人共用同一个提示队列，所以是一起挂死。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createAssetImportRuntimeState,
  getImportPromptQueue,
  resolvePendingImportError,
  waitForImportErrorResolution,
  type AssetImportRuntimeState
} from './importRuntime'

let runtime: AssetImportRuntimeState

beforeEach(() => {
  vi.useFakeTimers()
  runtime = createAssetImportRuntimeState()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForImportErrorResolution', () => {
  it('different tasks in one window share a serial prompt queue', async () => {
    const owner = {}
    const firstQueue = getImportPromptQueue(owner)
    const secondQueue = getImportPromptQueue(owner)
    const second = vi.fn()
    let release!: () => void
    const first = firstQueue.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const next = secondQueue.run(second)
    await Promise.resolve()
    expect(second).not.toHaveBeenCalled()
    release()
    await first
    await next
    expect(second).toHaveBeenCalledOnce()
    expect(getImportPromptQueue({})).not.toBe(firstQueue)
  })

  it('用户点了选择就用用户的选择', async () => {
    const pending = waitForImportErrorResolution(runtime, 'task-1')

    expect(resolvePendingImportError(runtime, 'task-1', 'ignore')).toBe(true)

    await expect(pending).resolves.toBe('ignore')
  })

  it('等太久就自己做决定，不会永远挂着', async () => {
    const onFallback = vi.fn()
    const pending = waitForImportErrorResolution(runtime, 'task-1', {
      timeoutMs: 5_000,
      onFallback
    })

    await vi.advanceTimersByTimeAsync(5_000)

    await expect(pending).resolves.toBe('ignore_all')
    expect(onFallback).toHaveBeenCalledWith('timeout')
  })

  it('窗口关了就立刻收敛，不等超时', async () => {
    let windowGone = false
    const onFallback = vi.fn()
    const pending = waitForImportErrorResolution(runtime, 'task-1', {
      timeoutMs: 120_000,
      pollIntervalMs: 1_000,
      isAbandoned: () => windowGone,
      onFallback
    })

    windowGone = true
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(pending).resolves.toBe('ignore_all')
    expect(onFallback).toHaveBeenCalledWith('window_gone')
  })

  it('发事件之前窗口就没了 —— 一次都不用等', async () => {
    const pending = waitForImportErrorResolution(runtime, 'task-1', {
      isAbandoned: () => true
    })

    await expect(pending).resolves.toBe('ignore_all')
    // 没有留在等待队列里
    expect(runtime.importErrorResolvers.has('task-1')).toBe(false)
  })

  it('兜底之后把自己从队列里摘掉，迟到的回答不会错位落到下一个提问上', async () => {
    const first = waitForImportErrorResolution(runtime, 'task-1', { timeoutMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(first).resolves.toBe('ignore_all')

    // 队列已空，此时迟到的回答无处可落
    expect(resolvePendingImportError(runtime, 'task-1', 'cancel')).toBe(false)

    // 下一个提问拿到的是它自己的答案
    const second = waitForImportErrorResolution(runtime, 'task-1')
    resolvePendingImportError(runtime, 'task-1', 'ignore')
    await expect(second).resolves.toBe('ignore')
  })

  it('用户先点了，之后的超时不再改写结果', async () => {
    const onFallback = vi.fn()
    const pending = waitForImportErrorResolution(runtime, 'task-1', {
      timeoutMs: 1_000,
      onFallback
    })

    resolvePendingImportError(runtime, 'task-1', 'cancel')
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(pending).resolves.toBe('cancel')
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('取消这类决定会一次性放行所有并发工人，不是只放一个', async () => {
    const a = waitForImportErrorResolution(runtime, 'task-1')
    const b = waitForImportErrorResolution(runtime, 'task-1')

    resolvePendingImportError(runtime, 'task-1', 'cancel')

    await expect(a).resolves.toBe('cancel')
    await expect(b).resolves.toBe('cancel')
  })
})
