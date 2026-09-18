import type { BrowserWindow, Event } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { keepWindowTitleFixed, MAIN_WINDOW_TITLE } from './windowTitle'

describe('main window title', () => {
  it('keeps the app name when page titles change between tabs', () => {
    let titleListener: ((event: Event, title: string, explicitSet: boolean) => void) | undefined
    const window = {
      on: vi.fn((eventName, listener) => {
        if (eventName === 'page-title-updated') titleListener = listener
      })
    } as unknown as Pick<BrowserWindow, 'on'>

    keepWindowTitleFixed(window)

    const event = { preventDefault: vi.fn() } as unknown as Event
    titleListener?.(event, 'AI 创作', true)
    titleListener?.(event, '资产库', true)

    expect(MAIN_WINDOW_TITLE).toBe('虚幻盒子')
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
  })
})
