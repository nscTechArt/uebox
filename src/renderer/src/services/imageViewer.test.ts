import { describe, expect, it, vi } from 'vitest'

import { handleVerticalImageViewerPageKey } from './imageViewer'

function createNavigator(count = 3): {
  getNumItems: () => number
  prev: ReturnType<typeof vi.fn>
  next: ReturnType<typeof vi.fn>
} {
  return {
    getNumItems: () => count,
    prev: vi.fn(),
    next: vi.fn()
  }
}

describe('handleVerticalImageViewerPageKey', () => {
  it('用上方向键打开上一张图片', () => {
    const navigator = createNavigator()
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true })

    expect(handleVerticalImageViewerPageKey(event, navigator)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(navigator.prev).toHaveBeenCalledOnce()
    expect(navigator.next).not.toHaveBeenCalled()
  })

  it('用下方向键打开下一张图片', () => {
    const navigator = createNavigator()
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })

    expect(handleVerticalImageViewerPageKey(event, navigator)).toBe(true)
    expect(navigator.next).toHaveBeenCalledOnce()
    expect(navigator.prev).not.toHaveBeenCalled()
  })

  it('单张图片和带修饰键的操作不接管上下方向键', () => {
    const singleImageNavigator = createNavigator(1)
    const singleImageEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true })
    const modifiedNavigator = createNavigator()
    const modifiedEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
      cancelable: true
    })

    expect(handleVerticalImageViewerPageKey(singleImageEvent, singleImageNavigator)).toBe(false)
    expect(handleVerticalImageViewerPageKey(modifiedEvent, modifiedNavigator)).toBe(false)
    expect(singleImageNavigator.prev).not.toHaveBeenCalled()
    expect(modifiedNavigator.next).not.toHaveBeenCalled()
  })
})
