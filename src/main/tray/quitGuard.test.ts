/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import { confirmTrayQuit } from './quitGuard'

/** 托盘「退出」的拦截线：有任务在跑就得先问一句，没有就直接退 */

describe('托盘退出确认', () => {
  it('没有任务在跑：直接退，不问', () => {
    const askConfirm = vi.fn()
    const quit = vi.fn()
    confirmTrayQuit({ countActiveOperations: () => 0, askConfirm, quit })

    expect(quit).toHaveBeenCalledTimes(1)
    expect(askConfirm).not.toHaveBeenCalled()
  })

  it('有任务在跑：带着数目去问，自己不退', () => {
    const askConfirm = vi.fn()
    const quit = vi.fn()
    confirmTrayQuit({ countActiveOperations: () => 2, askConfirm, quit })

    expect(askConfirm).toHaveBeenCalledWith(2)
    expect(quit).not.toHaveBeenCalled()
  })
})
