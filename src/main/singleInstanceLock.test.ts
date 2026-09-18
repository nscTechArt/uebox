import { describe, expect, it, vi } from 'vitest'
import { acquireSingleInstanceLock } from './singleInstanceLock'

describe('single instance lock', () => {
  it('未拿到锁时退出，并阻止第二实例继续初始化', () => {
    const quit = vi.fn()
    const requestSingleInstanceLock = vi.fn(() => false)

    const shouldInitialize = acquireSingleInstanceLock({ requestSingleInstanceLock, quit }, false)

    expect(shouldInitialize).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
  })

  it('拿到锁时允许主实例继续初始化', () => {
    const quit = vi.fn()

    expect(acquireSingleInstanceLock({ requestSingleInstanceLock: () => true, quit }, false)).toBe(
      true
    )
    expect(quit).not.toHaveBeenCalled()
  })

  it('显式关闭单实例锁时不申请锁', () => {
    const quit = vi.fn()
    const requestSingleInstanceLock = vi.fn(() => false)

    expect(acquireSingleInstanceLock({ requestSingleInstanceLock, quit }, true)).toBe(true)
    expect(requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })
})
