import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLatestValueScheduler } from './latestValueScheduler'

describe('createLatestValueScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('立即显示第一份内容，并把一个节拍内的增量合并为最新值', () => {
    vi.useFakeTimers()
    let now = 0
    const onValue = vi.fn()
    const scheduler = createLatestValueScheduler({ intervalMs: 80, onValue, now: () => now })

    scheduler.schedule('第一段')
    scheduler.schedule('第二段')
    scheduler.schedule('第三段')

    expect(onValue).toHaveBeenCalledTimes(1)
    expect(onValue).toHaveBeenLastCalledWith('第一段')

    now = 80
    vi.advanceTimersByTime(80)

    expect(onValue).toHaveBeenCalledTimes(2)
    expect(onValue).toHaveBeenLastCalledWith('第三段')
  })

  it('持续输入不会重置截止时间，最长一个节拍就会显示进度', () => {
    vi.useFakeTimers()
    let now = 0
    const onValue = vi.fn()
    const scheduler = createLatestValueScheduler({ intervalMs: 80, onValue, now: () => now })

    scheduler.schedule('0ms')
    for (const elapsed of [20, 40, 60]) {
      now = elapsed
      vi.advanceTimersByTime(20)
      scheduler.schedule(`${elapsed}ms`)
    }

    now = 80
    vi.advanceTimersByTime(20)

    expect(onValue.mock.calls).toEqual([['0ms'], ['60ms']])
  })

  it('收尾时立即补齐最新内容，并取消尚未到点的任务', () => {
    vi.useFakeTimers()
    let now = 0
    const onValue = vi.fn()
    const scheduler = createLatestValueScheduler({ intervalMs: 80, onValue, now: () => now })

    scheduler.schedule('开头')
    now = 20
    scheduler.schedule('终稿')
    scheduler.flush()
    vi.advanceTimersByTime(80)

    expect(onValue.mock.calls).toEqual([['开头'], ['终稿']])
  })

  it('组件销毁后不再执行积压的渲染', () => {
    vi.useFakeTimers()
    let now = 0
    const onValue = vi.fn()
    const scheduler = createLatestValueScheduler({ intervalMs: 80, onValue, now: () => now })

    scheduler.schedule('开头')
    now = 20
    scheduler.schedule('不会显示')
    scheduler.cancel()
    vi.advanceTimersByTime(80)

    expect(onValue.mock.calls).toEqual([['开头']])
  })
})
