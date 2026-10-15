import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssetChangeDebouncer } from './assetChangeDebouncer'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createAssetChangeDebouncer', () => {
  it('一个窗口内的多条变更合成一次刷新', async () => {
    const onFlush = vi.fn()
    const debouncer = createAssetChangeDebouncer(onFlush, 500)
    debouncer.push('assetData')
    debouncer.push('assetData')
    await vi.advanceTimersByTimeAsync(500)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith({ touchedFolders: false })
  })

  it('先来文件夹、后来资产：仍然要刷目录树（以前只看最后一条，树漏刷）', async () => {
    const onFlush = vi.fn()
    const debouncer = createAssetChangeDebouncer(onFlush, 500)
    debouncer.push('assetFolder')
    debouncer.push('assetData')
    await vi.advanceTimersByTimeAsync(500)
    expect(onFlush).toHaveBeenCalledWith({ touchedFolders: true })
  })

  it('刷新之后标记清零，下一个窗口只有资产就不刷树', async () => {
    const onFlush = vi.fn()
    const debouncer = createAssetChangeDebouncer(onFlush, 500)
    debouncer.push('assetFolder')
    await vi.advanceTimersByTimeAsync(500)
    debouncer.push('assetData')
    await vi.advanceTimersByTimeAsync(500)
    expect(onFlush).toHaveBeenLastCalledWith({ touchedFolders: false })
  })

  it('cancel 之后不再刷新（页面卸载）', async () => {
    const onFlush = vi.fn()
    const debouncer = createAssetChangeDebouncer(onFlush, 500)
    debouncer.push('assetFolder')
    debouncer.cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onFlush).not.toHaveBeenCalled()
  })
})
