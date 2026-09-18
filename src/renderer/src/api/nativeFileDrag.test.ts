import { afterEach, describe, expect, it, vi } from 'vitest'
import { startNativeFileDrag } from './nativeFileDrag'

vi.mock('@renderer/i18n', () => ({
  default: { global: { t: () => 'Cannot drag file' } }
}))

describe('native file drag must not import itself', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function receiver(): {
    target: HTMLElement
    overlay: ReturnType<typeof vi.fn>
    importFiles: ReturnType<typeof vi.fn>
  } {
    const target = document.createElement('div')
    document.body.append(target)
    const overlay = vi.fn()
    const importFiles = vi.fn()
    target.addEventListener('dragenter', overlay)
    target.addEventListener('dragover', overlay)
    target.addEventListener('drop', importFiles)
    return { target, overlay, importFiles }
  }

  function fileEvent(type: string): DragEvent {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], dropEffect: 'copy', files: [new File(['asset'], 'asset.fbx')] }
    })
    return event as DragEvent
  }

  it('blocks overlay and import even after leaving and re-entering the window', async () => {
    let finish!: (value: { success: boolean; data: boolean }) => void
    window.api.startNativeFileDrag = vi.fn(
      () =>
        new Promise<{ success: boolean; data: boolean }>((resolve) => {
          finish = resolve
        })
    )
    const { target, overlay, importFiles } = receiver()
    const pending = startNativeFileDrag('C:/asset.fbx')
    for (const type of ['dragenter', 'dragover', 'dragleave', 'dragenter', 'dragover', 'drop']) {
      const event = fileEvent(type)
      target.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(event.dataTransfer?.dropEffect).toBe('none')
    }
    expect(overlay).not.toHaveBeenCalled()
    expect(importFiles).not.toHaveBeenCalled()
    finish({ success: true, data: true })
    await pending
    // A subsequent Explorer drag must still be accepted.
    target.dispatchEvent(fileEvent('dragenter'))
    target.dispatchEvent(fileEvent('drop'))
    expect(overlay).toHaveBeenCalledOnce()
    expect(importFiles).toHaveBeenCalledOnce()
  })

  it('installs the protection before calling the preload bridge', async () => {
    const { target, importFiles } = receiver()
    window.api.startNativeFileDrag = vi.fn(async () => {
      target.dispatchEvent(fileEvent('drop'))
      return { success: true, data: true }
    })
    await startNativeFileDrag('C:/asset.fbx')
    expect(importFiles).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'failed', 'cancelled'])(
    'restores import after native drag is %s',
    async (outcome) => {
      const { target, importFiles } = receiver()
      window.api.startNativeFileDrag =
        outcome === 'rejected'
          ? vi.fn().mockRejectedValue(new Error('IPC failure'))
          : vi.fn().mockResolvedValue({ success: outcome === 'cancelled', data: true })
      await startNativeFileDrag('C:/asset.fbx').catch(() => undefined)
      const event = fileEvent('drop')
      target.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(importFiles).toHaveBeenCalledOnce()
    }
  )
})
