import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  lightboxEvents: new Map<string, () => void>(),
  viewerEvents: new Map<string, (event?: unknown) => void>(),
  copy: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
  viewer: {
    element: null as HTMLElement | null,
    currSlide: { data: { src: 'data:image/png;base64,first' } },
    on: vi.fn(),
    ui: { registerElement: vi.fn() }
  }
}))

vi.mock('photoswipe/lightbox', () => ({
  default: class {
    pswp = mocks.viewer
    on = (name: string, callback: () => void): void => {
      mocks.lightboxEvents.set(name, callback)
    }
    init = vi.fn()
    loadAndOpen = (): boolean => {
      mocks.lightboxEvents.get('uiRegister')?.()
      mocks.lightboxEvents.get('afterInit')?.()
      return true
    }
  }
}))
vi.mock('@renderer/utils/imageBlob', () => ({
  copyImageToClipboard: mocks.copy,
  downloadImage: mocks.save
}))
vi.mock('@renderer/utils/messageManager', () => ({ message: { error: mocks.error } }))

import { openImageViewer } from './imageViewer'

async function rightClick(): Promise<MouseEvent> {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 200,
    clientY: 120
  })
  mocks.viewer.element!.dispatchEvent(event)
  await vi.advanceTimersByTimeAsync(20)
  await nextTick()
  return event
}

describe('大图右键菜单', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.viewerEvents.clear()
    mocks.viewer.on.mockImplementation((name, callback) => mocks.viewerEvents.set(name, callback))
    mocks.viewer.element = document.createElement('div')
    document.body.appendChild(mocks.viewer.element)
    mocks.viewer.currSlide.data.src = 'data:image/png;base64,first'
    await openImageViewer({ items: [{ src: 'test.png', width: 100, height: 100 }] })
  })

  afterEach(async () => {
    mocks.viewerEvents.get('destroy')?.()
    mocks.viewer.element?.remove()
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  })

  it('显示统一菜单并复制当前图片，同时保留两个顶部按钮', async () => {
    const event = await rightClick()
    expect(event.defaultPrevented).toBe(true)
    const items = document.querySelectorAll<HTMLElement>('.context-menu [role="menuitem"]')
    expect(Array.from(items, (item) => item.textContent)).toEqual(['复制', '保存'])
    items[0].click()
    await nextTick()
    expect(mocks.copy).toHaveBeenCalledWith('data:image/png;base64,first')
    expect(document.querySelector('.context-menu')).toBeNull()
    expect(mocks.viewer.ui.registerElement.mock.calls.map(([item]) => item.name)).toEqual([
      'copy-button',
      'download-button'
    ])
  })

  it('翻页收起菜单，再次右键保存新图片，失败会提示', async () => {
    await rightClick()
    mocks.viewer.currSlide.data.src = 'data:image/png;base64,second'
    mocks.viewerEvents.get('change')?.()
    expect(document.querySelector('.context-menu')).toBeNull()
    mocks.save.mockRejectedValueOnce(new Error('failed'))
    await rightClick()
    document.querySelectorAll<HTMLElement>('.context-menu [role="menuitem"]')[1].click()
    await nextTick()
    expect(mocks.save).toHaveBeenCalledWith('data:image/png;base64,second')
    expect(mocks.error).toHaveBeenCalledWith('保存失败')
  })

  it('空图片不弹菜单，关闭查看器清理尚未显示的菜单', async () => {
    mocks.viewer.currSlide.data.src = ''
    await rightClick()
    expect(document.querySelector('.context-menu')).toBeNull()
    mocks.viewer.currSlide.data.src = 'test.png'
    mocks.viewer.element!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    mocks.viewerEvents.get('close')?.()
    await vi.advanceTimersByTimeAsync(20)
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('Escape 先关闭菜单，点击外部也能收起菜单', async () => {
    await rightClick()
    const originalEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    const preventDefault = vi.fn()
    mocks.viewerEvents.get('keydown')?.({ originalEvent, preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(originalEvent.defaultPrevented).toBe(true)
    expect(document.querySelector('.context-menu')).toBeNull()

    await rightClick()
    document.body.click()
    await nextTick()
    expect(document.querySelector('.context-menu')).toBeNull()
  })
})
