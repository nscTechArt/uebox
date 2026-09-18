import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { startNativeFileDrag } from './nativeFileDrag'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), getFileIcon: vi.fn() }))
vi.mock('electron', () => ({ app: { getFileIcon: mocks.getFileIcon } }))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, default: { stat: mocks.stat } }))

describe('native file drag', () => {
  const icon = { isEmpty: () => false }
  const sender = { startDrag: vi.fn(), isDestroyed: vi.fn(() => false) }
  const event = { sender } as unknown as IpcMainInvokeEvent
  const file = path.resolve('asset.fbx')

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stat.mockResolvedValue({ isFile: () => true })
    mocks.getFileIcon.mockResolvedValue(icon)
    sender.isDestroyed.mockReturnValue(false)
  })

  it('hands the actual absolute file and system icon to the originating window', async () => {
    expect(await startNativeFileDrag(event, file)).toEqual({ success: true, data: true })
    expect(sender.startDrag).toHaveBeenCalledWith({ file, icon })
  })

  it.each([null, '', 'relative.fbx', 'https://example.test/asset.fbx'])(
    'rejects invalid paths: %s',
    async (value) => {
      expect((await startNativeFileDrag(event, value)).success).toBe(false)
      expect(mocks.stat).not.toHaveBeenCalled()
      expect(sender.startDrag).not.toHaveBeenCalled()
    }
  )

  it('rejects folders', async () => {
    mocks.stat.mockResolvedValue({ isFile: () => false })
    expect((await startNativeFileDrag(event, file)).success).toBe(false)
    expect(sender.startDrag).not.toHaveBeenCalled()
  })

  it('reports missing files without starting a drag', async () => {
    mocks.stat.mockRejectedValue(new Error('ENOENT'))
    expect((await startNativeFileDrag(event, file)).success).toBe(false)
    expect(sender.startDrag).not.toHaveBeenCalled()
  })

  it('does not start after the window closes while loading the icon', async () => {
    sender.isDestroyed.mockReturnValue(true)
    expect((await startNativeFileDrag(event, file)).success).toBe(false)
    expect(sender.startDrag).not.toHaveBeenCalled()
  })

  it('reports native drag errors', async () => {
    sender.startDrag.mockImplementationOnce(() => {
      throw new Error('native failure')
    })
    expect((await startNativeFileDrag(event, file)).success).toBe(false)
  })
})
