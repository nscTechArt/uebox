import { describe, expect, it, vi } from 'vitest'
import { openBrowsePath } from './networkBrowsePath'

/**
 * 用户报上来的现象是「点了没反应」—— 主进程其实分得很清楚
 * （`{ success, error, pathNotFound }`），但渲染层把返回值丢了。
 * 这几条守的就是「失败必须说出来，而且要带上路径」。
 */
describe('openBrowsePath', () => {
  const path = '\\\\nas\\assets\\ZRR'

  it('打开成功时什么也不提示', async () => {
    const onNotFound = vi.fn()
    const onFailed = vi.fn()

    const ok = await openBrowsePath(path, {
      openPath: async () => ({ success: true }),
      onNotFound,
      onFailed
    })

    expect(ok).toBe(true)
    expect(onNotFound).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('路径不存在要单独说，并且带上路径', async () => {
    const onNotFound = vi.fn()
    const onFailed = vi.fn()

    const ok = await openBrowsePath(path, {
      openPath: async () => ({ success: false, error: '路径不存在', pathNotFound: true }),
      onNotFound,
      onFailed
    })

    expect(ok).toBe(false)
    expect(onNotFound).toHaveBeenCalledWith(path)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('其他失败也要说，把系统给的原因一起带出来', async () => {
    const onNotFound = vi.fn()
    const onFailed = vi.fn()

    const ok = await openBrowsePath(path, {
      openPath: async () => ({ success: false, error: 'Access is denied' }),
      onNotFound,
      onFailed
    })

    expect(ok).toBe(false)
    expect(onFailed).toHaveBeenCalledWith(path, 'Access is denied')
    expect(onNotFound).not.toHaveBeenCalled()
  })

  it('主进程返回个空的也不许静默', async () => {
    const onFailed = vi.fn()

    const ok = await openBrowsePath(path, {
      openPath: async () => undefined as unknown as { success: boolean },
      onNotFound: vi.fn(),
      onFailed
    })

    expect(ok).toBe(false)
    expect(onFailed).toHaveBeenCalledWith(path, '')
  })
})
