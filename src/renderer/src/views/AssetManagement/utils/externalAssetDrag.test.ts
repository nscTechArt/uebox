import { describe, expect, it, vi } from 'vitest'
import { handleExternalAssetDrag } from './externalAssetDrag'

describe('Alt file drag routing', () => {
  it('leaves ordinary drags and their data transfer untouched', () => {
    const event = { altKey: false, preventDefault: vi.fn() }
    const resolve = vi.fn()
    const start = vi.fn()
    expect(handleExternalAssetDrag(event, resolve, start, vi.fn())).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('cancels HTML drag and starts an OS drag for Alt', () => {
    const event = { altKey: true, preventDefault: vi.fn() }
    const start = vi.fn().mockResolvedValue(undefined)
    expect(handleExternalAssetDrag(event, () => 'C:/asset.fbx', start, vi.fn())).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith('C:/asset.fbx')
  })

  it('does not fall back to an internal move for an unsupported Alt drag', () => {
    const start = vi.fn()
    const error = vi.fn()
    expect(
      handleExternalAssetDrag({ altKey: true, preventDefault: vi.fn() }, () => null, start, error)
    ).toBe(true)
    expect(start).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledOnce()
  })

  it('surfaces a native failure while keeping the internal route blocked', async () => {
    const error = vi.fn()
    expect(
      handleExternalAssetDrag(
        { altKey: true, preventDefault: vi.fn() },
        () => 'C:/missing.fbx',
        vi.fn().mockRejectedValue(new Error('missing')),
        error
      )
    ).toBe(true)
    await Promise.resolve()
    expect(error).toHaveBeenCalledOnce()
  })
})
